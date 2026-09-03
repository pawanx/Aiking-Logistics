import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  CallOutcome,
  CallStatus,
  Channel,
  CommunicationEventType,
  TranscriptSpeaker,
  UsageEventType,
} from '@aiking/shared';
import type { Prisma } from '@prisma/client';

import { InsufficientFundsException } from '../../common/errors/app-exception';
import { PRISMA, type ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { TenantContext } from '../../common/tenant/tenant-context';
import { plivoCallbackUrl, type PlivoCallbackKind } from '../../common/webhook-urls';
import { CONFIG, type AppConfig } from '../../config/configuration';
import { SUMMARY_PROMPT_VERSION } from '../../providers/llm/llm.live';
import {
  LLM_PROVIDER,
  ProviderError,
  STORAGE_PROVIDER,
  STT_PROVIDER,
  TELEPHONY_PROVIDER,
  type LlmProvider,
  type SttProvider,
  type StorageProvider,
  type SummarizeCallResult,
  type TelephonyProvider,
  type TranscriptTurn,
} from '../../providers/provider.types';
import { MeteringService } from '../billing/metering.service';
import { CommunicationsService } from '../communications/communications.service';
import { QueueService } from '../queue/queue.service';
import {
  PermanentJobError,
  type CallPlaceJob,
  type CallSummarizeJob,
  type RecordingIngestJob,
} from '../queue/queue.types';
import { ESTIMATED_CALL_MINUTES, maskNumber, reservationKey } from './calls.service';

/**
 * How much synthetic audio a mock recording gets.
 *
 * Two seconds, regardless of the call's real length. The bytes exist so the storage
 * write and the §10 signed-URL path are genuinely exercised; making them proportional
 * to a 300-second call would put ~1 MB per call on disk to prove exactly the same
 * thing, and the seed alone places hundreds of calls.
 */
const MOCK_AUDIO_SECONDS = 2;

/**
 * One MPEG-1 Layer III frame: a valid 4-byte header (128 kbps, 44.1 kHz, stereo)
 * followed by silence. 417 bytes is that bitrate's frame size, and ~38 frames make a
 * second of audio.
 */
const MP3_FRAME_HEADER = Buffer.from([0xff, 0xfb, 0x90, 0x64]);
const MP3_FRAME_BYTES = 417;
const MP3_FRAMES_PER_SECOND = 38;

/**
 * The AI calling pipeline — spec §5.1, in its five steps.
 *
 * 1. **`call-place`** dials. Reserves the estimated cost *before* the provider call, so
 *    two concurrent calls cannot both spend the same last rupee, and releases the hold
 *    if the dial itself fails.
 * 2–3. **`recording-ingest`** stores the recording and transcribes it. Storage first,
 *    transcription second: the recording is the artifact the tenant is entitled to
 *    under §10 and it must survive a transcription failure.
 * 4–5. **`call-summarize`** summarizes, extracts the next action, and decides whether
 *    §5.2's escalation to a human applies.
 *
 * The steps are separate jobs rather than one long one because they fail for unrelated
 * reasons and retry differently. A Deepgram timeout should not re-dial the customer.
 */
@Injectable()
export class CallProcessors implements OnModuleInit {
  private readonly logger = new Logger(CallProcessors.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: ExtendedPrismaClient,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(TELEPHONY_PROVIDER) private readonly telephony: TelephonyProvider,
    @Inject(STT_PROVIDER) private readonly stt: SttProvider,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    private readonly queue: QueueService,
    private readonly metering: MeteringService,
    private readonly communications: CommunicationsService,
    private readonly tenantContext: TenantContext,
  ) {}

  onModuleInit(): void {
    this.queue.register('call-place', (payload) => this.place(payload));
    this.queue.register('recording-ingest', (payload) => this.ingestRecording(payload));
    this.queue.register('call-summarize', (payload) => this.summarize(payload));
  }

  /**
   * Step 1 — dial.
   *
   * The reserve is repeated here rather than done in `CallsService.place()`, and that is
   * on purpose. `place()` only *checks* affordability; the hold is taken next to the
   * provider call it protects, so the window between "funds held" and "money spent" is
   * as short as it can be. The key is the call row's id, so a retried job finds the
   * existing hold instead of opening a second one.
   */
  private async place(job: CallPlaceJob): Promise<void> {
    await this.tenantContext.runAsWorker(
      job.tenantId,
      'place an AI call',
      async () => {
        const call = await this.prisma.call.findUnique({
          where: { id: job.callId },
          include: { contact: { select: { fullName: true, optedOutAt: true } } },
        });

        if (!call) throw new PermanentJobError(`Call ${job.callId} no longer exists`);

        if (call.status !== CallStatus.QUEUED) {
          // Already dialed. A queue retry after a successful placeCall lands here, and
          // re-dialing would ring the customer twice.
          this.logger.debug(`call ${call.id} is ${call.status} — nothing to place`);
          return;
        }

        if (call.contact.optedOutAt) {
          // §12 — an opt-out recorded between queueing and dialing is still honored.
          await this.fail(call.id, 'opted_out', 'The contact opted out before this call was placed');
          throw new PermanentJobError(`Contact for call ${call.id} opted out before dialing`);
        }

        const key = reservationKey(call.id);

        await this.metering
          .reserve({
            tenantId: job.tenantId,
            eventType: UsageEventType.AI_CALL_MINUTE,
            estimatedQuantity: ESTIMATED_CALL_MINUTES,
            idempotencyKey: key,
            referenceType: 'call',
            referenceId: call.id,
            contactId: call.contactId,
            callId: call.id,
          })
          .catch(async (error: unknown) => {
            if (error instanceof InsufficientFundsException) {
              await this.fail(call.id, 'insufficient_funds', error.message);
              // Retrying without a top-up fails identically. The tenant resolves this,
              // not the queue.
              throw new PermanentJobError(`Insufficient funds to place call ${call.id}`);
            }
            throw error;
          });

        try {
          const result = await this.telephony.placeCall({
            to: call.toNumber,
            from: call.fromNumber,
            answerUrl: this.callbackUrl('answer', call.id),
            hangupUrl: this.callbackUrl('hangup', call.id),
            // §10 — recorded so the transcript and summary exist at all. The recording
            // is High sensitivity from here on.
            record: true,
          });

          await this.prisma.call.update({
            where: { id: call.id },
            data: {
              status: CallStatus.INITIATED,
              providerCallId: result.providerCallId,
              startedAt: result.requestedAt,
              failureReason: null,
            },
          });

          await this.communications.recordSafely({
            tenantId: job.tenantId,
            contactId: call.contactId,
            callId: call.id,
            channel: Channel.CALL,
            eventType: CommunicationEventType.CALL_PLACED,
            summary: `AI call placed to ${call.contact.fullName}`,
            providerReference: result.providerCallId,
            metadata: { objective: call.objective, to: maskNumber(call.toNumber) },
          });

          this.logger.log(`call ${call.id} placed as ${result.providerCallId}`);
        } catch (error) {
          // The dial failed, so nothing was consumed — the hold comes back in full.
          await this.metering.release({
            tenantId: job.tenantId,
            idempotencyKey: key,
            reason: `Dialing failed for call ${call.id}`,
          });

          const providerError = error instanceof ProviderError ? error : null;
          const retryable = providerError?.retryable ?? true;

          if (!retryable) {
            await this.fail(call.id, providerError?.providerCode ?? 'dial_failed', (error as Error).message);
            await this.communications.recordSafely({
              tenantId: job.tenantId,
              contactId: call.contactId,
              callId: call.id,
              channel: Channel.CALL,
              eventType: CommunicationEventType.CALL_FAILED,
              summary: `AI call could not be placed: ${(error as Error).message}`,
              metadata: { providerCode: providerError?.providerCode },
            });
          } else {
            // Left `queued` so the queue's own retry picks it up. Marking it failed
            // would strand a call the next attempt would have connected.
            this.logger.warn(`call ${call.id} dial failed (retryable): ${(error as Error).message}`);
          }

          throw error;
        }
      },
      job.actorUserId,
    );
  }

  /**
   * Steps 2–3 — store the recording, then transcribe it.
   *
   * Ordered that way deliberately: the recording is what §10 entitles the tenant to and
   * what a dispute would be settled from, so it is durable before anything that can
   * fail on a third party's availability. A transcription failure retries against a
   * recording that is already safe.
   */
  private async ingestRecording(job: RecordingIngestJob): Promise<void> {
    await this.tenantContext.runAsWorker(
      job.tenantId,
      'ingest a call recording',
      async () => {
        const call = await this.prisma.call.findUnique({ where: { id: job.callId } });
        if (!call) throw new PermanentJobError(`Call ${job.callId} no longer exists`);

        let recordingKey = call.recordingKey;

        if (!recordingKey) {
          const audio = await this.fetchAudio(job.recordingUrl, job.durationSeconds);
          const stored = await this.storage.put({
            key: recordingObjectKey(job.tenantId, call.id),
            body: audio.body,
            contentType: audio.contentType,
            // Not `public-read` and not cacheable by anything in between: §10 classifies
            // this object High sensitivity and it is only ever served through a signed URL.
            cacheControl: 'private, no-store',
            metadata: { callId: call.id, tenantId: job.tenantId, durationSeconds: String(job.durationSeconds) },
          });

          recordingKey = stored.key;

          await this.prisma.call.update({
            where: { id: call.id },
            data: { recordingKey: stored.key, recordingDurationSeconds: job.durationSeconds },
          });

          this.logger.log(`call ${call.id} recording stored at ${stored.key} (${stored.sizeBytes} bytes)`);
        }

        // Counted rather than assumed: this job retries, and a retry after a successful
        // transcription must not pay Deepgram a second time for the same audio.
        const existingTurns = await this.prisma.callTranscriptTurn.count({ where: { callId: call.id } });

        if (existingTurns === 0) {
          const transcript = await this.stt.transcribe({            // The provider's own URL, not our stored key: a live Deepgram fetches from
            // the telephony provider's CDN, and the mock reads the `mock://` URL to pick
            // its scripted conversation.
            audioUrl: job.recordingUrl,
            languageHint: 'multi',
            context: { purpose: call.objective ?? undefined },
          });

          await this.saveTranscript(call.id, transcript.turns);
          this.logger.log(`call ${call.id} transcribed: ${transcript.turns.length} turns`);
        }

        await this.queue.enqueue(
          'call-summarize',
          { tenantId: job.tenantId, actorUserId: job.actorUserId, callId: call.id },
          { jobId: `summarize:${call.id}` },
        );
      },
      job.actorUserId,
    );
  }

  /**
   * Steps 4–5 — summarize, extract the next action, decide escalation (§5.2).
   *
   * The status this lands on is the call's final one: `escalated` when a human is
   * needed, `completed` otherwise. Until this runs the call sits in `summarizing`,
   * which is why that status exists at all — a call with a duration but no summary is
   * not yet something a manager can act on.
   */
  private async summarize(job: CallSummarizeJob): Promise<void> {
    await this.tenantContext.runAsWorker(
      job.tenantId,
      'summarize a call',
      async () => {
        const call = await this.prisma.call.findUnique({
          where: { id: job.callId },
          include: {
            contact: { select: { fullName: true } },
            tenant: { select: { name: true } },
            transcriptTurns: { orderBy: { sequence: 'asc' } },
          },
        });

        if (!call) throw new PermanentJobError(`Call ${job.callId} no longer exists`);

        if (call.transcriptTurns.length === 0) {
          // Connected, recorded, but nothing was said. There is nothing to summarize
          // and no judgement to make, so the call closes as unknown rather than being
          // left in `summarizing` forever.
          await this.prisma.call.update({
            where: { id: call.id },
            data: { status: CallStatus.COMPLETED, outcome: CallOutcome.UNKNOWN },
          });
          this.logger.warn(`call ${call.id} has no transcript — closed as unknown`);
          return;
        }

        const turns: TranscriptTurn[] = call.transcriptTurns.map((turn) => ({
          sequence: turn.sequence,
          speaker: turn.speaker === TranscriptSpeaker.CUSTOMER ? 'customer' : 'agent',
          text: turn.text,
          startMs: Math.round(turn.atSeconds * 1000),
          endMs: Math.round(turn.atSeconds * 1000),
          confidence: turn.confidence ?? 0,
        }));

        const result = await this.llm.summarizeCall({
          turns,
          purpose: call.objective ?? 'general',
          contactName: call.contact.fullName,
          tenantName: call.tenant.name,
          promptVersion: SUMMARY_PROMPT_VERSION,
        });

        const outcome = outcomeOf(result);
        const existingMetadata =
          call.metadata && typeof call.metadata === 'object'
            ? (call.metadata as Record<string, unknown>)
            : {};
        const updatedMetadata = {
          ...existingMetadata,
          priority: result.priority,
          sentiment: result.sentiment,
        };

        await this.prisma.call.update({
          where: { id: call.id },
          data: {
            status: result.escalate ? CallStatus.ESCALATED : CallStatus.COMPLETED,
            outcome,
            summary: result.summary,
            nextAction: result.nextAction === 'None' ? null : result.nextAction,
            metadata: updatedMetadata as Prisma.InputJsonValue,
            // The provider's own version, so a later prompt change does not silently
            // reinterpret this call's summary.
            promptVersion: result.promptVersion,
            ...(result.escalate
              ? { escalatedAt: new Date(), escalationReason: result.escalationReason ?? 'Escalation triggered by call analysis' }
              : {}),
          },
        });

        await this.communications.recordSafely({
          tenantId: job.tenantId,
          contactId: call.contactId,
          callId: call.id,
          channel: Channel.CALL,
          eventType: result.escalate
            ? CommunicationEventType.CALL_ESCALATED
            : CommunicationEventType.CALL_COMPLETED,
          summary: result.escalate
            ? `Call flagged for human follow-up: ${result.escalationReason ?? 'escalation triggered'}`
            : `Call summarized (${result.priority} priority) — ${outcome.replace(/_/g, ' ')}`,
          providerReference: call.providerCallId,
          metadata: {
            priority: result.priority,
            sentiment: result.sentiment,
            nextAction: result.nextAction,
            promptVersion: result.promptVersion,
          },
        });

        this.logger.log(
          `call ${call.id} summarized: outcome=${outcome} priority=${result.priority} sentiment=${result.sentiment} escalate=${result.escalate}`,
        );
      },
      job.actorUserId,
    );
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /**
   * Replace a call's transcript.
   *
   * A delete-then-insert inside one transaction rather than an upsert per turn: the
   * `(call_id, sequence)` unique index means a re-transcription that produced a
   * different number of turns would otherwise leave orphans from the previous run
   * interleaved with the new ones.
   */
  private async saveTranscript(callId: string, turns: TranscriptTurn[]): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.callTranscriptTurn.deleteMany({ where: { callId } });
      if (turns.length === 0) return;

      await tx.callTranscriptTurn.createMany({
        data: turns.map((turn) => ({
          callId,
          sequence: turn.sequence,
          speaker: turn.speaker === 'customer' ? TranscriptSpeaker.CUSTOMER : TranscriptSpeaker.AGENT,
          text: turn.text,
          confidence: turn.confidence,
          atSeconds: turn.startMs / 1000,
        })),
      });
    });
  }

  /**
   * The recording bytes.
   *
   * An `http(s)` URL is fetched for real — that is what a live Plivo recording is. A
   * `mock://` URL has no bytes behind it, because the mock telephony provider never
   * generated audio, so a short synthetic MP3 is stored instead.
   *
   * That synthetic file is a deliberate, visible fake, and it is worth being exact
   * about what it does and does not prove. It exercises the storage write, the
   * `recording_key` on the call, and the §10 signed-URL path with its access log. It
   * proves nothing about audio fidelity and it will not play as speech. Transcription
   * does not depend on it: the mock STT reads the `mock://` URL directly and returns a
   * scripted conversation.
   *
   * The alternative — leaving `recording_key` null whenever the URL is not http — would
   * mean the entire §10 access path had no coverage until the first live call.
   */
  private async fetchAudio(recordingUrl: string, durationSeconds: number): Promise<{ body: Buffer; contentType: string }> {
    if (/^https?:\/\//i.test(recordingUrl)) {
      const response = await fetch(recordingUrl);
      if (!response.ok) {
        throw new ProviderError(
          'telephony',
          'fetchRecording',
          String(response.status),
          `Recording fetch failed with HTTP ${response.status}`,
          // 5xx and 404 both retry: a recording that is not ready yet returns 404 for a
          // few seconds. Only a 4xx that is not 404 is hopeless.
          response.status >= 500 || response.status === 404,
        );
      }
      return {
        body: Buffer.from(await response.arrayBuffer()),
        contentType: response.headers.get('content-type') ?? 'audio/mpeg',
      };
    }

    return { body: syntheticMp3(MOCK_AUDIO_SECONDS), contentType: 'audio/mpeg' };
  }

  /**
   * Where the provider posts call events back to.
   *
   * Built by the shared helper rather than string-concatenated here, because the Plivo
   * V3 signature covers this exact URL and the webhook controller has to rebuild it
   * byte-for-byte to verify a callback. See `common/webhook-urls.ts`.
   */
  private callbackUrl(kind: PlivoCallbackKind, callId: string): string {
    return plivoCallbackUrl(this.config, kind, callId);
  }

  private async fail(callId: string, code: string, message: string): Promise<void> {
    await this.prisma.call.update({
      where: { id: callId },
      data: {
        status: CallStatus.FAILED,
        outcome: CallOutcome.UNREACHABLE,
        failureReason: `${code}: ${message}`,
        endedAt: new Date(),
      },
    });
  }
}

