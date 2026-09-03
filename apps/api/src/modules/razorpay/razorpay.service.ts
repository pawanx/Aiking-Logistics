import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ProviderMode,
  RazorpayOrderStatus,
  RazorpayPaymentStatus,
  WalletTransactionType,
  money,
  toPaise,
  type CreateTopupResponse,
} from '@aiking/shared';

import { CONFIG, type AppConfig } from '../../config/configuration';
import {
  NotFoundException,
  ValidationFailedException,
} from '../../common/errors/app-exception';
import {
  PRISMA,
  isUniqueViolation,
  type ExtendedPrismaClient,
} from '../../common/prisma/prisma.service';
import { TenantContext } from '../../common/tenant/tenant-context';
import { PAYMENTS_PROVIDER, type PaymentsProvider } from '../../providers/provider.types';
import { PaymentsMockProvider } from '../../providers/payments/payments.mock';
import { WalletService } from '../wallet/wallet.service';

export interface CreateTopupInput {
  tenantId?: string;
  amountPaise: bigint;
  notes?: Record<string, string>;
  createdBy: string;
}

/** What the webhook handler extracted from a verified `payment.captured` payload. */
export interface CapturedPaymentInput {
  razorpayPaymentId: string;
  razorpayOrderId: string;
  /** Amount as the payload claims it. Reconciled against the order, see below. */
  amountPaise: bigint;
  method?: string;
  /** Always true in practice — the handler verifies before calling. Recorded anyway. */
  signatureVerified: boolean;
  rawPayload: Record<string, unknown>;
}

export interface CapturedPaymentResult {
  tenantId: string;
  paymentId: string;
  /** False when this payment id had already been credited. */
  credited: boolean;
  creditedPaise: bigint;
  balanceAfterPaise: bigint;
}

/** Smallest and largest single top-up. The upper bound matches the mock provider's. */
const MIN_TOPUP_PAISE = 100n;
const MAX_TOPUP_PAISE = 50_000_000n;

/**
 * Razorpay top-ups — spec §8.1.
 *
 * The flow the spec describes: create an order → the tenant pays in Checkout →
 * Razorpay sends `payment.captured` → the wallet is credited. Two properties matter
 * more than the happy path:
 *
 * 1. **The credit is idempotent on `payment_id`**, enforced by the UNIQUE index on
 *    `razorpay_payments.razorpay_payment_id`. Razorpay retries any webhook it did not
 *    get a 2xx for, so a redelivery is expected traffic, not an anomaly — and §15
 *    names "double-crediting a wallet on webhook retry" as a live risk.
 * 2. **The credited amount comes from our own order row, not from the payload.** The
 *    webhook body is attacker-controlled up to the signature; the order was created by
 *    us, for a known tenant, at a known amount. A mismatch is logged and the order's
 *    amount wins. This is also how the tenant is resolved — a webhook carries no
 *    tenant, so there is nothing to trust in it even if we wanted to.
 */
@Injectable()
export class RazorpayService {
  private readonly logger = new Logger(RazorpayService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: ExtendedPrismaClient,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(PAYMENTS_PROVIDER) private readonly payments: PaymentsProvider,
    private readonly paymentsMock: PaymentsMockProvider,
    private readonly wallet: WalletService,
    private readonly tenantContext: TenantContext,
  ) {}

  private get mockMode(): boolean {
    return this.config.providers.payments === ProviderMode.MOCK;
  }

  // ── Step 1: create the order (spec §8.1) ───────────────────────────────────

