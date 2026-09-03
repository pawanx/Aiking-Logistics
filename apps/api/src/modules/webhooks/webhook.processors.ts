import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { QueueName } from '@aiking/shared';

import { QueueService } from '../queue/queue.service';
import type { JobContext, ProviderCallbackJob } from '../queue/queue.types';
import { WebhooksService } from './webhooks.service';
import { TenantContext } from '../../common/tenant/tenant-context';

/**
 * BullMQ processor for `provider-callback` queue jobs.
 *
 * In mock mode, mock provider callbacks (such as simulated Razorpay payment capture,
 * Meta WhatsApp message delivery receipts, SES email bounces) are enqueued to the
 * `provider-callback` queue. This processor handles them asynchronously through the
 * same `WebhooksService` that HTTP requests reach, ensuring end-to-end verification,
 * deduplication, and domain dispatch.
 */
@Injectable()
export class WebhookProcessors implements OnModuleInit {
  private readonly logger = new Logger(WebhookProcessors.name);

  constructor(
    private readonly queue: QueueService,
    private readonly webhooks: WebhooksService,
    private readonly tenantContext: TenantContext,
  ) {}

  onModuleInit(): void {
    this.queue.register(QueueName.PROVIDER_CALLBACK, (payload: ProviderCallbackJob, context: JobContext) =>
      this.process(payload, context),
    );
  }

  async process(payload: ProviderCallbackJob, _context: JobContext): Promise<void> {
    this.logger.debug(`processing mock callback job: ${payload.description} (route=${payload.route})`);
    await this.tenantContext.runAsSystem(`process callback: ${payload.description}`, () =>
      this.webhooks.handleCallbackJob(payload),
    );
  }
}
