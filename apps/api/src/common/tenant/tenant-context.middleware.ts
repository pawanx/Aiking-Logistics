import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@aiking/shared';
import type { NextFunction, Request, Response } from 'express';

import { CONFIG, type AppConfig } from '../../config/configuration';
import type { JwtPayload, RequestPrincipal } from '../auth/jwt-payload';
import { TenantContext } from './tenant-context';

/**
 * Establishes the ambient tenant scope for the whole request.
 *
 * This is middleware rather than a guard or interceptor for one specific reason:
 * `AsyncLocalStorage.run()` has to *enclose* everything downstream, and only
 * middleware can do that — it calls `next()` from inside the store, so guards,
 * interceptors, the controller and every service below them all observe the same
 * context. A guard returns a boolean and cannot wrap what follows it; an
 * interceptor returns an Observable that Nest subscribes to *after* the
 * interceptor has returned, which would leave the handler running outside the
 * store.
 *
 * Consequence: JWT *verification* happens here, before the guards. The guards
 * then make authorization decisions from an already-verified principal. Nothing
 * here authorizes anything — an invalid or missing token is recorded and left for
 * JwtAuthGuard to reject, so that `@Public()` routes still work and the 401 has a
 * single origin.
 */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  constructor(
    private readonly jwt: JwtService,
    private readonly tenantContext: TenantContext,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const token = this.extractToken(req);

    if (!token) {
      // No credentials at all. Deliberately no ALS store: a tenant-scoped query
      // on an unauthenticated path then throws TenantScopeMissingError instead of
      // quietly returning another tenant's rows. Routes that legitimately need to
      // query before authentication (login) opt in via runAsSystem().
      next();
      return;
    }

    let payload: JwtPayload;
    try {
      payload = this.jwt.verify<JwtPayload>(token, { secret: this.config.auth.jwtSecret });
    } catch (error) {
      (req as Request & { authError?: string }).authError =
        (error as Error).name === 'TokenExpiredError' ? 'Your session has expired' : 'Invalid authentication token';
      next();
      return;
    }

    const principal: RequestPrincipal = {
      userId: payload.sub,
      email: payload.email,
      name: payload.name,
      role: payload.role,
      tenantId: payload.tid,
      isSuperAdmin: payload.sa === true,
    };
    (req as Request & { principal?: RequestPrincipal }).principal = principal;

    // A Super Admin session is platform-level and runs unscoped (§4.2 cross-tenant
    // usage and billing views). Acting *on* one tenant is a separate, explicit
    // step — see TenantAccessService.asTenant() — so support access is always a
    // deliberate call with a recorded reason rather than an ambient default.
    if (principal.isSuperAdmin || principal.role === Role.SUPER_ADMIN || principal.tenantId === null) {
      this.tenantContext.runAsSuperAdmin(`${req.method} ${req.originalUrl}`, () => next(), principal.userId);
      return;
    }

    this.tenantContext.runWithTenant(
      {
        tenantId: principal.tenantId,
        userId: principal.userId,
        role: principal.role,
        isSuperAdmin: false,
        viaSupport: false,
        viaWorker: false,
      },
      () => next(),
    );
  }

  private extractToken(req: Request): string | null {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) return header.slice(7).trim() || null;

    // Cookie fallback: the Next.js app stores the token in an httpOnly cookie so
    // it is not reachable from client-side JavaScript.
    const cookie = req.headers.cookie;
    if (!cookie) return null;
    for (const part of cookie.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === 'aiking_token') return decodeURIComponent(rest.join('=')) || null;
    }
    return null;
  }
}
