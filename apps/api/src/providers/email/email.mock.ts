import { Injectable, Logger } from '@nestjs/common';
import { ProviderMode } from '@aiking/shared';

import { ProviderCallbackRegistry } from '../callback-registry';
import { MockBehavior } from '../mock-support';
import { ProviderError, type EmailProvider, type EmailSend, type EmailSendResult } from '../provider.types';

export interface MockEmailOutboxEntry {
  providerMessageId: string;
  to: string;
  subject: string;
  html: string;
  from: string;
  referenceId?: string;
  sentAt: Date;
}

/**
 * Deterministic email stand-in.
 *
 * Bounces are modelled, not skipped. Anything at `@bounce.invalid` hard-bounces and
 * anything at `@complaint.invalid` files a complaint, so the suppression path has a
 * way to be exercised — and since bulk email reputation is decided by how bounces
 * are handled, that path is worth having covered before the first real send rather
 * than after.
 */
@Injectable()
export class EmailMockProvider implements EmailProvider {
  readonly name = 'email';
  readonly mode = ProviderMode.MOCK;

  private readonly logger = new Logger(EmailMockProvider.name);
  private readonly outbox: MockEmailOutboxEntry[] = [];

  private static readonly OUTBOX_LIMIT = 5_000;

  constructor(
    private readonly behavior: MockBehavior,
    private readonly callbacks: ProviderCallbackRegistry,
  ) {}

  async send(input: EmailSend): Promise<EmailSendResult> {
    await this.behavior.begin('email', 'send');

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.to)) {
      throw new ProviderError('email', 'send', '553', `"${input.to}" is not a valid email address`, false);
    }

    const providerMessageId = `<${this.behavior.id('mock')}@aiking.mock>`;
    const from = input.fromAddress ?? 'no-reply@aiking.mock';

    this.record({
      providerMessageId,
      to: input.to,
      subject: input.subject,
      html: input.html,
      from,
      referenceId: input.referenceId,
      sentAt: new Date(),
    });

    const domain = input.to.split('@')[1]?.toLowerCase() ?? '';

    await this.callbacks.emit(`email event for ${providerMessageId}`, async (sink) => {
      if (domain === 'bounce.invalid') {
        await sink.emailEvent({
          providerMessageId,
          to: input.to,
          event: 'bounced',
          reason: 'Recipient address does not exist',
          delayMs: 200,
        });
        return;
      }
      if (domain === 'complaint.invalid') {
        await sink.emailEvent({ providerMessageId, to: input.to, event: 'delivered' });
        await sink.emailEvent({ providerMessageId, to: input.to, event: 'complained', delayMs: 400 });
        return;
      }
      await sink.emailEvent({ providerMessageId, to: input.to, event: 'delivered', delayMs: 150 });
    });

    return { providerMessageId, acceptedAt: new Date() };
  }

  /* ── test / smoke affordances ─────────────────────────────────────────────── */

  messages(): readonly MockEmailOutboxEntry[] {
    return this.outbox;
  }

  messagesTo(address: string): MockEmailOutboxEntry[] {
    return this.outbox.filter((entry) => entry.to.toLowerCase() === address.toLowerCase());
  }

  clear(): void {
    this.outbox.length = 0;
  }

  private record(entry: MockEmailOutboxEntry): void {
    this.outbox.push(entry);
    if (this.outbox.length > EmailMockProvider.OUTBOX_LIMIT) {
      this.outbox.splice(0, this.outbox.length - EmailMockProvider.OUTBOX_LIMIT);
    }
    this.logger.debug(`mock email → ${entry.to} (${entry.subject})`);
  }
}
