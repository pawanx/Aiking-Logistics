import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';

import { CONFIG, type AppConfig } from '../../config/configuration';
import { TenantContext } from '../tenant/tenant-context';

/**
 * Models carrying a `tenantId` that the extension below filters automatically.
 *
 * This list is explicit rather than derived from the schema at runtime. Deriving
 * it would silently start (or stop) scoping a model when the schema changes,
 * which is precisely the kind of quiet change you do not want governing tenant
 * isolation. Adding a tenant-scoped model means adding it here, and the
 * `every-tenant-scoped-model-is-listed` unit test fails if you forget.
 *
 * Deliberately excluded:
 *   - Tenant             — keyed by `id`, not `tenantId`
 *   - User               — global accounts (spec §9.3 "Global user accounts")
 *   - CallTranscriptTurn — scoped transitively through its Call
 *   - WebhookDelivery    — pre-tenant-resolution audit log
 *   - PricingRule        — `tenantId` is NULLABLE there, because NULL means "the
 *                          platform default rate". Auto-filtering to
 *                          `tenantId = X` would hide every default rule, so
 *                          PricingRuleService resolves the tenant-or-default
 *                          lookup itself.
 */
export const TENANT_SCOPED_MODELS = [
  'TenantUser',
  'Contact',
  'Wallet',
  'WalletTransaction',
  'WalletReservation',
  'RazorpayOrder',
  'RazorpayPayment',
  'UsageEvent',
  'Template',
  'Campaign',
  'CampaignRecipient',
  'Call',
  'CommunicationEvent',
] as const;

export type TenantScopedModel = (typeof TENANT_SCOPED_MODELS)[number];

const TENANT_SCOPED_MODEL_SET: ReadonlySet<string> = new Set(TENANT_SCOPED_MODELS);

/** Operations whose `where` clause gets the tenant filter. */
const WHERE_FILTERED_OPERATIONS: ReadonlySet<string> = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'count',
  'aggregate',
  'groupBy',
]);

/** Operations whose `data` gets the tenant id stamped in. */
const DATA_STAMPED_OPERATIONS: ReadonlySet<string> = new Set(['create', 'createMany', 'createManyAndReturn']);

/**
 * Build the Prisma client with the tenant-isolation extension applied.
 *
 * This is the structural half of spec §4.3: the guard establishes scope, and this
 * extension applies it to every query without the service layer having to
 * remember. A service method that writes `prisma.contact.findMany({})` still only
 * ever sees its own tenant's rows.
 *
 * `where` injection on `findUnique` / `update` / `delete` relies on Prisma's
 * extended-where-unique support (GA since Prisma 5), which permits non-unique
 * fields alongside the unique selector. That matters: it means a lookup by
 * primary key belonging to another tenant returns null instead of the row, and
 * an update targeting another tenant's row matches nothing rather than
 * succeeding.
 */
