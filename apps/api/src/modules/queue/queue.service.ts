import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { QueueName } from '@aiking/shared';

import { CONFIG, type AppConfig } from '../../config/configuration';
import { BullQueueDriver } from './bull.driver';
import { InlineQueueDriver, type QueueDriver, type RegisteredHandler } from './inline.driver';
import type { EnqueueOptions, JobHandler, JobPayload } from './queue.types';

/**
 * The queue seam — spec §3.4.
 *
 * Everything that touches a provider goes through here, so an HTTP handler returns as
 * soon as the work is durably accepted. `QUEUE_DRIVER` picks the implementation:
 * `bullmq` in production and Docker, `inline` in tests and for a zero-infrastructure
 * local run.
 *
 * Processors register in their own `onModuleInit`; workers start in
 * `onApplicationBootstrap`. That ordering is not incidental — Nest runs every
 * `onModuleInit` before any `onApplicationBootstrap`, so by the time a BullMQ worker
 * is created its handler is guaranteed present. Starting workers in `onModuleInit`
 * would race the processors that depend on this service and start workers for queues
 * that had not registered yet.
 */
@Injectable()
export class QueueService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private readonly handlers = new Map<QueueName, RegisteredHandler>();
  private readonly driver: QueueDriver;

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {
    this.driver =
      config.queue.driver === 'bullmq'
        ? new BullQueueDriver(config, this.handlers)
        : new InlineQueueDriver(this.handlers, 5);
  }

  register<K extends QueueName>(queue: K, handler: JobHandler<K>): void {
    if (this.handlers.has(queue)) {
      // Two processors on one queue means one of them silently never runs. Better to
      // refuse at boot than to debug it later.
      throw new Error(`A processor is already registered for queue "${queue}"`);
    }
    this.handlers.set(queue, handler as RegisteredHandler);
  }

  async enqueue<K extends QueueName>(queue: K, payload: JobPayload<K>, options: EnqueueOptions = {}): Promise<string> {
    const jobId = await this.driver.add(queue, payload, options);
    this.logger.debug(`enqueued ${queue} ${jobId}${options.delayMs ? ` (+${options.delayMs}ms)` : ''}`);
    return jobId;
  }

  /**
   * Wait for the queues to be empty.
   *
   * Used by tests and the smoke script after triggering an action, in place of
   * sleeping and hoping. Under `inline` this is exact. Under `bullmq` it polls job
   * counts, so it is subject to the usual "empty right now" caveat — a job a handler
   * is about to enqueue may not be counted yet — which is why the e2e suite runs
   * inline and the BullMQ path is checked by the smoke script instead.
   */
  async drain(timeoutMs = 15_000): Promise<void> {
    await this.driver.drain(timeoutMs);
  }

  async pendingCount(): Promise<number> {
    return this.driver.pendingCount();
  }

  get driverKind(): 'bullmq' | 'inline' {
    return this.driver.kind;
  }

  /** Registered queues, for the health endpoint and the boot log. */
  get registeredQueues(): QueueName[] {
    return [...this.handlers.keys()];
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.driver.start();
    this.logger.log(
      `driver=${this.driver.kind} role=${this.config.appRole} queues=[${this.registeredQueues.join(', ')}]`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.driver.close();
  }
}
