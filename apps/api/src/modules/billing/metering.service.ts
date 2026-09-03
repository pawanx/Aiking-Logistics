import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  BalanceBucket,
  UsageEventType,
  billableMinutes,
  money,
  toPaise,
  type Paginated,
  type UsageEventDto,
} from '@aiking/shared';

import { ValidationFailedException } from '../../common/errors/app-exception';
import {
  PRISMA,
  type ExtendedPrismaClient,
  type PrismaTransaction,
} from '../../common/prisma/prisma.service';
import { TenantContext } from '../../common/tenant/tenant-context';
import { WalletService, type MovementResult } from '../wallet/wallet.service';
import { PricingService } from './pricing.service';

/** What a metered event refers to. Every field optional — a charge may have none. */
export interface UsageLinks {
  contactId?: string | null;
  campaignId?: string | null;
  callId?: string | null;
}

export interface ChargeUsageInput extends UsageLinks {
  /** Webhook and queue callers pass it explicitly; request callers let the scope decide. */
  tenantId?: string;
  eventType: UsageEventType;
  /** Messages, or billable minutes for a call. Must be a non-negative integer. */
  quantity: number;
  /**
   * The provider's own reference — WhatsApp message id, Plivo call UUID (spec §8.2).
   * This is the value the UNIQUE index is on, so it must be the provider's, not ours.
   */
  idempotencyKey: string;
  description: string;
  /** When the usage happened, if not now — a call metered after it ended. */
  occurredAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface MeteredCharge {
  usageEventId: string;
  /** False when this was a replay and the existing event was returned. */
  applied: boolean;
  eventType: UsageEventType;
  quantity: number;
  unitPricePaise: bigint;
  totalChargePaise: bigint;
  fromFreePaise: bigint;
  fromPaidPaise: bigint;
  balanceAfterPaise: bigint;
}

export interface ReserveUsageInput extends UsageLinks {
  tenantId?: string;
  eventType: UsageEventType;
  /** Best estimate. The settle step charges what actually happened. */
  estimatedQuantity: number;
  idempotencyKey: string;
  referenceType: string;
  referenceId: string;
}

export interface SettleUsageInput extends UsageLinks {
  tenantId?: string;
  eventType: UsageEventType;
  /** What actually happened — real minutes, real messages sent. */
  actualQuantity: number;
  idempotencyKey: string;
  description: string;
  occurredAt?: Date;
  metadata?: Record<string, unknown>;
}

/**
 * Metering — spec §8.2, and the bridge between the provider layer and the wallet.
 *
 * One rule, and everything else follows from it: **a `usage_events` row and the
 * wallet movement that funds it are written in the same transaction.** The row is
 * created inside `WalletService`'s `withinTransaction` hook, which runs under the
 * wallet row lock, so there is no window in which a tenant has been charged with no
 * metered record — or metered with no charge. Spec §9.3 calls `usage_events` the
 * immutable billing source; that is only true if it cannot disagree with the ledger.
 *
 * Idempotency is the provider's reference, on a UNIQUE `(tenant_id, idempotency_key)`
 * index (§8.2). A redelivered delivery receipt therefore charges once, and the second
 * attempt returns the first attempt's numbers rather than an error — see `applied`.
 *
 * Two paths, deliberately:
 *
 * - `charge()` — the cost is known *after* the fact and is fixed: a WhatsApp message
 *   either sent or it didn't. Charge on the provider's success callback.
 * - `reserve()` → `settle()` / `release()` — the cost is known only after the event
 *   completes: an AI call's duration. Hold the estimate first so two concurrent calls
 *   cannot both spend the same balance, then charge the real amount. This is the §15
 *   mitigation for "billing a tenant for a message that then fails at the provider".
 */
@Injectable()
export class MeteringService {
  private readonly logger = new Logger(MeteringService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: ExtendedPrismaClient,
    private readonly wallet: WalletService,
    private readonly pricing: PricingService,
    private readonly tenantContext: TenantContext,
  ) {}

  // ── Immediate charge ───────────────────────────────────────────────────────

