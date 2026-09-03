import { Injectable } from '@nestjs/common';
import { ProviderMode } from '@aiking/shared';

import { MockBehavior } from '../mock-support';
import {
  type CallSentiment,
  type LlmProvider,
  type SummarizeCallInput,
  type SummarizeCallResult,
  type TranscriptTurn,
} from '../provider.types';
import { SUMMARY_PROMPT_VERSION } from './llm.live';

/**
 * Escalation triggers — spec §5.2, "escalation to a human".
 *
 * Rule-based, and that is a deliberate limitation rather than an oversight: a real
 * model reads intent, this reads phrases. It is here so the *pipeline* around
 * escalation — flagging the call, surfacing it on the timeline, notifying the
 * manager — is exercised and tested end to end without an API key. The judgement
 * itself is the live adapter's job.
 */
const ESCALATION_PATTERNS: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /\b(escalate|escalat)/i, reason: 'Customer said they would escalate' },
  { pattern: /\b(senior|manager|supervisor)\b.*\b(call|talk|speak|back)\b/i, reason: 'Customer asked for a senior person' },
  { pattern: /\b(third|3rd|fourth|4th) time\b/i, reason: 'Repeated unresolved issue' },
  { pattern: /\b(damaged|damage|broken)\b/i, reason: 'Damage reported' },
  { pattern: /\b(nobody|no one) (responded|replied|answered)\b/i, reason: 'Previous contact went unanswered' },
  { pattern: /\b(complaint|complain|unacceptable|worst)\b/i, reason: 'Explicit complaint raised' },
];

const NEGATIVE_MARKERS = /\b(damaged|damage|broken|late|delay|delayed|not helping|stuck|overdue|complaint|escalate|angry|worst|unacceptable)\b/i;
const POSITIVE_MARKERS = /\b(all good|no complaints|perfect|thank you|thanks|on time|proper|glad|fine)\b/i;

/** Next-action extraction, ordered most specific first. */
const NEXT_ACTION_RULES: readonly { pattern: RegExp; action: (match: RegExpMatchArray) => string }[] = [
  { pattern: /\bafter (\d{1,2})\s*(am|pm|baje)/i, action: (m) => `Deliver after ${m[1]}${m[2].toLowerCase() === 'baje' ? ':00' : m[2].toUpperCase()}` },
  { pattern: /\breschedule\w*\b.*?\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i, action: (m) => `Reschedule delivery to ${capitalize(m[1])}` },
  { pattern: /\b(thursday|monday|tuesday|wednesday|friday|saturday|sunday)\b/i, action: (m) => `Follow up on ${capitalize(m[1])}` },
  { pattern: /\b(?:the )?(fifteenth|15th|tenth|10th|twentieth|20th)\b/i, action: (m) => `Collect payment on the ${m[1].toLowerCase()}` },
  { pattern: /\bUTR\b/i, action: () => 'Await UTR number from customer and reconcile the payment' },
  { pattern: /\be-?way bill\b/i, action: () => 'Send the e-way bill copy on WhatsApp' },
  { pattern: /\btracking link\b/i, action: () => 'Send the tracking link earlier for future consignments' },
  { pattern: /\bcall (?:me )?(?:back )?(today|tomorrow)\b/i, action: (m) => `Call the customer back ${m[1].toLowerCase()}` },
  { pattern: /\bone week\b/i, action: () => 'Follow up on payment in one week' },
];

/**
 * Deterministic call analysis.
 *
 * Given the same transcript it produces the same summary, so a test can assert on
 * the exact text — which is not something you can do against a real model, and is
 * exactly what you want when the thing under test is the surrounding pipeline
 * rather than the model.
 */
@Injectable()
export class LlmMockProvider implements LlmProvider {
  readonly name = 'llm';
  readonly mode = ProviderMode.MOCK;

  constructor(private readonly behavior: MockBehavior) {}

