import { Global, Module } from '@nestjs/common';

import { QueueService } from './queue.service';

/**
 * Global because nearly every feature module enqueues something, and threading an
 * import of this through all of them adds noise without adding structure.
 */
@Global()
@Module({
  providers: [QueueService],
  exports: [QueueService],
})
export class QueueModule {}
