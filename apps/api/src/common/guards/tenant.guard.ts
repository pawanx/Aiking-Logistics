import { type CanActivate, type ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TenantStatus } from '@prisma/client';
import type { Request } from 'express';

import type { RequestPrincipal } from '../auth/jwt-payload';
import { PUBLIC_KEY, WEBHOOK_KEY } from '../decorators';
import { CrossTenantAccessException, TenantSuspendedException, UnauthorizedException } from '../errors/app-exception';
import { TenantSettingsService } from '../tenant/tenant-settings.service';

/**
 * Enforces the tenant half of spec §4.3.
 *
 * Two jobs:
 *
 * 1. **Reject any request that names a tenant other than the caller's own.** The
 *    Prisma extension already makes cross-tenant *reads* return nothing, so a
 *    tampered id would surface as a 404. This guard turns that into an explicit
 *    403 with a distinct error code, which is the difference between "no such
 *    record" and "you just tried to read someone else's data" — the second is
 *    worth logging and alerting on.
 *
 * 2. **Stop a suspended tenant.** §4.2 gives Super Admin the right to suspend a
 *    tenant; that has to mean the tenant's users stop being able to spend money,
 *    checked per request rather than only at login, because a suspension must take
 *    effect without waiting for a 12-hour token to expire.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  private readonly logger = new Logger(TenantGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly tenantSettings: TenantSettingsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler();
    const controller = context.getClass();

    if (this.reflector.getAllAndOverride<string>(PUBLIC_KEY, [handler, controller])) return true;
    if (this.reflector.getAllAndOverride<string>(WEBHOOK_KEY, [handler, controller])) return true;

    const request = context.switchToHttp().getRequest<Request & { principal?: RequestPrincipal }>();
    const principal = request.principal;
    if (!principal) throw new UnauthorizedException();

    const claimedTenantId = this.claimedTenantId(request);

    if (principal.isSuperAdmin) {
      // Platform-level session: naming a tenant is legitimate (§4.2 support and
      // cross-tenant views). Whether that particular action is allowed is
      // RolesGuard's decision, not this guard's.
      return true;
    }

    if (!principal.tenantId) {
      // A non-super-admin token with no tenant binding cannot be scoped to
      // anything, so there is nothing it may legitimately do.
      throw new UnauthorizedException('This session is not bound to a tenant');
    }

    if (claimedTenantId && claimedTenantId !== principal.tenantId) {
      this.logger.warn(
        `Cross-tenant access blocked: user ${principal.userId} (tenant ${principal.tenantId}) ` +
          `requested tenant ${claimedTenantId} at ${request.method} ${request.originalUrl}`,
      );
      throw new CrossTenantAccessException({ requested: claimedTenantId });
    }

    const tenant = await this.tenantSettings.get(principal.tenantId);
    if (!tenant) throw new UnauthorizedException('The tenant for this session no longer exists');
    if (tenant.status === TenantStatus.suspended) throw new TenantSuspendedException(tenant.name);

    return true;
  }

  /**
   * A tenant id supplied by the client, from wherever it might arrive. Collected
   * only so it can be *checked against* the JWT — never used as the scope.
   */
  private claimedTenantId(request: Request): string | null {
    const fromParams = (request.params as Record<string, string | undefined> | undefined)?.tenantId;
    if (fromParams) return fromParams;

    const fromHeader = request.headers['x-tenant-id'];
    if (typeof fromHeader === 'string' && fromHeader) return fromHeader;

    const fromQuery = (request.query as Record<string, unknown> | undefined)?.tenantId;
    if (typeof fromQuery === 'string' && fromQuery) return fromQuery;

    const body = request.body as Record<string, unknown> | undefined;
    if (body && typeof body.tenantId === 'string' && body.tenantId) return body.tenantId;

    return null;
  }
}
