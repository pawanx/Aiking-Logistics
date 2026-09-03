import type { Role } from '@aiking/shared';

/**
 * JWT claim set.
 *
 * `tid` is the tenant binding and it is the *only* source of tenant identity for
 * a tenant-scoped request (spec §4.3). Short keys keep the token small; the
 * meaning is documented here rather than inferred.
 */
export interface JwtPayload {
  /** User id (standard `sub` claim). */
  sub: string;
  email: string;
  name: string;
  role: Role;
  /** Tenant id, or null for a platform-level Super Admin session. */
  tid: string | null;
  /** Super Admin flag, kept explicit so it cannot be inferred from `role` alone. */
  sa: boolean;
  iat?: number;
  exp?: number;
}

/**
 * The authenticated principal, attached to the request by
 * TenantContextMiddleware after signature verification.
 */
export interface RequestPrincipal {
  userId: string;
  email: string;
  name: string;
  role: Role;
  tenantId: string | null;
  isSuperAdmin: boolean;
}

/** Express request with the principal attached. */
export interface AuthenticatedRequest extends Request {
  principal?: RequestPrincipal;
}
