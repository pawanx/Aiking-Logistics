import { Module } from '@nestjs/common';

import { CallsModule } from '../calls/calls.module';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { RazorpayModule } from '../razorpay/razorpay.module';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { WebhookProcessors } from './webhook.processors';
import { MockCallbackSink } from './mock-callback-sink.service';

/**
 * Inbound provider webhooks — spec §8.1, §6.1, §6.3, §5.1, §12.
 *
 * This module is the receiving end for every provider callback: Razorpay payment
 * notifications, Meta WhatsApp delivery receipts, Plivo call events, and SES
 * email delivery notifications.
 *
 * It imports the domain modules whose services `WebhooksService` dispatches to
 * after signature verification:
 *   - `RazorpayModule` → `recordCapturedPayment` / `recordFailedPayment`
 *   - `CampaignsModule` → `applyDeliveryStatus` / `applyInboundMessage`
 *   - `CallsModule` → `applyCallEvent` / `applyRecordingReady`
 */
@Module({
  imports: [RazorpayModule, CampaignsModule, CallsModule],
  controllers: [WebhooksController],
  providers: [WebhooksService, WebhookProcessors, MockCallbackSink],
  exports: [WebhooksService, WebhookProcessors, MockCallbackSink],
})
export class WebhooksModule {}