/**
 * Where a recording lives — spec §10.
 *
 * Tenant-prefixed, so an S3 bucket policy or a lifecycle rule can be written per
 * tenant without reading the database, and a stray key cannot be mistaken for another
 * tenant's object.
 */
export function recordingObjectKey(tenantId: string, callId: string): string {
  return `recordings/${tenantId}/${callId}.mp3`;
}

/**
 * `seconds` worth of silent MP3 frames.
 *
 * Not audio anybody will listen to — see `fetchAudio` for why this exists and what it
 * is for. The header is a real one so the file is at least well-formed.
 */
export function syntheticMp3(seconds: number): Buffer {
  const frame = Buffer.alloc(MP3_FRAME_BYTES);
  MP3_FRAME_HEADER.copy(frame, 0);
  return Buffer.concat(Array.from({ length: Math.max(1, seconds * MP3_FRAMES_PER_SECOND) }, () => frame));
}

/**
 * The §9.3 `call_outcome` for a summarized call.
 *
 * `not_interested` is deliberately absent: it is a judgement about intent that the
 * rule-based mock has no signal for, and inferring it from negative sentiment would be
 * wrong — an angry customer chasing a late delivery is the opposite of uninterested.
 * The live adapter is where that distinction belongs.
 */
export function outcomeOf(result: SummarizeCallResult): CallOutcome {
  if (result.escalate) return CallOutcome.ESCALATED_TO_HUMAN;
  if (result.nextAction && result.nextAction !== 'None') return CallOutcome.FOLLOW_UP_REQUIRED;
  return CallOutcome.RESOLVED;
}
