import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { CONFIG, type AppConfig } from '../config/configuration';
import { PrismaModule } from './prisma/prisma.module';
import { TenantAccessService } from './tenant/tenant-access.service';
import { TenantContextMiddleware } from './tenant/tenant-context.middleware';
import { TenantSettingsService } from './tenant/tenant-settings.service';

/**
 * Cross-cutting infrastructure: database, tenant context, JWT.
 *
 * `JwtModule` is registered `global: true` because TenantContextMiddleware needs
 * `JwtService` before any feature module is resolved, and it must use the same
 * secret the auth module signs with — one registration removes the possibility of
 * those two drifting apart.
 */
@Global()
@Module({
  imports: [
    PrismaModule,
    JwtModule.registerAsync({
      global: true,
      inject: [CONFIG],
      useFactory: (config: AppConfig) => ({
        secret: config.auth.jwtSecret,
        signOptions: { expiresIn: config.auth.jwtExpiresIn },
      }),
    }),
  ],
  providers: [TenantSettingsService, TenantAccessService, TenantContextMiddleware],
  exports: [PrismaModule, JwtModule, TenantSettingsService, TenantAccessService, TenantContextMiddleware],
})
export class CommonModule {}
