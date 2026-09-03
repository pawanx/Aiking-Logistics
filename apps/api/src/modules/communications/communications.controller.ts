import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Channel,
  Permission,
  type CommunicationEventDto,
  type ContactTimelineDto,
  type Paginated,
} from '@aiking/shared';

import type { RequestPrincipal } from '../../common/auth/jwt-payload';
import { CurrentUser, RequirePermission } from '../../common/decorators';
import { ValidationFailedException } from '../../common/errors/app-exception';
import { TenantAccessService } from '../../common/tenant/tenant-access.service';
import { CommunicationsService } from './communications.service';

/**
 * The 360° timeline — spec §6.4.
 *
 * Two reads off one table: the whole tenant's activity, and one contact's history
 * across all three channels. Both are gated on `timeline:view`, which §4.2 grants to
 * Manager and Staff alike — a staff member handling a customer needs to see what that
 * customer has already been told, and withholding it would just produce a worse
 * conversation.
 */
@ApiTags('timeline')
@Controller('timeline')
export class CommunicationsController {
  constructor(
    private readonly communications: CommunicationsService,
    private readonly tenantAccess: TenantAccessService,
  ) {}

  @Get()
  @RequirePermission(Permission.TIMELINE_VIEW)
  @ApiOperation({ summary: 'Tenant-wide activity feed, newest first' })
  async feed(
    @CurrentUser() principal: RequestPrincipal,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('channel') channel?: string,
    @Query('contactId') contactId?: string,
    @Query('tenantId') tenantId?: string,
  ): Promise<Paginated<CommunicationEventDto>> {
    return this.tenantAccess.asCaller(
      principal,
      tenantId ?? principal.tenantId ?? undefined,
      'read the activity feed',
      () =>
        this.communications.feed({
          page: page ? Number(page) : undefined,
          pageSize: pageSize ? Number(pageSize) : undefined,
          channel: parseChannel(channel),
          contactId,
        }),
    );
  }

  /** Literal segment before any dynamic one — Nest matches in declaration order. */
  @Get('contact/:contactId')
  @RequirePermission(Permission.TIMELINE_VIEW)
  @ApiOperation({ summary: 'One contact, every channel — the 360° view (spec §6.4)' })
  async timeline(
    @CurrentUser() principal: RequestPrincipal,
    @Param('contactId') contactId: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('channel') channel?: string,
    @Query('tenantId') tenantId?: string,
  ): Promise<ContactTimelineDto> {
    return this.tenantAccess.asCaller(
      principal,
      tenantId ?? principal.tenantId ?? undefined,
      `read the timeline for contact ${contactId}`,
      () =>
        this.communications.timeline(contactId, {
          page: page ? Number(page) : undefined,
          pageSize: pageSize ? Number(pageSize) : undefined,
          channel: parseChannel(channel),
        }),
    );
  }
}

function parseChannel(value?: string): Channel | undefined {
  if (!value) return undefined;
  const known = Object.values(Channel) as string[];
  if (!known.includes(value)) {
    throw new ValidationFailedException(`Unknown channel "${value}"`, { allowed: known });
  }
  return value as Channel;
}
