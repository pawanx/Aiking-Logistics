import { Module } from '@nestjs/common';

import { WalletModule } from '../wallet/wallet.module';
import { BillingController } from './billing.controller';
import { MeteringService } from './metering.service';
import { PricingService } from './pricing.service';

/**
 * Metering and pricing — spec §8.2, §9.3.
 *
 * Both services are exported: campaigns charge per message, calls charge per billed
 * minute, and both need the same estimate before they start. `MeteringService` is the
 * only component that writes `usage_events`, which is what keeps the metered record
 * and the wallet movement in one transaction.
 */
@Module({
  imports: [WalletModule],
  controllers: [BillingController],
  providers: [PricingService, MeteringService],
  exports: [PricingService, MeteringService],
})
export class BillingModule {}
