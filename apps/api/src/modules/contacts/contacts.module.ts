import { Module } from '@nestjs/common';

import { ContactsController } from './contacts.controller';
import { ContactsService } from './contacts.service';

/**
 * Contacts — spec §7.
 *
 * Exported because campaigns resolve their audience through it and calls resolve the
 * number to dial, so the opt-out rules in §12 are applied in one place rather than
 * re-implemented per channel.
 */
@Module({
  controllers: [ContactsController],
  providers: [ContactsService],
  exports: [ContactsService],
})
export class ContactsModule {}
