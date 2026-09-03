import { Module } from '@nestjs/common';

import { WalletModule } from '../wallet/wallet.module';
import { RazorpayService } from './razorpay.service';
import { TopupController } from './topup.controller';

/**
 * Razorpay top-ups (spec §8.1).
 *
 * `RazorpayService` is exported because the webhook module calls
 * `recordCapturedPayment` — the credit itself happens on the verified webhook, not on
 * the client's return from Checkout, so the module that owns the money must be
 * reachable from the module that receives the notification.
 */
@Module({
  imports: [WalletModule],
  controllers: [TopupController],
  providers: [RazorpayService],
  exports: [RazorpayService],
})
export class RazorpayModule {}
