import { Inject, Injectable } from '@nestjs/common';
import { ProviderMode } from '@aiking/shared';

import { CONFIG, type AppConfig } from '../../config/configuration';
import {
  ProviderError,
  type CreateOrderInput,
  type CreateOrderResult,
  type FetchedPayment,
  type PaymentsProvider,
} from '../provider.types';

/**
 * Razorpay Orders and Payments — spec §8.1.
 *
 * Razorpay denominates in paise, which lines up exactly with the integer-paise rule
 * in §9.1: the amount is passed through with no conversion and therefore no rounding
 * step where a rupee could go missing.
 *
 * `fetchPayment` exists because the webhook body is attacker-supplied up to the
 * signature. Re-reading the payment server-side means the credited amount comes from
 * Razorpay's record rather than from a payload — so even a leaked webhook secret
 * cannot mint an arbitrary wallet credit.
 */
@Injectable()
export class PaymentsLiveProvider implements PaymentsProvider {
  readonly name = 'payments';
  readonly mode = ProviderMode.LIVE;

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  private get authHeader(): string {
    const { keyId, keySecret } = this.config.razorpay;
    return `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;
  }

  async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
    if (input.amountPaise <= 0n) {
      throw new ProviderError('payments', 'createOrder', 'invalid_amount', 'Order amount must be positive', false);
    }
    // Razorpay caps a single order at ₹5,00,000 for most accounts. Caught here so
    // the user sees a clear message instead of a raw gateway rejection.
    if (input.amountPaise > 50_000_000n) {
      throw new ProviderError(
        'payments',
        'createOrder',
        'amount_too_large',
        'A single top-up cannot exceed ₹5,00,000',
        false,
      );
    }

    const response = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { authorization: this.authHeader, 'content-type': 'application/json' },
      body: JSON.stringify({
        amount: Number(input.amountPaise),
        currency: input.currency,
        receipt: input.receipt,
        notes: input.notes ?? {},
        payment_capture: 1,
      }),
    }).catch((error: unknown) => {
      throw new ProviderError('payments', 'createOrder', 'network_error', (error as Error).message, true);
    });

    const body = (await response.json().catch(() => ({}))) as {
      id?: string;
      amount?: number;
      currency?: string;
      created_at?: number;
      error?: { description?: string; code?: string };
    };

    if (!response.ok || !body.id) {
      throw new ProviderError(
        'payments',
        'createOrder',
        body.error?.code ?? String(response.status),
        body.error?.description ?? `Razorpay returned HTTP ${response.status}`,
        response.status >= 500,
        response.status,
      );
    }

    return {
      orderId: body.id,
      amountPaise: BigInt(body.amount ?? Number(input.amountPaise)),
      currency: body.currency ?? input.currency,
      keyId: this.config.razorpay.keyId,
      createdAt: body.created_at ? new Date(body.created_at * 1000) : new Date(),
    };
  }

  async fetchPayment(paymentId: string): Promise<FetchedPayment> {
    const response = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, {
      headers: { authorization: this.authHeader },
    }).catch((error: unknown) => {
      throw new ProviderError('payments', 'fetchPayment', 'network_error', (error as Error).message, true);
    });

    const body = (await response.json().catch(() => ({}))) as {
      id?: string;
      order_id?: string;
      amount?: number;
      status?: string;
      method?: string;
      error?: { description?: string; code?: string };
    };

    if (!response.ok || !body.id) {
      throw new ProviderError(
        'payments',
        'fetchPayment',
        body.error?.code ?? String(response.status),
        body.error?.description ?? `Razorpay returned HTTP ${response.status}`,
        response.status >= 500,
        response.status,
      );
    }

    return {
      paymentId: body.id,
      orderId: body.order_id ?? '',
      amountPaise: BigInt(body.amount ?? 0),
      status: (body.status as FetchedPayment['status']) ?? 'created',
      method: body.method,
    };
  }
}
