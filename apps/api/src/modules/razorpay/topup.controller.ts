import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, toPaise, type CreateTopupResponse } from '@aiking/shared';

import type { RequestPrincipal } from '../../common/auth/jwt-payload';
import { CurrentUser, RequirePermission } from '../../common/decorators';
import { ValidationFailedException } from '../../common/errors/app-exception';
import { TenantAccessService } from '../../common/tenant/tenant-access.service';
import { RazorpayService } from './razorpay.service';

interface CreateTopupBody {
  amountPaise?: string;
  notes?: Record<string, string>;
}

/**
 * Wallet top-ups — spec §8.1, §8.4 ("Manager: initiate a top-up").
 *
 * Mounted under `billing` so the top-up surface sits with usage and pricing from the
 * client's point of view, while the Razorpay-specific logic stays in its own module.
 * `wallet:topup` is a Manager permission in the §4.2 matrix; Staff resolve to `deny`,
 * so this needs no role check of its own.
 */
@ApiTags('billing')
@Controller('billing')
export class TopupController {
  constructor(
    private readonly razorpay: RazorpayService,
    private readonly tenantAccess: TenantAccessService,
  ) {}

  @Post('topups')
  @RequirePermission(Permission.WALLET_TOPUP)
  @ApiOperation({ summary: 'Create a Razorpay order for a wallet top-up (spec §8.1)' })
  async create(
    @CurrentUser() principal: RequestPrincipal,
    @Body() body: CreateTopupBody,
    @Query('tenantId') tenantId?: string,
  ): Promise<CreateTopupResponse> {
    if (!body.amountPaise) {
      throw new ValidationFailedException('amountPaise is required (integer paise — ₹5,000 is "500000")');
    }

    return this.tenantAccess.asCaller(principal, tenantId ?? principal.tenantId ?? undefined, 'create top-up order', () =>
      this.razorpay.createTopup({
        amountPaise: toPaise(body.amountPaise as string),
        notes: body.notes,
        createdBy: principal.userId,
      }),
    );
  }

  /**
   * Mock mode only — stands in for the browser completing Razorpay Checkout.
   *
   * The service refuses this in live mode. It is reachable by the same permission as
   * creating the top-up, because in mock mode it *is* the rest of creating the top-up.
   */
  @Post('topups/:orderId/mock-capture')
  @RequirePermission(Permission.WALLET_TOPUP)
  @ApiOperation({ summary: 'Simulate Checkout completing (mock payments mode only)' })
  async mockCapture(
    @CurrentUser() principal: RequestPrincipal,
    @Param('orderId') orderId: string,
  ): Promise<{ razorpayPaymentId: string; duplicate: boolean }> {
    return this.tenantAccess.asCaller(principal, principal.tenantId ?? undefined, 'simulate a top-up capture', () =>
      this.razorpay.mockCapture(orderId),
    );
  }

  @Get('topups')
  @RequirePermission(Permission.WALLET_VIEW)
  @ApiOperation({ summary: 'Recent top-up orders and their payments' })
  async list(@CurrentUser() principal: RequestPrincipal, @Query('limit') limit?: string) {
    return this.tenantAccess.asCaller(principal, principal.tenantId ?? undefined, 'list top-ups', () =>
      this.razorpay.listOrders(undefined, limit ? Number(limit) : undefined),
    );
  }
}
