import { Global, Module } from '@nestjs/common';

import { CONFIG, type AppConfig } from '../../config/configuration';
import { TenantContext } from '../tenant/tenant-context';
import { PRISMA, PrismaService, createPrismaClient } from './prisma.service';

/**
 * Global Prisma module.
 *
 * The client is a provider rather than a subclass of PrismaClient because
 * `$extends` returns a *different* type from the client it extends. Providing the
 * extended client directly keeps full type inference at every call site, which a
 * `class PrismaService extends PrismaClient` shape would lose the moment the
 * extension is applied.
 */
@Global()
@Module({
  providers: [
    TenantContext,
    {
      provide: PRISMA,
      inject: [CONFIG, TenantContext],
      useFactory: (config: AppConfig, tenantContext: TenantContext) => createPrismaClient(config, tenantContext),
    },
    PrismaService,
  ],
  exports: [PRISMA, PrismaService, TenantContext],
})
export class PrismaModule {}
