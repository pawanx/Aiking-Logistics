import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Permission,
  Role,
  WalletTransactionType,
  toPaise,
  type WalletLedgerDto,
  type WalletStaffViewDto,
  type WalletSummaryDto,
} from '@aiking/shared';
import type { ResolvedPermission } from '@aiking/shared';
import type { Request } from 'express';

import type { RequestPrincipal } from '../../common/auth/jwt-payload';
import { CurrentUser, RequirePermission, Roles } from '../../common/decorators';
import { ValidationFailedException } from '../../common/errors/app-exception';
import { TenantAccessService } from '../../common/tenant/tenant-access.service';
import { WalletService, type MovementResult } from './wallet.service';

/** Body of `POST /wallet/adjustments`. Amounts are integer-paise strings (§9.1). */
interface AdjustmentBody {
  tenantId?: string;
  amountPaise?: string;
  reason?: string;
  allowNegativeBalance?: boolean;
  idempotencyKey?: string;
}

/**
 * Wallet endpoints — spec §8.4.
 *
 * The Manager/Staff split is served by **one** handler reading the guard's resolved
 * decision, not by two routes. `RolesGuard` resolves `wallet:view` through the §4.2
 * matrix, where Staff's cell is `allow_limited`, and attaches the result to the
 * request. So the narrowing rule lives in the shared matrix that the web app also
 * reads, and there is no second route to forget to guard.
 */
@ApiTags('wallet')
@Controller('wallet')
export class WalletController {
  constructor(
    private readonly wallet: WalletService,
    private readonly tenantAccess: TenantAccessService,
  ) {}

  /**
   * Spec §8.4: "Manager — full itemized ledger. Staff — balance and recent activity
   * summary only."
   *
   * Staff never get the ledger query executed at all, rather than getting it filtered
   * on the way out — there is no itemized data in the response object for a shaping
   * bug to leak.
   */
  @Get()
  @RequirePermission(Permission.WALLET_VIEW)
  @ApiOperation({ summary: 'Wallet view, narrowed by role (spec §8.4)' })
  async view(
    @CurrentUser() principal: RequestPrincipal,
    @Req() request: Request & { permissionCheck?: ResolvedPermission },
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('type') type?: string,
    @Query('tenantId') tenantId?: string,
  ): Promise<WalletLedgerDto | WalletStaffViewDto> {
    const limited = request.permissionCheck?.limited === true;

    return this.tenantAccess.asCaller<WalletLedgerDto | WalletStaffViewDto>(
      principal,
      tenantId ?? principal.tenantId ?? undefined,
      'view wallet',
      () =>
        limited
          ? this.wallet.staffView()
          : this.wallet.ledger({
              page: page ? Number(page) : undefined,
              pageSize: pageSize ? Number(pageSize) : undefined,
              type: parseTransactionType(type),
            }),
    );
  }

  /** Balance only. Used by the dashboard header and the low-balance banner. */
  @Get('summary')
  @RequirePermission(Permission.WALLET_VIEW)
  @ApiOperation({ summary: 'Balance, reserved and available amounts' })
  async summary(
    @CurrentUser() principal: RequestPrincipal,
    @Query('tenantId') tenantId?: string,
  ): Promise<WalletSummaryDto> {
    return this.tenantAccess.asCaller(principal, tenantId ?? principal.tenantId ?? undefined, 'view wallet summary', () =>
      this.wallet.summary(),
    );
  }

  /**
   * Cross-tenant wallet read for the Super Admin console — §4.2
   * "View cross-tenant usage / billing".
   */
  @Get('tenants/:tenantId')
  @RequirePermission(Permission.BILLING_VIEW_CROSS_TENANT)
  @ApiOperation({ summary: 'Any tenant’s wallet (Super Admin)' })
  async forTenant(
    @CurrentUser() principal: RequestPrincipal,
    @Param('tenantId') tenantId: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<WalletLedgerDto> {
    return this.tenantAccess.asTenant(tenantId, principal, 'cross-tenant billing view', () =>
      this.wallet.ledger({ page: page ? Number(page) : undefined, pageSize: pageSize ? Number(pageSize) : undefined }),
    );
  }

  /**
   * Manual correction, Super Admin only.
   *
   * `@Roles` rather than `@RequirePermission` because the §4.2 matrix has no cell for
   * it — it is a platform operation the matrix does not model, and inventing a
   * permission would put a row in the shared matrix that the spec does not contain.
   */
  @Post('adjustments')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Append a signed correction to a tenant’s ledger' })
  async adjust(@CurrentUser() principal: RequestPrincipal, @Body() body: AdjustmentBody): Promise<MovementResult> {
    if (!body.tenantId) throw new ValidationFailedException('tenantId is required');
    if (!body.amountPaise) throw new ValidationFailedException('amountPaise is required (integer paise)');
    if (!body.reason?.trim()) throw new ValidationFailedException('reason is required — this is an audit record');

    return this.wallet.adjust({
      tenantId: body.tenantId,
      amountPaise: toPaise(body.amountPaise),
      reason: body.reason,
      createdBy: principal.userId,
      idempotencyKey: body.idempotencyKey,
      allowNegativeBalance: body.allowNegativeBalance === true,
    });
  }
}

/** Reject an unknown `?type=` rather than silently returning an unfiltered ledger. */
function parseTransactionType(value?: string): WalletTransactionType | undefined {
  if (!value) return undefined;
  const known = Object.values(WalletTransactionType) as string[];
  if (!known.includes(value)) {
    throw new ValidationFailedException(`Unknown transaction type "${value}"`, { allowed: known });
  }
  return value as WalletTransactionType;
}
