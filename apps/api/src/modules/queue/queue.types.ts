import type { QueueName } from '@aiking/shared';

/**
 * Job payloads — spec §3.4, "async always": every provider call happens on a queue
 * so an HTTP request never waits on a third party.
 *
 * Two rules hold across all of them.
 *
 * **Ids, not data.** A payload carries the primary key of the row to act on and
 * nothing else that lives in the database. A job can sit in Redis for minutes; the
 * row is the source of truth by the time the processor runs, and a payload that
 * duplicated `templateBody` or `amountPaise` would be acting on a stale copy.
 *
 * **Every tenant-scoped job carries `tenantId`.** A worker has no HTTP request, so
 * there is no `AsyncLocalStorage` context to inherit — the processor must open one
 * explicitly with `runWithTenant`. Without `tenantId` in the payload the processor
 * literally cannot query, because the Prisma extension refuses tenant-scoped models
 * outside a context. That is the isolation guarantee of §4.3 holding on the worker
 * side too, rather than only on the request path.
 */

export interface TenantJob {
  tenantId: string;
  /** The user who initiated this, for the audit trail. Absent for system work. */
  actorUserId?: string;
}

/** Fan a campaign out into per-recipient send jobs (spec §6.1). */
export interface CampaignDispatchJob extends TenantJob {
  campaignId: string;
  /** Resume point, so a re-dispatch after a halt does not re-send. */
  afterRecipientId?: string;
}

/** One WhatsApp message to one recipient. */
export interface WhatsAppSendJob extends TenantJob {
  campaignRecipientId: string;
}

export interface EmailSendJob extends TenantJob {
  campaignRecipientId: string;
}

/** Spec §5.1 step 1 — place the call. */
export interface CallPlaceJob extends TenantJob {
  callId: string;
}

/** Spec §5.1 steps 2–3 — fetch the recording, transcribe it, store both. */
export interface RecordingIngestJob extends TenantJob {
  callId: string;
  recordingUrl: string;
  durationSeconds: number;
}

/** Spec §5.1 steps 4–5 — summarize, extract next action, decide escalation. */
export interface CallSummarizeJob extends TenantJob {
  callId: string;
}

/**
 * A simulated inbound webhook from a mock provider.
 *
 * Deliberately shaped as the *raw HTTP request* rather than as a domain event: the
 * exact body bytes plus the signature header a real provider would send. The
 * processor hands both to the same webhook service an HTTP request reaches, so
 * signature verification, tenant resolution and idempotency are all exercised by
 * mock-mode traffic. A mock that called the domain service directly would leave the
 * §12 verification path untested until the first live deployment.
 *
 * No `tenantId`: the real webhook has none either. Resolving the tenant from the
 * provider's own identifiers is part of what is under test.
 */
export interface ProviderCallbackJob {
  route: 'meta' | 'plivo' | 'razorpay' | 'email';
  rawBody: string;
  /** Header value in the provider's own format (`sha256=…`, base64, hex). */
  signature: string;
  /** Plivo V3 signs `url + nonce`, so both travel with the job. */
  url?: string;
  nonce?: string;
  /** For logs, so a failed callback is identifiable without decoding the body. */
  description: string;
}

export interface JobPayloadMap {
  'campaign-dispatch': CampaignDispatchJob;
  'whatsapp-send': WhatsAppSendJob;
  'email-send': EmailSendJob;
  'call-place': CallPlaceJob;
  'recording-ingest': RecordingIngestJob;
  'call-summarize': CallSummarizeJob;
  'provider-callback': ProviderCallbackJob;
}

/** Compile-time proof that the map covers every queue, and no more. */
export type JobPayload<K extends QueueName> = JobPayloadMap[K];

export interface JobContext {
  queue: QueueName;
  jobId: string;
  /** 1-based. */
  attempt: number;
  maxAttempts: number;
  /** True on the last attempt — the point at which a processor records a terminal failure. */
  isFinalAttempt: boolean;
}

export type JobHandler<K extends QueueName> = (payload: JobPayload<K>, context: JobContext) => Promise<void>;

export interface EnqueueOptions {
  /**
   * Delay before the job becomes eligible. Under the inline driver this advances a
   * virtual clock rather than sleeping, so ordering is preserved without wall time.
   */
  delayMs?: number;
  attempts?: number;
  /**
   * Deduplication key. BullMQ will not add a second job with the same id while the
   * first is still in the queue — which is what stops a double-clicked "Launch
   * campaign" from dispatching twice.
   */
  jobId?: string;
}

/**
 * Marks a failure the queue should not retry.
 *
 * Distinct from `ProviderError.retryable === false` because a processor can also
 * decide this for its own reasons — a campaign that was cancelled while its jobs were
 * in flight, a contact that opted out after enqueue. Retrying either would be wrong
 * and would burn the attempt budget on work that can never succeed.
 */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentJobError';
  }
}
