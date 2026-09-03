import type { ProviderMode } from '@aiking/shared';

/**
 * Provider contracts — spec §1.2 and §5's "configurable provider layer".
 *
 * The spec asks for this layer explicitly so Gemini Live can replace the
 * Deepgram→Gemini→TTS chain "without a pipeline rewrite". It earns its keep twice:
 * once for that swap, and once for testability, because every provider here needs
 * a paid account and Meta template approval has multi-day lead time (§6.1). A
 * `Mock` implementation of each interface is what lets the whole product — bulk
 * sends, AI calls, wallet metering, the 360° timeline — run end to end with no
 * credentials at all.
 *
 * These are deliberately narrow. Each method is the smallest thing the domain
 * needs, expressed in domain terms, so a swap of vendor changes one adapter rather
 * than every caller.
 */

export interface ProviderInfo {
  readonly name: string;
  readonly mode: ProviderMode;
}

/**
 * A normalized provider failure.
 *
 * `retryable` is the field the queue cares about: a rate limit should back off and
 * retry, an invalid phone number should not (spec §15's "WhatsApp rate limits and
 * template rejection" risk). Adapters map vendor-specific codes onto this so the
 * retry policy lives in one place.
 */
export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly operation: string,
    readonly providerCode: string,
    message: string,
    readonly retryable: boolean,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  static from(provider: string, operation: string, error: unknown): ProviderError {
    if (error instanceof ProviderError) return error;
    const message = error instanceof Error ? error.message : String(error);
    // An unclassified error is treated as retryable: a transient network fault is
    // far more common than a permanent one, and the reservation is released either
    // way so a retry cannot double-charge.
    return new ProviderError(provider, operation, 'unknown', message, true);
  }
}

/* ── WhatsApp (Meta Cloud API) — spec §6.1 ─────────────────────────────────── */

export interface WhatsAppSendResult {
  providerMessageId: string;
  acceptedAt: Date;
}

export interface WhatsAppTemplateSend {
  to: string;
  templateName: string;
  languageCode: string;
  /** Positional body variables, `{{1}}` first. */
  variables: string[];
  /** Per-tenant sender, falling back to the platform number. */
  phoneNumberId?: string;
}

export interface WhatsAppTextSend {
  to: string;
  body: string;
  phoneNumberId?: string;
}

export interface WhatsAppTemplateStatus {
  name: string;
  status: 'approved' | 'pending' | 'rejected' | 'unknown';
  rejectionReason?: string;
}

export interface WhatsAppProvider extends ProviderInfo {
  sendTemplate(input: WhatsAppTemplateSend): Promise<WhatsAppSendResult>;
  /**
   * Free-form text, valid only inside the 24-hour customer service window. Used
   * for replies in the §6.3 inbound flow, never for bulk sends.
   */
  sendText(input: WhatsAppTextSend): Promise<WhatsAppSendResult>;
  fetchTemplateStatus(name: string): Promise<WhatsAppTemplateStatus>;
}

export const WHATSAPP_PROVIDER = 'WHATSAPP_PROVIDER';

/* ── Email (SES / SMTP) — spec §6.2 ────────────────────────────────────────── */

export interface EmailSend {
  to: string;
  toName?: string;
  subject: string;
  html: string;
  text?: string;
  fromName?: string;
  fromAddress?: string;
  /** Correlation id echoed back on the delivery callback. */
  referenceId?: string;
}

export interface EmailSendResult {
  providerMessageId: string;
  acceptedAt: Date;
}

export interface EmailProvider extends ProviderInfo {
  send(input: EmailSend): Promise<EmailSendResult>;
}

export const EMAIL_PROVIDER = 'EMAIL_PROVIDER';

/* ── Telephony (Plivo) — spec §5.1 step 1 ──────────────────────────────────── */

export interface PlaceCallInput {
  to: string;
  from?: string;
  /** Where the provider fetches call control instructions. */
  answerUrl: string;
  hangupUrl: string;
  /** Provider-side recording, since §10 classifies recordings as High sensitivity. */
  record: boolean;
}

export interface PlaceCallResult {
  providerCallId: string;
  requestedAt: Date;
}

export interface CallRecording {
  url: string;
  durationSeconds: number;
  mimeType: string;
}

export interface TelephonyProvider extends ProviderInfo {
  placeCall(input: PlaceCallInput): Promise<PlaceCallResult>;
  hangup(providerCallId: string): Promise<void>;
  fetchRecording(providerCallId: string): Promise<CallRecording | null>;
}

export const TELEPHONY_PROVIDER = 'TELEPHONY_PROVIDER';

/* ── Speech to text (Deepgram) — spec §5.1 step 2 ──────────────────────────── */

