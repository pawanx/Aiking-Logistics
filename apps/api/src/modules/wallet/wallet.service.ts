import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  BalanceBucket,
  LowBalanceBehavior,
  ReservationStatus,
  UsageEventType,
  WalletTransactionType,
  money,
  nonNegative,
  sumPaise,
  toPaise,
  type WalletLedgerDto,
  type WalletStaffViewDto,
  type WalletSummaryDto,
  type WalletTransactionDto,
} from '@aiking/shared';

import {
  ConflictingDuplicateException,
  InsufficientFundsException,
  ValidationFailedException,
} from '../../common/errors/app-exception';
import {
  PRISMA,
  isUniqueViolation,
  type ExtendedPrismaClient,
  type PrismaTransaction,
} from '../../common/prisma/prisma.service';
import { TenantContext } from '../../common/tenant/tenant-context';
import { TenantSettingsService } from '../../common/tenant/tenant-settings.service';

/**
 * Mutable in-transaction view of a wallet.
 *
 * Operations mutate this; `withLockedWallet` writes it back once, at the end. That
 * single-writer arrangement is deliberate — a balance updated from three places is a
 * balance that eventually disagrees with its own ledger.
 */
interface WalletSnapshot {
  readonly id: string;
  readonly tenantId: string;
  paidPaise: bigint;
  freePaise: bigint;
  reservedPaise: bigint;
  lifetimeCreditedPaise: bigint;
  lifetimeDebitedPaise: bigint;
}

/** Internal sentinel: the wallet row does not exist yet. Never leaves this file. */
class WalletMissingError extends Error {}

export interface CreditInput {
  /** Defaults to the active tenant scope. Webhooks resolve a tenant first and pass it. */
  tenantId?: string;
  amountPaise: bigint;
  type?: typeof WalletTransactionType.TOPUP_CREDIT | typeof WalletTransactionType.FREE_CREDIT_GRANT;
  description: string;
  /**
   * Spec §15 — every balance mutation carries one. `null` only for movements with no
   * external reference at all; anything driven by a provider must supply the
   * provider's own id so a redelivery cannot double-credit.
   */
  idempotencyKey: string | null;
  referenceType?: string;
  referenceId?: string;
  createdBy?: string;
  withinTransaction?: TransactionHook;
}

export interface DebitInput {
  tenantId?: string;
  amountPaise: bigint;
  description: string;
  /** The provider's own reference (spec §8.2). Unique per tenant. */
  idempotencyKey: string;
  referenceType?: string;
  referenceId?: string;
  withinTransaction?: TransactionHook;
}

/**
 * Runs inside the same transaction as the balance movement, after the ledger rows
 * exist and before commit.
 *
 * This is how BillingService writes its `usage_events` row atomically with the
 * charge. Spec §8.2 wants the meter and the money to move together; a callback
 * inside the lock is a smaller seam than handing the transaction out to callers and
 * hoping each one remembers to take the row lock.
 */
export type TransactionHook = (tx: PrismaTransaction, movement: MovementResult) => Promise<void>;

export interface MovementResult {
  /** False when an existing row with this idempotency key was returned instead. */
  applied: boolean;
  fromFreePaise: bigint;
  fromPaidPaise: bigint;
  /** Unsigned magnitude of the movement. */
  totalPaise: bigint;
  /**
   * Spendable balance (paid + free) immediately after the movement.
   *
   * On a replay this is the balance recorded at the time of the *original*
   * movement, not the current balance — returning the original outcome is what
   * makes the call idempotent rather than merely non-duplicating.
   */
  balanceAfterPaise: bigint;
  transactionIds: string[];
}

export interface ReserveInput {
  tenantId?: string;
  amountPaise: bigint;
  idempotencyKey: string;
  referenceType: string;
  referenceId: string;
}

export interface ReservationResult {
  id: string;
  amountPaise: bigint;
  status: ReservationStatus;
  /** False when an existing hold with this key was returned instead. */
  created: boolean;
}

export interface ConfirmReservationInput {
  tenantId?: string;
  idempotencyKey: string;
  /**
   * What to actually charge — may differ from the held amount, because a call's real
   * duration differs from its estimate (spec §5.3).
   */
  settledAmountPaise: bigint;
  description: string;
  withinTransaction?: TransactionHook;
}

export interface AdjustInput {
  tenantId: string;
  /** Signed and non-zero. Negative claws back a mistaken credit. */
  amountPaise: bigint;
  reason: string;
  createdBy: string;
  idempotencyKey?: string;
  /** Permit the correction to leave the wallet negative. Off unless asked for. */
  allowNegativeBalance?: boolean;
}

