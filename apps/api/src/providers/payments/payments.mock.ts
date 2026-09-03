import { Inject, Injectable, Logger } from '@nestjs/common';
import { ProviderMode } from '@aiking/shared';

import { CONFIG, type AppConfig } from '../../config/configuration';
import { ProviderCallbackRegistry } from '../callback-registry';
import { MockBehavior } from '../mock-support';
import {
  ProviderError,
  type CreateOrderInput,
  type CreateOrderResult,
  type FetchedPayment,
  type PaymentsProvider,
} from '../provider.types';

interface MockOrder {
  orderId: string;
  amountPaise: bigint;
  currency: string;
  receipt: string;
  notes: Record<string, string>;
  createdAt: Date;
  paymentId?: string;
  status: 'created' | 'paid' | 'failed';
}

/**
 * Deterministic Razorpay stand-in.
 *
 * Crucially, it does **not** auto-capture. A real top-up waits for a human to
 * complete Checkout, and a mock that credited the wallet the moment an order was
 * created would hide the entire state machine spec §8.1 describes — order created,
 * payment captured, webhook received, wallet credited — along with every failure mode
 * in between. So capture is an explicit call, exposed as an endpoint the web app and
 * the smoke script invoke, standing in for the browser.
 *
 * `simulateCapture` can be called more than once on purpose. Razorpay retries a
 * webhook it did not get a 2xx for, and the §15 "double-crediting a wallet on webhook
 * retry" risk is only testable if a duplicate can actually be produced.
 */
@Injectable()
export class PaymentsMockProvider implements PaymentsProvider {
  readonly name = 'payments';
  readonly mode = ProviderMode.MOCK;

  private readonly logger = new Logger(PaymentsMockProvider.name);
  private readonly orders = new Map<string, MockOrder>();

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly behavior: MockBehavior,
    private readonly callbacks: ProviderCallbackRegistry,
  ) {}

  async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
    await this.behavior.begin('payments', 'createOrder');

    if (input.amountPaise <= 0n) {
      throw new ProviderError('payments', 'createOrder', 'invalid_amount', 'Order amount must be positive', false);
    }
    if (input.amountPaise > 50_000_000n) {
      throw new ProviderError('payments', 'createOrder', 'amount_too_large', 'A single top-up cannot exceed ₹5,00,000', false);
    }

    const orderId = `order_${this.behavior.id('MOCK').replace('MOCK_', '')}`;
    const order: MockOrder = {
      orderId,
      amountPaise: input.amountPaise,
      currency: input.currency,
      receipt: input.receipt,
      notes: input.notes ?? {},
      createdAt: new Date(),
      status: 'created',
    };
    this.orders.set(orderId, order);

    return {
      orderId,
      amountPaise: input.amountPaise,
      currency: input.currency,
      keyId: this.config.razorpay.keyId,
      createdAt: order.createdAt,
    };
  }

  async fetchPayment(paymentId: string): Promise<FetchedPayment> {
    await this.behavior.delay();

    const order = [...this.orders.values()].find((candidate) => candidate.paymentId === paymentId);
    if (!order) {
      throw new ProviderError('payments', 'fetchPayment', 'not_found', `No mock payment ${paymentId}`, false, 404);
    }

    return {
      paymentId,
      orderId: order.orderId,
      amountPaise: order.amountPaise,
      status: order.status === 'paid' ? 'captured' : order.status === 'failed' ? 'failed' : 'created',
      method: 'upi',
    };
  }

  /* ── the browser's part of the flow, made callable ────────────────────────── */

  /**
   * Complete a mock payment and deliver the `payment.captured` webhook.
   *
   * Repeat calls reuse the same `paymentId`, which is what makes the idempotency
   * guarantee testable: the second webhook carries an identical id, hits the unique
   * index on `razorpay_payments.razorpay_payment_id`, and must credit nothing.
   */
  async simulateCapture(orderId: string): Promise<{ paymentId: string; amountPaise: bigint; duplicate: boolean }> {
    const order = this.orders.get(orderId);
    if (!order) {
      throw new ProviderError('payments', 'simulateCapture', 'not_found', `No mock order ${orderId}`, false, 404);
    }

    const duplicate = order.status === 'paid';
    if (!order.paymentId) order.paymentId = `pay_${this.behavior.id('MOCK').replace('MOCK_', '')}`;
    order.status = 'paid';

    this.logger.log(
      `mock razorpay capture ${order.paymentId} for ${orderId}${duplicate ? ' (replayed webhook)' : ''}`,
    );

    await this.callbacks.emit(`payment.captured for ${order.paymentId}`, async (sink) => {
      await sink.paymentCaptured({
        orderId,
        paymentId: order.paymentId as string,
        amountPaise: order.amountPaise,
        method: 'upi',
      });
    });

    return { paymentId: order.paymentId, amountPaise: order.amountPaise, duplicate };
  }

  /** Mark an order failed, for exercising the abandoned-checkout path. */
  simulateFailure(orderId: string): void {
    const order = this.orders.get(orderId);
    if (order) order.status = 'failed';
  }

  order(orderId: string): MockOrder | undefined {
    return this.orders.get(orderId);
  }

  clear(): void {
    this.orders.clear();
  }
}
