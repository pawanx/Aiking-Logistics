import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Permission,
  Role,
  UsageEventType,
  toPaise,
  type Paginated,
  type PricingRuleDto,
  type UsageEventDto,
} from '@aiking/shared';

import type { RequestPrincipal } from '../../common/auth/jwt-payload';
import { CurrentUser, RequirePermission, Roles } from '../../common/decorators';
import { ValidationFailedException } from '../../common/errors/app-exception';
import { TenantAccessService } from '../../common/tenant/tenant-access.service';
import { MeteringService } from './metering.service';
import { PricingService } from './pricing.service';

interface UpsertPricingBody {
  tenantId?: string | null;
  eventType?: string;
  unitPricePaise?: string;
  currency?: string;
  effectiveFrom?: string;
  effectiveTo?: string | null;
}

/**
 * Usage and pricing — spec §8.2, §9.3.
 *
 * The read/write split follows §4.2: a tenant Manager can *see* the rates that price
 * their invoice (`wallet:view`), and only a Super Admin can change them
 * (`platform:config`). Rates are per-tenant-overridable so a negotiated rate needs no
 * code change (§9.3 "editable without a redeploy").
 */
@ApiTags('billing')
@Controller('billing')
export class BillingController {
  constructor(
    private readonly metering: MeteringService,
    private readonly pricing: PricingService,
    private readonly tenantAccess: TenantAccessService,
  ) {}

  /** Itemized metered events — the detail behind a wallet debit. */
  @Get('usage')
  @RequirePermission(Permission.WALLET_VIEW)
  @ApiOperation({ summary: 'Metered usage events (spec §9.3 usage_events)' })
  async usage(
    @CurrentUser() principal: RequestPrincipal,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('eventType') eventType?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('tenantId') tenantId?: string,
  ): Promise<Paginated<UsageEventDto>> {
    return this.tenantAccess.asCaller(principal, tenantId ?? principal.tenantId ?? undefined, 'list usage events', () =>
      this.metering.listUsage({
        page: page ? Number(page) : undefined,
        pageSize: pageSize ? Number(pageSize) : undefined,
        eventType: parseUsageEventType(eventType),
        from: parseDate(from, 'from'),
        to: parseDate(to, 'to'),
      }),
    );
  }

  /** The rates in force for the caller's tenant, plus the platform defaults. */
  @Get('pricing')
  @RequirePermission(Permission.WALLET_VIEW)
  @ApiOperation({ summary: 'Pricing rules applying to this tenant' })
  async pricingRules(
    @CurrentUser() principal: RequestPrincipal,
    @Query('tenantId') tenantId?: string,
  ): Promise<PricingRuleDto[]> {
    const target = tenantId ?? principal.tenantId ?? undefined;
    return this.tenantAccess.asCaller(principal, target, 'list pricing rules', () => this.pricing.list(target ?? null));
  }

  /**
   * Effective unit prices as three resolved numbers, with the reason each won.
   * The dashboard uses this to show a campaign estimate before launch (§8.2).
   */
  @Get('pricing/effective')
  @RequirePermission(Permission.WALLET_VIEW)
  @ApiOperation({ summary: 'Resolved unit price per metered unit' })
  async effectivePricing(@CurrentUser() principal: RequestPrincipal, @Query('tenantId') tenantId?: string) {
    return this.tenantAccess.asCaller(
      principal,
      tenantId ?? principal.tenantId ?? undefined,
      'resolve effective pricing',
      async () => {
        const resolved = await this.pricing.resolveAll();
        return Object.fromEntries(
          Object.entries(resolved).map(([eventType, price]) => [
            eventType,
            {
              unitPricePaise: price.unitPricePaise.toString(),
              currency: price.currency,
              source: price.source,
              ruleId: price.ruleId,
            },
          ]),
        );
      },
    );
  }

  /**
   * Set a rate. Super Admin only.
   *
   * `@Roles` rather than a permission because `platform:config` is Super-Admin-only in
   * the §4.2 matrix anyway, and this route also accepts a `tenantId` in the body —
   * which `TenantGuard` would otherwise read as a cross-tenant claim. Naming the role
   * keeps the intent obvious at the route.
   */
  @Post('pricing')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Create or supersede a pricing rule (Super Admin)' })
  async upsertPricing(
    @CurrentUser() principal: RequestPrincipal,
    @Body() body: UpsertPricingBody,
  ): Promise<PricingRuleDto> {
    const eventType = parseUsageEventType(body.eventType);
    if (!eventType) {
      throw new ValidationFailedException('eventType is required', {
        allowed: Object.values(UsageEventType),
      });
    }
    if (!body.unitPricePaise) {
      throw new ValidationFailedException('unitPricePaise is required (integer paise)');
    }

    return this.pricing.upsert({
      tenantId: body.tenantId ?? null,
      eventType,
      unitPricePaise: toPaise(body.unitPricePaise),
      currency: body.currency,
      effectiveFrom: parseDate(body.effectiveFrom, 'effectiveFrom'),
      effectiveTo: parseDate(body.effectiveTo ?? undefined, 'effectiveTo') ?? null,
      createdBy: principal.userId,
    });
  }

  /** Retire a rule. Deactivation, never deletion — past charges stay explainable. */
  @Delete('pricing/:ruleId')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Deactivate a pricing rule (Super Admin)' })
  async deactivatePricing(@Param('ruleId') ruleId: string): Promise<PricingRuleDto> {
    return this.pricing.deactivate(ruleId);
  }
}

function parseUsageEventType(value?: string): UsageEventType | undefined {
  if (!value) return undefined;
  const known = Object.values(UsageEventType) as string[];
  if (!known.includes(value)) {
    throw new ValidationFailedException(`Unknown usage event type "${value}"`, { allowed: known });
  }
  return value as UsageEventType;
}

function parseDate(value: string | undefined, field: string): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationFailedException(`${field} must be an ISO 8601 date`, { [field]: value });
  }
  return parsed;
}
