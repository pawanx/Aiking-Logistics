import type { TranscriptTurn } from './provider.types';

/**
 * How a mock provider delivers the asynchronous callbacks a real provider would.
 *
 * A message send is only the first half of the story: WhatsApp reports delivery
 * later over a webhook (§6.1), an AI call produces a recording after it ends
 * (§5.1), Razorpay confirms capture out of band (§8.1). Without those callbacks a
 * campaign in mock mode would sit at "sent" forever and the §5.1 pipeline would
 * stop at step 1, so most of what is worth testing would be untestable.
 *
 * The implementation (MockCallbackSink, in the webhooks module) does not shortcut
 * anything: it builds the provider's real payload shape, signs it with the
 * configured secret, and feeds it through the same handler an inbound HTTP webhook
 * reaches — signature verification included. So mock mode exercises the webhook
 * path rather than bypassing it.
 *
 * Callbacks are dispatched through the queue rather than a `setTimeout`, which is
 * what makes them deterministic: with `QUEUE_DRIVER=inline` they run immediately
 * in-process, so a test can assert on the post-delivery state without sleeping,
 * and with BullMQ they arrive after a real delay like the genuine article.
 */
export interface ProviderCallbackSink {
  whatsappStatus(input: {
    providerMessageId: string;
    to: string;
    phoneNumberId: string;
    status: 'sent' | 'delivered' | 'read' | 'failed';
    errorCode?: number;
    errorMessage?: string;
    delayMs?: number;
  }): Promise<void>;

  /** Inbound reply from a contact — drives the §6.3 conversation flow. */
  whatsappInbound(input: {
    from: string;
    phoneNumberId: string;
    text: string;
    providerMessageId?: string;
    delayMs?: number;
  }): Promise<void>;

  emailEvent(input: {
    providerMessageId: string;
    to: string;
    event: 'delivered' | 'bounced' | 'complained' | 'opened' | 'clicked';
    reason?: string;
    delayMs?: number;
  }): Promise<void>;

  /**
   * Telephony lifecycle. `answered` then `completed` mirrors Plivo's own callback
   * pair, and `completed` is what carries the billable duration (§9.1).
   */
  callEvent(input: {
    providerCallId: string;
    event: 'ringing' | 'answered' | 'completed' | 'failed' | 'no_answer' | 'busy';
    durationSeconds?: number;
    recordingUrl?: string;
    hangupCause?: string;
    delayMs?: number;
  }): Promise<void>;

  /** Recording is available — step 2 of the §5.1 pipeline. */
  recordingReady(input: {
    providerCallId: string;
    recordingUrl: string;
    durationSeconds: number;
    turns?: TranscriptTurn[];
    delayMs?: number;
  }): Promise<void>;

  /** Razorpay `payment.captured` — the authoritative credit trigger (§8.1). */
  paymentCaptured(input: {
    orderId: string;
    paymentId: string;
    amountPaise: bigint;
    method?: string;
    delayMs?: number;
  }): Promise<void>;

  /**
   * Await every callback dispatched so far.
   *
   * Test-only affordance. With the inline queue driver callbacks have already run
   * by the time `sendTemplate` resolves; this exists so a test never has to guess.
   */
  drain(): Promise<void>;
}

export const PROVIDER_CALLBACK_SINK = 'PROVIDER_CALLBACK_SINK';
