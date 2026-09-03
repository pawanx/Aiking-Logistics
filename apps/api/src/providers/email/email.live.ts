import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ProviderMode } from '@aiking/shared';
import nodemailer, { type Transporter } from 'nodemailer';

import { CONFIG, type AppConfig } from '../../config/configuration';
import { ProviderError, type EmailProvider, type EmailSend, type EmailSendResult } from '../provider.types';

/**
 * Transactional and bulk email — spec §6.2.
 *
 * SMTP via nodemailer, which covers both deployment shapes the spec mentions: a
 * plain SMTP relay, and Amazon SES through its SMTP interface. Using SES's SMTP
 * endpoint rather than the SES API keeps `@aws-sdk/client-ses` out of the
 * dependency tree while producing the same delivery, the same DKIM signing and the
 * same bounce handling — the only thing it costs is the API-only features (bulk
 * templated sends, per-message configuration sets), and neither is needed here.
 *
 * One consequence worth being explicit about: `EMAIL_TRANSPORT=ses` selects SES's
 * SMTP host and expects SES SMTP credentials, and delivery notifications still
 * arrive via SNS, whose RSA signature verification is the remaining production
 * work noted in `signatures.ts`.
 */
@Injectable()
export class EmailLiveProvider implements EmailProvider, OnModuleDestroy {
  readonly name = 'email';
  readonly mode = ProviderMode.LIVE;

  private readonly logger = new Logger(EmailLiveProvider.name);
  private transporter?: Transporter;

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  private get transport(): Transporter {
    if (this.transporter) return this.transporter;

    const { email } = this.config;
    const host = email.transport === 'ses' ? `email-smtp.${email.sesRegion}.amazonaws.com` : email.smtp.host;
    const port = email.transport === 'ses' ? 587 : email.smtp.port;

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure: email.transport === 'ses' ? false : email.smtp.secure,
      requireTLS: email.transport === 'ses',
      auth: email.smtp.user ? { user: email.smtp.user, pass: email.smtp.pass } : undefined,
      // Connection pooling matters for bulk: a campaign to a few thousand
      // recipients otherwise opens and tears down a TLS session per message.
      pool: true,
      maxConnections: 5,
      maxMessages: 100,
    });

    this.logger.log(`Email transport ready (${email.transport} → ${host}:${port})`);
    return this.transporter;
  }

  async send(input: EmailSend): Promise<EmailSendResult> {
    const fromAddress = input.fromAddress ?? this.config.email.from;
    const from = input.fromName && input.fromAddress ? `${input.fromName} <${input.fromAddress}>` : fromAddress;

    try {
      const result = await this.transport.sendMail({
        from,
        to: input.toName ? `${input.toName} <${input.to}>` : input.to,
        subject: input.subject,
        html: input.html,
        text: input.text ?? stripHtml(input.html),
        // Echoed back on the delivery notification, which is how a bounce is
        // matched to the campaign recipient that caused it.
        headers: input.referenceId ? { 'X-Aiking-Reference': input.referenceId } : undefined,
      });

      return { providerMessageId: result.messageId, acceptedAt: new Date() };
    } catch (error) {
      throw this.mapError(error);
    }
  }

  /**
   * SMTP reply codes → retry decision.
   *
   * 4xx is a transient failure by definition and 5xx is permanent, which maps
   * directly onto whether the queue should retry. A hard bounce retried twenty
   * times damages sender reputation, so getting this wrong is not free.
   */
  private mapError(error: unknown): ProviderError {
    const typed = error as { responseCode?: number; code?: string; message?: string };
    const responseCode = typed.responseCode;
    const retryable =
      responseCode === undefined
        ? ['ETIMEDOUT', 'ECONNRESET', 'ECONNECTION', 'ESOCKET', 'EDNS'].includes(typed.code ?? '')
        : responseCode >= 400 && responseCode < 500;

    return new ProviderError(
      'email',
      'send',
      String(responseCode ?? typed.code ?? 'unknown'),
      typed.message ?? 'SMTP send failed',
      retryable,
    );
  }

  async onModuleDestroy(): Promise<void> {
    this.transporter?.close();
  }
}

/** Plain-text alternative, so a message is not flagged for having an HTML part only. */
function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
