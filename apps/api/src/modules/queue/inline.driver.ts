import { Logger } from '@nestjs/common';
import type { QueueName } from '@aiking/shared';

import { PermanentJobError, type EnqueueOptions, type JobContext } from './queue.types';

/**
 * What a queue driver has to do. Two implement it: BullMQ for production, inline for
 * tests and zero-infrastructure local runs.
 */
export interface QueueDriver {
  readonly kind: 'bullmq' | 'inline';
  add(queue: QueueName, payload: unknown, options: EnqueueOptions): Promise<string>;
  /** Called once at application bootstrap, after every processor has registered. */
  start(): Promise<void>;
  /** Block until nothing is pending. Meaningful in tests; a no-op is not acceptable. */
  drain(timeoutMs: number): Promise<void>;
  close(): Promise<void>;
  pendingCount(): Promise<number>;
}

export type RegisteredHandler = (payload: unknown, context: JobContext) => Promise<void>;

interface InlineJob {
  queue: QueueName;
  payload: unknown;
  jobId: string;
  /** Virtual milliseconds at which this job becomes eligible. */
  dueAt: number;
  /** Insertion order, the tiebreak that makes execution order total. */
  seq: number;
  attempt: number;
  maxAttempts: number;
}

/**
 * In-process execution on a virtual clock.
 *
 * The plan's honest trade-off: BullMQ needs a real Redis, and `ioredis-mock` does not
 * implement enough of BullMQ's Lua scripting to stand in. So tests get a second
 * driver rather than a fake Redis.
 *
 * The virtual clock is what makes this more than "call the handler immediately". A
 * mock provider emits `sent` at +0ms and `delivered` at +250ms; a second send does the
 * same. Executing in enqueue order would give sent₁, delivered₁, sent₂, delivered₂ —
 * an ordering that cannot happen in production. Ordering by virtual due time gives
 * sent₁, sent₂, delivered₁, delivered₂, which can. Tests that assert on event
 * sequence are then asserting on something real.
 *
 * `dueAt` is computed from the virtual time of the job that scheduled it, so a chain
 * of callbacks accumulates delay the way wall time would, at no wall-clock cost.
 */
export class InlineQueueDriver implements QueueDriver {
  readonly kind = 'inline' as const;

  private readonly logger = new Logger('InlineQueue');
  private readonly pending: InlineJob[] = [];
  private pumping?: Promise<void>;
  private virtualNow = 0;
  private seq = 0;
  private closed = false;

  constructor(
    private readonly handlers: Map<QueueName, RegisteredHandler>,
    private readonly defaultAttempts: number,
  ) {}

  async add(queue: QueueName, payload: unknown, options: EnqueueOptions): Promise<string> {
    if (this.closed) throw new Error(`Inline queue is closed; cannot enqueue to ${queue}`);

    const jobId = options.jobId ?? `${queue}-${++this.seq}`;

    // Same deduplication semantics as BullMQ's job id: a job already waiting with
    // this id is not added again.
    if (options.jobId && this.pending.some((job) => job.jobId === options.jobId)) {
      return options.jobId;
    }

    this.pending.push({
      queue,
      payload,
      jobId,
      dueAt: this.virtualNow + (options.delayMs ?? 0),
      seq: ++this.seq,
      attempt: 1,
      maxAttempts: options.attempts ?? this.defaultAttempts,
    });

    // Not awaited: `enqueue` returns as soon as the job is accepted, exactly as the
    // BullMQ driver does. Callers that need completion call `drain()`.
    this.pumping ??= this.pump();
    return jobId;
  }

  async start(): Promise<void> {
    // Nothing to start — handlers are resolved at execution time.
  }

  private async pump(): Promise<void> {
    // Yield once so the caller finishes its own work — most importantly, commits its
    // transaction — before a callback job observes the database.
    await Promise.resolve();

    try {
      while (this.pending.length > 0) {
        this.pending.sort((a, b) => a.dueAt - b.dueAt || a.seq - b.seq);
        const job = this.pending.shift() as InlineJob;
        this.virtualNow = Math.max(this.virtualNow, job.dueAt);
        await this.execute(job);
      }
    } finally {
      this.pumping = undefined;
      // A handler may have enqueued more work after the loop's last check.
      if (this.pending.length > 0 && !this.closed) this.pumping = this.pump();
    }
  }

  private async execute(job: InlineJob): Promise<void> {
    const handler = this.handlers.get(job.queue);
    if (!handler) {
      // Loud, because a silently dropped job looks exactly like a feature that does
      // not work, and the cause is three layers away from the symptom.
      this.logger.error(`No processor registered for queue "${job.queue}" — job ${job.jobId} dropped`);
      return;
    }

    const context: JobContext = {
      queue: job.queue,
      jobId: job.jobId,
      attempt: job.attempt,
      maxAttempts: job.maxAttempts,
      isFinalAttempt: job.attempt >= job.maxAttempts,
    };

    try {
      await handler(job.payload, context);
    } catch (error) {
      const permanent = error instanceof PermanentJobError;
      const exhausted = job.attempt >= job.maxAttempts;

      if (permanent || exhausted) {
        this.logger.warn(
          `${job.queue} job ${job.jobId} failed ${permanent ? 'permanently' : `after ${job.attempt} attempts`}: ${
            (error as Error).message
          }`,
        );
        return;
      }

      // Retried on the virtual clock: the policy is exercised, the suite does not wait.
      // BullMQ's own backoff and stalled-job recovery are not covered here — that is
      // what the opt-in real-Redis test is for.
      this.pending.push({
        ...job,
        attempt: job.attempt + 1,
        dueAt: this.virtualNow + backoffMs(job.attempt),
        seq: ++this.seq,
      });
    }
  }

  async drain(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.pumping || this.pending.length > 0) {
      if (Date.now() > deadline) {
        throw new Error(
          `Inline queue did not drain within ${timeoutMs}ms; ${this.pending.length} job(s) still pending ` +
            `(${[...new Set(this.pending.map((job) => job.queue))].join(', ')})`,
        );
      }
      await (this.pumping ?? Promise.resolve());
    }
  }

  async pendingCount(): Promise<number> {
    return this.pending.length;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.pending.length = 0;
  }

  /** Test affordance: reset the virtual clock between cases. */
  resetClock(): void {
    this.virtualNow = 0;
  }
}

/** Exponential with a ceiling — the same shape the BullMQ driver configures. */
export function backoffMs(attempt: number): number {
  return Math.min(1_000 * 2 ** (attempt - 1), 30_000);
}
