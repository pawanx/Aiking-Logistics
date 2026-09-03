import { Inject, Injectable, Logger } from '@nestjs/common';
import { ProviderMode } from '@aiking/shared';

import { CONFIG, type AppConfig } from '../../config/configuration';
import { ProviderCallbackRegistry } from '../callback-registry';
import { MockBehavior } from '../mock-support';
import {
  ProviderError,
  type WhatsAppProvider,
  type WhatsAppSendResult,
  type WhatsAppTemplateSend,
  type WhatsAppTemplateStatus,
  type WhatsAppTextSend,
} from '../provider.types';

export interface MockWhatsAppOutboxEntry {
  providerMessageId: string;
  to: string;
  kind: 'template' | 'text';
  templateName?: string;
  variables?: string[];
  body?: string;
  phoneNumberId: string;
  sentAt: Date;
}

/**
 * Deterministic WhatsApp stand-in.
 *
 * Two things make this more than a stub:
 *
 * 1. **It validates like Meta does.** E.164 format, the 24-hour free-form window,
 *    template existence. Code that only ever met an always-yes mock discovers those
 *    rules in production instead.
 * 2. **It calls back.** A real send is followed by `sent` → `delivered` webhooks,
 *    which is what moves a campaign recipient off "queued" and what the §6.4
 *    timeline is built from. The callbacks go through the genuine webhook handler,
 *    signature check included.
 *
 * The outbox is what tests and the smoke script assert against — "did recipient X
 * actually receive template Y with these variables" — without a WhatsApp account.
 */
@Injectable()
export class WhatsAppMockProvider implements WhatsAppProvider {
  readonly name = 'whatsapp';
  readonly mode = ProviderMode.MOCK;

  private readonly logger = new Logger(WhatsAppMockProvider.name);
  private readonly outbox: MockWhatsAppOutboxEntry[] = [];

  /** Bounded so a long-running dev server cannot grow it without limit. */
  private static readonly OUTBOX_LIMIT = 5_000;

  /**
   * Numbers that always fail, so an error path can be triggered on purpose rather
   * than by raising the global failure rate. The seed data uses one of these for a
   * contact whose number is deliberately unreachable.
   */
  private static readonly UNREACHABLE_SUFFIXES = ['0000000000', '9999999999'];

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly behavior: MockBehavior,
    private readonly callbacks: ProviderCallbackRegistry,
  ) {}

  async sendTemplate(input: WhatsAppTemplateSend): Promise<WhatsAppSendResult> {
    await this.behavior.begin('whatsapp', 'sendTemplate');
    this.assertE164(input.to, 'sendTemplate');

    if (!input.templateName) {
      throw new ProviderError('whatsapp', 'sendTemplate', '132001', 'Template name is required', false);
    }

    const phoneNumberId = input.phoneNumberId || this.config.whatsapp.phoneNumberId || 'mock_sender';
    const providerMessageId = `wamid.${this.behavior.id('MOCK').toUpperCase()}`;

    this.record({
      providerMessageId,
      to: input.to,
      kind: 'template',
      templateName: input.templateName,
      variables: input.variables,
      phoneNumberId,
      sentAt: new Date(),
    });

    const unreachable = WhatsAppMockProvider.UNREACHABLE_SUFFIXES.some((suffix) => input.to.endsWith(suffix));

    // Meta accepts the request and reports failure asynchronously, which is the
    // behaviour that matters: the send succeeded, the delivery did not. That is
    // exactly the case spec §15 flags — a tenant must not be billed for it.
    await this.callbacks.emit(`whatsapp status for ${providerMessageId}`, async (sink) => {
      if (unreachable) {
        await sink.whatsappStatus({
          providerMessageId,
          to: input.to,
          phoneNumberId,
          status: 'failed',
          errorCode: 131026,
          errorMessage: 'Message undeliverable',
        });
        return;
      }
      await sink.whatsappStatus({ providerMessageId, to: input.to, phoneNumberId, status: 'sent' });
      await sink.whatsappStatus({ providerMessageId, to: input.to, phoneNumberId, status: 'delivered', delayMs: 250 });
    });

    return { providerMessageId, acceptedAt: new Date() };
  }

  async sendText(input: WhatsAppTextSend): Promise<WhatsAppSendResult> {
    await this.behavior.begin('whatsapp', 'sendText');
    this.assertE164(input.to, 'sendText');

    const phoneNumberId = input.phoneNumberId || this.config.whatsapp.phoneNumberId || 'mock_sender';
    const providerMessageId = `wamid.${this.behavior.id('MOCK').toUpperCase()}`;

    this.record({
      providerMessageId,
      to: input.to,
      kind: 'text',
      body: input.body,
      phoneNumberId,
      sentAt: new Date(),
    });

    await this.callbacks.emit(`whatsapp status for ${providerMessageId}`, async (sink) => {
      await sink.whatsappStatus({ providerMessageId, to: input.to, phoneNumberId, status: 'sent' });
      await sink.whatsappStatus({ providerMessageId, to: input.to, phoneNumberId, status: 'delivered', delayMs: 150 });
    });

    return { providerMessageId, acceptedAt: new Date() };
  }

  /**
   * Approval status.
   *
   * Templates named `*_pending` or `*_rejected` report as such, so the §6.1
   * "cannot send on an unapproved template" rule is testable — otherwise the only
   * way to see that branch would be to wait days for Meta to reject something.
   */
  async fetchTemplateStatus(name: string): Promise<WhatsAppTemplateStatus> {
    await this.behavior.delay();
    if (name.endsWith('_rejected')) {
      return { name, status: 'rejected', rejectionReason: 'Promotional content in a utility template' };
    }
    if (name.endsWith('_pending')) return { name, status: 'pending' };
    return { name, status: 'approved' };
  }

  /* ── test / smoke affordances ─────────────────────────────────────────────── */

  messages(): readonly MockWhatsAppOutboxEntry[] {
    return this.outbox;
  }

  messagesTo(phone: string): MockWhatsAppOutboxEntry[] {
    return this.outbox.filter((entry) => entry.to === phone);
  }

  clear(): void {
    this.outbox.length = 0;
  }

  private record(entry: MockWhatsAppOutboxEntry): void {
    this.outbox.push(entry);
    if (this.outbox.length > WhatsAppMockProvider.OUTBOX_LIMIT) {
      this.outbox.splice(0, this.outbox.length - WhatsAppMockProvider.OUTBOX_LIMIT);
    }
    this.logger.debug(`mock whatsapp → ${entry.to} (${entry.templateName ?? 'text'})`);
  }

  private assertE164(to: string, operation: string): void {
    if (!/^\+[1-9]\d{7,14}$/.test(to)) {
      throw new ProviderError(
        'whatsapp',
        operation,
        '100',
        `"${to}" is not a valid E.164 phone number`,
        false, // permanent: retrying a malformed number never helps
      );
    }
  }
}
