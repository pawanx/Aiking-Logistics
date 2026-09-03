import { Module } from '@nestjs/common';

import { BillingModule } from '../billing/billing.module';
import { CommunicationsModule } from '../communications/communications.module';
import { ContactsModule } from '../contacts/contacts.module';
import { QueueModule } from '../queue/queue.module';
import { WalletModule } from '../wallet/wallet.module';
import { CallProcessors } from './call.processors';
import { CallsController } from './calls.controller';
import { CallsService } from './calls.service';

/**
 * AI voice calls — spec §5.
 *
 * Exported because the webhooks module drives the whole pipeline through
 * `applyCallEvent` / `applyRecordingReady`: a call's life after the dial is entirely a
 * sequence of provider callbacks, and those two methods are the only way in.
 */
@Module({
  imports: [QueueModule, ContactsModule, BillingModule, WalletModule, CommunicationsModule],
  controllers: [CallsController],
  providers: [CallsService, CallProcessors],
  exports: [CallsService],
})
export class CallsModule {}