  /**
   * Meter and charge in one transaction.
   *
   * Throws `InsufficientFundsException` when the funds are not there, having written
   * nothing — which is what lets a bulk campaign fail one recipient and continue
   * (spec §6.1, §8.2).
   */
  async charge(input: ChargeUsageInput): Promise<MeteredCharge> {
    const tenantId = input.tenantId ?? this.tenantContext.requireTenantId('metering.charge');
    assertQuantity(input.quantity);
    if (!input.idempotencyKey) {
      throw new ValidationFailedException('A metered charge requires the provider reference as its idempotency key');
    }

    const occurredAt = input.occurredAt ?? new Date();
    const price = await this.pricing.resolve(input.eventType, tenantId, occurredAt);
    const totalChargePaise = price.unitPricePaise * BigInt(input.quantity);

    let usageEventId: string | null = null;

    const movement = await this.wallet.debit({
      tenantId,
      amountPaise: totalChargePaise,
      description: input.description,
      idempotencyKey: input.idempotencyKey,
      referenceType: input.callId ? 'call' : input.campaignId ? 'campaign' : 'usage',
      referenceId: input.callId ?? input.campaignId ?? undefined,
      withinTransaction: async (tx, result) => {
        const row = await this.writeUsageEvent(tx, {
          tenantId,
          eventType: input.eventType,
          quantity: input.quantity,
          unitPricePaise: price.unitPricePaise,
          totalChargePaise,
          idempotencyKey: input.idempotencyKey,
          movement: result,
          links: input,
          occurredAt,
          metadata: { ...(input.metadata ?? {}), priceSource: price.source, priceRuleId: price.ruleId },
        });
        usageEventId = row.id;
      },
    });

    // `applied: false` means the hook never ran, because the wallet found this key
    // already applied. The metered row from that first attempt is the answer.
    if (!movement.applied) {
      const existing = await this.prisma.usageEvent.findFirst({
        where: { tenantId, idempotencyKey: input.idempotencyKey },
      });
      if (existing) {
        return {
          usageEventId: existing.id,
          applied: false,
          eventType: existing.eventType as UsageEventType,
          quantity: existing.quantity,
          unitPricePaise: existing.unitPricePaise,
          totalChargePaise: existing.totalChargePaise,
          fromFreePaise: movement.fromFreePaise,
          fromPaidPaise: movement.fromPaidPaise,
          balanceAfterPaise: movement.balanceAfterPaise,
        };
      }
      // Ledger row without its usage event: only reachable if something charged this
      // key through `WalletService` directly. Loud, because the billing source of
      // truth is now incomplete for this tenant.
      this.logger.error(
        `Wallet key "${input.idempotencyKey}" for tenant ${tenantId} was already applied but has no usage_events row`,
      );
    }

    return {
      usageEventId: usageEventId ?? '',
      applied: movement.applied,
      eventType: input.eventType,
      quantity: input.quantity,
      unitPricePaise: price.unitPricePaise,
      totalChargePaise,
      fromFreePaise: movement.fromFreePaise,
      fromPaidPaise: movement.fromPaidPaise,
      balanceAfterPaise: movement.balanceAfterPaise,
    };
  }

  // ── Reserve → settle / release (spec §15) ──────────────────────────────────

  /** Hold the estimated cost before starting something whose real cost is unknown. */
  async reserve(input: ReserveUsageInput): Promise<{ reservationId: string; heldPaise: bigint; created: boolean }> {
    const tenantId = input.tenantId ?? this.tenantContext.requireTenantId('metering.reserve');
    assertQuantity(input.estimatedQuantity);

    const price = await this.pricing.resolve(input.eventType, tenantId);
    // A zero-quantity estimate would hold nothing and defeat the purpose, so an
    // estimate always holds at least one unit.
    const units = BigInt(Math.max(1, input.estimatedQuantity));
    const heldPaise = price.unitPricePaise * units;

    const reservation = await this.wallet.reserve({
      tenantId,
      amountPaise: heldPaise,
      idempotencyKey: input.idempotencyKey,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
    });

    return { reservationId: reservation.id, heldPaise: reservation.amountPaise, created: reservation.created };
  }

  /**
   * Convert a hold into a real charge for what actually happened, and meter it.
   *
   * The usage row is written in the confirm transaction, so the same
   * "no charge without a meter" guarantee holds on this path too.
   */
  async settle(input: SettleUsageInput): Promise<MeteredCharge> {
    const tenantId = input.tenantId ?? this.tenantContext.requireTenantId('metering.settle');
    assertQuantity(input.actualQuantity);

    const occurredAt = input.occurredAt ?? new Date();
    const price = await this.pricing.resolve(input.eventType, tenantId, occurredAt);
    const totalChargePaise = price.unitPricePaise * BigInt(input.actualQuantity);

    let usageEventId: string | null = null;

    const movement = await this.wallet.confirmReservation({
      tenantId,
      idempotencyKey: input.idempotencyKey,
      settledAmountPaise: totalChargePaise,
      description: input.description,
      withinTransaction: async (tx, result) => {
        const row = await this.writeUsageEvent(tx, {
          tenantId,
          eventType: input.eventType,
          quantity: input.actualQuantity,
          unitPricePaise: price.unitPricePaise,
          totalChargePaise,
          idempotencyKey: input.idempotencyKey,
          movement: result,
          links: input,
          occurredAt,
          metadata: { ...(input.metadata ?? {}), priceSource: price.source, priceRuleId: price.ruleId, settled: true },
        });
        usageEventId = row.id;
      },
    });

    if (!movement.applied && !usageEventId) {
      const existing = await this.prisma.usageEvent.findFirst({
        where: { tenantId, idempotencyKey: input.idempotencyKey },
      });
      if (existing) {
        return {
          usageEventId: existing.id,
          applied: false,
          eventType: existing.eventType as UsageEventType,
          quantity: existing.quantity,
          unitPricePaise: existing.unitPricePaise,
          totalChargePaise: existing.totalChargePaise,
          fromFreePaise: movement.fromFreePaise,
          fromPaidPaise: movement.fromPaidPaise,
          balanceAfterPaise: movement.balanceAfterPaise,
        };
      }
    }

    return {
      usageEventId: usageEventId ?? '',
      applied: movement.applied,
      eventType: input.eventType,
      quantity: input.actualQuantity,
      unitPricePaise: price.unitPricePaise,
      totalChargePaise,
      fromFreePaise: movement.fromFreePaise,
      fromPaidPaise: movement.fromPaidPaise,
      balanceAfterPaise: movement.balanceAfterPaise,
    };
  }

