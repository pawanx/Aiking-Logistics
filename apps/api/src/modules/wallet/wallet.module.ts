import { Module } from '@nestjs/common';

import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';

/**
 * Exports `WalletService` because billing, campaigns and calls all charge through it
 * — spec §8.2 requires the balance check to happen before every paid provider call,
 * so there is exactly one component that knows how to move money.
 */
@Module({
  controllers: [WalletController],
  providers: [WalletService],
  exports: [WalletService],
})
export class WalletModule {}
