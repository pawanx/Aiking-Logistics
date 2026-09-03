import { AsyncLocalStorage } from 'node:async_hooks';

import { Injectable } from '@nestjs/common';
import type { Role } from '@aiking/shared';

/**
 * Ambient tenant scope — spec §4.3.
 *
 * The spec is specific about the mechanism: "A TenantGuard reads tenant_id from
 * the JWT and injects it into request context; every service method scopes its
 * query to this context value, **never to a client-supplied tenant identifier**,
 * so one tenant cannot read another's data by altering a request parameter."
 *
 * AsyncLocalStorage is what makes that practical. The alternative — threading a
 * tenantId parameter through every service signature — works right up until one
 * call site forgets, and the failure mode is silent cross-tenant data exposure.
 * Here the scope is ambient and the Prisma extension (prisma.service.ts) reads it
 * on every query, so forgetting is not possible in the same way.
 *
 * Scope is deliberately hard to acquire: it comes from the verified JWT via
 * TenantGuard, or from an explicit `runAsSuperAdmin` / `runAsSystem` call. There
 * is no setter that takes a request parameter.
 */

export interface TenantScope {
  readonly tenantId: string;
  /**
   * The acting user, or `null` when no person initiated this — a queue processor
   * working through a campaign nobody is watching.
   */
  readonly userId: string | null;
  /** The acting role, or `null` when the actor is the platform itself. */
  readonly role: Role | null;
  readonly isSuperAdmin: boolean;
  /**
   * True when a Super Admin is acting on behalf of this tenant — the spec's
   * "✅ (support)" cells in §4.2. Kept distinct so support access is auditable.
   */
  readonly viaSupport: boolean;
  /**
   * True when a queue processor opened this scope from a job payload (§3.4).
   *
   * Worth distinguishing from a request scope because the authorisation already
   * happened — a Manager launched the campaign — and the processor is executing it
   * rather than deciding it. A log line that cannot tell the two apart makes a
   * worker's writes look like unauthenticated ones.
   */
  readonly viaWorker: boolean;
}

/**
 * An unscoped context. Two shapes, deliberately named differently so the intent
 * is visible at the call site and in a code review:
 *
 *   - `super_admin` — a platform-level session legitimately reading across
 *     tenants (§4.2 "View cross-tenant usage / billing").
 *   - `system`      — a background worker or webhook handler that has not yet
 *     resolved which tenant a payload belongs to.
 */
export interface UnscopedContext {
  readonly kind: 'super_admin' | 'system';
  readonly userId?: string;
  readonly reason: string;
}

type Store = { scope: TenantScope; unscoped?: never } | { scope?: never; unscoped: UnscopedContext };

export class TenantScopeMissingError extends Error {
  constructor(operation: string) {
    super(
      `No tenant scope is active for "${operation}". A tenant-scoped query must run inside ` +
        `TenantContext.runWithTenant(), or explicitly opt out via runAsSuperAdmin()/runAsSystem().`,
    );
    this.name = 'TenantScopeMissingError';
  }
}

@Injectable()
export class TenantContext {
  private readonly storage = new AsyncLocalStorage<Store>();

  /** Run `fn` scoped to one tenant. Used by TenantGuard per request. */
  runWithTenant<T>(scope: TenantScope, fn: () => T): T {
    return this.storage.run({ scope }, fn);
  }

  /**
   * Run `fn` scoped to one tenant on behalf of the system — a queue processor acting
   * on the `tenantId` in its job payload (spec §3.4).
   *
   * Deliberately tenant-*scoped* rather than `runAsSystem`: a worker has no HTTP
   * request to inherit a scope from, but that is a reason to open one explicitly, not
   * a reason to run unfiltered. The Prisma extension keeps filtering every query, so
   * §4.3's isolation guarantee holds on the worker side exactly as it does on the
   * request side — a processor with a bug in its `where` clause still cannot reach
   * another tenant's rows.
   */
  runAsWorker<T>(tenantId: string, reason: string, fn: () => T, actorUserId?: string): T {
    return this.storage.run(
      {
        scope: {
          tenantId,
          userId: actorUserId ?? null,
          role: null,
          isSuperAdmin: false,
          viaSupport: false,
          viaWorker: true,
        },
      },
      fn,
    );
  }

  /**
   * Run `fn` with no tenant filter, as a Super Admin.
   *
   * Every call site is a deliberate cross-tenant read and should be reviewable
   * as such — hence the mandatory `reason`, which is also what gets logged.
   */
  runAsSuperAdmin<T>(reason: string, fn: () => T, userId?: string): T {
    return this.storage.run({ unscoped: { kind: 'super_admin', reason, userId } }, fn);
  }

  /**
   * Run `fn` with no tenant filter, as the system: queue workers and webhook
   * handlers that must look up which tenant a provider payload belongs to before
   * they can scope anything.
   */
  runAsSystem<T>(reason: string, fn: () => T): T {
    return this.storage.run({ unscoped: { kind: 'system', reason } }, fn);
  }

  /** The active tenant scope, or undefined when unscoped. */
  get scope(): TenantScope | undefined {
    return this.storage.getStore()?.scope;
  }

  get unscoped(): UnscopedContext | undefined {
    return this.storage.getStore()?.unscoped;
  }

  /** True when any context at all is active. */
  get hasContext(): boolean {
    return this.storage.getStore() !== undefined;
  }

  /**
   * The tenant id for a scoped query, or `null` when running unscoped.
   *
   * Returning null rather than throwing lets the Prisma extension distinguish
   * "filter by this tenant" from "deliberately unfiltered". Running with no
   * context at all throws — that is a bug, not a legitimate unscoped read.
   */
  currentTenantIdOrNull(operation = 'query'): string | null {
    const store = this.storage.getStore();
    if (!store) throw new TenantScopeMissingError(operation);
    return store.scope?.tenantId ?? null;
  }

  /** The tenant id, throwing if unscoped. For code that requires a tenant. */
  requireTenantId(operation = 'query'): string {
    const scope = this.scope;
    if (!scope) throw new TenantScopeMissingError(operation);
    return scope.tenantId;
  }

  requireUserId(operation = 'query'): string {
    const store = this.storage.getStore();
    const userId = store?.scope?.userId ?? store?.unscoped?.userId;
    if (!userId) throw new TenantScopeMissingError(operation);
    return userId;
  }
}
