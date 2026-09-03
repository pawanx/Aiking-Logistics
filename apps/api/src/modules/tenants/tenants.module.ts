import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { WalletModule } from '../wallet/wallet.module';
import { TenantsController } from './tenants.controller';
import { TenantsService } from './tenants.service';

/**
 * Tenant lifecycle — spec §4.2.
 *
 * Imports `WalletModule` for the §8.3 onboarding free-credit grant and `AuthModule`
 * for password hashing, so the generated Manager credential uses the same bcrypt cost
 * as every other account.
 */
@Module({
  imports: [WalletModule, AuthModule],
  controllers: [TenantsController],
  providers: [TenantsService],
  exports: [TenantsService],
})
export class TenantsModule {}
