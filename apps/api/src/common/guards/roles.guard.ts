import { type CanActivate, type ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  Permission,
  Role,
  getPermissionSpec,
  resolvePermission,
  type ResolvedPermission,
  type TenantPolicy,
} from '@aiking/shared';
import type { Request } from 'express';

import type { RequestPrincipal } from '../auth/jwt-payload';
import { PERMISSION_KEY, PUBLIC_KEY, ROLES_KEY, WEBHOOK_KEY } from '../decorators';
import { ForbiddenRoleException, ForbiddenTenantPolicyException, UnauthorizedException } from '../errors/app-exception';
import { TenantSettingsService } from '../tenant/tenant-settings.service';

/**
 * Authorization against the §4.2 matrix.
 *
 * Runs last in the global chain, after authentication and tenant checks, and
 * fails closed: a route with none of `@Public`, `@Webhook`, `@Roles` or
 * `@RequirePermission` is rejected outright rather than allowed. That inversion is
 * what makes spec §16's "every API route is behind an explicit role guard"
 * enforceable — an unmarked route is dead on arrival in development, so it cannot
 * reach production as an open endpoint.
 *
 * The resolved decision is attached to the request as `permissionCheck` so a
 * controller can read `limited` and narrow its response (spec §8.4: Staff see
 * balance and recent activity, Managers see the itemized ledger).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  private readonly logger = new Logger(RolesGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly tenantSettings: TenantSettingsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler();
    const controller = context.getClass();

    if (this.reflector.getAllAndOverride<string>(PUBLIC_KEY, [handler, controller])) return true;
    if (this.reflector.getAllAndOverride<string>(WEBHOOK_KEY, [handler, controller])) return true;

    const request = context.switchToHttp().getRequest<
      Request & {
        principal?: RequestPrincipal;
        permissionCheck?: ResolvedPermission;
      }
    >();
    const principal = request.principal;
    if (!principal) throw new UnauthorizedException();

    const required = this.reflector.getAllAndOverride<Permission>(PERMISSION_KEY, [handler, controller]);
    const allowedRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [handler, controller]);

    if (required) {
      await this.checkPermission(required, principal, request);
      return true;
    }

    if (allowedRoles?.length) {
      if (!allowedRoles.includes(principal.role)) {
        throw new ForbiddenRoleException(
          `This action requires ${allowedRoles.join(' or ')}; you are ${principal.role}`,
          { requiredRoles: allowedRoles, actualRole: principal.role },
        );
      }
      return true;
    }

    // No authorization metadata. Refusing is the only safe answer, and the
    // route-coverage test turns this into a build-time failure rather than a
    // runtime surprise.
    this.logger.error(
      `Route ${request.method} ${request.originalUrl} (${controller.name}.${handler.name}) has no ` +
        `@Roles, @RequirePermission, @Public or @Webhook marker — denying.`,
    );
    throw new ForbiddenRoleException('This endpoint is not configured for access');
  }

  private async checkPermission(
    permission: Permission,
    principal: RequestPrincipal,
    request: Request & { permissionCheck?: ResolvedPermission },
  ): Promise<void> {
    const tenantPolicy = await this.loadPolicy(principal);

    // For a Super Admin, "acting on a tenant" means the route names one. That is
    // how the matrix's "✅ (support)" cells get their qualification: a
    // platform-level session with no tenant in the path is not doing support work.
    const actingOnTenant = principal.isSuperAdmin ? this.namesATenant(request) : true;

    const resolved = resolvePermission(permission, principal.role, { tenantPolicy, actingOnTenant });
    request.permissionCheck = resolved;

    if (resolved.granted) {
      if (resolved.asSupport) {
        // Support access to tenant data is exactly the kind of thing a customer
        // may later ask you to account for, so it is logged at every occurrence.
        this.logger.log(
          `Support access: super admin ${principal.userId} exercised ${permission} at ` +
            `${request.method} ${request.originalUrl}`,
        );
      }
      return;
    }

    const spec = getPermissionSpec(permission);

    if (resolved.decision === 'tenant_policy') {
      throw new ForbiddenTenantPolicyException(
        `${spec.label} is not enabled for ${principal.role} in this account. ` +
          `A Manager can enable it in account settings.`,
        { permission, policyKey: spec.policyKey, role: principal.role },
      );
    }

    throw new ForbiddenRoleException(`${spec.label} is not permitted for ${principal.role}`, {
      permission,
      role: principal.role,
      reason: resolved.reason,
    });
  }

  private async loadPolicy(principal: RequestPrincipal): Promise<TenantPolicy | undefined> {
    // Only Staff decisions consult tenant policy, so this avoids the lookup for
    // everyone else.
    if (principal.role !== Role.STAFF || !principal.tenantId) return undefined;
    const tenant = await this.tenantSettings.get(principal.tenantId);
    if (!tenant) return undefined;
    return {
      staffCanLaunchCampaigns: tenant.settings.staffCanLaunchCampaigns,
      staffCanTriggerCalls: tenant.settings.staffCanTriggerCalls,
    };
  }

  private namesATenant(request: Request): boolean {
    const params = request.params as Record<string, string | undefined> | undefined;
    if (params?.tenantId) return true;
    const header = request.headers['x-acting-tenant-id'];
    if (typeof header === 'string' && header) return true;
    const body = request.body as Record<string, unknown> | undefined;
    return typeof body?.tenantId === 'string' && body.tenantId.length > 0;
  }
}
