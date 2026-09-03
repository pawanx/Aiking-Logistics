import { Inject, Injectable, Logger } from '@nestjs/common';
import { ProviderMode } from '@aiking/shared';

import { CONFIG, type AppConfig } from '../../config/configuration';
import {
  ProviderError,
  type WhatsAppProvider,
  type WhatsAppSendResult,
  type WhatsAppTemplateSend,
  type WhatsAppTemplateStatus,
  type WhatsAppTextSend,
} from '../provider.types';

/**
 * Meta WhatsApp Cloud API — spec §6.1.
 *
 * Plain `fetch` against the Graph API rather than a vendor SDK: three endpoints
 * are needed, and the SDK would add a dependency with its own release cadence for
 * no benefit.
 *
 * Never exercised by the test suite, because it needs a real WhatsApp Business
 * account and an approved template. It exists so that switching
 * `WHATSAPP_MODE=live` is a configuration change rather than a code change, and
 * the error mapping below is the part worth reviewing: Meta's rate-limit and
 * template-rejection codes drive the queue's retry decision (spec §15).
 */
@Injectable()
export class WhatsAppLiveProvider implements WhatsAppProvider {
  readonly name = 'whatsapp';
  readonly mode = ProviderMode.LIVE;

  private readonly logger = new Logger(WhatsAppLiveProvider.name);

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  private get baseUrl(): string {
    return `https://graph.facebook.com/${this.config.whatsapp.apiVersion}`;
  }

  async sendTemplate(input: WhatsAppTemplateSend): Promise<WhatsAppSendResult> {
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: input.to,
      type: 'template',
      template: {
        name: input.templateName,
        language: { code: input.languageCode },
        components: input.variables.length
          ? [{ type: 'body', parameters: input.variables.map((text) => ({ type: 'text', text })) }]
          : [],
      },
    };
    return this.postMessage(input.phoneNumberId, payload, 'sendTemplate');
  }

  async sendText(input: WhatsAppTextSend): Promise<WhatsAppSendResult> {
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: input.to,
      type: 'text',
      text: { preview_url: false, body: input.body },
    };
    return this.postMessage(input.phoneNumberId, payload, 'sendText');
  }

  private async postMessage(
    phoneNumberId: string | undefined,
    payload: unknown,
    operation: string,
  ): Promise<WhatsAppSendResult> {
    const senderId = phoneNumberId || this.config.whatsapp.phoneNumberId;
    if (!senderId) {
      throw new ProviderError(
        'whatsapp',
        operation,
        'missing_phone_number_id',
        'No WhatsApp sender is configured for this tenant or the platform',
        false,
      );
    }

    const response = await fetch(`${this.baseUrl}/${senderId}/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.whatsapp.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    }).catch((error: unknown) => {
      throw new ProviderError('whatsapp', operation, 'network_error', (error as Error).message, true);
    });

    const body = (await response.json().catch(() => ({}))) as {
      messages?: { id: string }[];
      error?: { message?: string; code?: number; error_subcode?: number; type?: string };
    };

    if (!response.ok || body.error) {
      throw this.mapError(operation, response.status, body.error);
    }

    const messageId = body.messages?.[0]?.id;
    if (!messageId) {
      throw new ProviderError('whatsapp', operation, 'no_message_id', 'Meta accepted the send but returned no message id', true);
    }

    return { providerMessageId: messageId, acceptedAt: new Date() };
  }

  async fetchTemplateStatus(name: string): Promise<WhatsAppTemplateStatus> {
    const wabaId = this.config.whatsapp.businessAccountId;
    if (!wabaId) {
      return { name, status: 'unknown', rejectionReason: 'WHATSAPP_BUSINESS_ACCOUNT_ID is not configured' };
    }

    const url = `${this.baseUrl}/${wabaId}/message_templates?name=${encodeURIComponent(name)}`;
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${this.config.whatsapp.accessToken}` },
    }).catch((error: unknown) => {
      throw new ProviderError('whatsapp', 'fetchTemplateStatus', 'network_error', (error as Error).message, true);
    });

    const body = (await response.json().catch(() => ({}))) as {
      data?: { name: string; status: string; rejected_reason?: string }[];
    };

    const match = body.data?.find((entry) => entry.name === name);
    if (!match) return { name, status: 'unknown' };

    const status = match.status.toLowerCase();
    return {
      name,
      status: status === 'approved' ? 'approved' : status === 'rejected' ? 'rejected' : 'pending',
      rejectionReason: match.rejected_reason,
    };
  }

  /**
   * Meta error codes → retry decision.
   *
   * The distinction that matters: 130429 (throughput) and 4 (app rate limit) mean
   * "try again shortly", while 131026 (undeliverable) and 132xxx (template
   * problems) mean "this will never work" — retrying those burns quota and delays
   * the rest of a campaign for nothing.
   */
  private mapError(operation: string, httpStatus: number, error?: { message?: string; code?: number }): ProviderError {
    const code = error?.code;
    const message = error?.message ?? `Meta returned HTTP ${httpStatus}`;

    const permanent = new Set([
      131026, // Message undeliverable
      131047, // Re-engagement required (outside 24h window)
      132000, // Template param count mismatch
      132001, // Template does not exist
      132005, // Template hydrated text too long
      132007, // Template format character policy violated
      132012, // Template param format mismatch
      132015, // Template is paused
      132016, // Template is disabled
      100, // Invalid parameter
    ]);

    const retryable = code === undefined ? httpStatus >= 500 || httpStatus === 429 : !permanent.has(code);

    if (code === 130429 || code === 4 || httpStatus === 429) {
      this.logger.warn(`WhatsApp rate limited on ${operation} (code ${code ?? httpStatus}) — will retry with backoff`);
    }

    return new ProviderError('whatsapp', operation, String(code ?? httpStatus), message, retryable, httpStatus);
  }
}
