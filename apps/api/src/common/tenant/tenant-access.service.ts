import { Injectable, Logger } from '@nestjs/common';
import { Role } from '@aiking/shared';

import type { RequestPrincipal } from '../auth/jwt-payload';
import { NotFoundException } from '../errors/app-exception';
import { TenantSettingsService } from './tenant-settings.service';
import { TenantContext } from './tenant-context';

/**
 * Super Admin support access — the spec's "✅ (support)" cells in §4.2.
 *
 * A Super Admin session is unscoped by default, which is right for the
 * cross-tenant usage and billing views but wrong for anything that touches one
 * tenant's data: an unscoped write would land with no `tenant_id` at all. So
 * acting on a tenant is a separate, explicit step through this service.
 *
 * The `reason` argument is not decoration. Support access to a customer's
 * contacts, wallet and call recordings is precisely what a customer may later ask
 * you to account for, and a log line that says *why* is worth considerably more
 * than one that only says it happened.
 */
@Injectable()
export class TenantAccessService {
  private readonly logger = new Logger(TenantAccessService.name);

  constructor(
    private readonly tenantContext: TenantContext,
    private readonly tenantSettings: TenantSettingsService,
  ) {}

  /**
   * Run `fn` scoped to `tenantId` on behalf of a Super Admin.
   *
   * Verifies the tenant exists first, so a typo'd id fails as a 404 rather than
   * running a scoped query that silently matches nothing.
   */
  async asTenant<T>(tenantId: string, principal: RequestPrincipal, reason: string, fn: () => Promise<T>): Promise<T> {
    const tenant = await this.tenantSettings.get(tenantId);
    if (!tenant) throw new NotFoundException('Tenant', tenantId);

    this.logger.log(`Support access to tenant ${tenant.name} (${tenantId}) by ${principal.email}: ${reason}`);

    return this.tenantContext.runWithTenant(
      {
        tenantId,
        userId: principal.userId,
        role: principal.role,
        isSuperAdmin: true,
        viaSupport: true,
        viaWorker: false,
      },
      fn,
    );
  }

  /**
   * Run `fn` scoped to whichever tenant the caller belongs to.
   *
   * For a tenant user this is already the ambient scope and `fn` runs as-is. For a
   * Super Admin it routes through `asTenant`, which is what makes one controller
   * method serve both a Manager and a Super Admin doing support without the
   * controller branching on role.
   */
  async asCaller<T>(
    principal: RequestPrincipal,
    tenantId: string | undefined,
    reason: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (!principal.isSuperAdmin && principal.role !== Role.SUPER_ADMIN) return fn();

    if (!tenantId) {
      throw new NotFoundException('Tenant', '(no tenant specified for support access)');
    }
    return this.asTenant(tenantId, principal, reason, fn);
  }
}
