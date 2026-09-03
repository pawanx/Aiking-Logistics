/**
 * The RBAC permission matrix — spec §4.2, transcribed row for row.
 *
 * This module is the single source of truth for "who can do what", imported by
 * both the API (to build guards) and the web dashboard (to hide navigation and
 * controls the user cannot use). Keeping one copy means the UI cannot drift out
 * of sync with what the server actually enforces.
 *
 * Three of the matrix's cells are not a simple yes/no:
 *
 *   - `allow_as_support` — the spec's "✅ (support)" for Super Admin. Permitted,
 *     but only while explicitly acting on behalf of a named tenant. Recorded
 *     distinctly from a plain allow so support access stays auditable.
 *   - `tenant_policy`    — the spec's "Depends on tenant policy" for Staff
 *     campaign/calling rights. This is the §4.4 open item: it is NOT yet decided,
 *     so it resolves at runtime against a per-tenant setting rather than being
 *     guessed here. See TenantPolicyKey below.
 *   - `allow_limited`    — the spec's "✅ (balance + recent-activity summary
 *     only)" for Staff viewing the wallet. Permitted, but the response is
 *     narrower than a Manager's (spec §8.4).
 */

import { Role } from './roles';

export const Permission = {
  TENANT_ONBOARD: 'tenant:onboard',
  TENANT_SUSPEND: 'tenant:suspend',
  BILLING_VIEW_CROSS_TENANT: 'billing:view_cross_tenant',
  STAFF_MANAGE: 'staff:manage',
  CONTACTS_MANAGE: 'contacts:manage',
  CAMPAIGNS_LAUNCH: 'campaigns:launch',
  CALLS_TRIGGER: 'calls:trigger',
  WALLET_VIEW: 'wallet:view',
  WALLET_TOPUP: 'wallet:topup',
  TIMELINE_VIEW: 'timeline:view',
  PLATFORM_CONFIG: 'platform:config',
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

export type PermissionDecision =
  /** Straightforwardly permitted. */
  | 'allow'
  /** Permitted, but the payload is narrowed (spec §8.4 Staff wallet view). */
  | 'allow_limited'
  /** Permitted only while acting on behalf of a tenant — spec's "✅ (support)". */
  | 'allow_as_support'
  /** Deferred to a per-tenant setting — the spec §4.4 open item. */
  | 'tenant_policy'
  /** Denied. */
  | 'deny';

/** Per-tenant settings that resolve a `tenant_policy` decision (spec §4.4). */
export const TenantPolicyKey = {
  STAFF_CAN_LAUNCH_CAMPAIGNS: 'staffCanLaunchCampaigns',
  STAFF_CAN_TRIGGER_CALLS: 'staffCanTriggerCalls',
} as const;

export type TenantPolicyKey = (typeof TenantPolicyKey)[keyof typeof TenantPolicyKey];

export interface PermissionSpec {
  readonly permission: Permission;
  /** The spec's "Module / Action" label, kept verbatim for traceability. */
  readonly label: string;
  readonly matrix: Readonly<Record<Role, PermissionDecision>>;
  /**
   * Set when `matrix` yields `tenant_policy` for some role: the tenant setting
   * consulted to resolve it.
   */
  readonly policyKey?: TenantPolicyKey;
  readonly note?: string;
}

/**
 * Spec §4.2, in document order. Do not reorder — the web dashboard renders an
 * "effective permissions" view straight from this array.
 */
export const PERMISSION_MATRIX: readonly PermissionSpec[] = [
  {
    permission: Permission.TENANT_ONBOARD,
    label: 'Onboard a new tenant company',
    matrix: { super_admin: 'allow', manager: 'deny', staff: 'deny' },
  },
  {
    permission: Permission.TENANT_SUSPEND,
    label: 'Suspend / reactivate a tenant',
    matrix: { super_admin: 'allow', manager: 'deny', staff: 'deny' },
  },
  {
    permission: Permission.BILLING_VIEW_CROSS_TENANT,
    label: 'View cross-tenant usage / billing',
    matrix: { super_admin: 'allow', manager: 'deny', staff: 'deny' },
  },
  {
    permission: Permission.STAFF_MANAGE,
    label: 'Invite / remove staff within own tenant',
    matrix: { super_admin: 'allow_as_support', manager: 'allow', staff: 'deny' },
  },
  {
    permission: Permission.CONTACTS_MANAGE,
    label: 'Manage contacts',
    matrix: { super_admin: 'allow_as_support', manager: 'allow', staff: 'allow' },
  },
  {
    permission: Permission.CAMPAIGNS_LAUNCH,
    label: 'Create / launch WhatsApp & email campaigns',
    matrix: { super_admin: 'allow_as_support', manager: 'allow', staff: 'tenant_policy' },
    policyKey: TenantPolicyKey.STAFF_CAN_LAUNCH_CAMPAIGNS,
    note: 'Staff rights unresolved in spec §4.4 — defaults to denied until confirmed.',
  },
  {
    permission: Permission.CALLS_TRIGGER,
    label: 'Trigger / monitor AI calling',
    matrix: { super_admin: 'allow_as_support', manager: 'allow', staff: 'tenant_policy' },
    policyKey: TenantPolicyKey.STAFF_CAN_TRIGGER_CALLS,
    note: 'Staff rights unresolved in spec §4.4 — defaults to denied until confirmed.',
  },
  {
    permission: Permission.WALLET_VIEW,
    label: 'View wallet balance',
    matrix: { super_admin: 'allow', manager: 'allow', staff: 'allow_limited' },
    note: 'Manager sees the full itemized ledger; Staff sees balance + recent-activity summary only (spec §8.4).',
  },
  {
    permission: Permission.WALLET_TOPUP,
    label: 'Top up wallet (Razorpay)',
    matrix: { super_admin: 'allow_as_support', manager: 'allow', staff: 'deny' },
  },
  {
    permission: Permission.TIMELINE_VIEW,
    label: 'View 360° communication timeline',
    matrix: { super_admin: 'allow_as_support', manager: 'allow', staff: 'allow' },
  },
  {
    permission: Permission.PLATFORM_CONFIG,
    label: 'Platform configuration',
    matrix: { super_admin: 'allow', manager: 'deny', staff: 'deny' },
  },
];

const BY_PERMISSION: ReadonlyMap<Permission, PermissionSpec> = new Map(
  PERMISSION_MATRIX.map((entry) => [entry.permission, entry]),
);

export function getPermissionSpec(permission: Permission): PermissionSpec {
  const spec = BY_PERMISSION.get(permission);
  if (!spec) {
    // Unreachable while Permission and PERMISSION_MATRIX stay in step — and the
    // matrix-completeness unit test asserts exactly that.
    throw new Error(`Unknown permission: ${permission}`);
  }
  return spec;
}

/** The raw matrix cell, before any tenant policy is applied. */
export function decide(permission: Permission, role: Role): PermissionDecision {
  return getPermissionSpec(permission).matrix[role];
}

export type TenantPolicy = Partial<Record<TenantPolicyKey, boolean>>;

export interface ResolvedPermission {
  readonly granted: boolean;
  readonly decision: PermissionDecision;
  /** True when the payload must be narrowed (spec §8.4). */
  readonly limited: boolean;
  /** True when this was granted through Super Admin support access. */
  readonly asSupport: boolean;
  readonly reason: string;
}

/**
 * Resolve a matrix cell into an actual yes/no for one user.
 *
 * `tenantPolicy` supplies the §4.4 settings. A `tenant_policy` cell with no
 * setting present resolves to DENIED — the safe reading while the open item is
 * unresolved, since granting campaign-launch rights by default would let Staff
 * spend a tenant's wallet without anyone having decided they may.
 */
export function resolvePermission(
  permission: Permission,
  role: Role,
  options: { tenantPolicy?: TenantPolicy; actingOnTenant?: boolean } = {},
): ResolvedPermission {
  const spec = getPermissionSpec(permission);
  const decision = spec.matrix[role];

  switch (decision) {
    case 'allow':
      return { granted: true, decision, limited: false, asSupport: false, reason: 'Allowed by role' };

    case 'allow_limited':
      return {
        granted: true,
        decision,
        limited: true,
        asSupport: false,
        reason: 'Allowed with a narrowed response (spec §8.4)',
      };

    case 'allow_as_support':
      // Super Admin support access requires an explicit tenant to act on, so a
      // platform-level session cannot silently mutate tenant data.
      if (options.actingOnTenant === false) {
        return {
          granted: false,
          decision,
          limited: false,
          asSupport: true,
          reason: 'Support access requires acting on behalf of a specific tenant',
        };
      }
      return { granted: true, decision, limited: false, asSupport: true, reason: 'Allowed as platform support' };

    case 'tenant_policy': {
      const key = spec.policyKey;
      const granted = key ? options.tenantPolicy?.[key] === true : false;
      return {
        granted,
        decision,
        limited: false,
        asSupport: false,
        reason: granted
          ? `Allowed by tenant policy '${key}'`
          : `Denied: tenant policy '${key}' is not enabled (spec §4.4 open item)`,
      };
    }

    case 'deny':
    default:
      return { granted: false, decision, limited: false, asSupport: false, reason: 'Denied by role' };
  }
}

/** Convenience wrapper for call sites that only need the boolean. */
export function can(
  permission: Permission,
  role: Role,
  options: { tenantPolicy?: TenantPolicy; actingOnTenant?: boolean } = {},
): boolean {
  return resolvePermission(permission, role, options).granted;
}

/** Every permission a role holds, for rendering the dashboard's nav. */
export function permissionsFor(
  role: Role,
  options: { tenantPolicy?: TenantPolicy; actingOnTenant?: boolean } = {},
): Permission[] {
  return PERMISSION_MATRIX.filter((entry) => resolvePermission(entry.permission, role, options).granted).map(
    (entry) => entry.permission,
  );
}