export interface SpendCheck {
  affordable: boolean;
  requiredPaise: bigint;
  /** Spendable minus held. What a new action can actually spend. */
  availablePaise: bigint;
  shortfallPaise: bigint;
  /** True when the tenant's §5.3 soft limit is what makes this affordable. */
  viaSoftLimit: boolean;
}

export interface LedgerQuery {
  page?: number;
  pageSize?: number;
  type?: WalletTransactionType;
}

/** Days of history in the Staff recent-activity summary (spec §8.4). */
const STAFF_ACTIVITY_WINDOW_DAYS = 30;

/**
 * The wallet engine — spec §8, and the source of four of the §15 risks.
 *
 * Four rules hold everywhere in this file:
 *
 * 1. **Integer paise, never float** (§9.1). Every amount is a `bigint`.
 * 2. **Every balance mutation happens under `SELECT … FOR UPDATE`** on the wallet
 *    row, inside one transaction with the ledger insert. Concurrent debits then
 *    serialize on the row rather than racing through a read-modify-write.
 * 3. **Idempotency is a database constraint**, not a code check. The pre-check
 *    inside the lock is the fast path; the UNIQUE index is what makes it true.
 * 4. **The ledger is append-only.** Nothing here updates or deletes a
 *    `wallet_transactions` row, which is what lets
 *    `sum(amount_paise) = balance_paise + free_credit_balance_paise` be asserted as
 *    an invariant.
 *
 * Reservations (§15 reserve-then-confirm) move *availability*, not balance, so they
 * live in `wallet_reservations` and write no ledger row. `reserve` → provider call →
 * `confirmReservation` on success or `releaseReservation` on failure. That is the
 * direct answer to "billing a tenant for a message that then fails at the provider".
 */
