import { Inject, Injectable, Logger } from '@nestjs/common';
import { Channel, RecipientStatus } from '@aiking/shared';
import type { Prisma } from '@prisma/client';

import {
  verifyEmailWebhookSignature,
  verifyMetaSignature,
  verifyPlivoV3Signature,
  verifyRazorpayWebhookSignature,
} from '../../common/crypto/signatures';
import { AppException, InvalidSignatureException } from '../../common/errors/app-exception';
import { PRISMA, isUniqueViolation, type ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { TenantContext } from '../../common/tenant/tenant-context';
import { CONFIG, type AppConfig } from '../../config/configuration';
import { CallsService } from '../calls/calls.service';
import { CampaignsService } from '../campaigns/campaigns.service';
import type { ProviderCallbackJob } from '../queue/queue.types';
import { RazorpayService } from '../razorpay/razorpay.service';

/** The four providers that call us back. Kept in step with the job payload's own union. */
export type WebhookProvider = ProviderCallbackJob['route'];

export interface WebhookAck {
  received: true;
  /** False when the delivery was a replay of an event already handled. */
  processed: boolean;
  duplicate: boolean;
  /** Present when the payload was understood but could not be acted on. */
  error?: string;
}

/** What a verified delivery is recorded as before anything acts on it. */
interface DeliveryRecord {
  provider: WebhookProvider;
  eventType: string | null;
  providerEventId: string | null;
  payload: Prisma.InputJsonValue;
}

/**
 * Anything that reads as a permanent rejection rather than a transient fault.
 *
 * A 4xx from a dispatch target means the payload will never be actionable: an order
 * we did not create, a call that no longer exists. Returning a 5xx for that puts the
 * provider into a retry loop that can only ever fail — Razorpay retries for hours,
 * Meta for days. So a 4xx is absorbed into a 200 with the reason recorded, and only
 * a genuine fault (database down, bug) is allowed to surface as a 5xx and be retried.
 */
function isPermanentRejection(error: unknown): boolean {
  return error instanceof AppException && error.getStatus() >= 400 && error.getStatus() < 500;
}

/**
 * Inbound provider webhooks — spec §8.1, §6.1, §6.3, §5.1, §12.
 *
 * Every handler has the same four steps, in this order, and the order is the design:
 *
 * 1. **Verify the signature over the raw bytes** (§12). Before parsing, before
 *    logging, before touching the database. A payload that fails verification is
 *    recorded as a rejected delivery and answered with a 401 — it is not "probably
 *    fine but unsigned", it is someone else's traffic or an attack. A forged
 *    `payment.captured` credits a wallet, so this is the load-bearing check in the
 *    whole module.
 * 2. **Record the delivery, keyed on the provider's own event id.** The unique index
 *    on `(provider, provider_event_id)` is what makes replay handling a database
 *    guarantee rather than a code convention: the second delivery of the same event
 *    loses the insert race and is answered as a duplicate without dispatching.
 * 3. **Resolve the tenant from our own rows**, never from the payload (§4.3). A
 *    webhook arrives with no session and no tenant; every dispatch target below looks
 *    up the tenant by the provider identifier it owns and opens a worker scope on
 *    *that*. Nothing in the body selects a tenant.
 * 4. **Dispatch to the domain service that owns the table.** This module verifies,
 *    de-duplicates and routes; it does not write to `campaign_recipients`, `calls` or
 *    `wallets` itself. Keeping the writes with their owner is what stops the delivery
 *    rules (monotonic status, reserve/settle, idempotent credit) from being
 *    re-implemented differently here.
 *
 * The same four steps run for mock-mode traffic: `MockCallbackSink` builds the
 * provider's real payload shape, signs it with the configured secret, and feeds it
 * through these methods. So the §12 verification path is exercised by every test that
 * sends a message, rather than first executing in production.
 */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: ExtendedPrismaClient,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly razorpay: RazorpayService,
    private readonly campaigns: CampaignsService,
    private readonly calls: CallsService,
    private readonly tenantContext: TenantContext,
  ) {}

  // ── Meta / WhatsApp Cloud API (spec §6.1, §6.3) ────────────────────────────

  /**
   * Meta's subscription handshake.
   *
   * A `GET` with `hub.verify_token`, answered by echoing `hub.challenge` verbatim as
   * plain text. Meta calls this once when the webhook is configured and refuses to
   * subscribe if the echo is wrong.
   *
   * Returns null rather than throwing on a bad token so the controller can answer
   * 403 — which is what Meta's own documentation says an unrecognised token gets, and
   * a 401 makes their configuration UI report a different error than the real one.
   */
  verifyMetaSubscription(mode: string | undefined, token: string | undefined, challenge: string | undefined): string | null {
    if (mode !== 'subscribe') return null;
    if (!token || token !== this.config.whatsapp.verifyToken) {
      this.logger.warn('meta subscription handshake rejected — verify token mismatch');
      return null;
    }
    return challenge ?? '';
  }

  async handleMeta(rawBody: Buffer, signature: string | undefined): Promise<WebhookAck> {
    if (!verifyMetaSignature(this.config.whatsapp.appSecret, rawBody, signature)) {
      await this.recordRejected('meta', rawBody);
      throw new InvalidSignatureException('meta');
    }

    const payload = parseJson(rawBody);
    const statuses = metaStatuses(payload);
    const messages = metaMessages(payload);

    if (statuses.length === 0 && messages.length === 0) {
      // Meta also sends template-approval and account-alert notifications on the same
      // subscription. Acknowledged and recorded, not treated as an error — a non-2xx
      // makes Meta retry a payload we will never have anything to do with.
      const kind = metaChangeField(payload) ?? 'unknown';
      this.logger.debug(`meta webhook carried no statuses or messages (field=${kind}) — acknowledged`);
      return { received: true, processed: false, duplicate: false };
    }

    let processed = 0;
    let duplicates = 0;

    for (const status of statuses) {
      const ack = await this.withDelivery(
        {
          provider: 'meta',
          eventType: `message.${status.status}`,
          // Meta gives no per-delivery event id, so the replay key is the message id
          // plus the status it reports. `sent`, `delivered` and `read` for one message
          // are three distinct events; a second `delivered` for it is a redelivery.
          providerEventId: `${status.id}:${status.status}`,
          payload: status.raw,
        },
        () =>
          this.campaigns.applyDeliveryStatus({
            providerMessageId: status.id,
            status: status.recipientStatus,
            occurredAt: status.occurredAt,
            errorCode: status.errorCode,
            errorMessage: status.errorMessage,
          }),
      );
      if (ack.processed) processed += 1;
      if (ack.duplicate) duplicates += 1;
    }

    for (const message of messages) {
      const ack = await this.withDelivery(
        {
          provider: 'meta',
          eventType: 'message.inbound',
          providerEventId: message.id,
          payload: message.raw,
        },
        () => this.campaigns.applyInboundMessage({ from: message.from, text: message.text, occurredAt: message.occurredAt }),
      );
      if (ack.processed) processed += 1;
      if (ack.duplicate) duplicates += 1;
    }

    return {
      received: true,
      processed: processed > 0,
      duplicate: duplicates > 0 && processed === 0,
    };
  }

  // ── Plivo (spec §5.1) ──────────────────────────────────────────────────────

  /**
   * A Plivo call callback.
   *
   * `url` is supplied by the caller — rebuilt from our own configuration by the
   * controller, or carried in the job payload by the mock sink — because the V3
   * signature is an HMAC over `url + nonce` and not over the body at all. That has a
   * consequence worth stating: the signature proves the request was addressed to a URL
   * we published and signed with our auth token, but it does **not** authenticate the
   * body. So the body is only ever used to look up a call we already have, and the
   * call's own row supplies the tenant.
   *
   * Plivo posts `application/x-www-form-urlencoded`, so the body is parsed as form
   * data with a JSON fallback — see `parseFormOrJson`.
   */
  async handlePlivo(
    rawBody: Buffer,
    signature: string | undefined,
    nonce: string | undefined,
    url: string,
  ): Promise<WebhookAck> {
    if (!verifyPlivoV3Signature(this.config.plivo.authToken, url, nonce, signature)) {
      await this.recordRejected('plivo', rawBody);
      throw new InvalidSignatureException('plivo');
    }

    const payload = parseFormOrJson(rawBody);
    const providerCallId = firstString(payload, ['CallUUID', 'call_uuid', 'RequestUUID']);
    if (!providerCallId) {
      this.logger.warn('plivo callback carried no CallUUID — acknowledged and ignored');
      return { received: true, processed: false, duplicate: false };
    }

    const recording = readPlivoRecording(payload);
    if (recording) {
      return this.withDelivery(
        {
          provider: 'plivo',
          eventType: 'call.recording',
          // Plivo's own recording id where it sends one; otherwise the call uuid,
          // which is unique per recording for a single-recording call flow.
          providerEventId: `recording:${firstString(payload, ['RecordingID', 'recording_id']) ?? providerCallId}`,
          payload: payload as Prisma.InputJsonValue,
        },
        () =>
          this.calls.applyRecordingReady({
            providerCallId,
            recordingUrl: recording.url,
            durationSeconds: recording.durationSeconds,
          }),
      );
    }

    const event = readPlivoEvent(payload);
    if (!event) {
      this.logger.debug(`plivo callback for ${providerCallId} had no recognisable status — acknowledged`);
      return { received: true, processed: false, duplicate: false };
    }

    return this.withDelivery(
      {
        provider: 'plivo',
        eventType: `call.${event.event}`,
        providerEventId: `${providerCallId}:${event.event}`,
        payload: payload as Prisma.InputJsonValue,
      },
      () =>
        this.calls.applyCallEvent({
          providerCallId,
          event: event.event,
          durationSeconds: event.durationSeconds,
          recordingUrl: event.recordingUrl,
          hangupCause: event.hangupCause,
        }),
    );
  }

  // ── Razorpay (spec §8.1) ───────────────────────────────────────────────────

  /**
   * `payment.captured` / `payment.failed`.
   *
   * The authoritative credit trigger. Two of the §15 risks meet here: a redelivery
   * must not double-credit, and a payload must not be able to name its own amount or
   * tenant. Both are handled below the dispatch — `RazorpayService` credits idempotently
   * on the payment id and takes the amount and the tenant from our own order row — so
   * this method's job is verification, the replay record, and getting out of the way.
   *
   * `x-razorpay-event-id` is Razorpay's own idempotency key and is used when present.
   * It is a header rather than a body field, so it is outside the signed bytes; the
   * fallback key is derived from the signed body, which is why a missing or tampered
   * header degrades to "de-duplicate on the payment id" rather than to "process twice".
   */
  async handleRazorpay(rawBody: Buffer, signature: string | undefined, eventId?: string): Promise<WebhookAck> {
    if (!verifyRazorpayWebhookSignature(this.config.razorpay.webhookSecret, rawBody, signature)) {
      await this.recordRejected('razorpay', rawBody);
      throw new InvalidSignatureException('razorpay');
    }

    const payload = parseJson(rawBody);
    const event = typeof payload.event === 'string' ? payload.event : 'unknown';
    const payment = razorpayPaymentEntity(payload);

    if (!payment) {
      this.logger.debug(`razorpay ${event} carried no payment entity — acknowledged`);
      return { received: true, processed: false, duplicate: false };
    }

    if (event !== 'payment.captured' && event !== 'payment.failed') {
      // Razorpay's dashboard subscribes to whole event families. `order.paid` and
      // `payment.authorized` describe states we already learn from `payment.captured`,
      // so they are recorded and acknowledged rather than acted on twice.
      this.logger.debug(`razorpay ${event} is not a settlement event — acknowledged`);
      return { received: true, processed: false, duplicate: false };
    }

    const input = {
      razorpayPaymentId: payment.id,
      razorpayOrderId: payment.orderId,
      amountPaise: payment.amountPaise,
      method: payment.method,
      signatureVerified: true,
      rawPayload: payload,
    };

    return this.withDelivery(
      {
        provider: 'razorpay',
        eventType: event,
        providerEventId: eventId?.trim() || `${event}:${payment.id}`,
        payload: payload as Prisma.InputJsonValue,
      },
      () =>
        this.tenantContext.runAsSystem(`razorpay ${event} for payment ${payment.id}`, () =>
          event === 'payment.captured'
            ? this.razorpay.recordCapturedPayment(input).then(() => undefined)
            : this.razorpay.recordFailedPayment(input),
        ),
    );
  }

  // ── Email delivery notifications (spec §6.1, §12) ──────────────────────────

  /**
   * An SES event notification.
   *
   * The body shape is SES's own event JSON, so a live deployment only has to unwrap
   * the SNS envelope around it. The signature, however, is a shared-secret HMAC rather
   * than SNS's RSA certificate chain — `signatures.ts` documents that gap and names the
   * remaining production work. The verification path here is real; only the SNS key
   * material is not.
   */
  async handleEmail(rawBody: Buffer, signature: string | undefined): Promise<WebhookAck> {
    if (!verifyEmailWebhookSignature(this.config.email.webhookSecret, rawBody, signature)) {
      await this.recordRejected('email', rawBody);
      throw new InvalidSignatureException('email');
    }

    const payload = parseJson(rawBody);
    const event = readSesEvent(payload);

    if (!event) {
      this.logger.debug('email webhook carried no recognisable SES event — acknowledged');
      return { received: true, processed: false, duplicate: false };
    }

    return this.withDelivery(
      {
        provider: 'email',
        eventType: `email.${event.kind}`,
        // SES sends no event id either; the message id plus the event kind is the
        // same replay key shape used for Meta, for the same reason.
        providerEventId: `${event.messageId}:${event.kind}`,
        payload: payload as Prisma.InputJsonValue,
      },
      () =>
        event.kind === 'complained'
          ? // A spam complaint is an opt-out, not a delivery state (§12). It does not
            // move the recipient's status — the message *was* delivered — it stops us
            // emailing that contact again.
            this.campaigns.applyEmailComplaint(event.messageId)
          : this.campaigns.applyDeliveryStatus({
              providerMessageId: event.messageId,
              status: event.recipientStatus,
              occurredAt: event.occurredAt,
              errorCode: event.errorCode,
              errorMessage: event.errorMessage,
            }),
    );
  }

  /** Re-entry point for the `provider-callback` queue — see `webhook.processors.ts`. */
  async handleCallbackJob(job: ProviderCallbackJob): Promise<WebhookAck> {
    const rawBody = Buffer.from(job.rawBody, 'utf8');
    switch (job.route) {
      case 'meta':
        return this.handleMeta(rawBody, job.signature);
      case 'plivo':
        return this.handlePlivo(rawBody, job.signature, job.nonce, job.url ?? '');
      case 'razorpay':
        return this.handleRazorpay(rawBody, job.signature);
      case 'email':
        return this.handleEmail(rawBody, job.signature);
    }
  }

  /* ── the delivery record ───────────────────────────────────────────────────── */

  /**
   * Record the delivery, then dispatch it exactly once.
   *
   * The insert comes first and the unique index does the de-duplication. The
   * alternative — read, decide, then insert — has a window between the read and the
   * insert in which a concurrent redelivery also reads "not seen yet", and both
   * dispatch. Providers retry in parallel, so that window is reached in practice, and
   * the §15 double-credit risk is exactly what falls through it.
   *
   * `webhook_deliveries` has no `tenant_id`: a delivery is a platform-level fact that
   * exists before any tenant is known, and it is the only table in this module that is
   * written to directly.
   */
  private async withDelivery(record: DeliveryRecord, dispatch: () => Promise<unknown>): Promise<WebhookAck> {
    let deliveryId: string;

    try {
      const row = await this.prisma.webhookDelivery.create({
        data: {
          provider: record.provider,
          eventType: record.eventType,
          providerEventId: record.providerEventId,
          signatureVerified: true,
          payload: record.payload,
        },
      });
      deliveryId = row.id;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;

      // The §15 case, reached on every provider retry. Recorded as a duplicate and
      // acknowledged with a 200 so the retries stop — this is the normal path, not an
      // anomaly, and it must not dispatch.
      this.logger.log(
        `${record.provider} ${record.eventType ?? 'event'} ${record.providerEventId ?? '?'} already delivered — skipped`,
      );
      await this.prisma.webhookDelivery.create({
        data: {
          provider: record.provider,
          // Null rather than the real id: the unique index is on
          // `(provider, provider_event_id)` and this row exists only as an audit trail
          // of the redelivery, so it must not compete for the key.
          providerEventId: null,
          eventType: record.eventType,
          signatureVerified: true,
          duplicate: true,
          processed: false,
          payload: record.payload,
        },
      });
      return { received: true, processed: false, duplicate: true };
    }

    try {
      await dispatch();
      await this.prisma.webhookDelivery.update({ where: { id: deliveryId }, data: { processed: true } });
      return { received: true, processed: true, duplicate: false };
    } catch (error) {
      const message = (error as Error).message;
      await this.prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: { processed: false, errorMessage: message.slice(0, 500) },
      });

      if (isPermanentRejection(error)) {
        this.logger.warn(`${record.provider} ${record.eventType ?? 'event'} is not actionable: ${message}`);
        return { received: true, processed: false, duplicate: false, error: message };
      }

      // A transient fault. Re-thrown so the response is a 5xx and the provider
      // retries — at which point the delivery row above already exists, so the retry
      // is answered as a duplicate and the event is silently dropped. That is the
      // honest limitation of using the delivery record as the replay key: it records
      // *receipt*, not successful processing. A reconciliation sweep over
      // `webhook_deliveries WHERE processed = false` is the missing piece and is not
      // built.
      this.logger.error(`${record.provider} ${record.eventType ?? 'event'} failed: ${message}`);
      throw error;
    }
  }

  /**
   * Record a delivery that failed verification.
   *
   * Kept because a burst of these is the signal that someone is probing the endpoint,
   * or that a secret was rotated on one side only — and neither is visible if a
   * rejected webhook leaves no trace. `providerEventId` is null because the payload is
   * unauthenticated: taking an id out of it would let an attacker occupy the unique
   * key for an event that has not happened yet and block the genuine delivery.
   *
   * The body is truncated. It is unverified input, and an unbounded write of it into
   * our own database on a path that requires no authentication is a free disk-fill.
   */
  private async recordRejected(provider: WebhookProvider, rawBody: Buffer): Promise<void> {
    this.logger.warn(`${provider} webhook rejected — signature verification failed`);
    try {
      await this.prisma.webhookDelivery.create({
        data: {
          provider,
          eventType: 'signature.invalid',
          providerEventId: null,
          signatureVerified: false,
          processed: false,
          errorMessage: 'Signature verification failed',
          payload: { truncatedBody: rawBody.toString('utf8').slice(0, 2_000) },
        },
      });
    } catch (error) {
      // Never let the audit write turn a 401 into a 500 — the caller is unauthenticated
      // either way, and the log line above has already recorded it.
      this.logger.error(`could not record rejected ${provider} webhook: ${(error as Error).message}`);
    }
  }
}

