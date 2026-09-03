import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { PUBLIC_KEY, WEBHOOK_KEY } from '../decorators';
import { UnauthorizedException } from '../errors/app-exception';

/**
 * Requires an authenticated principal, unless the route is explicitly marked
 * `@Public(reason)` or `@Webhook(provider)`.
 *
 * Registered globally, so the default for a new route is "authentication
 * required" — the safe direction to fail. Verification itself already happened in
 * TenantContextMiddleware; this guard only decides whether the result is
 * acceptable for the route.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const handler = context.getHandler();
    const controller = context.getClass();

    const isPublic = this.reflector.getAllAndOverride<string>(PUBLIC_KEY, [handler, controller]);
    if (isPublic) return true;

    // Webhooks authenticate by provider signature inside the handler (spec §12),
    // not by JWT. The signature check is mandatory there and covered by the
    // route-coverage test.
    const isWebhook = this.reflector.getAllAndOverride<string>(WEBHOOK_KEY, [handler, controller]);
    if (isWebhook) return true;

    const request = context.switchToHttp().getRequest<Request & { principal?: unknown; authError?: string }>();
    if (!request.principal) {
      throw new UnauthorizedException(request.authError ?? 'Authentication is required');
    }
    return true;
  }
}
