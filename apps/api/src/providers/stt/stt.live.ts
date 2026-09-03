import { Inject, Injectable, Logger } from '@nestjs/common';
import { ProviderMode } from '@aiking/shared';

import { CONFIG, type AppConfig } from '../../config/configuration';
import {
  ProviderError,
  type SttProvider,
  type TranscribeInput,
  type TranscribeResult,
  type TranscriptTurn,
} from '../provider.types';

interface DeepgramUtterance {
  speaker?: number;
  transcript: string;
  start: number;
  end: number;
  confidence: number;
}

/**
 * Deepgram pre-recorded transcription — spec §5.1 step 2.
 *
 * `diarize=true` and `utterances=true` are what produce a *turn-by-turn* transcript
 * rather than one undivided block of text. The §6.4 timeline shows who said what, and
 * the summarizer's output is markedly better when it can tell the agent's words from
 * the customer's, so the turn structure is not cosmetic.
 *
 * `language=multi` is the default here: logistics calls in India are routinely
 * code-mixed Hindi and English within a single sentence, and pinning `en-IN` drops
 * the Hindi.
 */
@Injectable()
export class SttLiveProvider implements SttProvider {
  readonly name = 'stt';
  readonly mode = ProviderMode.LIVE;

  private readonly logger = new Logger(SttLiveProvider.name);

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
    if (!this.config.deepgram.apiKey) {
      throw new ProviderError('stt', 'transcribe', 'missing_api_key', 'DEEPGRAM_API_KEY is not configured', false);
    }
    if (!input.audioUrl && !input.audioBuffer) {
      throw new ProviderError('stt', 'transcribe', 'no_audio', 'Neither audioUrl nor audioBuffer was supplied', false);
    }

    const params = new URLSearchParams({
      model: this.config.deepgram.model,
      diarize: 'true',
      punctuate: 'true',
      utterances: 'true',
      smart_format: 'true',
      language: input.languageHint ?? 'multi',
    });

    const headers: Record<string, string> = { authorization: `Token ${this.config.deepgram.apiKey}` };
    // Deepgram takes either raw audio bytes or a JSON `{ url }` envelope. Typed as
    // the two concrete shapes rather than the DOM `BodyInit` — this project compiles
    // with the Node libs only, so that global does not exist here.
    let body: string | Uint8Array;

    if (input.audioBuffer) {
      headers['content-type'] = input.mimeType ?? 'audio/mpeg';
      body = input.audioBuffer;
    } else {
      headers['content-type'] = 'application/json';
      body = JSON.stringify({ url: input.audioUrl });
    }

    const response = await fetch(`https://api.deepgram.com/v1/listen?${params.toString()}`, {
      method: 'POST',
      headers,
      body,
    }).catch((error: unknown) => {
      throw new ProviderError('stt', 'transcribe', 'network_error', (error as Error).message, true);
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ProviderError(
        'stt',
        'transcribe',
        String(response.status),
        `Deepgram returned HTTP ${response.status}: ${text.slice(0, 200)}`,
        response.status >= 500 || response.status === 429,
        response.status,
      );
    }

    const payload = (await response.json()) as {
      metadata?: { duration?: number };
      results?: {
        utterances?: DeepgramUtterance[];
        channels?: { detected_language?: string; alternatives?: { transcript?: string; confidence?: number }[] }[];
      };
    };

    const utterances = payload.results?.utterances ?? [];

    // Speaker 0 is whoever spoke first. On an outbound call that is our agent,
    // since the answer URL plays the opening line — an assumption worth stating
    // because everything downstream depends on it.
    const turns: TranscriptTurn[] = utterances.map((utterance, index) => ({
      sequence: index + 1,
      speaker: (utterance.speaker ?? 0) === 0 ? 'agent' : 'customer',
      text: utterance.transcript,
      startMs: Math.round(utterance.start * 1000),
      endMs: Math.round(utterance.end * 1000),
      confidence: utterance.confidence,
    }));

    if (turns.length === 0) {
      const fallback = payload.results?.channels?.[0]?.alternatives?.[0];
      if (fallback?.transcript) {
        this.logger.warn('Deepgram returned no utterances; falling back to the flat transcript');
        turns.push({
          sequence: 1,
          speaker: 'customer',
          text: fallback.transcript,
          startMs: 0,
          endMs: Math.round((payload.metadata?.duration ?? 0) * 1000),
          confidence: fallback.confidence ?? 0,
        });
      }
    }

    const averageConfidence = turns.length
      ? turns.reduce((total, turn) => total + turn.confidence, 0) / turns.length
      : 0;

    return {
      turns,
      durationSeconds: Math.round(payload.metadata?.duration ?? 0),
      language: payload.results?.channels?.[0]?.detected_language ?? (input.languageHint ?? 'multi'),
      averageConfidence,
    };
  }
}