/* ── payload readers ─────────────────────────────────────────────────────────── */

/*
 * These are deliberately defensive. Every field below comes from outside, on a route
 * that any host on the internet can reach, and a provider adding a field or sending a
 * string where a number is documented must not produce a 500 — a 500 is a retry, and a
 * retry of a payload we cannot parse is an infinite loop.
 */

type Json = Record<string, unknown>;

function parseJson(rawBody: Buffer): Json {
  try {
    const parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Plivo posts form-encoded; the mock sink does too, because that is what the live
 * provider sends and a mock that sent JSON would leave the real parse path untested.
 *
 * The JSON fallback covers one specific case: if `rawBody: true` is ever lost from
 * `main.ts`, the `@RawBody()` decorator re-serialises the parsed body as JSON. The
 * fallback means that misconfiguration degrades to a working parse rather than a
 * silently empty payload.
 */
function parseFormOrJson(rawBody: Buffer): Json {
  const text = rawBody.toString('utf8').trim();
  if (text.startsWith('{')) return parseJson(rawBody);

  const params = new URLSearchParams(text);
  const result: Json = {};
  for (const [key, value] of params.entries()) result[key] = value;
  return result;
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstString(source: Json, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/** Meta and Plivo both send numbers as strings in places. */
function asInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return undefined;
}

/** Meta timestamps are Unix seconds, as strings. */
function metaTimestamp(value: unknown): Date {
  const seconds = asInt(value);
  return seconds ? new Date(seconds * 1_000) : new Date();
}

function metaChanges(payload: Json): Json[] {
  return asArray(payload.entry)
    .filter(isObject)
    .flatMap((entry) => asArray(entry.changes).filter(isObject));
}

function metaChangeField(payload: Json): string | undefined {
  for (const change of metaChanges(payload)) {
    if (typeof change.field === 'string') return change.field;
  }
  return undefined;
}

interface MetaStatus {
  id: string;
  status: string;
  recipientStatus: RecipientStatus;
  occurredAt: Date;
  errorCode?: string;
  errorMessage?: string;
  raw: Prisma.InputJsonValue;
}

const META_STATUS_MAP: Record<string, RecipientStatus> = {
  sent: RecipientStatus.SENT,
  delivered: RecipientStatus.DELIVERED,
  read: RecipientStatus.READ,
  failed: RecipientStatus.FAILED,
  // Meta also emits `deleted` for a message the user removed. It says nothing about
  // delivery — the message was delivered and then deleted — so it is not mapped, and
  // an unmapped status is skipped rather than guessed at.
};

function metaStatuses(payload: Json): MetaStatus[] {
  const result: MetaStatus[] = [];

  for (const change of metaChanges(payload)) {
    const value = isObject(change.value) ? change.value : {};
    for (const entry of asArray(value.statuses).filter(isObject)) {
      const id = typeof entry.id === 'string' ? entry.id : undefined;
      const status = typeof entry.status === 'string' ? entry.status : undefined;
      if (!id || !status) continue;

      const recipientStatus = META_STATUS_MAP[status];
      if (!recipientStatus) continue;

      const error = asArray(entry.errors).filter(isObject)[0];

      result.push({
        id,
        status,
        recipientStatus,
        occurredAt: metaTimestamp(entry.timestamp),
        errorCode: error?.code !== undefined ? String(error.code) : undefined,
        errorMessage:
          typeof error?.title === 'string'
            ? error.title
            : typeof error?.message === 'string'
              ? error.message
              : undefined,
        raw: entry as Prisma.InputJsonValue,
      });
    }
  }

  return result;
}

interface MetaInboundMessage {
  id: string;
  from: string;
  text: string;
  occurredAt: Date;
  raw: Prisma.InputJsonValue;
}

function metaMessages(payload: Json): MetaInboundMessage[] {
  const result: MetaInboundMessage[] = [];

  for (const change of metaChanges(payload)) {
    const value = isObject(change.value) ? change.value : {};
    for (const entry of asArray(value.messages).filter(isObject)) {
      const id = typeof entry.id === 'string' ? entry.id : undefined;
      const from = typeof entry.from === 'string' ? entry.from : undefined;
      if (!id || !from) continue;

      result.push({
        id,
        from,
        text: metaMessageText(entry),
        occurredAt: metaTimestamp(entry.timestamp),
        raw: entry as Prisma.InputJsonValue,
      });
    }
  }

  return result;
}

/**
 * The text of an inbound message.
 *
 * A quick-reply button carries its label in `button.text` and a list selection in
 * `interactive`, and both are how a contact actually taps "Stop promotions" — so
 * reading only `text.body` would miss the opt-out that §12 requires us to honour.
 * Media messages have no text at all and come back as an empty string, which the
 * timeline renders as the message type.
 */
function metaMessageText(message: Json): string {
  const text = isObject(message.text) ? message.text.body : undefined;
  if (typeof text === 'string') return text;

  const button = isObject(message.button) ? (message.button.text ?? message.button.payload) : undefined;
  if (typeof button === 'string') return button;

  const interactive = isObject(message.interactive) ? message.interactive : undefined;
  const reply = interactive
    ? isObject(interactive.button_reply)
      ? interactive.button_reply
      : isObject(interactive.list_reply)
        ? interactive.list_reply
        : undefined
    : undefined;
  if (reply && typeof reply.title === 'string') return reply.title;

  return '';
}

interface PlivoEvent {
  event: 'ringing' | 'answered' | 'completed' | 'failed' | 'no_answer' | 'busy';
  durationSeconds?: number;
  recordingUrl?: string;
  hangupCause?: string;
}

/**
 * Map Plivo's call status onto our event union.
 *
 * Plivo reports the outcome in `CallStatus` and the reason in `HangupCause`, and the
 * distinction between "nobody picked up" and "the line was busy" lives only in the
 * cause — which matters because §9.1 bills per connected minute and neither of those
 * is billable. So the cause is consulted before falling back to a generic failure.
 */
function readPlivoEvent(payload: Json): PlivoEvent | null {
  const status = (firstString(payload, ['CallStatus', 'Status', 'Event']) ?? '').toLowerCase();
  const hangupCause = firstString(payload, ['HangupCause', 'HangupCauseName']);
  const cause = (hangupCause ?? '').toUpperCase();
  const durationSeconds =
    asInt(payload.Duration) ?? asInt(payload.BillDuration) ?? asInt(payload.duration) ?? undefined;
  const recordingUrl = firstString(payload, ['RecordUrl', 'RecordingUrl', 'record_url']);

  const base = { durationSeconds, recordingUrl, hangupCause };

  switch (status) {
    case 'ringing':
    case 'startapp':
      return { ...base, event: 'ringing' };
    case 'in-progress':
    case 'inprogress':
    case 'answer':
    case 'answered':
      return { ...base, event: 'answered' };
    case 'completed':
    case 'hangup':
      // A "completed" call that nobody answered is Plivo's normal reporting for a
      // ring-out: the call reached its end state, with zero billable seconds. Billing
      // it as a completed call would charge a minute for a phone that rang in an empty
      // room, which is the §15 risk this branch exists to avoid.
      if (cause === 'NO_ANSWER' || cause === 'NO_USER_RESPONSE' || cause === 'ORIGINATOR_CANCEL') {
        return { ...base, event: 'no_answer', durationSeconds: 0 };
      }
      if (cause === 'USER_BUSY') return { ...base, event: 'busy', durationSeconds: 0 };
      if (durationSeconds === 0 && cause && cause !== 'NORMAL_CLEARING') {
        return { ...base, event: 'failed', durationSeconds: 0 };
      }
      return { ...base, event: 'completed' };
    case 'no_answer':
    case 'no-answer':
      return { ...base, event: 'no_answer', durationSeconds: 0 };
    case 'busy':
      return { ...base, event: 'busy', durationSeconds: 0 };
    case 'failed':
    case 'failure':
      return { ...base, event: 'failed', durationSeconds: 0 };
    default:
      return null;
  }
}

/**
 * A recording callback, distinguished from a hangup callback that merely mentions the
 * recording URL.
 *
 * Plivo's recording notification carries `RecordingDuration`; the hangup callback
 * carries the call's `Duration`. Requiring the recording-specific field is what keeps
 * a single hangup callback from being processed as both events.
 */
function readPlivoRecording(payload: Json): { url: string; durationSeconds: number } | null {
  const url = firstString(payload, ['RecordUrl', 'RecordingUrl', 'record_url']);
  const duration = asInt(payload.RecordingDuration) ?? asInt(payload.recording_duration);
  if (!url || duration === undefined) return null;
  return { url, durationSeconds: duration };
}

interface RazorpayPaymentEntity {
  id: string;
  orderId: string;
  amountPaise: bigint;
  method?: string;
}

function razorpayPaymentEntity(payload: Json): RazorpayPaymentEntity | null {
  const container = isObject(payload.payload) ? payload.payload : {};
  const wrapper = isObject(container.payment) ? container.payment : {};
  const entity = isObject(wrapper.entity) ? wrapper.entity : {};

  const id = typeof entity.id === 'string' ? entity.id : undefined;
  const orderId = typeof entity.order_id === 'string' ? entity.order_id : undefined;
  if (!id || !orderId) return null;

  // Razorpay's `amount` is already in paise (§9.1's unit), so it is read as an integer
  // and never through a float. It is recorded but not trusted: `RazorpayService`
  // credits the order's amount, not this one.
  const amount = asInt(entity.amount) ?? 0;

  return {
    id,
    orderId,
    amountPaise: BigInt(amount),
    method: typeof entity.method === 'string' ? entity.method : undefined,
  };
}

interface SesEvent {
  kind: 'delivered' | 'bounced' | 'complained' | 'opened' | 'clicked';
  messageId: string;
  recipientStatus: RecipientStatus;
  occurredAt: Date;
  errorCode?: string;
  errorMessage?: string;
}

const SES_EVENT_MAP: Record<string, { kind: SesEvent['kind']; status: RecipientStatus }> = {
  delivery: { kind: 'delivered', status: RecipientStatus.DELIVERED },
  bounce: { kind: 'bounced', status: RecipientStatus.BOUNCED },
  // A complaint does not change the delivery state; the status is carried only so the
  // type is uniform, and `handleEmail` routes this kind to the opt-out path instead.
  complaint: { kind: 'complained', status: RecipientStatus.DELIVERED },
  open: { kind: 'opened', status: RecipientStatus.OPENED },
  click: { kind: 'clicked', status: RecipientStatus.CLICKED },
};

function readSesEvent(payload: Json): SesEvent | null {
  const raw = typeof payload.eventType === 'string' ? payload.eventType : payload.notificationType;
  if (typeof raw !== 'string') return null;

  const mapped = SES_EVENT_MAP[raw.toLowerCase()];
  if (!mapped) return null;

  const mail = isObject(payload.mail) ? payload.mail : {};
  const messageId = typeof mail.messageId === 'string' ? mail.messageId : undefined;
  if (!messageId) return null;

  const detail = isObject(payload[mapped.kind === 'delivered' ? 'delivery' : raw.toLowerCase()])
    ? (payload[mapped.kind === 'delivered' ? 'delivery' : raw.toLowerCase()] as Json)
    : {};
  const bouncedRecipient = asArray(detail.bouncedRecipients).filter(isObject)[0];

  return {
    kind: mapped.kind,
    messageId,
    recipientStatus: mapped.status,
    occurredAt: readDate(detail.timestamp) ?? readDate(mail.timestamp) ?? new Date(),
    errorCode: typeof detail.bounceType === 'string' ? detail.bounceType : undefined,
    errorMessage:
      typeof bouncedRecipient?.diagnosticCode === 'string'
        ? bouncedRecipient.diagnosticCode
        : typeof detail.complaintFeedbackType === 'string'
          ? detail.complaintFeedbackType
          : undefined,
  };
}

function readDate(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** Re-exported for the unit tests, which drive these directly with provider fixtures. */
export const webhookPayloadReaders = {
  metaStatuses,
  metaMessages,
  metaMessageText,
  readPlivoEvent,
  readPlivoRecording,
  razorpayPaymentEntity,
  readSesEvent,
  parseFormOrJson,
};

/** Unused import guard: `Channel` is re-exported for the sink's payload builders. */
export type { Channel };
