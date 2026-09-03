import 'reflect-metadata';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from './app.module';
import { CONFIG, type AppConfig, redactedSummary } from './config/configuration';

/**
 * API entry point — boots the NestJS application and starts listening.
 *
 * `rawBody: true` is critical: webhook HMAC verification (spec §12) must run
 * over the exact bytes the provider signed, not a re-serialised object. The
 * `@RawBody()` decorator in the webhook controller depends on this.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    bodyParser: true,
  });

  const config = app.get<AppConfig>(CONFIG);
  const logger = new Logger('Bootstrap');

  // ── Global prefix ────────────────────────────────────────────────────────
  const prefix = config.api.globalPrefix;
  app.setGlobalPrefix(prefix);

  // ── CORS ─────────────────────────────────────────────────────────────────
  app.enableCors({
    origin: config.api.corsOrigins,
    credentials: true,
  });

  // ── Swagger (development only) ───────────────────────────────────────────
  if (!config.isProduction) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Aiking Solutions API')
      .setDescription('Multi-Tenant AI Customer Communication Platform')
      .setVersion('1.0.0')
      .addBearerAuth()
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup(`${prefix}/docs`, app, document);
    logger.log(`Swagger → http://localhost:${config.api.port}/${prefix}/docs`);
  }

  // ── Start listening ──────────────────────────────────────────────────────
  await app.listen(config.api.port);
  logger.log(`API listening on port ${config.api.port} (${config.nodeEnv})`);
  logger.log(JSON.stringify(redactedSummary(config), null, 2));
}

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Fatal: bootstrap failed', error);
  process.exit(1);
});
