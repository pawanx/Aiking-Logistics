import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  UsageEventType,
  money,
  toPaise,
  type PricingRuleDto,
} from '@aiking/shared';

import { CONFIG, type AppConfig } from '../../config/configuration';
import { NotFoundException, ValidationFailedException } from '../../common/errors/app-exception';
import { PRISMA, type ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { TenantContext } from '../../common/tenant/tenant-context';

/** A resolved unit price plus where it came from — the "why" the invoice needs. */
export interface ResolvedPrice {
  eventType: UsageEventType;
  unitPricePaise: bigint;
  currency: string;
  /** Which rule won: a tenant override, the platform default, or the env fallback. */
  source: 'tenant_override' | 'platform_default' | 'environment_default';
  /** Null for the environment fallback, which has no row. */
  ruleId: string | null;
}

export interface UpsertPricingRuleInput {
  /** Null or omitted creates/updates the platform default (spec §9.3). */
  tenantId?: string | null;
  eventType: UsageEventType;
  unitPricePaise: bigint;
  currency?: string;
  effectiveFrom?: Date;
  effectiveTo?: Date | null;
  createdBy: string;
}

interface CacheEntry {
  price: ResolvedPrice;
  expiresAt: number;
}

/**
 * Pricing lookups happen on every metered event, so they are cached — but only
 * briefly. A Super Admin editing a rate expects it to take effect without a
 * redeploy (spec §9.3), and five seconds of staleness is the price of not hitting
 * Postgres twice per WhatsApp message in a 500-recipient campaign.
 */
const CACHE_TTL_MS = 5_000;

/**
 * Resolves what a metered unit costs — spec §8.2, §9.3 `pricing_rules`.
 *
 * Three layers, most specific first:
 *
 * 1. a rule with this tenant's `tenant_id` — a negotiated rate;
 * 2. a rule with `tenant_id = NULL` — the platform default;
 * 3. the `PRICE_*_PAISE` environment values, so a fresh database with no
 *    `pricing_rules` rows still bills correctly rather than charging zero.
 *
 * Layer 3 matters more than it looks: silently pricing at 0 would let a
 * misconfigured deployment give the service away, and the failure would only be
 * visible in a revenue report weeks later.
 *
 * `PricingRule` is deliberately **not** in `TENANT_SCOPED_MODELS`, because for this
 * one table `tenant_id IS NULL` is meaningful data rather than an unscoped query.
 * That means the tenant filter here is written by hand — the `tenantId: { in: [...] }`
 * predicate below is the whole point of the exclusion, and it is why every read in
 * this file names its tenant explicitly.
 */
@Injectable()
export class PricingService {
  private readonly logger = new Logger(PricingService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    @Inject(PRISMA) private readonly prisma: ExtendedPrismaClient,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly tenantContext: TenantContext,
  ) {}

  /** Environment fallback for an event type (layer 3). */
  private environmentPricePaise(eventType: UsageEventType): bigint {
    switch (eventType) {
      case UsageEventType.WHATSAPP_MESSAGE:
        return this.config.billing.whatsappMessagePaise;
      case UsageEventType.EMAIL_MESSAGE:
        return this.config.billing.emailMessagePaise;
      case UsageEventType.AI_CALL_MINUTE:
        return this.config.billing.aiCallMinutePaise;
      default: {
        // Exhaustiveness: adding a UsageEventType without a price here is a compile
        // error, not a runtime zero-rate.
        const unreachable: never = eventType;
        throw new Error(`No environment price configured for usage type "${String(unreachable)}"`);
      }
    }
  }

  /**
   * The price to charge, for a tenant, at a moment in time.
   *
   * `at` exists because a call is metered when it *ends*, which may be after a rate
   * change started. Billing the rate that was in force when the usage occurred is
   * what makes a re-run of the metering job reproduce the same charge.
   */
  async resolve(eventType: UsageEventType, tenantId?: string, at: Date = new Date()): Promise<ResolvedPrice> {
    const id = tenantId ?? this.tenantContext.requireTenantId('pricing.resolve');
    const cacheKey = `${id}:${eventType}`;

    // Only "now" lookups are cached. A historical `at` is rare and must be exact.
    const isNow = Math.abs(at.getTime() - Date.now()) < 1_000;
    if (isNow) {
      const hit = this.cache.get(cacheKey);
      if (hit && hit.expiresAt > Date.now()) return hit.price;
    }

    const rules = await this.prisma.pricingRule.findMany({
      where: {
        // `null` is a legitimate value here, so this cannot be left to the tenant
        // extension — it would have rewritten NULL away and lost the default.
        // Written as an AND of two ORs because Prisma's nullable-uuid `in` filter
        // does not accept null as a member.
        AND: [
          { OR: [{ tenantId: id }, { tenantId: null }] },
          { OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }] },
        ],
        eventType,
        active: true,
        effectiveFrom: { lte: at },
      },
      // A tenant override sorts before the platform default because NULLs sort last
      // under DESC in Postgres; the newest effective_from wins within each layer.
      orderBy: [{ tenantId: 'desc' }, { effectiveFrom: 'desc' }],
    });

    const override = rules.find((rule) => rule.tenantId === id);
    const platform = rules.find((rule) => rule.tenantId === null);
    const winner = override ?? platform;

    const price: ResolvedPrice = winner
      ? {
          eventType,
          unitPricePaise: winner.unitPricePaise,
          currency: winner.currency,
          source: winner.tenantId ? 'tenant_override' : 'platform_default',
          ruleId: winner.id,
        }
      : {
          eventType,
          unitPricePaise: this.environmentPricePaise(eventType),
          currency: this.config.razorpay.currency,
          source: 'environment_default',
          ruleId: null,
        };

    if (isNow) this.cache.set(cacheKey, { price, expiresAt: Date.now() + CACHE_TTL_MS });
    return price;
  }

  /** All three unit prices at once, for a campaign estimate or a pricing screen. */
  async resolveAll(tenantId?: string): Promise<Record<UsageEventType, ResolvedPrice>> {
    const id = tenantId ?? this.tenantContext.requireTenantId('pricing.resolveAll');
    const types = Object.values(UsageEventType);
    const resolved = await Promise.all(types.map((type) => this.resolve(type, id)));
    return Object.fromEntries(types.map((type, index) => [type, resolved[index]!])) as Record<
      UsageEventType,
      ResolvedPrice
    >;
  }

  /** What `quantity` units cost right now. Integer arithmetic throughout (§9.1). */
  async quote(
    eventType: UsageEventType,
    quantity: number,
    tenantId?: string,
  ): Promise<{ unitPricePaise: bigint; quantity: number; totalPaise: bigint }> {
    if (!Number.isInteger(quantity) || quantity < 0) {
      throw new ValidationFailedException('Quantity must be a non-negative integer', { quantity });
    }
    const price = await this.resolve(eventType, tenantId);
    return {
      unitPricePaise: price.unitPricePaise,
      quantity,
      totalPaise: price.unitPricePaise * BigInt(quantity),
    };
  }

  // ── Administration (spec §9.3 — "editable without a redeploy") ──────────────

  /**
   * List rules visible to the caller.
   *
   * A tenant Manager sees their own overrides plus the platform defaults that apply
   * to them, because a rate they cannot see is a rate they cannot reconcile their
   * invoice against. They cannot *edit* either — that is `platform:config`.
   */
  async list(tenantId?: string | null, includePlatformDefaults = true): Promise<PricingRuleDto[]> {
    const scopes: Array<{ tenantId: string | null }> = [];
    if (tenantId !== undefined && tenantId !== null) scopes.push({ tenantId });
    if (includePlatformDefaults) scopes.push({ tenantId: null });

    const rules = await this.prisma.pricingRule.findMany({
      where: scopes.length ? { OR: scopes } : {},
      orderBy: [{ eventType: 'asc' }, { tenantId: 'desc' }, { effectiveFrom: 'desc' }],
    });

    return rules.map(toPricingRuleDto);
  }

  /**
   * Introduce a new rate.
   *
   * Existing rules are **closed off** rather than edited: the old row gets
   * `effective_to = now` and stays, so a historical charge can still be explained by
   * the rule that produced it. Same reasoning as the append-only wallet ledger — a
   * billing dispute six months out needs the rate that was in force, not the rate
   * that is.
   */
  async upsert(input: UpsertPricingRuleInput): Promise<PricingRuleDto> {
    if (input.unitPricePaise < 0n) {
      throw new ValidationFailedException('A unit price cannot be negative', {
        unitPricePaise: input.unitPricePaise.toString(),
      });
    }

    const tenantId = input.tenantId ?? null;
    const effectiveFrom = input.effectiveFrom ?? new Date();

    if (tenantId) {
      const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
      if (!tenant) throw new NotFoundException('Tenant', tenantId);
    }

    const created = await this.prisma.$transaction(async (tx) => {
      await tx.pricingRule.updateMany({
        where: { tenantId, eventType: input.eventType, active: true, effectiveTo: null },
        data: { effectiveTo: effectiveFrom, active: false },
      });

      return tx.pricingRule.create({
        data: {
          tenantId,
          eventType: input.eventType,
          unitPricePaise: input.unitPricePaise,
          currency: input.currency ?? this.config.razorpay.currency,
          effectiveFrom,
          effectiveTo: input.effectiveTo ?? null,
          active: true,
          createdBy: input.createdBy,
        },
      });
    });

    this.invalidate();
    this.logger.log(
      `Pricing rule for ${input.eventType} set to ${input.unitPricePaise}p ` +
        `(${tenantId ? `tenant ${tenantId}` : 'platform default'}) by ${input.createdBy}`,
    );

    return toPricingRuleDto(created);
  }

  /**
   * Retire a rule. Deactivation, not deletion — the rows that priced past usage stay
   * readable.
   */
  async deactivate(ruleId: string): Promise<PricingRuleDto> {
    const rule = await this.prisma.pricingRule.findUnique({ where: { id: ruleId } });
    if (!rule) throw new NotFoundException('PricingRule', ruleId);

    const updated = await this.prisma.pricingRule.update({
      where: { id: ruleId },
      data: { active: false, effectiveTo: rule.effectiveTo ?? new Date() },
    });

    this.invalidate();
    return toPricingRuleDto(updated);
  }

  /** Drop the cache. Called after any write, and by tests between cases. */
  invalidate(): void {
    this.cache.clear();
  }
}

interface PricingRuleRow {
  id: string;
  tenantId: string | null;
  eventType: string;
  unitPricePaise: bigint;
  currency: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  active: boolean;
}

function toPricingRuleDto(row: PricingRuleRow): PricingRuleDto {
  return {
    id: row.id,
    tenantId: row.tenantId,
    eventType: row.eventType as UsageEventType,
    unitPrice: money(toPaise(row.unitPricePaise)),
    currency: row.currency,
    effectiveFrom: row.effectiveFrom.toISOString(),
    effectiveTo: row.effectiveTo?.toISOString() ?? null,
    active: row.active,
  };
}
