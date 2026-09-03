import { Inject, Injectable, Logger } from '@nestjs/common';
import { ProviderMode } from '@aiking/shared';

import { CONFIG, type AppConfig } from '../../config/configuration';
import {
  ProviderError,
  type CallRecording,
  type PlaceCallInput,
  type PlaceCallResult,
  type TelephonyProvider,
} from '../provider.types';

/**
 * Plivo outbound voice — spec §5.1 step 1.
 *
 * REST over `fetch` with HTTP Basic auth, which is Plivo's own scheme.
 *
 * The id returned by `Call/` is a `request_uuid`, not the `call_uuid` that later
 * callbacks carry. They are different values, and conflating them is the classic
 * way to end up unable to match a completion callback to the call that produced it.
 * The call record therefore stores the request uuid at creation and the callback
 * handler reconciles the call uuid onto the same row when the first event arrives.
 */
@Injectable()
export class TelephonyLiveProvider implements TelephonyProvider {
  readonly name = 'telephony';
  readonly mode = ProviderMode.LIVE;

  private readonly logger = new Logger(TelephonyLiveProvider.name);

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  private get authHeader(): string {
    const { authId, authToken } = this.config.plivo;
    return `Basic ${Buffer.from(`${authId}:${authToken}`).toString('base64')}`;
  }

  private get accountUrl(): string {
    return `https://api.plivo.com/v1/Account/${this.config.plivo.authId}`;
  }

  async placeCall(input: PlaceCallInput): Promise<PlaceCallResult> {
    const from = input.from || this.config.plivo.fromNumber;
    if (!from) {
      throw new ProviderError('telephony', 'placeCall', 'missing_from', 'No Plivo caller id is configured', false);
    }

    const response = await fetch(`${this.accountUrl}/Call/`, {
      method: 'POST',
      headers: { authorization: this.authHeader, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: from.replace(/^\+/, ''),
        to: input.to.replace(/^\+/, ''),
        answer_url: input.answerUrl,
        answer_method: 'POST',
        hangup_url: input.hangupUrl,
        hangup_method: 'POST',
        // Ring for 45s. Long enough for a driver to reach a phone, short enough
        // that a dead number does not hold a concurrency slot for a minute.
        ring_timeout: 45,
        machine_detection: 'hangup',
      }),
    }).catch((error: unknown) => {
      throw new ProviderError('telephony', 'placeCall', 'network_error', (error as Error).message, true);
    });

    const body = (await response.json().catch(() => ({}))) as {
      request_uuid?: string;
      message?: string;
      error?: string;
    };

    if (!response.ok || !body.request_uuid) {
      throw new ProviderError(
        'telephony',
        'placeCall',
        String(response.status),
        body.error ?? body.message ?? `Plivo returned HTTP ${response.status}`,
        response.status >= 500 || response.status === 429,
        response.status,
      );
    }

    return { providerCallId: body.request_uuid, requestedAt: new Date() };
  }

  async hangup(providerCallId: string): Promise<void> {
    const response = await fetch(`${this.accountUrl}/Call/${providerCallId}/`, {
      method: 'DELETE',
      headers: { authorization: this.authHeader },
    }).catch((error: unknown) => {
      throw new ProviderError('telephony', 'hangup', 'network_error', (error as Error).message, true);
    });

    // 404 means the call already ended, which is the outcome we wanted.
    if (!response.ok && response.status !== 404) {
      throw new ProviderError(
        'telephony',
        'hangup',
        String(response.status),
        `Plivo returned HTTP ${response.status} on hangup`,
        response.status >= 500,
        response.status,
      );
    }
  }

  async fetchRecording(providerCallId: string): Promise<CallRecording | null> {
    const response = await fetch(`${this.accountUrl}/Recording/?call_uuid=${encodeURIComponent(providerCallId)}`, {
      headers: { authorization: this.authHeader },
    }).catch((error: unknown) => {
      throw new ProviderError('telephony', 'fetchRecording', 'network_error', (error as Error).message, true);
    });

    if (!response.ok) {
      throw new ProviderError(
        'telephony',
        'fetchRecording',
        String(response.status),
        `Plivo returned HTTP ${response.status} fetching the recording`,
        response.status >= 500,
        response.status,
      );
    }

    const body = (await response.json().catch(() => ({}))) as {
      objects?: { recording_url?: string; duration?: string | number }[];
    };

    const recording = body.objects?.[0];
    if (!recording?.recording_url) return null;

    return {
      url: recording.recording_url,
      durationSeconds: Number(recording.duration ?? 0),
      mimeType: 'audio/mpeg',
    };
  }
}
