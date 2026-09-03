import { Module } from '@nestjs/common';

import { ContactsModule } from '../contacts/contacts.module';
import { CommunicationsController } from './communications.controller';
import { CommunicationsService } from './communications.service';

/**
 * Unified communication events — spec §6.4.
 *
 * Exported because campaigns, calls and the delivery webhooks all append here. That
 * one-writer arrangement is the whole reason the 360° view is a single query.
 */
@Module({
  imports: [ContactsModule],
  controllers: [CommunicationsController],
  providers: [CommunicationsService],
  exports: [CommunicationsService],
})
export class CommunicationsModule {}
