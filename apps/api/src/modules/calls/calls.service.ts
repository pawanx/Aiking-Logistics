import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CallDirection,
  CallOutcome,
  CallStatus,
  Channel,
  CommunicationEventType,
  TranscriptSpeaker,
  UsageEventType,
  money,
  type CallDto,
  type Paginated,
  type PlaceCallRequest,
  type TranscriptTurnDto,
} from '@aiking/shared';
import type { Call, CallTranscriptTurn, Prisma } from '@prisma/client';

import { NotFoundException, ValidationFailedException } from '../../common/errors/app-exception';
import { PRISMA, type ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { TenantContext } from '../../common/tenant/tenant-context';
import { CONFIG, type AppConfig } from '../../config/configuration';
import {
  STORAGE_PROVIDER,
  TELEPHONY_PROVIDER,
  type StorageProvider,
  type TelephonyProvider,
} from '../../providers/provider.types';
import { MeteringService } from '../billing/metering.service';
import { CommunicationsService } from '../communications/communications.service';
import { QueueService } from '../queue/queue.service';
import { ContactsService } from '../contacts/contacts.service';
import { WalletService } from '../wallet/wallet.service';

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

/**
 * What a call is assumed to cost before it happens — spec §5.3.
 *
 * Only a hold, never a charge: `settle()` bills the minutes that actually elapsed.
 * Three minutes is a deliberate over-estimate of a delivery-confirmation call, because
 * the failure mode of under-estimating is worse. Under-estimate and two concurrent
 * calls can both pass the balance check and the second one overdraws; over-estimate and
 * a tenant briefly sees less spendable balance than they have.
 *
 * Exported so `call-place` holds exactly what this checked. Two constants that had to
 * agree by convention would eventually stop agreeing.
 */
export const ESTIMATED_CALL_MINUTES = 3;

/** Spec §10 — a recording link is deliberately short-lived. */
const RECORDING_URL_TTL_SECONDS = 300;

/** The default objective, when the caller does not give one. */
const DEFAULT_OBJECTIVE = 'delivery_confirmation';

export interface ListCallsQuery {
  page?: number;
  pageSize?: number;
  status?: CallStatus;
  outcome?: CallOutcome;
  contactId?: string;
}

/** A telephony callback, in the shape `ProviderCallbackSink.callEvent` delivers it. */
export interface CallEventInput {
  providerCallId: string;
  event: 'ringing' | 'answered' | 'completed' | 'failed' | 'no_answer' | 'busy';
  durationSeconds?: number;
  recordingUrl?: string;
  hangupCause?: string;
}

export interface RecordingReadyInput {
  providerCallId: string;
  recordingUrl: string;
  durationSeconds: number;
}

/**
 * Statuses past which a call is finished.
 *
 * Callbacks arrive out of order — a `ringing` can land after the `completed` it
 * preceded, and a retried webhook can replay one from ten minutes ago. Applying either
 * to a finished call would walk the status backwards, so the terminal set is checked
 * first and late callbacks are dropped.
 */
const TERMINAL_STATUSES: readonly CallStatus[] = [
  CallStatus.COMPLETED,
  CallStatus.NO_ANSWER,
  CallStatus.BUSY,
  CallStatus.FAILED,
  CallStatus.ESCALATED,
];

/**
 * AI voice calls — spec §5.
 *
 * The §5.1 pipeline is five steps: place the call, record it, transcribe it, summarize
 * it, decide whether a human is needed. Only the first is triggered by a request; the
 * rest are driven by the provider's own callbacks, so this service is split accordingly:
 *
 * - `place()` runs on the request path and does the money and consent checks, then
 *   hands the dial to the `call-place` queue (§3.4 — an HTTP request never waits on a
 *   telephony provider).
 * - `applyCallEvent()` / `applyRecordingReady()` are the only entrypoints the webhooks
 *   module uses. They resolve the tenant from **our own** row keyed by the provider's
 *   call id, never from the callback body.
 *
 * The money sequence mirrors the campaign sends, with one addition that voice forces:
 * the cost is not known until the call ends. So `place()` reserves an estimate,
 * `completed` settles the minutes that actually elapsed, and every unbilled outcome —
 * no answer, busy, provider failure — releases the hold in full. §15 names "billing a
 * tenant for a message that then fails at the provider" as a risk; for voice the
 * equivalent is being billed three minutes for a phone that rang out, and the release
 * path is what prevents it.
 */
@Injectable()
export class CallsService {
  private readonly logger = new Logger(CallsService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: ExtendedPrismaClient,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(TELEPHONY_PROVIDER) private readonly telephony: TelephonyProvider,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    private readonly queue: QueueService,
    private readonly metering: MeteringService,
    private readonly wallet: WalletService,
    private readonly contacts: ContactsService,
    private readonly communications: CommunicationsService,
    private readonly tenantContext: TenantContext,
  ) {}

  // ── Request path ───────────────────────────────────────────────────────────

  async list(query: ListCallsQuery = {}): Promise<Paginated<CallDto>> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, query.pageSize ?? DEFAULT_PAGE_SIZE));

    const where: Prisma.CallWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.outcome ? { outcome: query.outcome } : {}),
      ...(query.contactId ? { contactId: query.contactId } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.call.findMany({
        where,
        // The list does not include transcripts: a page of 25 calls at ~20 turns each
        // is 500 rows of text nobody reads until they open one.
        include: { contact: { select: { fullName: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.call.count({ where }),
    ]);

    return {
      items: rows.map((row) => toCallDto(row, row.contact.fullName, [])),
      page: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    };
  }

  /** One call, with its transcript — the §5.2 review view. */
  async get(callId: string): Promise<CallDto> {
    const call = await this.prisma.call.findUnique({
      where: { id: callId },
      include: {
        contact: { select: { fullName: true } },
        transcriptTurns: { orderBy: { sequence: 'asc' } },
      },
    });

    if (!call) throw new NotFoundException('Call', callId);
    return toCallDto(call, call.contact.fullName, call.transcriptTurns);
  }

  /**
   * Queue an outbound AI call — spec §5.1 step 1.
   *
   * Four gates before a row exists, in this order:
   *
   * 1. the contact resolves within the caller's tenant (a cross-tenant id 404s here,
   *    because the lookup goes through `ContactsService`);
   * 2. there is a number to dial;
   * 3. §12 consent — a contact who opted out is not called, and that check happens
   *    before the money check so an opted-out contact never produces a hold;
   * 4. §8.2 the wallet can fund the estimate.
   *
   * Only then is the `Call` row written and the dial queued. Doing it in the other
   * order would leave `queued` calls that can never be placed.
   */
  async place(request: PlaceCallRequest, createdBy: string): Promise<CallDto> {
    const tenantId = this.tenantContext.requireTenantId('calls.place');
    const contact = await this.contacts.get(request.contactId);

    if (!contact.phone) {
      throw new ValidationFailedException(`Contact ${contact.fullName} has no phone number to call`, {
        contactId: contact.id,
      });
    }

    if (contact.optedOutAt) {
      // §12 — the opt-out is global, so it covers voice even though the opt-in flags
      // are per-channel. Refusing here rather than at dial time means the tenant gets
      // an error they can act on instead of a call that silently never happens.
      throw new ValidationFailedException(`Contact ${contact.fullName} has opted out of all communication`, {
        contactId: contact.id,
        optedOutAt: contact.optedOutAt,
      });
    }

    // §8.2 — balance checked before the paid action. `checkAffordable` applies the
    // tenant's §5.3 low-balance policy: `hard_stop` refuses at zero, `soft_limit`
    // allows the configured overdraft. Resolving that open item is a settings change.
    const estimatePaise = await this.metering.estimate(
      UsageEventType.AI_CALL_MINUTE,
      ESTIMATED_CALL_MINUTES,
      tenantId,
    );
    await this.wallet.assertAffordable(estimatePaise, `place an AI call to ${contact.fullName}`, tenantId);

    const call = await this.prisma.call.create({
      data: {
        // From the JWT-derived scope, never the request body (§4.3).
        tenantId,
        contactId: contact.id,
        direction: CallDirection.OUTBOUND,
        status: CallStatus.QUEUED,
        fromNumber: this.config.plivo.fromNumber,
        toNumber: contact.phone,
        objective: request.objective ?? DEFAULT_OBJECTIVE,
        scriptId: request.scriptId ?? null,
        // `promptVersion` stays null until a summary exists. It records which prompt
        // produced the summary, which is a property of the summarization and not of
        // the dial — writing it here would claim a provenance nothing has yet.
        createdBy,
        metadata: (request.metadata ?? {}) as Prisma.InputJsonValue,
      },
      include: { contact: { select: { fullName: true } } },
    });

    await this.queue.enqueue(
      'call-place',
      { tenantId, actorUserId: createdBy, callId: call.id },
      // Keyed on our row, so a double-clicked "Call" button dials once.
      { jobId: `call:${call.id}` },
    );

    this.logger.log(`call ${call.id} queued to ${maskNumber(call.toNumber)} for contact ${contact.id}`);
    return toCallDto(call, call.contact.fullName, []);
  }

  /**
   * Hand the call to a human — spec §5.2.
   *
   * Runs the provider hangup inline rather than through the queue, which is the one
   * deliberate exception to §3.4's "async always": the point of escalating is that the
   * AI stops talking to the customer *now*, and a queue hop measured in seconds is a
   * queue hop the customer spends listening to a bot. The billing still settles on the
   * provider's own `completed` callback, so the money path is unchanged.
   */
  async escalate(callId: string, reason: string): Promise<CallDto> {
    const call = await this.require(callId);

    if (call.providerCallId && !TERMINAL_STATUSES.includes(call.status as CallStatus)) {
      await this.telephony.hangup(call.providerCallId).catch((error: unknown) => {
        // The call may already have ended on its own. Escalation is a record of a
        // decision, and failing it because the line was already dead would lose that.
        this.logger.warn(`hangup during escalation of call ${callId} failed: ${(error as Error).message}`);
      });
    }

    const updated = await this.prisma.call.update({
      where: { id: callId },
      data: {
        status: CallStatus.ESCALATED,
        outcome: CallOutcome.ESCALATED_TO_HUMAN,
        escalatedAt: new Date(),
        escalationReason: reason,
        endedAt: call.endedAt ?? new Date(),
      },
      include: {
        contact: { select: { fullName: true } },
        transcriptTurns: { orderBy: { sequence: 'asc' } },
      },
    });

    await this.communications.recordSafely({
      tenantId: call.tenantId,
      contactId: call.contactId,
      callId: call.id,
      channel: Channel.CALL,
      eventType: CommunicationEventType.CALL_ESCALATED,
      summary: `Call escalated to a human: ${reason}`,
      providerReference: call.providerCallId,
      metadata: { reason },
    });

    return toCallDto(updated, updated.contact.fullName, updated.transcriptTurns);
  }

  /** End a call in progress. The `completed` callback does the billing. */
  async hangup(callId: string): Promise<CallDto> {
    const call = await this.require(callId);

    if (!call.providerCallId) {
      throw new ValidationFailedException('This call has not reached the provider yet', {
        callId,
        status: call.status,
      });
    }
    if (TERMINAL_STATUSES.includes(call.status as CallStatus)) {
      throw new ValidationFailedException(`Call is already ${call.status}`, { callId });
    }

    await this.telephony.hangup(call.providerCallId);
    this.logger.log(`call ${callId} hung up by request`);
    return this.get(callId);
  }

  /**
   * A time-limited link to the recording — spec §10.
   *
   * Recordings are classified High sensitivity, which the spec spells out as encrypted
   * at rest, access logged, and never served from a permanent public URL. All three are
   * here: the object lives in S3 (or the local mock's directory), the link expires in
   * five minutes, and every issued link writes a log line naming who asked — "access
   * logged" is only true if something actually writes the line.
   */
  async recordingUrl(callId: string, actor: string): Promise<{ url: string; expiresInSeconds: number }> {
    const call = await this.require(callId);

    if (!call.recordingKey) {
      throw new NotFoundException('Call recording', callId);
    }

    const url = await this.storage.signedUrl(call.recordingKey, RECORDING_URL_TTL_SECONDS);

    this.logger.log(
      `recording access: call=${callId} key=${call.recordingKey} tenant=${call.tenantId} ` +
        `actor=${actor} ttl=${RECORDING_URL_TTL_SECONDS}s`,
    );

    return { url, expiresInSeconds: RECORDING_URL_TTL_SECONDS };
  }

  // ── Provider callbacks ─────────────────────────────────────────────────────

  /**
   * Apply a telephony status callback — spec §5.1.
   *
   * The tenant is resolved from our own `calls` row, keyed by the provider's call id,
   * and then a worker scope is opened on it. Nothing in the callback body selects a
   * tenant, so a forged payload can at worst name a call that does not exist. That is
   * the §4.3 rule ("never a client-supplied tenant identifier") applied to a request
   * that has no JWT to derive a tenant from.
   */
  async applyCallEvent(input: CallEventInput): Promise<void> {
    const located = await this.locate(input.providerCallId);
    if (!located) {
      this.logger.warn(`callback for unknown provider call ${input.providerCallId} — ignored`);
      return;
    }

    await this.tenantContext.runAsWorker(located.tenantId, `apply a ${input.event} call callback`, async () => {
      const call = await this.require(located.id);

      if (TERMINAL_STATUSES.includes(call.status as CallStatus) && input.event !== 'completed') {
        this.logger.debug(`late ${input.event} callback for ${call.status} call ${call.id} — ignored`);
        return;
      }

      switch (input.event) {
        case 'ringing':
          await this.prisma.call.update({ where: { id: call.id }, data: { status: CallStatus.RINGING } });
          return;

        case 'answered':
          await this.prisma.call.update({
            where: { id: call.id },
            data: { status: CallStatus.IN_PROGRESS, startedAt: call.startedAt ?? new Date() },
          });
          return;

        case 'completed':
          await this.complete(call, input);
          return;

        case 'no_answer':
        case 'busy':
        case 'failed':
          await this.abandon(call, input);
          return;
      }
    });
  }

  /**
   * The recording file is available — spec §5.1 steps 2–3.
   *
   * A separate callback from `completed` on purpose: a provider tells you the call
   * ended some seconds before the recording is fetchable, and fetching on the hangup
   * callback is exactly the race that produces intermittent 404s. So the hangup sets
   * `summarizing` and this enqueues the ingest.
   *
   * Honest gap: a call whose recording callback never arrives stays `summarizing`. A
   * reconciliation sweep that polls `fetchRecording` for stuck calls is not built.
   */
  async applyRecordingReady(input: RecordingReadyInput): Promise<void> {
    const located = await this.locate(input.providerCallId);
    if (!located) {
      this.logger.warn(`recording callback for unknown provider call ${input.providerCallId} — ignored`);
      return;
    }

    await this.tenantContext.runAsWorker(located.tenantId, 'ingest a call recording', async () => {
      const call = await this.require(located.id);

      if (call.recordingKey) {
        this.logger.debug(`call ${call.id} already has a stored recording — ignoring the replay`);
        return;
      }

      await this.queue.enqueue(
        'recording-ingest',
        {
          tenantId: located.tenantId,
          callId: call.id,
          recordingUrl: input.recordingUrl,
          durationSeconds: input.durationSeconds,
        },
        { jobId: `recording:${call.id}` },
      );
    });
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /**
   * The call ended having connected — bill the minutes that actually elapsed (§5.3).
   *
   * `billableMinutes` rounds up, so this must not run for a zero-length call: a call
   * that connected and carried no audio would otherwise be charged a full minute. Zero
   * minutes releases the hold instead.
   */
  private async complete(call: Call, input: CallEventInput): Promise<void> {
    const durationSeconds = Math.max(0, Math.round(input.durationSeconds ?? 0));
    const minutes = this.metering.billableMinutes(durationSeconds);
    const key = reservationKey(call.id);

    let costPaise = 0n;

    if (minutes > 0) {
      const charge = await this.metering.settle({
        tenantId: call.tenantId,
        eventType: UsageEventType.AI_CALL_MINUTE,
        actualQuantity: minutes,
        idempotencyKey: key,
        description: `AI call to ${maskNumber(call.toNumber)} — ${minutes} min (${durationSeconds}s)`,
        contactId: call.contactId,
        callId: call.id,
        occurredAt: new Date(),
        metadata: { providerCallId: call.providerCallId, durationSeconds, hangupCause: input.hangupCause },
      });
      costPaise = charge.totalChargePaise;
    } else {
      await this.metering.release({
        tenantId: call.tenantId,
        idempotencyKey: key,
        reason: `Call ${call.id} connected but carried no billable audio`,
      });
    }

    await this.prisma.call.update({
      where: { id: call.id },
      data: {
        // `summarizing` when a recording is promised: the outcome is not known until
        // the LLM has read the transcript, and claiming `completed` first would show a
        // finished call with no summary.
        status: input.recordingUrl ? CallStatus.SUMMARIZING : CallStatus.COMPLETED,
        durationSeconds,
        billedMinutes: minutes,
        costPaise,
        endedAt: new Date(),
        startedAt: call.startedAt ?? new Date(Date.now() - durationSeconds * 1000),
        failureReason: null,
        ...(input.recordingUrl ? {} : { outcome: call.outcome ?? CallOutcome.UNKNOWN }),
      },
    });

    await this.communications.recordSafely({
      tenantId: call.tenantId,
      contactId: call.contactId,
      callId: call.id,
      channel: Channel.CALL,
      eventType: CommunicationEventType.CALL_COMPLETED,
      summary: `AI call completed — ${formatDuration(durationSeconds)}, ${minutes} billed minute${minutes === 1 ? '' : 's'}`,
      providerReference: call.providerCallId,
      metadata: { durationSeconds, billedMinutes: minutes, hangupCause: input.hangupCause },
    });

    this.logger.log(`call ${call.id} completed: ${durationSeconds}s → ${minutes} min, ${costPaise} paise`);
  }

  /**
   * The call never connected — release the hold in full (§15).
   *
   * A phone that rang out costs the tenant nothing. This is the voice equivalent of a
   * provider-side send failure, and the release is what keeps an unreachable contact
   * off the bill.
   */
  private async abandon(call: Call, input: CallEventInput): Promise<void> {
    await this.metering.release({
      tenantId: call.tenantId,
      idempotencyKey: reservationKey(call.id),
      reason: `Call ${call.id} ended as ${input.event}`,
    });

    const status =
      input.event === 'no_answer'
        ? CallStatus.NO_ANSWER
        : input.event === 'busy'
          ? CallStatus.BUSY
          : CallStatus.FAILED;

    await this.prisma.call.update({
      where: { id: call.id },
      data: {
        status,
        outcome: CallOutcome.UNREACHABLE,
        durationSeconds: 0,
        billedMinutes: 0,
        costPaise: 0n,
        endedAt: new Date(),
        failureReason: input.hangupCause ?? input.event,
      },
    });

    await this.communications.recordSafely({
      tenantId: call.tenantId,
      contactId: call.contactId,
      callId: call.id,
      channel: Channel.CALL,
      eventType: CommunicationEventType.CALL_FAILED,
      summary: `AI call not connected — ${input.event.replace(/_/g, ' ')}`,
      providerReference: call.providerCallId,
      metadata: { event: input.event, hangupCause: input.hangupCause },
    });

    this.logger.log(`call ${call.id} ended as ${input.event} — reservation released, nothing billed`);
  }

  /**
   * Which tenant a provider call id belongs to.
   *
   * `runAsSystem` because a webhook has no tenant scope yet and `calls` is a
   * tenant-scoped model — the Prisma extension would refuse the query outright. This
   * is the narrowest possible unscoped read: one row, by a unique provider id, and the
   * only thing taken from it is the tenant to scope everything else to.
   */
  private async locate(providerCallId: string): Promise<{ id: string; tenantId: string } | null> {
    return this.tenantContext.runAsSystem(`resolve provider call ${providerCallId}`, () =>
      this.prisma.call.findUnique({
        where: { providerCallId },
        select: { id: true, tenantId: true },
      }),
    );
  }

  private async require(callId: string): Promise<Call> {
    const call = await this.prisma.call.findUnique({ where: { id: callId } });
    if (!call) throw new NotFoundException('Call', callId);
    return call;
  }
}

/**
 * The idempotency key for a call's reservation and its eventual charge.
 *
 * Our own row id, not the Plivo call uuid — which §8.2 would otherwise suggest. Two
 * reasons: the reserve happens before the provider has issued an id at all, and a
 * retried `call-place` job must find the *existing* hold rather than open a second one.
 * The provider's id is still recorded, on `calls.provider_call_id` and in the usage
 * event's metadata, so the audit trail back to Plivo is intact.
 */
export function reservationKey(callId: string): string {
  return `call:${callId}`;
}

export function toCallDto(call: Call, contactName: string, turns: CallTranscriptTurn[]): CallDto {
  const meta =
    call.metadata && typeof call.metadata === 'object'
      ? (call.metadata as Record<string, unknown>)
      : {};
  const priority =
    typeof meta.priority === 'string' && ['urgent', 'high', 'medium', 'low'].includes(meta.priority)
      ? (meta.priority as 'urgent' | 'high' | 'medium' | 'low')
      : call.escalatedAt
        ? 'urgent'
        : call.summary
          ? 'medium'
          : null;
  const sentiment =
    typeof meta.sentiment === 'string' && ['positive', 'neutral', 'negative'].includes(meta.sentiment)
      ? (meta.sentiment as 'positive' | 'neutral' | 'negative')
      : null;

  return {
    id: call.id,
    contactId: call.contactId,
    contactName,
    direction: call.direction as CallDirection,
    status: call.status as CallStatus,
    outcome: (call.outcome as CallOutcome | null) ?? null,
    providerCallId: call.providerCallId,
    fromNumber: call.fromNumber,
    toNumber: call.toNumber,
    durationSeconds: call.durationSeconds,
    billedMinutes: call.billedMinutes,
    cost: call.costPaise === null ? null : money(call.costPaise),
    recordingKey: call.recordingKey,
    summary: call.summary,
    nextAction: call.nextAction,
    priority,
    sentiment,
    transcript: turns.map(toTranscriptTurnDto),
    promptVersion: call.promptVersion,
    escalatedAt: call.escalatedAt?.toISOString() ?? null,
    startedAt: call.startedAt?.toISOString() ?? null,
    endedAt: call.endedAt?.toISOString() ?? null,
    createdAt: call.createdAt.toISOString(),
  };
}

export function toTranscriptTurnDto(turn: CallTranscriptTurn): TranscriptTurnDto {
  return {
    sequence: turn.sequence,
    speaker: turn.speaker as TranscriptSpeaker,
    text: turn.text,
    confidence: turn.confidence,
    atSeconds: turn.atSeconds,
  };
}

/**
 * A phone number with its middle digits hidden, for logs.
 *
 * Log aggregators are searchable by everyone with access to them, and §10 classifies
 * contact phone numbers as personal data. Keeping the country code and last four is
 * enough to identify a call in a support conversation without putting a customer's
 * number in a log line.
 */
export function maskNumber(number: string): string {
  if (number.length <= 6) return number;
  return `${number.slice(0, 3)}${'*'.repeat(Math.max(0, number.length - 7))}${number.slice(-4)}`;
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}
