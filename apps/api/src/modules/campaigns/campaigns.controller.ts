import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CampaignStatus,
  Channel,
  Permission,
  RecipientStatus,
  type CampaignDto,
  type CampaignRecipientDto,
  type CreateCampaignRequest,
  type LaunchCampaignResponse,
  type Paginated,
} from '@aiking/shared';

import type { RequestPrincipal } from '../../common/auth/jwt-payload';
import { CurrentUser, RequirePermission } from '../../common/decorators';
import { ValidationFailedException } from '../../common/errors/app-exception';
import { TenantAccessService } from '../../common/tenant/tenant-access.service';
import { CampaignsService } from './campaigns.service';

interface CancelBody {
  reason?: string;
}

/**
 * Campaigns — spec §6.1, §6.2.
 *
 * Every route is gated on `campaigns:launch`, which the §4.2 matrix resolves as
 * `allow` for Manager and `tenant_policy` for Staff — so whether Staff can launch is the
 * tenant's `staffCanLaunchCampaigns` setting, resolved in `RolesGuard`, rather than a
 * decision hard-coded here. That is §4.4's open item expressed as configuration.
 */
@ApiTags('campaigns')
@Controller('campaigns')
export class CampaignsController {
  constructor(
    private readonly campaigns: CampaignsService,
    private readonly tenantAccess: TenantAccessService,
  ) {}

  @Get()
  @RequirePermission(Permission.CAMPAIGNS_LAUNCH)
  @ApiOperation({ summary: 'List campaigns with per-recipient counters' })
  async list(
    @CurrentUser() principal: RequestPrincipal,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: string,
    @Query('channel') channel?: string,
    @Query('tenantId') tenantId?: string,
  ): Promise<Paginated<CampaignDto>> {
    return this.tenantAccess.asCaller(principal, tenantId ?? principal.tenantId ?? undefined, 'list campaigns', () =>
      this.campaigns.list({
        page: page ? Number(page) : undefined,
        pageSize: pageSize ? Number(pageSize) : undefined,
        status: parseEnum(CampaignStatus, status, 'campaign status'),
        channel: parseEnum(Channel, channel, 'channel'),
      }),
    );
  }

  @Post()
  @RequirePermission(Permission.CAMPAIGNS_LAUNCH)
  @ApiOperation({ summary: 'Create a campaign draft' })
  async create(
    @CurrentUser() principal: RequestPrincipal,
    @Body() body: CreateCampaignRequest,
    @Query('tenantId') tenantId?: string,
  ): Promise<CampaignDto> {
    return this.tenantAccess.asCaller(principal, tenantId ?? principal.tenantId ?? undefined, 'create a campaign', () =>
      this.campaigns.create(body, principal.userId),
    );
  }

  @Get(':campaignId')
  @RequirePermission(Permission.CAMPAIGNS_LAUNCH)
  @ApiOperation({ summary: 'One campaign' })
  async get(
    @CurrentUser() principal: RequestPrincipal,
    @Param('campaignId') campaignId: string,
    @Query('tenantId') tenantId?: string,
  ): Promise<CampaignDto> {
    return this.tenantAccess.asCaller(principal, tenantId ?? principal.tenantId ?? undefined, 'read a campaign', () =>
      this.campaigns.get(campaignId),
    );
  }

  @Get(':campaignId/recipients')
  @RequirePermission(Permission.CAMPAIGNS_LAUNCH)
  @ApiOperation({ summary: 'Per-recipient results, including skip reasons (spec §6.1)' })
  async recipients(
    @CurrentUser() principal: RequestPrincipal,
    @Param('campaignId') campaignId: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: string,
    @Query('tenantId') tenantId?: string,
  ): Promise<Paginated<CampaignRecipientDto>> {
    return this.tenantAccess.asCaller(
      principal,
      tenantId ?? principal.tenantId ?? undefined,
      'read campaign recipients',
      () =>
        this.campaigns.recipients(campaignId, {
          page: page ? Number(page) : undefined,
          pageSize: pageSize ? Number(pageSize) : undefined,
          status: parseEnum(RecipientStatus, status, 'recipient status'),
        }),
    );
  }

  /**
   * Launch — spec §6.1, §8.2.
   *
   * The body is optional: a draft created with an audience already selected launches
   * with an empty body, and passing one overrides the stored selection. Responds 200
   * with `insufficientFunds` rather than an error status when the balance is short —
   * the dashboard needs the shortfall to render the top-up prompt (§8.2), and this is
   * a refusal to spend rather than a failure to process.
   */
  @Post(':campaignId/launch')
  @RequirePermission(Permission.CAMPAIGNS_LAUNCH)
  @ApiOperation({ summary: 'Launch a campaign (refuses with a shortfall if the wallet is short)' })
  async launch(
    @CurrentUser() principal: RequestPrincipal,
    @Param('campaignId') campaignId: string,
    @Body() body?: CreateCampaignRequest,
    @Query('tenantId') tenantId?: string,
  ): Promise<LaunchCampaignResponse> {
    return this.tenantAccess.asCaller(principal, tenantId ?? principal.tenantId ?? undefined, 'launch a campaign', () =>
      this.campaigns.launch(campaignId, body && (body.contactIds || body.filter) ? body : undefined),
    );
  }

  @Post(':campaignId/resume')
  @RequirePermission(Permission.CAMPAIGNS_LAUNCH)
  @ApiOperation({ summary: 'Resume a campaign halted for funds, after a top-up (spec §8.2)' })
  async resume(
    @CurrentUser() principal: RequestPrincipal,
    @Param('campaignId') campaignId: string,
    @Query('tenantId') tenantId?: string,
  ): Promise<LaunchCampaignResponse> {
    return this.tenantAccess.asCaller(principal, tenantId ?? principal.tenantId ?? undefined, 'resume a campaign', () =>
      this.campaigns.resume(campaignId),
    );
  }

  @Post(':campaignId/cancel')
  @RequirePermission(Permission.CAMPAIGNS_LAUNCH)
  @ApiOperation({ summary: 'Cancel a campaign — stops what has not been sent yet' })
  async cancel(
    @CurrentUser() principal: RequestPrincipal,
    @Param('campaignId') campaignId: string,
    @Body() body: CancelBody,
    @Query('tenantId') tenantId?: string,
  ): Promise<CampaignDto> {
    return this.tenantAccess.asCaller(principal, tenantId ?? principal.tenantId ?? undefined, 'cancel a campaign', () =>
      this.campaigns.cancel(campaignId, body?.reason?.trim() || 'cancelled by the tenant'),
    );
  }
}

/** Validate a query-string enum, naming the allowed values in the error. */
function parseEnum<T extends Record<string, string>>(
  values: T,
  raw: string | undefined,
  label: string,
): T[keyof T] | undefined {
  if (!raw) return undefined;
  const allowed = Object.values(values);
  if (!allowed.includes(raw)) {
    throw new ValidationFailedException(`Unknown ${label} "${raw}"`, { allowed });
  }
  return raw as T[keyof T];
}