@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: ExtendedPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly tenantSettings: TenantSettingsService,
  ) {}

  // ── Credits ────────────────────────────────────────────────────────────────

  /**
   * Add funds. Spec §8.1 (captured top-up) and §8.3 (onboarding free credits).
   *
   * A `free_credit_grant` lands in the free bucket, which is what makes §8.3's
   * "free credits consumed before paid balance" expressible at debit time.
   */
  async credit(input: CreditInput): Promise<MovementResult> {
    const tenantId = this.resolveTenantId(input.tenantId, 'wallet.credit');
    const amount = input.amountPaise;
    if (amount <= 0n) {
      throw new ValidationFailedException('A credit must be a positive amount of paise', {
        amountPaise: amount.toString(),
      });
    }

    const type = input.type ?? WalletTransactionType.TOPUP_CREDIT;
    const bucket =
      type === WalletTransactionType.FREE_CREDIT_GRANT ? BalanceBucket.FREE : BalanceBucket.PAID;

    return this.withLockedWallet(tenantId, 'wallet.credit', async (tx, wallet) => {
      const replay = await this.findReplay(tx, tenantId, [input.idempotencyKey]);
      if (replay) return replay;

      if (bucket === BalanceBucket.FREE) wallet.freePaise += amount;
      else wallet.paidPaise += amount;
      wallet.lifetimeCreditedPaise += amount;

      const row = await this.appendRow(tx, wallet, {
        type,
        bucket,
        amountPaise: amount,
        description: input.description,
        idempotencyKey: input.idempotencyKey,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        createdBy: input.createdBy,
      });

      const result: MovementResult = {
        applied: true,
        fromFreePaise: bucket === BalanceBucket.FREE ? amount : 0n,
        fromPaidPaise: bucket === BalanceBucket.PAID ? amount : 0n,
        totalPaise: amount,
        balanceAfterPaise: row.balanceAfterPaise,
        transactionIds: [row.id],
      };

      await input.withinTransaction?.(tx, result);
      return result;
    });
  }

  /**
   * Super Admin correction — §4.2 grants Super Admin billing rights, and a
   * platform operator needs a way to fix a mis-credit without editing history.
   *
   * Implemented as a *new* signed ledger row rather than a mutation, so the original
   * mistake stays visible and the ledger remains append-only.
   */
  async adjust(input: AdjustInput): Promise<MovementResult> {
    if (input.amountPaise === 0n) {
      throw new ValidationFailedException('An adjustment of zero has no effect');
    }
    if (!input.reason.trim()) {
      throw new ValidationFailedException('An adjustment requires a reason — it is an audit record');
    }

    return this.withLockedWallet(input.tenantId, 'wallet.adjust', async (tx, wallet) => {
      const replay = await this.findReplay(tx, input.tenantId, [input.idempotencyKey ?? null]);
      if (replay) return replay;

      const amount = input.amountPaise;
      const spendableAfter = wallet.paidPaise + wallet.freePaise + amount;
      if (spendableAfter < 0n && input.allowNegativeBalance !== true) {
        throw new ValidationFailedException(
          'That adjustment would leave the wallet negative. Pass allowNegativeBalance to confirm.',
          { resultingBalancePaise: spendableAfter.toString() },
        );
      }

      wallet.paidPaise += amount;
      if (amount > 0n) wallet.lifetimeCreditedPaise += amount;
      else wallet.lifetimeDebitedPaise += -amount;

      const row = await this.appendRow(tx, wallet, {
        type: WalletTransactionType.ADJUSTMENT,
        bucket: BalanceBucket.PAID,
        amountPaise: amount,
        description: input.reason,
        idempotencyKey: input.idempotencyKey ?? null,
        referenceType: 'manual',
        createdBy: input.createdBy,
      });

      this.logger.warn(
        `Manual adjustment of ${amount}p on tenant ${input.tenantId} by ${input.createdBy}: ${input.reason}`,
      );

      return {
        applied: true,
        fromFreePaise: 0n,
        fromPaidPaise: amount,
        totalPaise: amount < 0n ? -amount : amount,
        balanceAfterPaise: row.balanceAfterPaise,
        transactionIds: [row.id],
      };
    });
  }

  // ── Debits ─────────────────────────────────────────────────────────────────

  /**
   * Charge the wallet. Free credits first (§8.3), then paid balance.
   *
   * Refuses when the funds are not there, and refuses *before* anything is written —
   * so the caller can surface §8.2's "top-up required" state and, in a bulk send,
   * fail the affected recipient without failing the campaign.
   */
  async debit(input: DebitInput): Promise<MovementResult> {
    const tenantId = this.resolveTenantId(input.tenantId, 'wallet.debit');
    if (input.amountPaise < 0n) {
      throw new ValidationFailedException('A debit cannot be negative — use adjust() to credit back');
    }
    if (!input.idempotencyKey) {
      // Not defensive noise: a debit without a key is a debit that a retried job will
      // apply twice, and the retry is guaranteed to happen eventually.
      throw new ValidationFailedException('A debit requires an idempotency key (spec §8.2)');
    }

    const floorPaise = await this.overdraftFloorPaise(tenantId);

    return this.withLockedWallet(tenantId, 'wallet.debit', async (tx, wallet) => {
      const replay = await this.findReplay(tx, tenantId, splitKeys(input.idempotencyKey));
      if (replay) return replay;

      const result = await this.applyDebit(tx, wallet, {
        amountPaise: input.amountPaise,
        description: input.description,
        idempotencyKey: input.idempotencyKey,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        floorPaise,
        enforceAvailability: true,
      });

      await input.withinTransaction?.(tx, result);
      return result;
    });
  }

  // ── Reservations (spec §15 reserve → confirm / release) ────────────────────

  /**
   * Hold funds before a paid provider call.
   *
   * The hold moves availability, not balance, so no ledger row is written — the
   * reservation row *is* the record. Availability is `paid + free - reserved`, which
   * is what every subsequent spend check subtracts, so two concurrent sends cannot
   * both be told the same rupee is theirs.
   */
  async reserve(input: ReserveInput): Promise<ReservationResult> {
    const tenantId = this.resolveTenantId(input.tenantId, 'wallet.reserve');
    if (input.amountPaise <= 0n) {
      throw new ValidationFailedException('A reservation must be a positive amount of paise');
    }

    const floorPaise = await this.overdraftFloorPaise(tenantId);

    return this.withLockedWallet(tenantId, 'wallet.reserve', async (tx, wallet) => {
      const existing = await tx.walletReservation.findFirst({
        where: { tenantId, idempotencyKey: input.idempotencyKey },
      });
      if (existing) {
        return {
          id: existing.id,
          amountPaise: existing.amountPaise,
          status: existing.status as ReservationStatus,
          created: false,
        };
      }

      const available = this.availablePaise(wallet) + floorPaise;
      if (input.amountPaise > available) {
        throw new InsufficientFundsException(
          input.amountPaise,
          nonNegative(this.availablePaise(wallet)),
          input.referenceType,
        );
      }

      wallet.reservedPaise += input.amountPaise;

      const reservation = await tx.walletReservation.create({
        data: {
          tenantId,
          amountPaise: input.amountPaise,
          status: ReservationStatus.HELD,
          referenceType: input.referenceType,
          referenceId: input.referenceId,
          idempotencyKey: input.idempotencyKey,
        },
      });

      return {
        id: reservation.id,
        amountPaise: reservation.amountPaise,
        status: ReservationStatus.HELD,
        created: true,
      };
    });
  }

  /**
   * Convert a hold into a real charge, for the amount actually incurred.
   *
   * Availability is deliberately **not** enforced here. The provider has already
   * delivered the message or completed the call; refusing the debit at this point
   * would mean giving the service away, and an over-long call that lands the wallet
   * slightly negative is a top-up prompt rather than a lost charge. The check that
   * protects the tenant is the one at `reserve` time, before the spend (§8.2).
   */
  async confirmReservation(input: ConfirmReservationInput): Promise<MovementResult> {
    const tenantId = this.resolveTenantId(input.tenantId, 'wallet.confirmReservation');
    if (input.settledAmountPaise < 0n) {
      throw new ValidationFailedException('A settled amount cannot be negative');
    }

    return this.withLockedWallet(tenantId, 'wallet.confirmReservation', async (tx, wallet) => {
      const reservation = await tx.walletReservation.findFirst({
        where: { tenantId, idempotencyKey: input.idempotencyKey },
      });
      if (!reservation) {
        // No hold to convert. Charging anyway would be a silent policy change, so the
        // caller is told to use debit() if that is what it meant.
        throw new ConflictingDuplicateException(
          `No reservation found for key "${input.idempotencyKey}"; use debit() for an unreserved charge`,
          { idempotencyKey: input.idempotencyKey },
        );
      }

      if (reservation.status === ReservationStatus.RELEASED) {
        throw new ConflictingDuplicateException('That reservation was already released and cannot be confirmed', {
          reservationId: reservation.id,
        });
      }

      const debitKey = reservationDebitKey(input.idempotencyKey);
      const replay = await this.findReplay(tx, tenantId, splitKeys(debitKey));
      if (replay) return replay;

      // Free the hold first, so the availability arithmetic below sees the funds this
      // charge is entitled to rather than counting them twice.
      wallet.reservedPaise = nonNegative(wallet.reservedPaise - reservation.amountPaise);

      const result = await this.applyDebit(tx, wallet, {
        amountPaise: input.settledAmountPaise,
        description: input.description,
        idempotencyKey: debitKey,
        referenceType: reservation.referenceType ?? undefined,
        referenceId: reservation.referenceId ?? undefined,
        floorPaise: 0n,
        enforceAvailability: false,
      });

      await tx.walletReservation.update({
        where: { id: reservation.id },
        data: {
          status: ReservationStatus.CONFIRMED,
          settledAmountPaise: input.settledAmountPaise,
          confirmedAt: new Date(),
        },
      });

      if (wallet.paidPaise + wallet.freePaise < 0n) {
        this.logger.warn(
          `Tenant ${tenantId} wallet is negative (${wallet.paidPaise + wallet.freePaise}p) after settling ` +
            `reservation ${reservation.id} at ${input.settledAmountPaise}p against a ${reservation.amountPaise}p hold`,
        );
      }

      await input.withinTransaction?.(tx, result);
      return result;
    });
  }

  /**
   * Return a hold because the provider call failed — the other half of the §15
   * mitigation. Idempotent: releasing an already-released hold is a no-op.
   */
  async releaseReservation(args: { tenantId?: string; idempotencyKey: string; reason: string }): Promise<void> {
    const tenantId = this.resolveTenantId(args.tenantId, 'wallet.releaseReservation');

    await this.withLockedWallet(tenantId, 'wallet.releaseReservation', async (tx, wallet) => {
      const reservation = await tx.walletReservation.findFirst({
        where: { tenantId, idempotencyKey: args.idempotencyKey },
      });
      if (!reservation || reservation.status === ReservationStatus.RELEASED) return;

      if (reservation.status === ReservationStatus.CONFIRMED) {
        throw new ConflictingDuplicateException('That reservation was already confirmed and cannot be released', {
          reservationId: reservation.id,
        });
      }

      wallet.reservedPaise = nonNegative(wallet.reservedPaise - reservation.amountPaise);

      await tx.walletReservation.update({
        where: { id: reservation.id },
        data: { status: ReservationStatus.RELEASED, releasedAt: new Date(), releaseReason: args.reason },
      });
    });
  }

  // ── Pre-flight checks (spec §8.2 — "before the paid API call") ─────────────

  /**
   * Advisory affordability check, deliberately lock-free.
   *
   * Used to fail fast — refusing a 500-recipient campaign at launch beats discovering
   * the problem on recipient 3. It is advisory because the authoritative check is the
   * one inside the locked debit transaction; this one can be stale by the time the
   * send happens, and that is fine, because the real check cannot be.
   */
  async checkAffordable(requiredPaise: bigint, tenantId?: string): Promise<SpendCheck> {
    const id = this.resolveTenantId(tenantId, 'wallet.checkAffordable');
    const wallet = await this.prisma.wallet.findFirst({ where: { tenantId: id } });

    const availablePaise = wallet
      ? wallet.balancePaise + wallet.freeCreditBalancePaise - wallet.reservedPaise
      : 0n;
    const floorPaise = await this.overdraftFloorPaise(id);
    const affordable = requiredPaise <= availablePaise + floorPaise;

    return {
      affordable,
      requiredPaise,
      availablePaise,
      shortfallPaise: nonNegative(requiredPaise - availablePaise - floorPaise),
      viaSoftLimit: affordable && requiredPaise > availablePaise,
    };
  }

  /** `checkAffordable`, throwing the §8.2 payment-required error instead of returning. */
  async assertAffordable(requiredPaise: bigint, context: string, tenantId?: string): Promise<SpendCheck> {
    const check = await this.checkAffordable(requiredPaise, tenantId);
    if (!check.affordable) {
      throw new InsufficientFundsException(requiredPaise, nonNegative(check.availablePaise), context);
    }
    return check;
  }

  // ── Read models (spec §8.4 Manager / Staff split) ──────────────────────────

  async summary(tenantId?: string): Promise<WalletSummaryDto> {
    const id = this.resolveTenantId(tenantId, 'wallet.summary');
    const wallet = await this.prisma.wallet.findFirst({ where: { tenantId: id } });
    const thresholdPaise = await this.lowBalanceThresholdPaise(id);

    // A tenant that has never transacted has a zero balance. That is a fact about the
    // account, not a 404 — the dashboard should render ₹0.00 and a top-up button.
    const paid = wallet?.balancePaise ?? 0n;
    const free = wallet?.freeCreditBalancePaise ?? 0n;
    const reserved = wallet?.reservedPaise ?? 0n;
    const available = paid + free - reserved;

    return {
      balance: money(paid + free),
      paidBalance: money(paid),
      freeCreditBalance: money(free),
      reservedBalance: money(reserved),
      availableBalance: money(available),
      lowBalance: available < thresholdPaise,
      updatedAt: (wallet?.updatedAt ?? new Date()).toISOString(),
    };
  }

  /** Spec §8.4 — Managers see the full itemized ledger. */
  async ledger(query: LedgerQuery = {}, tenantId?: string): Promise<WalletLedgerDto> {
    const id = this.resolveTenantId(tenantId, 'wallet.ledger');
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const pageSize = Math.min(200, Math.max(1, Math.trunc(query.pageSize ?? 50)));
    const where = { tenantId: id, ...(query.type ? { type: query.type } : {}) };

    const [summary, total, rows] = await Promise.all([
      this.summary(id),
      this.prisma.walletTransaction.count({ where }),
      this.prisma.walletTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return {
      summary,
      transactions: rows.map(toTransactionDto),
      page: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    };
  }

  /**
   * Spec §8.4 — Staff see the balance plus a recent-activity summary, and no ledger.
   *
   * This is a genuinely different query, not a filtered ledger: the itemized rows are
   * never fetched, so there is nothing for a response-shaping bug to leak.
   */
  async staffView(tenantId?: string): Promise<WalletStaffViewDto> {
    const id = this.resolveTenantId(tenantId, 'wallet.staffView');
    const since = new Date(Date.now() - STAFF_ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1_000);

    const [summary, grouped] = await Promise.all([
      this.summary(id),
      this.prisma.usageEvent.groupBy({
        by: ['eventType'],
        where: { tenantId: id, occurredAt: { gte: since } },
        _sum: { quantity: true, totalChargePaise: true },
      }),
    ]);

    const quantityOf = (type: UsageEventType): number =>
      grouped.find((row) => row.eventType === type)?._sum.quantity ?? 0;

    return {
      summary,
      recentActivity: {
        windowDays: STAFF_ACTIVITY_WINDOW_DAYS,
        whatsappMessages: quantityOf(UsageEventType.WHATSAPP_MESSAGE),
        emails: quantityOf(UsageEventType.EMAIL_MESSAGE),
        aiCallMinutes: quantityOf(UsageEventType.AI_CALL_MINUTE),
        totalSpend: money(sumPaise(grouped.map((row) => row._sum.totalChargePaise ?? 0n))),
      },
    };
  }

  /**
   * Create the wallet row if it is missing. Called at onboarding, and lazily by
   * `withLockedWallet`, so a tenant created outside the normal path still transacts.
   */
  async ensureWallet(tenantId: string): Promise<void> {
    try {
      await this.prisma.wallet.create({ data: { tenantId } });
    } catch (error) {
      // Two concurrent first-charges both try to create it; one loses the unique
      // index, and losing that race is the correct outcome, not an error.
      if (!isUniqueViolation(error)) throw error;
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private resolveTenantId(explicit: string | undefined, operation: string): string {
    // An explicit id is only ever passed by callers that resolved it themselves — a
    // webhook that looked up the payment, or a queue job carrying it in the payload.
    // It never comes from a request parameter; spec §4.3 is explicit about that.
    return explicit ?? this.tenantContext.requireTenantId(operation);
  }

  private availablePaise(wallet: WalletSnapshot): bigint {
    return wallet.paidPaise + wallet.freePaise - wallet.reservedPaise;
  }

  /**
   * Run `fn` holding the wallet row lock, and write the snapshot back once.
   *
   * `SELECT … FOR UPDATE` is raw SQL because Prisma has no row-lock API. Raw SQL also
   * bypasses the tenant-isolation extension, so `tenant_id` appears in the predicate
   * explicitly — the one place in the codebase where that filter is hand-written, and
   * the reason this helper exists instead of the pattern being repeated per operation.
   */
  private async withLockedWallet<T>(
    tenantId: string,
    operation: string,
    fn: (tx: PrismaTransaction, wallet: WalletSnapshot) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.runLocked(tenantId, operation, fn);
    } catch (error) {
      if (!(error instanceof WalletMissingError)) throw error;
      // Cold start for this tenant. Created in its own committed statement rather
      // than inside the transaction, so losing the create race does not abort a
      // transaction that was otherwise fine.
      await this.ensureWallet(tenantId);
      return this.runLocked(tenantId, operation, fn);
    }
  }

  private async runLocked<T>(
    tenantId: string,
    operation: string,
    fn: (tx: PrismaTransaction, wallet: WalletSnapshot) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(
      async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM wallets WHERE tenant_id = ${tenantId}::uuid FOR UPDATE
        `;
        if (locked.length === 0) throw new WalletMissingError(tenantId);

        // Re-read through the typed client so BigInt columns arrive as `bigint`
        // rather than however the driver adapter chose to render int8. The lock is
        // already held, so this sees the serialized state.
        const row = await tx.wallet.findUniqueOrThrow({ where: { id: locked[0]!.id } });
        if (row.tenantId !== tenantId) {
          // Only reachable if the extension rewrote the scope out from under us.
          // Loud, because the alternative is charging the wrong tenant.
          throw new Error(`Wallet lock/scope mismatch in ${operation}: locked ${tenantId}, read ${row.tenantId}`);
        }

        const wallet: WalletSnapshot = {
          id: row.id,
          tenantId: row.tenantId,
          paidPaise: row.balancePaise,
          freePaise: row.freeCreditBalancePaise,
          reservedPaise: row.reservedPaise,
          lifetimeCreditedPaise: row.lifetimeCreditedPaise,
          lifetimeDebitedPaise: row.lifetimeDebitedPaise,
        };
        const before = { ...wallet };

        const result = await fn(tx, wallet);

        if (
          wallet.paidPaise !== before.paidPaise ||
          wallet.freePaise !== before.freePaise ||
          wallet.reservedPaise !== before.reservedPaise ||
          wallet.lifetimeCreditedPaise !== before.lifetimeCreditedPaise ||
          wallet.lifetimeDebitedPaise !== before.lifetimeDebitedPaise
        ) {
          await tx.wallet.update({
            where: { id: wallet.id },
            data: {
              balancePaise: wallet.paidPaise,
              freeCreditBalancePaise: wallet.freePaise,
              reservedPaise: wallet.reservedPaise,
              lifetimeCreditedPaise: wallet.lifetimeCreditedPaise,
              lifetimeDebitedPaise: wallet.lifetimeDebitedPaise,
            },
          });
        }

        return result;
      },
      // Generous, because the row lock is held for the duration and a stuck
      // transaction blocks every other debit for this tenant. Read Committed is
      // sufficient: FOR UPDATE provides the serialization the balance needs.
      { timeout: 15_000, maxWait: 10_000 },
    );
  }

  /**
   * The free-then-paid split (§8.3), the availability check, and the ledger rows.
   *
   * Mutates `wallet` and appends rows; the caller's `withLockedWallet` persists the
   * balance. Nothing here is safe to call outside that lock.
   */
  private async applyDebit(
    tx: PrismaTransaction,
    wallet: WalletSnapshot,
    args: {
      amountPaise: bigint;
      description: string;
      idempotencyKey: string;
      referenceType?: string;
      referenceId?: string;
      /** How far below zero the balance may go — the §5.3 soft limit, or 0n. */
      floorPaise: bigint;
      enforceAvailability: boolean;
    },
  ): Promise<MovementResult> {
    const amount = args.amountPaise;

    if (amount === 0n) {
      // A zero charge is a real case: a 0-second call, or a channel priced at nothing
      // during a trial. Writing a 0-paise ledger row would just be noise.
      return {
        applied: true,
        fromFreePaise: 0n,
        fromPaidPaise: 0n,
        totalPaise: 0n,
        balanceAfterPaise: wallet.paidPaise + wallet.freePaise,
        transactionIds: [],
      };
    }

    if (args.enforceAvailability) {
      const available = this.availablePaise(wallet);
      if (amount > available + args.floorPaise) {
        throw new InsufficientFundsException(amount, nonNegative(available), args.description);
      }
    }

    // §8.3 — free credits are consumed before paid balance, always.
    const fromFree = wallet.freePaise >= amount ? amount : nonNegative(wallet.freePaise);
    const fromPaid = amount - fromFree;

    const transactionIds: string[] = [];
    let balanceAfterPaise = wallet.paidPaise + wallet.freePaise;

    if (fromFree > 0n) {
      wallet.freePaise -= fromFree;
      const row = await this.appendRow(tx, wallet, {
        type: WalletTransactionType.FREE_CREDIT_DEBIT,
        bucket: BalanceBucket.FREE,
        amountPaise: -fromFree,
        description: args.description,
        idempotencyKey: freeKey(args.idempotencyKey),
        referenceType: args.referenceType,
        referenceId: args.referenceId,
      });
      transactionIds.push(row.id);
      balanceAfterPaise = row.balanceAfterPaise;
    }

    if (fromPaid > 0n) {
      wallet.paidPaise -= fromPaid;
      const row = await this.appendRow(tx, wallet, {
        type: WalletTransactionType.USAGE_DEBIT,
        bucket: BalanceBucket.PAID,
        amountPaise: -fromPaid,
        description: args.description,
        idempotencyKey: paidKey(args.idempotencyKey),
        referenceType: args.referenceType,
        referenceId: args.referenceId,
      });
      transactionIds.push(row.id);
      balanceAfterPaise = row.balanceAfterPaise;
    }

    wallet.lifetimeDebitedPaise += amount;

    return {
      applied: true,
      fromFreePaise: fromFree,
      fromPaidPaise: fromPaid,
      totalPaise: amount,
      balanceAfterPaise,
      transactionIds,
    };
  }

  /**
   * Append one ledger row. `balance_after_paise` is read off the already-mutated
   * snapshot, so the ledger is self-auditing: replaying the rows in order reproduces
   * the balance, and the e2e suite asserts exactly that.
   */
  private async appendRow(
    tx: PrismaTransaction,
    wallet: WalletSnapshot,
    row: {
      type: WalletTransactionType;
      bucket: BalanceBucket;
      amountPaise: bigint;
      description: string;
      idempotencyKey: string | null;
      referenceType?: string;
      referenceId?: string;
      createdBy?: string;
    },
  ): Promise<{ id: string; balanceAfterPaise: bigint }> {
    const balanceAfterPaise = wallet.paidPaise + wallet.freePaise;

    try {
      const created = await tx.walletTransaction.create({
        data: {
          tenantId: wallet.tenantId,
          type: row.type,
          bucket: row.bucket,
          amountPaise: row.amountPaise,
          balanceAfterPaise,
          description: row.description,
          referenceType: row.referenceType ?? null,
          referenceId: row.referenceId ?? null,
          idempotencyKey: row.idempotencyKey,
          createdBy: row.createdBy ?? null,
        },
        select: { id: true },
      });
      return { id: created.id, balanceAfterPaise };
    } catch (error) {
      if (isUniqueViolation(error, 'idempotency_key')) {
        // Unreachable through the pre-check under the row lock, so if it fires the
        // lock discipline has been broken somewhere. Named as such rather than
        // swallowed, because quietly returning would hide a double-charge.
        throw new ConflictingDuplicateException(
          `Ledger row with idempotency key "${row.idempotencyKey}" already exists — ` +
            `a balance mutation ran outside the wallet row lock`,
          { idempotencyKey: row.idempotencyKey },
        );
      }
      throw error;
    }
  }

  /**
   * Look for an already-applied movement under these keys.
   *
   * Runs inside the row lock, so it is not a racy pre-check: a concurrent duplicate is
   * blocked on the lock and will see this transaction's rows once it acquires it. The
   * UNIQUE index behind it is the guarantee; this is the path that turns a duplicate
   * into "here is what happened last time" instead of an error.
   */
  private async findReplay(
    tx: PrismaTransaction,
    tenantId: string,
    keys: Array<string | null>,
  ): Promise<MovementResult | null> {
    const present = keys.filter((key): key is string => typeof key === 'string' && key.length > 0);
    if (present.length === 0) return null;

    const rows = await tx.walletTransaction.findMany({
      where: { tenantId, idempotencyKey: { in: present } },
      orderBy: { createdAt: 'asc' },
    });
    if (rows.length === 0) return null;

    const bucketTotal = (bucket: BalanceBucket): bigint =>
      sumPaise(rows.filter((r) => r.bucket === bucket).map((r) => r.amountPaise));

    const free = bucketTotal(BalanceBucket.FREE);
    const paid = bucketTotal(BalanceBucket.PAID);
    const signed = free + paid;

    return {
      applied: false,
      fromFreePaise: free < 0n ? -free : free,
      fromPaidPaise: paid < 0n ? -paid : paid,
      totalPaise: signed < 0n ? -signed : signed,
      balanceAfterPaise: rows[rows.length - 1]!.balanceAfterPaise,
      transactionIds: rows.map((r) => r.id),
    };
  }

  /** §5.3 — how far below zero this tenant's balance may go. */
  private async overdraftFloorPaise(tenantId: string): Promise<bigint> {
    const tenant = await this.tenantSettings.get(tenantId);
    if (!tenant || tenant.settings.lowBalanceBehavior !== LowBalanceBehavior.SOFT_LIMIT) return 0n;
    return toPaise(tenant.settings.softLimitPaise);
  }

  private async lowBalanceThresholdPaise(tenantId: string): Promise<bigint> {
    const tenant = await this.tenantSettings.get(tenantId);
    return tenant ? toPaise(tenant.settings.lowBalanceThresholdPaise) : 0n;
  }
}

/**
 * A debit can touch two buckets, and each ledger row holds exactly one — but
 * `(tenant_id, idempotency_key)` is UNIQUE, so the two rows cannot share a key.
 *
 * Suffixing is what keeps both rows idempotent under one caller-supplied key: the
 * replay lookup checks both derived keys, so a retried job finds whichever rows the
 * first attempt wrote. The `usage_events` row keeps the provider's raw reference, so
 * the §8.2 constraint is still literally on the provider id.
 */
function freeKey(key: string): string {
  return `${key}#free`;
}

function paidKey(key: string): string {
  return `${key}#paid`;
}

function splitKeys(key: string): string[] {
  return [freeKey(key), paidKey(key)];
}

/**
 * The charge arising from a confirmed hold gets its own key, distinct from the
 * reservation's. Sharing one would make "was this reserved" and "was this charged"
 * the same question, and a confirm retried after a crash needs to tell them apart.
 */
function reservationDebitKey(reservationKey: string): string {
  return `${reservationKey}#settled`;
}

interface WalletTransactionRow {
  id: string;
  type: string;
  bucket: string;
  amountPaise: bigint;
  balanceAfterPaise: bigint;
  description: string;
  referenceType: string | null;
  referenceId: string | null;
  createdAt: Date;
}

function toTransactionDto(row: WalletTransactionRow): WalletTransactionDto {
  return {
    id: row.id,
    type: row.type as WalletTransactionType,
    bucket: row.bucket as BalanceBucket,
    amount: money(row.amountPaise),
    balanceAfter: money(row.balanceAfterPaise),
    description: row.description,
    referenceType: row.referenceType,
    referenceId: row.referenceId,
    createdAt: row.createdAt.toISOString(),
  };
}