  async summarizeCall(input: SummarizeCallInput): Promise<SummarizeCallResult> {
    await this.behavior.begin('llm', 'summarizeCall');

    const customerText = input.turns
      .filter((turn) => turn.speaker === 'customer')
      .map((turn) => turn.text)
      .join(' ');
    const allText = input.turns.map((turn) => turn.text).join(' ');

    const escalation = ESCALATION_PATTERNS.find((rule) => rule.pattern.test(customerText));
    const sentiment = this.sentimentOf(customerText, Boolean(escalation));

    const nextAction = this.nextActionOf(allText, input.purpose);
    let priority: 'urgent' | 'high' | 'medium' | 'low';
    if (escalation || sentiment === 'negative') {
      priority = 'urgent';
    } else if (/reschedule|address|delay|change|payment|utr/i.test(allText)) {
      priority = 'high';
    } else if (nextAction && nextAction !== 'None') {
      priority = 'medium';
    } else {
      priority = 'low';
    }

    return {
      summary: this.summarize(input, sentiment, Boolean(escalation)),
      nextAction,
      priority,
      sentiment,
      escalate: Boolean(escalation),
      escalationReason: escalation?.reason,
      promptVersion: SUMMARY_PROMPT_VERSION,
    };
  }

  async nextUtterance(input: {
    turns: TranscriptTurn[];
    purpose: string;
    contactName?: string;
  }): Promise<{ text: string; endCall: boolean }> {
    await this.behavior.begin('llm', 'nextUtterance');

    const customerTurns = input.turns.filter((turn) => turn.speaker === 'customer').length;
    const last = input.turns.at(-1)?.text ?? '';

    if (input.turns.length === 0) {
      const greeting = input.contactName ? `Namaste ${input.contactName}` : 'Namaste';
      return { text: `${greeting}, main Infinity Fleet se bol raha hoon. Do minute baat kar sakte hain?`, endCall: false };
    }
    if (/\b(bye|thank you|thanks|theek hai|rakhta hoon|no complaints)\b/i.test(last) || customerTurns >= 4) {
      return { text: 'Thank you for your time. Have a good day.', endCall: true };
    }
    if (/\b(not|nahi|no)\b/i.test(last)) {
      return { text: 'Samajh gaya. Kya main aapko kal is time call kar sakta hoon?', endCall: false };
    }
    return { text: 'Theek hai, main yeh note kar leta hoon. Kuch aur bataana chahenge?', endCall: false };
  }

  private sentimentOf(customerText: string, escalated: boolean): CallSentiment {
    if (escalated) return 'negative';
    const negative = NEGATIVE_MARKERS.test(customerText);
    const positive = POSITIVE_MARKERS.test(customerText);
    if (negative && !positive) return 'negative';
    if (positive && !negative) return 'positive';
    return 'neutral';
  }

  private nextActionOf(text: string, purpose: string): string {
    for (const rule of NEXT_ACTION_RULES) {
      const match = text.match(rule.pattern);
      if (match) return rule.action(match);
    }
    return purpose === 'payment_reminder' ? 'Follow up on the outstanding invoice' : 'None';
  }

  private summarize(input: SummarizeCallInput, sentiment: CallSentiment, escalated: boolean): string {
    const who = input.contactName ?? 'The customer';
    const purposeLabel = input.purpose.replace(/_/g, ' ');
    const customerTurns = input.turns.filter((turn) => turn.speaker === 'customer');
    const firstResponse = customerTurns[0]?.text ?? '';
    const lastResponse = customerTurns.at(-1)?.text ?? '';

    const parts = [`Outbound ${purposeLabel} call with ${who}, ${input.turns.length} turns.`];

    if (firstResponse) {
      parts.push(`${who} responded: "${truncate(firstResponse, 120)}"`);
    }
    if (lastResponse && lastResponse !== firstResponse) {
      parts.push(`The call closed with: "${truncate(lastResponse, 120)}"`);
    }
    parts.push(
      escalated
        ? 'The customer asked for human involvement, so the call is flagged for escalation.'
        : `Overall tone was ${sentiment}.`,
    );

    return parts.join(' ');
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}