export function createPrismaClient(config: AppConfig, tenantContext: TenantContext) {
  const adapter = new PrismaPg({
    connectionString: config.database.url,
    max: config.database.poolMax,
    // Backstop against a pathological query pinning a connection. Wallet
    // transactions take row locks, so a query that never returns would block
    // every subsequent debit for that tenant.
    statement_timeout: config.database.statementTimeoutMs,
  });

  const base = new PrismaClient({
    adapter,
    log: config.isProduction
      ? [{ emit: 'event', level: 'warn' }, { emit: 'event', level: 'error' }]
      : [{ emit: 'event', level: 'warn' }, { emit: 'event', level: 'error' }],
  });

  return base.$extends({
    name: 'tenant-isolation',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!TENANT_SCOPED_MODEL_SET.has(model)) {
            return query(args);
          }

          // Throws when no context at all is active — that is a programming
          // error (a query outside any request or job), not an unscoped read.
          const tenantId = tenantContext.currentTenantIdOrNull(`${model}.${operation}`);

          // Deliberately unscoped: Super Admin cross-tenant reads (§4.2) and
          // webhook handlers that have not resolved a tenant yet.
          if (tenantId === null) {
            return query(args);
          }

          if (WHERE_FILTERED_OPERATIONS.has(operation)) {
            const typed = args as { where?: Record<string, unknown> };
            typed.where = { ...(typed.where ?? {}), tenantId };
            return query(typed as typeof args);
          }

          if (DATA_STAMPED_OPERATIONS.has(operation)) {
            const typed = args as { data?: Record<string, unknown> | Record<string, unknown>[] };
            if (Array.isArray(typed.data)) {
              typed.data = typed.data.map((row) => ({ tenantId, ...row }));
            } else if (typed.data) {
              // Caller-supplied tenantId wins only if it matches; a mismatch is
              // a bug worth surfacing loudly rather than silently rewriting.
              const supplied = typed.data.tenantId;
              if (supplied !== undefined && supplied !== tenantId) {
                throw new Error(
                  `Refusing ${model}.${operation}: data.tenantId (${String(supplied)}) does not match the ` +
                    `active tenant scope (${tenantId}).`,
                );
              }
              typed.data = { ...typed.data, tenantId };
            }
            return query(typed as typeof args);
          }

          // upsert, and anything Prisma adds later: scope both halves.
          if (operation === 'upsert') {
            const typed = args as {
              where?: Record<string, unknown>;
              create?: Record<string, unknown>;
              update?: Record<string, unknown>;
            };
            typed.where = { ...(typed.where ?? {}), tenantId };
            if (typed.create) typed.create = { tenantId, ...typed.create };
            return query(typed as typeof args);
          }

          return query(args);
        },
      },
    },
  });
}

export type ExtendedPrismaClient = ReturnType<typeof createPrismaClient>;

/** Injection token for the tenant-scoped client. */
export const PRISMA = 'PRISMA_CLIENT';

/**
 * Transaction client type — what `$transaction(async (tx) => ...)` hands you.
 *
 * The tenant extension applies inside a transaction too, so a service can use
 * `tx` exactly like the top-level client.
 */
export type PrismaTransaction = Omit<
  ExtendedPrismaClient,
  '$connect' | '$disconnect' | '$transaction' | '$extends' | '$on'
>;

/**
 * Lifecycle owner for the client: connects at boot, disconnects on shutdown, and
 * hosts the raw-SQL helpers that the wallet engine needs.
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(
    @Inject(PRISMA) public readonly client: ExtendedPrismaClient,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.client.$connect();
    this.logger.log('Database connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }

  /** Round-trip check for the health endpoint. */
  async ping(): Promise<boolean> {
    try {
      await this.client.$queryRaw`SELECT 1`;
      return true;
    } catch (error) {
      this.logger.error(`Database ping failed: ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * Truncate every table. Test-suite helper, refusing to run outside NODE_ENV=test
   * so it can never be reached by a stray call in a deployed environment.
   */
  async truncateAllForTests(): Promise<void> {
    if (!this.config.isTest) {
      throw new Error('truncateAllForTests() is only callable when NODE_ENV=test');
    }

    const tables = await this.client.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename NOT LIKE '_prisma%'
    `;
    if (tables.length === 0) return;

    const list = tables.map((row) => `"public"."${row.tablename}"`).join(', ');
    await this.client.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  }
}

/**
 * True when a Prisma error is a unique-constraint violation.
 *
 * This is load-bearing for idempotency (spec §8.1, §8.2, §15): a redelivered
 * webhook or retried job hits the unique index, and the handler treats that as
 * "already applied" rather than an error. Optionally narrowed to a specific
 * constraint so an unexpected collision elsewhere still surfaces.
 */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code !== 'P2002') return false;
  if (!constraint) return true;

  const target = error.meta?.target;
  if (typeof target === 'string') return target.includes(constraint);
  if (Array.isArray(target)) return target.some((field) => String(field).includes(constraint));
  return false;
}

/** True when a Prisma error is "record not found" (P2025). */
export function isNotFound(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';
}
