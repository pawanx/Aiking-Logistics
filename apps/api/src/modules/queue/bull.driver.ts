import { Logger } from '@nestjs/common';
import { ALL_QUEUES, type QueueName } from '@aiking/shared';
import { Queue, UnrecoverableError, Worker, type JobsOptions } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';

import type { AppConfig } from '../../config/configuration';
import { backoffMs, type QueueDriver, type RegisteredHandler } from './inline.driver';
import { PermanentJobError, type EnqueueOptions, type JobContext } from './queue.types';

/**
 * BullMQ over Redis — the production driver (spec §1.2, §3.4).
 *
 * The API process creates producers only; workers are created when `APP_ROLE` is
 * `worker` or `both`. That is the §3.5 modular-monolith shape: one image, two
 * commands, and an API container that cannot be starved of request capacity by a bulk
 * campaign that happens to be dispatching.
 */
export class BullQueueDriver implements QueueDriver {
  readonly kind = 'bullmq' as const;

  private readonly logger = new Logger('BullQueue');
  private readonly queues = new Map<QueueName, Queue>();
  private readonly workers: Worker[] = [];
  private readonly connections: Redis[] = [];

  constructor(
    private readonly config: AppConfig,
    private readonly handlers: Map<QueueName, RegisteredHandler>,
  ) {}

  /**
   * A fresh connection per role.
   *
   * `maxRetriesPerRequest: null` is required by BullMQ workers — with a finite value
   * ioredis rejects in-flight commands during a reconnect and the worker treats its
   * own blocking read as a job failure.
   */
  private connect(role: string): Redis {
    const connection = new IORedis(this.config.redis.url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      connectionName: `aiking-${role}`,
      retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
    });
    connection.on('error', (error) => this.logger.error(`redis (${role}): ${error.message}`));
    this.connections.push(connection);
    return connection;
  }

  private queueFor(name: QueueName): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, {
        connection: this.connect(`producer-${name}`),
        prefix: this.config.queue.prefix,
        defaultJobOptions: this.defaultJobOptions(),
      });
      this.queues.set(name, queue);
    }
    return queue;
  }

  private defaultJobOptions(): JobsOptions {
    return {
      attempts: 5,
      backoff: { type: 'exponential', delay: backoffMs(1) },
      // Kept briefly for debugging, then trimmed: an unbounded completed set is the
      // usual way a BullMQ Redis quietly fills up.
      removeOnComplete: { age: 3_600, count: 1_000 },
      removeOnFail: { age: 7 * 24 * 3_600 },
    };
  }

  async add(queue: QueueName, payload: unknown, options: EnqueueOptions): Promise<string> {
    const sanitizedJobId = options.jobId ? options.jobId.replace(/:/g, '_') : undefined;
    const job = await this.queueFor(queue).add(queue, payload, {
      delay: options.delayMs,
      attempts: options.attempts,
      jobId: sanitizedJobId,
    });
    return job.id ?? sanitizedJobId ?? 'unknown';
  }

  async start(): Promise<void> {
    if (this.config.appRole === 'api') {
      this.logger.log('APP_ROLE=api — producers only, no workers started');
      return;
    }

    for (const name of ALL_QUEUES) {
      const handler = this.handlers.get(name);
      if (!handler) {
        // Not fatal: a deployment may legitimately run a subset. But it is logged,
        // because the alternative is jobs accumulating with nobody consuming them.
        this.logger.warn(`no processor registered for "${name}" — not starting a worker`);
        continue;
      }

      const worker = new Worker(
        name,
        async (job) => {
          const context: JobContext = {
            queue: name,
            jobId: job.id ?? 'unknown',
            attempt: job.attemptsMade + 1,
            maxAttempts: job.opts.attempts ?? 5,
            isFinalAttempt: job.attemptsMade + 1 >= (job.opts.attempts ?? 5),
          };

          try {
            await handler(job.data, context);
          } catch (error) {
            // Translate our marker into BullMQ's, so a permanently-failed job stops
            // consuming its attempt budget instead of retrying four more times.
            if (error instanceof PermanentJobError) {
              throw new UnrecoverableError(error.message);
            }
            throw error;
          }
        },
        {
          connection: this.connect(`worker-${name}`),
          prefix: this.config.queue.prefix,
          concurrency: this.config.queue.concurrency,
        },
      );

      worker.on('failed', (job, error) => {
        this.logger.warn(`${name} job ${job?.id ?? '?'} failed (attempt ${job?.attemptsMade ?? '?'}): ${error.message}`);
      });
      worker.on('error', (error) => this.logger.error(`${name} worker: ${error.message}`));

      this.workers.push(worker);
    }

    this.logger.log(`started ${this.workers.length} worker(s), concurrency ${this.config.queue.concurrency}`);
  }

  async drain(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = await this.pendingCount();
      if (remaining === 0) return;
      if (Date.now() > deadline) {
        throw new Error(`Queues did not drain within ${timeoutMs}ms; ${remaining} job(s) outstanding`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async pendingCount(): Promise<number> {
    let total = 0;
    for (const name of ALL_QUEUES) {
      // Every state a job can sit in before it has run. Note there is no 'paused'
      // count in BullMQ 6 — a paused queue keeps its jobs in 'waiting' — and
      // 'wait' is an alias for 'waiting', so asking for both would double-count.
      const counts = await this.queueFor(name).getJobCounts(
        'waiting',
        'active',
        'delayed',
        'prioritized',
        'waiting-children',
      );
      total += Object.values(counts).reduce((sum, count) => sum + (count ?? 0), 0);
    }
    return total;
  }

  async close(): Promise<void> {
    // Workers first, so in-flight jobs finish before their Redis connection goes.
    await Promise.all(this.workers.map((worker) => worker.close()));
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    await Promise.all(this.connections.map((connection) => connection.quit().catch(() => connection.disconnect())));
  }
}
