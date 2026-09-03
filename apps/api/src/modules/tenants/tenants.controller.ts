import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Permission,
  Role,
  type OnboardTenantRequest,
  type OnboardTenantResponse,
  type TenantDto,
  type TenantSettings,
} from '@aiking/shared';

import type { RequestPrincipal } from '../../common/auth/jwt-payload';
import { CurrentUser, RequirePermission, Roles } from '../../common/decorators';
import { NotFoundException, ValidationFailedException } from '../../common/errors/app-exception';
import { TenantsService } from './tenants.service';

interface SuspendBody {
  reason?: string;
}

interface SendingIdentityBody {
  emailFromName?: string;
  emailFromAddress?: string;
  whatsappPhoneNumberId?: string;
}

/**
 * Tenant administration — spec §4.2.
 *
 * Split deliberately into two groups of routes:
 *
 *   - `/tenants` and `/tenants/:id/*` — Super Admin only. Onboarding, suspension.
 *   - `/tenants/current/*`            — the caller's *own* tenant, for a Manager.
 *
 * `current` rather than an id in the path is the §4.3 rule made structural: there is no
 * route on which a Manager names a tenant, so there is no route on which one could name
 * someone else's.
 */
@ApiTags('tenants')
@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  // ── Super Admin (spec §4.2) ─────────────────────────────────────────────────

  @Post()
  @RequirePermission(Permission.TENANT_ONBOARD)
  @ApiOperation({ summary: 'Onboard a tenant company with its first Manager (spec §4.2, §8.3)' })
  async onboard(
    @CurrentUser() principal: RequestPrincipal,
    @Body() body: OnboardTenantRequest,
  ): Promise<OnboardTenantResponse> {
    return this.tenants.onboard(body, principal.userId);
  }

  @Get()
  @RequirePermission(Permission.BILLING_VIEW_CROSS_TENANT)
  @ApiOperation({ summary: 'All tenants with wallet balances (Super Admin)' })
  async list(@CurrentUser() principal: RequestPrincipal): Promise<TenantDto[]> {
    return this.tenants.list(principal.email);
  }

  /**
   * The caller's own tenant.
   *
   * Declared before `:tenantId` because Nest matches routes in declaration order — the
   * dynamic segment would otherwise swallow the literal `current` and look up a tenant
   * whose id is the string "current".
   */
  @Get('current')
  @Roles(Role.MANAGER, Role.STAFF)
  @ApiOperation({ summary: "The caller's own tenant, including its §4.4 policy settings" })
  async current(@CurrentUser() principal: RequestPrincipal): Promise<TenantDto> {
    if (!principal.tenantId) {
      throw new NotFoundException('Tenant', '(this session has no tenant scope)');
    }
    return this.tenants.describe(principal.tenantId);
  }

  /**
   * Change the §4.4 / §5.3 policy settings for the caller's own tenant.
   *
   * A Manager may set these because they are the person the spec makes accountable for
   * the wallet: §4.2 gives them top-up rights and the itemized ledger, so deciding
   * whether Staff may spend it belongs to the same role.
   */
  @Patch('current/settings')
  @Roles(Role.MANAGER)
  @ApiOperation({ summary: 'Resolve the §4.4 / §5.3 open items for your tenant' })
  async updateOwnSettings(
    @CurrentUser() principal: RequestPrincipal,
    @Body() body: Partial<TenantSettings>,
  ): Promise<TenantDto> {
    if (!principal.tenantId) {
      throw new NotFoundException('Tenant', '(this session has no tenant scope)');
    }
    return this.tenants.updateSettings(principal.tenantId, body, principal.email);
  }

  /** The tenant's own sending identity — spec §6.2. */
  @Patch('current/sending-identity')
  @Roles(Role.MANAGER)
  @ApiOperation({ summary: 'Set the tenant’s email/WhatsApp sending identity (spec §6.2)' })
  async updateSendingIdentity(
    @CurrentUser() principal: RequestPrincipal,
    @Body() body: SendingIdentityBody,
  ): Promise<TenantDto> {
    if (!principal.tenantId) {
      throw new NotFoundException('Tenant', '(this session has no tenant scope)');
    }
    return this.tenants.updateSendingIdentity(principal.tenantId, body);
  }

  @Get(':tenantId')
  @RequirePermission(Permission.BILLING_VIEW_CROSS_TENANT)
  @ApiOperation({ summary: 'One tenant by id (Super Admin)' })
  async describe(@Param('tenantId') tenantId: string): Promise<TenantDto> {
    return this.tenants.describe(tenantId);
  }

  @Post(':tenantId/suspend')
  @RequirePermission(Permission.TENANT_SUSPEND)
  @ApiOperation({ summary: 'Suspend a tenant — blocks all access, keeps all data' })
  async suspend(
    @CurrentUser() principal: RequestPrincipal,
    @Param('tenantId') tenantId: string,
    @Body() body: SuspendBody,
  ): Promise<TenantDto> {
    if (!body.reason?.trim()) {
      throw new ValidationFailedException('A suspension reason is required');
    }
    return this.tenants.suspend({ tenantId, reason: body.reason, actorEmail: principal.email });
  }

  @Post(':tenantId/resume')
  @RequirePermission(Permission.TENANT_SUSPEND)
  @ApiOperation({ summary: 'Reactivate a suspended tenant' })
  async resume(
    @CurrentUser() principal: RequestPrincipal,
    @Param('tenantId') tenantId: string,
  ): Promise<TenantDto> {
    return this.tenants.resume(tenantId, principal.email);
  }

  /** Super Admin override of a tenant's §4.4 settings, for support. */
  @Patch(':tenantId/settings')
  @RequirePermission(Permission.PLATFORM_CONFIG)
  @ApiOperation({ summary: "Change a tenant's policy settings (Super Admin)" })
  async updateSettings(
    @CurrentUser() principal: RequestPrincipal,
    @Param('tenantId') tenantId: string,
    @Body() body: Partial<TenantSettings>,
  ): Promise<TenantDto> {
    return this.tenants.updateSettings(tenantId, body, principal.email);
  }
}