  /** The provider call failed — give the held funds back. Never charges. */
  async release(args: { tenantId?: string; idempotencyKey: string; reason: string }): Promise<void> {
    await this.wallet.releaseReservation(args);
  }

  // ── Estimates (spec §8.2 — check before the paid call) ─────────────────────

  /** What a campaign of `recipients` messages on this channel will cost. */
  async estimate(eventType: UsageEventType, quantity: number, tenantId?: string): Promise<bigint> {
    const quote = await this.pricing.quote(eventType, quantity, tenantId);
    return quote.totalPaise;
  }

  /**
   * Minutes a call of this many seconds bills at — spec §5.3 rounds up to the minute.
   * Exposed here so the estimate and the settle use the same rounding.
   */
  billableMinutes(durationSeconds: number): number {
    return billableMinutes(durationSeconds);
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  async listUsage(
    query: { page?: number; pageSize?: number; eventType?: UsageEventType; from?: Date; to?: Date } = {},
    tenantId?: string,
  ): Promise<Paginated<UsageEventDto>> {
    const id = tenantId ?? this.tenantContext.requireTenantId('metering.listUsage');
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const pageSize = Math.min(200, Math.max(1, Math.trunc(query.pageSize ?? 50)));

    const where = {
      tenantId: id,
      ...(query.eventType ? { eventType: query.eventType } : {}),
      ...(query.from || query.to
        ? { occurredAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } }
        : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.usageEvent.count({ where }),
      this.prisma.usageEvent.findMany({
        where,
        orderBy: { occurredAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return {
      items: rows.map(toUsageEventDto),
      page: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /**
   * Insert the `usage_events` row. Runs inside the wallet transaction, always.
   *
   * `bucket` is a single column but a debit can span both balances, so it records
   * which balance funded the *majority* and the exact split goes in `metadata`. The
   * §8.3 free-vs-paid report reads `wallet_transactions`, where each row carries
   * exactly one bucket and the numbers are exact — this column is for filtering, not
   * for arithmetic.
   */
  private async writeUsageEvent(
    tx: PrismaTransaction,
    args: {
      tenantId: string;
      eventType: UsageEventType;
      quantity: number;
      unitPricePaise: bigint;
      totalChargePaise: bigint;
      idempotencyKey: string;
      movement: MovementResult;
      links: UsageLinks;
      occurredAt: Date;
      metadata: Record<string, unknown>;
    },
  ): Promise<{ id: string }> {
    const { movement } = args;
    const bucket = movement.fromFreePaise > movement.fromPaidPaise ? BalanceBucket.FREE : BalanceBucket.PAID;

    return tx.usageEvent.create({
      data: {
        tenantId: args.tenantId,
        eventType: args.eventType,
        quantity: args.quantity,
        unitPricePaise: args.unitPricePaise,
        totalChargePaise: args.totalChargePaise,
        idempotencyKey: args.idempotencyKey,
        bucket,
        contactId: args.links.contactId ?? null,
        campaignId: args.links.campaignId ?? null,
        callId: args.links.callId ?? null,
        // The paid-bucket row where there is one: it is the row a billing query
        // starts from, and a free-only charge has no paid row to point at.
        walletTransactionId: movement.transactionIds[movement.transactionIds.length - 1] ?? null,
        metadata: {
          ...args.metadata,
          fromFreePaise: movement.fromFreePaise.toString(),
          fromPaidPaise: movement.fromPaidPaise.toString(),
          walletTransactionIds: movement.transactionIds,
        },
        occurredAt: args.occurredAt,
      },
      select: { id: true },
    });
  }
}

function assertQuantity(quantity: number): void {
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new ValidationFailedException('Metered quantity must be a non-negative integer', { quantity });
  }
}

interface UsageEventRow {
  id: string;
  eventType: string;
  quantity: number;
  unitPricePaise: bigint;
  totalChargePaise: bigint;
  idempotencyKey: string;
  contactId: string | null;
  campaignId: string | null;
  callId: string | null;
  occurredAt: Date;
}

function toUsageEventDto(row: UsageEventRow): UsageEventDto {
  return {
    id: row.id,
    eventType: row.eventType as UsageEventType,
    quantity: row.quantity,
    unitPrice: money(toPaise(row.unitPricePaise)),
    totalCharge: money(toPaise(row.totalChargePaise)),
    idempotencyKey: row.idempotencyKey,
    contactId: row.contactId,
    campaignId: row.campaignId,
    callId: row.callId,
    occurredAt: row.occurredAt.toISOString(),
  };
}