  async createTopup(input: CreateTopupInput): Promise<CreateTopupResponse> {
    const tenantId = input.tenantId ?? this.tenantContext.requireTenantId('razorpay.createTopup');

    if (input.amountPaise < MIN_TOPUP_PAISE) {
      throw new ValidationFailedException(`A top-up must be at least ${money(MIN_TOPUP_PAISE).formatted}`, {
        amountPaise: input.amountPaise.toString(),
        minimumPaise: MIN_TOPUP_PAISE.toString(),
      });
    }
    if (input.amountPaise > MAX_TOPUP_PAISE) {
      throw new ValidationFailedException(`A single top-up cannot exceed ${money(MAX_TOPUP_PAISE).formatted}`, {
        amountPaise: input.amountPaise.toString(),
        maximumPaise: MAX_TOPUP_PAISE.toString(),
      });
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, slug: true },
    });
    if (!tenant) throw new NotFoundException('Tenant', tenantId);

    // Short, unique, and meaningful in the Razorpay dashboard. Razorpay caps the
    // receipt at 40 characters, hence the slice.
    const receipt = `${tenant.slug}-${Date.now().toString(36)}`.slice(0, 40);

    const order = await this.payments.createOrder({
      amountPaise: input.amountPaise,
      currency: this.config.razorpay.currency,
      receipt,
      notes: { tenantId, createdBy: input.createdBy, ...(input.notes ?? {}) },
    });

    const row = await this.prisma.razorpayOrder.create({
      data: {
        tenantId,
        razorpayOrderId: order.orderId,
        amountPaise: order.amountPaise,
        currency: order.currency,
        status: RazorpayOrderStatus.CREATED,
        receipt,
        notes: input.notes ?? {},
        createdBy: input.createdBy,
      },
    });

    // The wallet row is created up front so the credit path never has to, and so the
    // dashboard shows ₹0.00 rather than nothing for a tenant mid-first-top-up.
    await this.wallet.ensureWallet(tenantId);

    return {
      orderId: row.id,
      razorpayOrderId: order.orderId,
      amount: money(toPaise(order.amountPaise)),
      currency: order.currency,
      keyId: order.keyId,
      mock: this.mockMode,
      // In mock mode there is no Checkout page, so the client needs somewhere to
      // POST in its place. This is the only mock-specific field in the API.
      mockCapturePath: this.mockMode ? `/${this.config.api.globalPrefix}/billing/topups/${row.id}/mock-capture` : undefined,
    };
  }

  // ── Step 4: credit on the verified webhook (spec §8.1) ─────────────────────

  /**
   * Record the payment and credit the wallet, exactly once.
   *
   * Called only by the webhook handler, after signature verification. It runs
   * **unscoped** — a webhook has no session and therefore no tenant context — so the
   * tenant is resolved from our own order row and every write below names it
   * explicitly.
   */
  async recordCapturedPayment(input: CapturedPaymentInput): Promise<CapturedPaymentResult> {
    const order = await this.prisma.razorpayOrder.findUnique({
      where: { razorpayOrderId: input.razorpayOrderId },
    });
    if (!order) {
      // A captured payment for an order we never created. Either a webhook for a
      // different environment sharing the same Razorpay account, or a forged
      // order id that happened to survive signature verification. Neither is
      // creditable, and neither should 500 — Razorpay would retry it forever.
      throw new NotFoundException('RazorpayOrder', input.razorpayOrderId);
    }

    const tenantId = order.tenantId;

    // The payload's amount is informational; the order's is authoritative.
    if (input.amountPaise !== order.amountPaise) {
      this.logger.warn(
        `payment ${input.razorpayPaymentId} claims ${input.amountPaise}p but order ` +
          `${input.razorpayOrderId} is for ${order.amountPaise}p — crediting the order amount`,
      );
    }
    const creditPaise = order.amountPaise;

    const existing = await this.prisma.razorpayPayment.findUnique({
      where: { razorpayPaymentId: input.razorpayPaymentId },
    });

    if (existing?.creditedAt) {
      // The §15 case, reached on every Razorpay retry. Not an error: the caller gets
      // the original outcome so the webhook can be acknowledged with a 200 and the
      // retries stop.
      this.logger.log(`payment ${input.razorpayPaymentId} already credited at ${existing.creditedAt.toISOString()}`);
      const wallet = await this.prisma.wallet.findFirst({ where: { tenantId } });
      return {
        tenantId,
        paymentId: existing.id,
        credited: false,
        creditedPaise: existing.amountPaise,
        balanceAfterPaise: (wallet?.balancePaise ?? 0n) + (wallet?.freeCreditBalancePaise ?? 0n),
      };
    }

    const payment = existing ?? (await this.insertPayment(input, order.id, tenantId, creditPaise));

    // The wallet's own idempotency key is the Razorpay payment id, so even if this
    // row were somehow inserted twice the ledger would still move once.
    const movement = await this.wallet.credit({
      tenantId,
      amountPaise: creditPaise,
      type: WalletTransactionType.TOPUP_CREDIT,
      description: `Razorpay top-up ${input.razorpayPaymentId}`,
      idempotencyKey: `razorpay:${input.razorpayPaymentId}`,
      referenceType: 'razorpay_payment',
      referenceId: payment.id,
      withinTransaction: async (tx, result) => {
        await tx.razorpayPayment.update({
          where: { id: payment.id },
          data: {
            status: RazorpayPaymentStatus.CAPTURED,
            creditedAt: new Date(),
            walletTransactionId: result.transactionIds[0] ?? null,
          },
        });
        await tx.razorpayOrder.update({
          where: { id: order.id },
          data: { status: RazorpayOrderStatus.PAID },
        });
      },
    });

    if (movement.applied) {
      this.logger.log(`credited ${creditPaise}p to tenant ${tenantId} from payment ${input.razorpayPaymentId}`);
    }

    return {
      tenantId,
      paymentId: payment.id,
      credited: movement.applied,
      creditedPaise: creditPaise,
      balanceAfterPaise: movement.balanceAfterPaise,
    };
  }

  /** Record a payment that failed at Razorpay. Never touches the wallet. */
  async recordFailedPayment(input: CapturedPaymentInput): Promise<void> {
    const order = await this.prisma.razorpayOrder.findUnique({
      where: { razorpayOrderId: input.razorpayOrderId },
    });
    if (!order) throw new NotFoundException('RazorpayOrder', input.razorpayOrderId);

    await this.prisma.razorpayOrder.update({
      where: { id: order.id },
      data: { status: RazorpayOrderStatus.FAILED },
    });

    try {
      await this.prisma.razorpayPayment.create({
        data: {
          tenantId: order.tenantId,
          orderId: order.id,
          razorpayPaymentId: input.razorpayPaymentId,
          razorpayOrderId: input.razorpayOrderId,
          amountPaise: input.amountPaise,
          currency: order.currency,
          status: RazorpayPaymentStatus.FAILED,
          method: input.method ?? null,
          signatureVerified: input.signatureVerified,
          rawPayload: input.rawPayload,
        },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }

  // ── Mock mode: stand in for Checkout ───────────────────────────────────────

  /**
   * Complete a mock payment, exercising the real webhook path.
   *
   * The mock provider signs a genuine Razorpay payload and pushes it through
   * `POST /webhooks/razorpay` — including signature verification — so what this tests
   * is the production code path, not a shortcut around it. Refuses outright in live
   * mode: an endpoint that could credit a wallet without a real payment has no
   * business existing when real money is involved.
   */
  async mockCapture(orderRowId: string, tenantId?: string): Promise<{ razorpayPaymentId: string; duplicate: boolean }> {
    if (!this.mockMode) {
      throw new ValidationFailedException(
        'Mock capture is unavailable when PAYMENTS_MODE=live — complete the payment in Razorpay Checkout',
        { paymentsMode: this.config.providers.payments },
      );
    }

    const id = tenantId ?? this.tenantContext.requireTenantId('razorpay.mockCapture');
    const order = await this.prisma.razorpayOrder.findFirst({ where: { id: orderRowId, tenantId: id } });
    if (!order) throw new NotFoundException('RazorpayOrder', orderRowId);

    const capture = await this.paymentsMock.simulateCapture(order.razorpayOrderId);
    return { razorpayPaymentId: capture.paymentId, duplicate: capture.duplicate };
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  async listOrders(tenantId?: string, limit = 25) {
    const id = tenantId ?? this.tenantContext.requireTenantId('razorpay.listOrders');
    const orders = await this.prisma.razorpayOrder.findMany({
      where: { tenantId: id },
      orderBy: { createdAt: 'desc' },
      take: Math.min(100, Math.max(1, limit)),
      include: { payments: { select: { razorpayPaymentId: true, status: true, creditedAt: true } } },
    });

    return orders.map((order) => ({
      orderId: order.id,
      razorpayOrderId: order.razorpayOrderId,
      amount: money(toPaise(order.amountPaise)),
      currency: order.currency,
      status: order.status,
      receipt: order.receipt,
      createdAt: order.createdAt.toISOString(),
      payments: order.payments.map((payment) => ({
        razorpayPaymentId: payment.razorpayPaymentId,
        status: payment.status,
        creditedAt: payment.creditedAt?.toISOString() ?? null,
      })),
    }));
  }

  private async insertPayment(
    input: CapturedPaymentInput,
    orderRowId: string,
    tenantId: string,
    amountPaise: bigint,
  ): Promise<{ id: string }> {
    try {
      return await this.prisma.razorpayPayment.create({
        data: {
          tenantId,
          orderId: orderRowId,
          razorpayPaymentId: input.razorpayPaymentId,
          razorpayOrderId: input.razorpayOrderId,
          amountPaise,
          status: RazorpayPaymentStatus.AUTHORIZED,
          method: input.method ?? null,
          signatureVerified: input.signatureVerified,
          rawPayload: input.rawPayload,
        },
        select: { id: true },
      });
    } catch (error) {
      // Two redeliveries arriving concurrently. Whichever lost the unique index reads
      // the winner's row and proceeds; the wallet key then makes the credit single.
      if (!isUniqueViolation(error)) throw error;
      const row = await this.prisma.razorpayPayment.findUniqueOrThrow({
        where: { razorpayPaymentId: input.razorpayPaymentId },
        select: { id: true },
      });
      return row;
    }
  }
}
