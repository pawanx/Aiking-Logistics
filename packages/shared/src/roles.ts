/**
 * Roles and role scoping — spec §4.1.
 *
 * There are exactly three roles. Super Admin is platform-wide (Aiking Solutions'
 * own team); Manager and Staff are always scoped to a single tenant.
 */

export const Role = {
  SUPER_ADMIN: 'super_admin',
  MANAGER: 'manager',
  STAFF: 'staff',
} as const;

export type Role = (typeof Role)[keyof typeof Role];

export const ALL_ROLES: readonly Role[] = [Role.SUPER_ADMIN, Role.MANAGER, Role.STAFF];

/** Roles that live inside a tenant. Super Admin deliberately excluded. */
export const TENANT_ROLES: readonly Role[] = [Role.MANAGER, Role.STAFF];

export const ROLE_LABELS: Record<Role, string> = {
  [Role.SUPER_ADMIN]: 'Super Admin',
  [Role.MANAGER]: 'Manager',
  [Role.STAFF]: 'Staff',
};

/** Spec §4.1 — "Scope" column. */
export const ROLE_SCOPES: Record<Role, string> = {
  [Role.SUPER_ADMIN]: 'Platform-wide, across all tenants',
  [Role.MANAGER]: 'Single tenant, full operational and billing authority',
  [Role.STAFF]: 'Single tenant, day-to-day operational use',
};

export function isTenantRole(role: string): role is Exclude<Role, 'super_admin'> {
  return role === Role.MANAGER || role === Role.STAFF;
}
