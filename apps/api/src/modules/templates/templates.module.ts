import { Module } from '@nestjs/common';

import { TemplatesController } from './templates.controller';
import { TemplatesService } from './templates.service';

/**
 * Templates — spec §6.1.
 *
 * Exported because campaigns call `assertLaunchable()` and the Meta webhook handler calls
 * `recordDecision()`; the approval rule lives in one place.
 */
@Module({
  controllers: [TemplatesController],
  providers: [TemplatesService],
  exports: [TemplatesService],
})
export class TemplatesModule {}
