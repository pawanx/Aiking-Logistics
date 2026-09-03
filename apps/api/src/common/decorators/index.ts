import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Permission, Role } from '@aiking/shared';

import type { RequestPrincipal } from '../auth/jwt-payload';

/**
 * Route authorization metadata.
 *
 * Spec §16's go-live checklist asks that "every API route is behind an explicit
 * role guard". That is enforced mechanically: a unit test walks the router and
 * fails if any handler carries none of the three markers below. So the decision
 * for each route is recorded in the code, and *forgetting* is a test failure
 * rather than an accidentally-open endpoint.
 */

export const PUBLIC_KEY = 'aiking:public';
export const ROLES_KEY = 'aiking:roles';
export const PERMISSION_KEY = 'aiking:permission';
export const WEBHOOK_KEY = 'aiking:webhook';

/**
 * No authentication. Use sparingly — login and health only.
 *
 * `reason` is required so an unauthenticated route always carries a written
 * justification at the point where someone reviewing the code will see it.
 */
export const Public = (reason: string) => SetMetadata(PUBLIC_KEY, reason);

/**
 * A provider webhook: unauthenticated in the JWT sense, but *authenticated by
 * signature* inside the handler (spec §12). Distinct from `@Public` so the two
 * are never confused, and so the route-coverage test can assert that every
 * webhook route also verifies a signature.
 */
export const Webhook = (provider: string) => SetMetadata(WEBHOOK_KEY, provider);

/** Restrict to the listed roles — the coarse §4.2 check. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

/**
 * Restrict by permission, resolved through the shared §4.2 matrix.
 *
 * Preferred over `@Roles` wherever the matrix has an entry, because it also
 * applies the `tenant_policy` rows (§4.4's open items) and the "(support)"
 * qualification on Super Admin cells — logic that a bare role list cannot
 * express.
 */
export const RequirePermission = (permission: Permission) => SetMetadata(PERMISSION_KEY, permission);

/** The authenticated principal. */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): RequestPrincipal => {
  const request = ctx.switchToHttp().getRequest<{ principal?: RequestPrincipal }>();
  if (!request.principal) {
    // Unreachable behind the auth guard; thrown rather than returning undefined
    // so a mis-ordered guard chain fails loudly instead of handing a controller
    // an undefined user.
    throw new Error('@CurrentUser() used on a route with no authenticated principal');
  }
  return request.principal;
});

/**
 * The raw request body — required for webhook HMAC verification, which must run
 * over the exact bytes the provider signed rather than a re-serialized object
 * (spec §12). Depends on `rawBody: true` in main.ts.
 */
export const RawBody = createParamDecorator((_data: unknown, ctx: ExecutionContext): Buffer => {
  const request = ctx.switchToHttp().getRequest<{ rawBody?: Buffer; body?: unknown }>();
  if (request.rawBody) return request.rawBody;
  // Fall back to a re-serialization so a misconfigured body parser produces a
  // signature mismatch (a 401) rather than a crash.
  return Buffer.from(typeof request.body === 'string' ? request.body : JSON.stringify(request.body ?? {}), 'utf8');
});
