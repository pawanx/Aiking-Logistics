import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { QueueName } from '@aiking/shared';
import * as crypto from 'node:crypto';

import {
  signEmailWebhook,
  signPlivoV3,
} from '../../common/crypto/signatures';
import { CONFIG, type AppConfig } from '../../config/configuration';
import { ProviderCallbackRegistry } from '../../providers/callback-registry';
import type { ProviderCallbackSink } from '../../providers/callback-sink';
import type { TranscriptTurn } from '../../providers/provider.types';
import { QueueService } from '../queue/queue.service';
import type { ProviderCallbackJob } from '../queue/queue.types';

/**
 * How mock providers deliver asynchronous callbacks matching real provider contracts.
 *
 * Implements `ProviderCallbackSink` (spec §8.1, §6.1, §5.1, §12) and signs realistic
 * JSON payloads using the corresponding provider webhook secrets, enqueueing them to the
 * `provider-callback` BullMQ queue for deterministic asynchronous dispatch.
 */
@Injectable()
export class MockCallbackSink implements ProviderCallbackSink, OnModuleInit {
  private readonly logger = new Logger(MockCallbackSink.name);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly callbacks: ProviderCallbackRegistry,
    private readonly queue: QueueService,
  ) {}

  onModuleInit(): void {
    this.callbacks.register(this);
    this.logger.log('MockCallbackSink registered with ProviderCallbackRegistry');
  }

  private async dispatch(job: ProviderCallbackJob, delayMs?: number): Promise<void> {
    await this.queue.enqueue(QueueName.PROVIDER_CALLBACK, job, {
      delayMs,
    });
  }

  async whatsappStatus(input: {
    providerMessageId: string;
    to: string;
    phoneNumberId: string;
    status: 'sent' | 'delivered' | 'read' | 'failed';
    errorCode?: number;
    errorMessage?: string;
    delayMs?: number;
  }): Promise<void> {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'entry_mock',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '+919999000000', phone_number_id: input.phoneNumberId },
                statuses: [
                  {
                    id: input.providerMessageId,
                    status: input.status,
                    timestamp: Math.floor(Date.now() / 1000).toString(),
                    recipient_id: input.to,
                    errors: input.errorCode
                      ? [{ code: input.errorCode, title: input.errorMessage ?? 'mock delivery failure' }]
                      : undefined,
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const rawBody = JSON.stringify(payload);
    const signature = `sha256=${crypto
      .createHmac('sha256', this.config.whatsapp.appSecret)
      .update(rawBody)
      .digest('hex')}`;

    await this.dispatch(
      {
        route: 'meta',
        rawBody,
        signature,
        description: `whatsapp status ${input.status} for ${input.providerMessageId}`,
      },
      input.delayMs,
    );
  }

  async whatsappInbound(input: {
    from: string;
    phoneNumberId: string;
    text: string;
    providerMessageId?: string;
    delayMs?: number;
  }): Promise<void> {
    const messageId = input.providerMessageId ?? `wamid_${Date.now()}`;
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'entry_mock',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '+919999000000', phone_number_id: input.phoneNumberId },
                messages: [
                  {
                    from: input.from,
                    id: messageId,
                    timestamp: Math.floor(Date.now() / 1000).toString(),
                    text: { body: input.text },
                    type: 'text',
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const rawBody = JSON.stringify(payload);
    const signature = `sha256=${crypto
      .createHmac('sha256', this.config.whatsapp.appSecret)
      .update(rawBody)
      .digest('hex')}`;

    await this.dispatch(
      {
        route: 'meta',
        rawBody,
        signature,
        description: `inbound whatsapp message from ${input.from}`,
      },
      input.delayMs,
    );
  }

  async emailEvent(input: {
    providerMessageId: string;
    to: string;
    event: 'delivered' | 'bounced' | 'complained' | 'opened' | 'clicked';
    reason?: string;
    delayMs?: number;
  }): Promise<void> {
    const typeMap: Record<string, string> = {
      delivered: 'Delivery',
      bounced: 'Bounce',
      complained: 'Complaint',
      opened: 'Open',
      clicked: 'Click',
    };
    const payload = {
      eventType: typeMap[input.event] ?? 'Delivery',
      mail: {
        messageId: input.providerMessageId,
        destination: [input.to],
        timestamp: new Date().toISOString(),
      },
      delivery: input.event === 'delivered' ? { timestamp: new Date().toISOString() } : undefined,
      bounce:
        input.event === 'bounced'
          ? {
              bounceType: 'Permanent',
              bouncedRecipients: [{ diagnosticCode: input.reason ?? 'mock bounce' }],
              timestamp: new Date().toISOString(),
            }
          : undefined,
    };

    const rawBody = JSON.stringify(payload);
    const signature = signEmailWebhook(this.config.email.webhookSecret, rawBody);
    await this.dispatch(
      {
        route: 'email',
        rawBody,
        signature,
        description: `email event ${input.event} for ${input.providerMessageId}`,
      },
      input.delayMs,
    );
  }

  async callEvent(input: {
    providerCallId: string;
    event: 'ringing' | 'answered' | 'completed' | 'failed' | 'no_answer' | 'busy';
    durationSeconds?: number;
    recordingUrl?: string;
    hangupCause?: string;
    delayMs?: number;
  }): Promise<void> {
    const payload = {
      CallUUID: input.providerCallId,
      Event: input.event,
      Duration: (input.durationSeconds ?? 0).toString(),
      HangupCause: input.hangupCause ?? 'NORMAL_CLEARING',
      RecordingUrl: input.recordingUrl,
    };

    const rawBody = JSON.stringify(payload);
    const url = `http://localhost:${this.config.api.port}/${this.config.api.globalPrefix}/webhooks/plivo/event/${input.providerCallId}`;
    const nonce = crypto.randomBytes(16).toString('hex');
    const signature = signPlivoV3(this.config.plivo.authToken, url, nonce);

    await this.dispatch(
      {
        route: 'plivo',
        rawBody,
        signature,
        url,
        nonce,
        description: `call event ${input.event} for ${input.providerCallId}`,
      },
      input.delayMs,
    );
  }

  async recordingReady(input: {
    providerCallId: string;
    recordingUrl: string;
    durationSeconds: number;
    turns?: TranscriptTurn[];
    delayMs?: number;
  }): Promise<void> {
    const payload = {
      CallUUID: input.providerCallId,
      Event: 'recording',
      RecordingUrl: input.recordingUrl,
      RecordingDuration: input.durationSeconds.toString(),
    };

    const rawBody = JSON.stringify(payload);
    const url = `http://localhost:${this.config.api.port}/${this.config.api.globalPrefix}/webhooks/plivo/recording/${input.providerCallId}`;
    const nonce = crypto.randomBytes(16).toString('hex');
    const signature = signPlivoV3(this.config.plivo.authToken, url, nonce);

    await this.dispatch(
      {
        route: 'plivo',
        rawBody,
        signature,
        url,
        nonce,
        description: `call recording ready for ${input.providerCallId}`,
      },
      input.delayMs,
    );
  }

  async paymentCaptured(input: {
    orderId: string;
    paymentId: string;
    amountPaise: bigint;
    method?: string;
    delayMs?: number;
  }): Promise<void> {
    const payload = {
      entity: 'event',
      account_id: 'acc_mock',
      event: 'payment.captured',
      contains: ['payment'],
      payload: {
        payment: {
          entity: {
            id: input.paymentId,
            entity: 'payment',
            amount: Number(input.amountPaise),
            currency: 'INR',
            status: 'captured',
            order_id: input.orderId,
            method: input.method ?? 'upi',
          },
        },
      },
      created_at: Math.floor(Date.now() / 1000),
    };

    const rawBody = JSON.stringify(payload);
    const signature = crypto
      .createHmac('sha256', this.config.razorpay.webhookSecret)
      .update(rawBody)
      .digest('hex');

    await this.dispatch(
      {
        route: 'razorpay',
        rawBody,
        signature,
        description: `razorpay payment.captured for ${input.paymentId}`,
      },
      input.delayMs,
    );
  }

  async drain(): Promise<void> {
    // No-op for BullMQ
  }
}
