import { Inject, Injectable } from '@nestjs/common';
import { LowBalanceBehavior, type TenantSettings } from '@aiking/shared';
import { TenantStatus } from '@prisma/client';

import { PRISMA, type ExtendedPrismaClient } from '../prisma/prisma.service';

export interface TenantRuntimeInfo {
  id: string;
  name: string;
  status: TenantStatus;
  settings: TenantSettings;
}

/**
 * Tenant status and policy settings, cached briefly.
 *
 * RolesGuard needs the tenant's policy on every request that touches a
 * `tenant_policy` row of the §4.2 matrix (§4.4's open items). Reading the tenants
 * table on each request would put a query in front of every call, so this holds a
 * short-lived cache.
 *
 * The TTL is 5 seconds, not minutes. Two of these values gate real actions — a
 * suspended tenant must stop sending, and revoking Staff's campaign right must
 * take effect promptly — so a stale read has consequences. Five seconds keeps the
 * per-request cost near zero while bounding staleness to something a Manager
 * would not notice. `invalidate()` is called on every write to a tenant, so the
 * TTL only matters for changes made by another process.
 */
@Injectable()
export class TenantSettingsService {
  private static readonly TTL_MS = 5_000;

  private readonly cache = new Map<string, { value: TenantRuntimeInfo; expiresAt: number }>();

  constructor(@Inject(PRISMA) private readonly prisma: ExtendedPrismaClient) {}

  async get(tenantId: string): Promise<TenantRuntimeInfo | null> {
    const cached = this.cache.get(tenantId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        name: true,
        status: true,
        staffCanLaunchCampaigns: true,
        staffCanTriggerCalls: true,
        lowBalanceBehavior: true,
        softLimitPaise: true,
        lowBalanceThresholdPaise: true,
      },
    });

    if (!tenant) {
      this.cache.delete(tenantId);
      return null;
    }

    const value: TenantRuntimeInfo = {
      id: tenant.id,
      name: tenant.name,
      status: tenant.status,
      settings: {
        staffCanLaunchCampaigns: tenant.staffCanLaunchCampaigns,
        staffCanTriggerCalls: tenant.staffCanTriggerCalls,
        lowBalanceBehavior: tenant.lowBalanceBehavior as LowBalanceBehavior,
        softLimitPaise: tenant.softLimitPaise.toString(),
        lowBalanceThresholdPaise: tenant.lowBalanceThresholdPaise.toString(),
      },
    };

    this.cache.set(tenantId, { value, expiresAt: Date.now() + TenantSettingsService.TTL_MS });
    return value;
  }

  /** Called by TenantsService after any write that changes status or policy. */
  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }

  clear(): void {
    this.cache.clear();
  }
}
