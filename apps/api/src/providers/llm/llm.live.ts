import { Inject, Injectable, Logger } from '@nestjs/common';
import { ProviderMode } from '@aiking/shared';

import { CONFIG, type AppConfig } from '../../config/configuration';
import {
  ProviderError,
  type CallSentiment,
  type LlmProvider,
  type SummarizeCallInput,
  type SummarizeCallResult,
  type TranscriptTurn,
} from '../provider.types';

/** Bumped whenever the prompt changes, and stored on the call row (§5.1 step 3). */
export const SUMMARY_PROMPT_VERSION = 'summary-v1';

/**
 * Google Gemini — spec §5.1 steps 3 and 4.
 *
 * `generateContent` over `fetch`, with `responseMimeType: application/json` and an
 * explicit `responseSchema`. That combination is the point: a summarizer that
 * returns prose has to be parsed with regexes, and a model that decides to add a
 * preamble breaks the parse. Constrained decoding means the response is either valid
 * against the schema or an error, with no half-parsed middle state.
 *
 * `promptVersion` travels back on the result and is stored on the call. When a
 * summary is questioned six weeks later, the version says which prompt produced it —
 * without it, an improved prompt silently invalidates every explanation of past
 * output.
 */
@Injectable()
export class LlmLiveProvider implements LlmProvider {
  readonly name = 'llm';
  readonly mode = ProviderMode.LIVE;

  private readonly logger = new Logger(LlmLiveProvider.name);

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  async summarizeCall(input: SummarizeCallInput): Promise<SummarizeCallResult> {
    const transcript = input.turns
      .map((turn) => `${turn.speaker === 'agent' ? 'Agent' : 'Customer'}: ${turn.text}`)
      .join('\n');

    const prompt = [
      `You are analysing a recorded outbound business call made by ${input.tenantName ?? 'a logistics company'}.`,
      `Call purpose: ${input.purpose}.`,
      input.contactName ? `Customer name: ${input.contactName}.` : '',
      '',
      'Transcript:',
      transcript,
      '',
      'Produce:',
      '- summary: 2-3 sentences on what was discussed and agreed. Facts from the transcript only.',
      '- nextAction: the single concrete follow-up, with a date if one was stated. "None" if there is none.',
      '- priority: "urgent" (critical complaint, escalation or delivery dispute), "high" (reschedule, address update or prompt follow-up needed), "medium" (general inquiry or verification), or "low" (smooth confirmation, no action needed).',
      '- sentiment: positive, neutral or negative — the customer\'s tone, not the agent\'s.',
      '- escalate: true only if the customer asked for a human or a manager, threatened to escalate,',
      '  raised a repeated unresolved complaint, or was clearly angry.',
      '- escalationReason: one sentence when escalate is true, otherwise an empty string.',
    ]
      .filter(Boolean)
      .join('\n');

    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        // Low but not zero: summarization at 0 tends to parrot transcript fragments
        // verbatim rather than condensing.
        temperature: 0.2,
        maxOutputTokens: 800,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            summary: { type: 'STRING' },
            nextAction: { type: 'STRING' },
            priority: { type: 'STRING', enum: ['urgent', 'high', 'medium', 'low'] },
            sentiment: { type: 'STRING', enum: ['positive', 'neutral', 'negative'] },
            escalate: { type: 'BOOLEAN' },
            escalationReason: { type: 'STRING' },
          },
          required: ['summary', 'nextAction', 'priority', 'sentiment', 'escalate'],
        },
      },
    };

    const parsed = await this.generate<{
      summary: string;
      nextAction: string;
      priority: string;
      sentiment: string;
      escalate: boolean;
      escalationReason?: string;
    }>('summarizeCall', body);

    const sentiment: CallSentiment =
      parsed.sentiment === 'positive' || parsed.sentiment === 'negative' ? parsed.sentiment : 'neutral';

    const priority: 'urgent' | 'high' | 'medium' | 'low' =
      parsed.priority === 'urgent' || parsed.priority === 'high' || parsed.priority === 'low'
        ? parsed.priority
        : (parsed.escalate ? 'urgent' : 'medium');

    return {
      summary: parsed.summary.trim(),
      nextAction: parsed.nextAction.trim() || 'None',
      priority,
      sentiment,
      escalate: parsed.escalate === true,
      escalationReason: parsed.escalate ? (parsed.escalationReason?.trim() || 'Customer requested escalation') : undefined,
      promptVersion: SUMMARY_PROMPT_VERSION,
    };
  }

  async nextUtterance(input: {
    turns: TranscriptTurn[];
    purpose: string;
    contactName?: string;
  }): Promise<{ text: string; endCall: boolean }> {
    const history = input.turns
      .map((turn) => `${turn.speaker === 'agent' ? 'Agent' : 'Customer'}: ${turn.text}`)
      .join('\n');

    const prompt = [
      `You are a polite phone agent for a logistics company. Call purpose: ${input.purpose}.`,
      input.contactName ? `You are speaking to ${input.contactName}.` : '',
      'Reply with one short spoken sentence — under 30 words, no markdown, no stage directions.',
      'Set endCall to true once the purpose is met or the customer asks to end the call.',
      '',
      history ? `Conversation so far:\n${history}` : 'The customer has just answered the phone.',
    ]
      .filter(Boolean)
      .join('\n');

    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        // Higher than the summarizer: an identical reply every time reads as a robot.
        temperature: 0.7,
        maxOutputTokens: 150,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: { text: { type: 'STRING' }, endCall: { type: 'BOOLEAN' } },
          required: ['text', 'endCall'],
        },
      },
    };

    const parsed = await this.generate<{ text: string; endCall: boolean }>('nextUtterance', body);
    return { text: parsed.text.trim(), endCall: parsed.endCall === true };
  }

  private async generate<T>(operation: string, body: unknown): Promise<T> {
    if (!this.config.gemini.apiKey) {
      throw new ProviderError('llm', operation, 'missing_api_key', 'GEMINI_API_KEY is not configured', false);
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.config.gemini.model}:generateContent`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Header rather than a query parameter, so the key cannot end up in an
        // access log or a proxy trace.
        'x-goog-api-key': this.config.gemini.apiKey,
      },
      body: JSON.stringify(body),
    }).catch((error: unknown) => {
      throw new ProviderError('llm', operation, 'network_error', (error as Error).message, true);
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ProviderError(
        'llm',
        operation,
        String(response.status),
        `Gemini returned HTTP ${response.status}: ${text.slice(0, 200)}`,
        response.status >= 500 || response.status === 429,
        response.status,
      );
    }

    const payload = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
      promptFeedback?: { blockReason?: string };
    };

    if (payload.promptFeedback?.blockReason) {
      throw new ProviderError(
        'llm',
        operation,
        `blocked_${payload.promptFeedback.blockReason}`,
        `Gemini blocked the request: ${payload.promptFeedback.blockReason}`,
        false,
      );
    }

    const text = payload.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new ProviderError('llm', operation, 'empty_response', 'Gemini returned no content', true);
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      // Schema-constrained output should make this unreachable; treated as retryable
      // because when it does happen it is a transient decoding fault, not a bad prompt.
      this.logger.warn(`Gemini ${operation} returned unparseable JSON: ${text.slice(0, 200)}`);
      throw new ProviderError('llm', operation, 'invalid_json', 'Gemini returned malformed JSON', true);
    }
  }
}
