import 'reflect-metadata';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { CONFIG, type AppConfig, redactedSummary } from './config/configuration';

/**
 * Worker entry point — boots the same `AppModule` as the API but never starts
 * an HTTP listener.
 *
 * Spec §3.5: the modular monolith means one codebase, two processes. The API
 * handles HTTP; the worker processes BullMQ jobs. Both share the same
 * `AppModule` so domain services, providers and database connections are
 * identical — a campaign processor calls `CampaignsService` the same way the
 * controller does.
 *
 * `APP_ROLE` is set to `worker` so `QueueService.onApplicationBootstrap()`
 * starts polling the Redis-backed queues. When `APP_ROLE=api` (the default),
 * workers are not started, so the API process never competes for jobs.
 */
async function bootstrap(): Promise<void> {
  // Force worker role before the config module reads the environment.
  process.env.APP_ROLE = 'worker';

  const app = await NestFactory.createApplicationContext(AppModule);
  const config = app.get<AppConfig>(CONFIG);
  const logger = new Logger('Worker');

  logger.log(`Worker started (${config.nodeEnv}, queue=${config.queue.driver})`);
  logger.log(JSON.stringify(redactedSummary(config), null, 2));

  // Graceful shutdown: let BullMQ workers finish their current job before
  // the process exits. `onModuleDestroy` in `QueueService` closes the workers.
  const shutdown = async (signal: string) => {
    logger.log(`Received ${signal} — shutting down…`);
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Fatal: worker bootstrap failed', error);
  process.exit(1);
});