export type TranscriptSpeaker = 'agent' | 'customer';

export interface TranscriptTurn {
  sequence: number;
  speaker: TranscriptSpeaker;
  text: string;
  startMs: number;
  endMs: number;
  confidence: number;
}

export interface TranscribeInput {
  audioUrl?: string;
  audioBuffer?: Buffer;
  mimeType?: string;
  /** BCP-47, e.g. `en-IN` / `hi`. Logistics calls in India are often code-mixed. */
  languageHint?: string;
  /** Context that makes a mock transcript resemble the real conversation. */
  context?: { contactName?: string; purpose?: string; tenantName?: string };
}

export interface TranscribeResult {
  turns: TranscriptTurn[];
  durationSeconds: number;
  language: string;
  averageConfidence: number;
}

export interface SttProvider extends ProviderInfo {
  transcribe(input: TranscribeInput): Promise<TranscribeResult>;
}

export const STT_PROVIDER = 'STT_PROVIDER';

/* ── LLM (Gemini) — spec §5.1 steps 3 and 4 ────────────────────────────────── */

export type CallSentiment = 'positive' | 'neutral' | 'negative';

export interface SummarizeCallInput {
  turns: TranscriptTurn[];
  purpose: string;
  contactName?: string;
  tenantName?: string;
  /** Prompt version, recorded on the call so a summary stays explainable. */
  promptVersion: string;
}

export interface SummarizeCallResult {
  summary: string;
  nextAction: string;
  priority: 'urgent' | 'high' | 'medium' | 'low';
  sentiment: CallSentiment;
  /** Spec §5.2 — hand off to a human. */
  escalate: boolean;
  escalationReason?: string;
  promptVersion: string;
}

export interface LlmProvider extends ProviderInfo {
  summarizeCall(input: SummarizeCallInput): Promise<SummarizeCallResult>;
  /**
   * One conversational turn. Present so the §5.1 pipeline has a real seam for the
   * Gemini Live swap the spec anticipates; the live adapter implements it against
   * the standard API, and the mock plays a scripted logistics conversation.
   */
  nextUtterance(input: {
    turns: TranscriptTurn[];
    purpose: string;
    contactName?: string;
  }): Promise<{ text: string; endCall: boolean }>;
}

export const LLM_PROVIDER = 'LLM_PROVIDER';

/* ── Payments (Razorpay) — spec §8.1 ──────────────────────────────────────── */

export interface CreateOrderInput {
  /** Integer paise. Razorpay's own unit is paise, so no conversion is needed. */
  amountPaise: bigint;
  currency: string;
  receipt: string;
  notes?: Record<string, string>;
}

export interface CreateOrderResult {
  orderId: string;
  amountPaise: bigint;
  currency: string;
  /** Publishable key for Checkout. Never the key secret. */
  keyId: string;
  createdAt: Date;
}

export interface FetchedPayment {
  paymentId: string;
  orderId: string;
  amountPaise: bigint;
  status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
  method?: string;
}

export interface PaymentsProvider extends ProviderInfo {
  createOrder(input: CreateOrderInput): Promise<CreateOrderResult>;
  /**
   * Server-side confirmation of what actually happened.
   *
   * Spec §8.1's flow credits on the webhook, but the webhook body is attacker-
   * controlled up to the signature. Re-reading the payment from the provider means
   * the credited amount comes from the provider's own record, not from a payload.
   */
  fetchPayment(paymentId: string): Promise<FetchedPayment>;
}

export const PAYMENTS_PROVIDER = 'PAYMENTS_PROVIDER';

/* ── Object storage (S3) — spec §10 ───────────────────────────────────────── */

export interface PutObjectInput {
  key: string;
  body: Buffer;
  contentType: string;
  cacheControl?: string;
  metadata?: Record<string, string>;
}

export interface PutObjectResult {
  key: string;
  /** `s3://bucket/key`, or `file://…` in mock mode. Stored on the call row. */
  uri: string;
  sizeBytes: number;
  etag?: string;
}

export interface StoredObject {
  body: Buffer;
  contentType?: string;
}

export interface StorageProvider extends ProviderInfo {
  put(input: PutObjectInput): Promise<PutObjectResult>;
  /** `null` when the key does not exist — a missing recording is not an error. */
  get(key: string): Promise<StoredObject | null>;
  /**
   * Time-limited URL. Spec §10 classifies call recordings as High sensitivity, so a
   * recording is never served from a permanent public URL.
   */
  signedUrl(key: string, expiresInSeconds: number): Promise<string>;
  exists(key: string): Promise<boolean>;
}

export const STORAGE_PROVIDER = 'STORAGE_PROVIDER';
