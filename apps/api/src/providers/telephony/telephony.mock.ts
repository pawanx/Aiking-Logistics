import { Inject, Injectable, Logger } from '@nestjs/common';
import { ProviderMode } from '@aiking/shared';

import { CONFIG, type AppConfig } from '../../config/configuration';
import { ProviderCallbackRegistry } from '../callback-registry';
import { MockBehavior } from '../mock-support';
import {
  ProviderError,
  type CallRecording,
  type PlaceCallInput,
  type PlaceCallResult,
  type TelephonyProvider,
} from '../provider.types';

interface MockCall {
  providerCallId: string;
  to: string;
  from: string;
  placedAt: Date;
  outcome: 'completed' | 'no_answer' | 'busy' | 'failed';
  durationSeconds: number;
  recordingUrl?: string;
}

/**
 * Deterministic telephony stand-in that drives the whole §5.1 call lifecycle.
 *
 * Outcome is decided by the last digit of the number, not by chance, so a test can
 * ask for a specific one:
 *
 *   - `…0` → no answer   (rings out, no recording, **not billable**)
 *   - `…1` → busy        (**not billable**)
 *   - `…2` → failed      (**not billable**)
 *   - anything else → answered and completed, 45–285 seconds
 *
 * The unbillable outcomes are the important ones. Spec §9.1 bills per AI-call
 * minute, and a call that never connected has no minutes — so the reservation taken
 * before dialling has to be released in full. That is the §15 risk about billing for
 * something that failed at the provider, and it needs a way to be provoked
 * deliberately rather than waiting for a real number not to answer.
 *
 * Durations land just over a minute boundary often enough that `ceil()` rounding
 * (§9.1) is exercised rather than assumed.
 */
@Injectable()
export class TelephonyMockProvider implements TelephonyProvider {
  readonly name = 'telephony';
  readonly mode = ProviderMode.MOCK;

  private readonly logger = new Logger(TelephonyMockProvider.name);
  private readonly calls = new Map<string, MockCall>();

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly behavior: MockBehavior,
    private readonly callbacks: ProviderCallbackRegistry,
  ) {}

  async placeCall(input: PlaceCallInput): Promise<PlaceCallResult> {
    await this.behavior.begin('telephony', 'placeCall');

    if (!/^\+[1-9]\d{7,14}$/.test(input.to)) {
      throw new ProviderError('telephony', 'placeCall', 'invalid_to', `"${input.to}" is not a valid E.164 number`, false);
    }

    const providerCallId = this.behavior.id('mockcall');
    const outcome = this.outcomeFor(input.to);

    // 45–285 seconds, and deliberately not a round number of minutes: a duration
    // of 61 seconds must bill as two minutes, and a mock that only ever returned
    // 60 or 120 would never show whether it does.
    const durationSeconds = outcome === 'completed' ? 45 + this.behavior.rng.int(240) + 1 : 0;

    const call: MockCall = {
      providerCallId,
      to: input.to,
      from: input.from || this.config.plivo.fromNumber,
      placedAt: new Date(),
      outcome,
      durationSeconds,
      recordingUrl: outcome === 'completed' && input.record ? `mock://recordings/${providerCallId}.mp3` : undefined,
    };
    this.calls.set(providerCallId, call);
    this.logger.debug(`mock call → ${input.to} (${outcome}, ${durationSeconds}s)`);

    await this.callbacks.emit(`call lifecycle for ${providerCallId}`, async (sink) => {
      await sink.callEvent({ providerCallId, event: 'ringing' });

      if (outcome !== 'completed') {
        await sink.callEvent({
          providerCallId,
          event: outcome,
          durationSeconds: 0,
          hangupCause: outcome === 'busy' ? 'USER_BUSY' : outcome === 'no_answer' ? 'NO_ANSWER' : 'FAILED',
          delayMs: 200,
        });
        return;
      }

      await sink.callEvent({ providerCallId, event: 'answered', delayMs: 150 });
      await sink.callEvent({
        providerCallId,
        event: 'completed',
        durationSeconds,
        recordingUrl: call.recordingUrl,
        hangupCause: 'NORMAL_CLEARING',
        delayMs: 300,
      });

      if (call.recordingUrl) {
        await sink.recordingReady({
          providerCallId,
          recordingUrl: call.recordingUrl,
          durationSeconds,
          delayMs: 400,
        });
      }
    });

    return { providerCallId, requestedAt: call.placedAt };
  }

  async hangup(providerCallId: string): Promise<void> {
    await this.behavior.delay();
    this.calls.delete(providerCallId);
  }

  async fetchRecording(providerCallId: string): Promise<CallRecording | null> {
    await this.behavior.delay();
    const call = this.calls.get(providerCallId);
    if (!call?.recordingUrl) return null;
    return { url: call.recordingUrl, durationSeconds: call.durationSeconds, mimeType: 'audio/mpeg' };
  }

  /* ── test / smoke affordances ─────────────────────────────────────────────── */

  placedCalls(): MockCall[] {
    return [...this.calls.values()];
  }

  clear(): void {
    this.calls.clear();
  }

  private outcomeFor(to: string): MockCall['outcome'] {
    switch (to.slice(-1)) {
      case '0':
        return 'no_answer';
      case '1':
        return 'busy';
      case '2':
        return 'failed';
      default:
        return 'completed';
    }
  }
}
