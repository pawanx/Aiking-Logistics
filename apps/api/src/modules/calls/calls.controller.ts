import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CallOutcome,
  CallStatus,
  Permission,
  type CallDto,
  type Paginated,
  type PlaceCallRequest,
} from '@aiking/shared';

import type { RequestPrincipal } from '../../common/auth/jwt-payload';
import { CurrentUser, RequirePermission } from '../../common/decorators';
import { ValidationFailedException } from '../../common/errors/app-exception';
import { TenantAccessService } from '../../common/tenant/tenant-access.service';
import { CallsService } from './calls.service';

/**
 * AI calling — spec §5.
 *
 * Every route is gated on `calls:trigger`, which §4.2 gives to Manager outright and to
 * Staff only when the tenant has enabled it — the §4.4 open item, resolved by
 * `RolesGuard` against the tenant setting rather than guessed here.
 *
 * Read and write share one permission because the matrix does: the spec's row is
 * "Trigger / monitor AI calling", one cell. Splitting it into view-vs-trigger would be
 * inventing a distinction the spec does not make, and would leave Staff at a tenant
 * with calling disabled unable to see the calls they are handling the follow-ups for.
 */
@ApiTags('calls')
@Controller('calls')
export class CallsController {
  constructor(
    private readonly calls: CallsService,
    private readonly tenantAccess: TenantAccessService,
  ) {}

  @Get()
  @RequirePermission(Permission.CALLS_TRIGGER)
  @ApiOperation({ summary: 'List calls, newest first' })
  async list(
    @CurrentUser() principal: RequestPrincipal,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: string,
    @Query('outcome') outcome?: string,
    @Query('contactId') contactId?: string,
    @Query('tenantId') tenantId?: string,
  ): Promise<Paginated<CallDto>> {
    return this.tenantAccess.asCaller(principal, tenantId ?? principal.tenantId ?? undefined, 'list calls', () =>
      this.calls.list({
        page: page ? Number(page) : undefined,
        pageSize: pageSize ? Number(pageSize) : undefined,
        status: parseEnum('status', status, CallStatus),
        outcome: parseEnum('outcome', outcome, CallOutcome),
        contactId,
      }),
    );
  }

  @Post()
  @RequirePermission(Permission.CALLS_TRIGGER)
  @ApiOperation({ summary: 'Queue an outbound AI call (spec §5.1)' })
  async place(
    @CurrentUser() principal: RequestPrincipal,
    @Body() body: PlaceCallRequest,
    @Query('tenantId') tenantId?: string,
  ): Promise<CallDto> {
    if (!body?.contactId) {
      throw new ValidationFailedException('contactId is required to place a call');
    }

    return this.tenantAccess.asCaller(
      principal,
      tenantId ?? principal.tenantId ?? undefined,
      `place an AI call to contact ${body.contactId}`,
      () => this.calls.place(body, principal.userId),
    );
  }

  @Get(':callId')
  @RequirePermission(Permission.CALLS_TRIGGER)
  @ApiOperation({ summary: 'One call with its transcript, summary and next action' })
  async get(
    @CurrentUser() principal: RequestPrincipal,
    @Param('callId') callId: string,
    @Query('tenantId') tenantId?: string,
  ): Promise<CallDto> {
    return this.tenantAccess.asCaller(
      principal,
      tenantId ?? principal.tenantId ?? undefined,
      `read call ${callId}`,
      () => this.calls.get(callId),
    );
  }

  /**
   * A time-limited link to the recording — spec §10.
   *
   * Returns a URL rather than the audio itself, so the bytes come straight from S3 and
   * never through the API. The link expires, and issuing one is logged.
   */
  @Get(':callId/recording')
  @RequirePermission(Permission.CALLS_TRIGGER)
  @ApiOperation({ summary: 'Signed, expiring URL for the call recording (spec §10)' })
  async recording(
    @CurrentUser() principal: RequestPrincipal,
    @Param('callId') callId: string,
    @Query('tenantId') tenantId?: string,
  ): Promise<{ url: string; expiresInSeconds: number }> {
    return this.tenantAccess.asCaller(
      principal,
      tenantId ?? principal.tenantId ?? undefined,
      `access the recording for call ${callId}`,
      () => this.calls.recordingUrl(callId, principal.email),
    );
  }

  /** Spec §5.2 — hand the conversation to a human. */
  @Post(':callId/escalate')
  @RequirePermission(Permission.CALLS_TRIGGER)
  @ApiOperation({ summary: 'Escalate a call to a human (spec §5.2)' })
  async escalate(
    @CurrentUser() principal: RequestPrincipal,
    @Param('callId') callId: string,
    @Body() body: { reason?: string },
    @Query('tenantId') tenantId?: string,
  ): Promise<CallDto> {
    const reason = body?.reason?.trim();
    if (!reason) {
      // The reason is the whole value of the record. An escalation with no stated cause
      // tells the person picking it up nothing they did not already know.
      throw new ValidationFailedException('A reason is required when escalating a call');
    }

    return this.tenantAccess.asCaller(
      principal,
      tenantId ?? principal.tenantId ?? undefined,
      `escalate call ${callId}`,
      () => this.calls.escalate(callId, reason),
    );
  }

  @Post(':callId/hangup')
  @RequirePermission(Permission.CALLS_TRIGGER)
  @ApiOperation({ summary: 'End a call that is in progress' })
  async hangup(
    @CurrentUser() principal: RequestPrincipal,
    @Param('callId') callId: string,
    @Query('tenantId') tenantId?: string,
  ): Promise<CallDto> {
    return this.tenantAccess.asCaller(
      principal,
      tenantId ?? principal.tenantId ?? undefined,
      `hang up call ${callId}`,
      () => this.calls.hangup(callId),
    );
  }
}

/**
 * Validate a query-string enum.
 *
 * An unknown value is rejected rather than ignored: silently dropping
 * `?status=complete` would return every call and look like the filter worked.
 */
function parseEnum<T extends Record<string, string>>(
  field: string,
  value: string | undefined,
  allowed: T,
): T[keyof T] | undefined {
  if (!value) return undefined;
  const values = Object.values(allowed);
  if (!values.includes(value)) {
    throw new ValidationFailedException(`Unknown ${field} "${value}"`, { allowed: values });
  }
  return value as T[keyof T];
}
