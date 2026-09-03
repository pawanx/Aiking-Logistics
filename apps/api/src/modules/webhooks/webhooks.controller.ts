import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { RawBody, Webhook } from '../../common/decorators';
import { CONFIG, type AppConfig } from '../../config/configuration';
import { webhookPath } from '../../common/webhook-urls';
import { WebhooksService } from './webhooks.service';

/**
 * Inbound provider webhooks — spec §8.1, §6.1, §6.3, §5.1, §12.
 *
 * Every route is marked `@Webhook(provider)` rather than `@Public()`: both
 * bypass JWT auth, but the distinction lets the route-coverage test assert
 * that every webhook route also verifies a signature (spec §12), and lets
 * the roles guard skip its check without treating webhooks as "public".
 *
 * `@RawBody()` gives the handler the exact bytes the provider signed. It
 * depends on `rawBody: true` in `main.ts`.
 */
@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    private readonly webhooks: WebhooksService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  // ── Meta / WhatsApp Cloud API ────────────────────────────────────────────

  /**
   * Meta subscription verification handshake.
   *
   * A `GET` with `hub.verify_token` and `hub.challenge`. Meta calls this once
   * when the webhook is configured and refuses to subscribe if the echo is
   * wrong. Returns the challenge as plain text on success, 403 on a bad token.
   */
  @Get('meta')
  @Webhook('meta')
  @HttpCode(HttpStatus.OK)
  verifyMetaSubscription(
    @Query('hub.mode') mode: string | undefined,
    @Query('hub.verify_token') token: string | undefined,
    @Query('hub.challenge') challenge: string | undefined,
    @Res() res: Response,
  ): void {
    const echo = this.webhooks.verifyMetaSubscription(mode, token, challenge);
    if (echo === null) {
      res.status(HttpStatus.FORBIDDEN).send('Verification failed');
      return;
    }
    // Meta expects the challenge echoed as plain text, not JSON.
    res.set('Content-Type', 'text/plain').send(echo);
  }

  /**
   * WhatsApp delivery/message callbacks (spec §6.1, §6.3).
   */
  @Post('meta')
  @Webhook('meta')
  @HttpCode(HttpStatus.OK)
  async handleMeta(
    @RawBody() rawBody: Buffer,
    @Req() req: Request,
  ) {
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    return this.webhooks.handleMeta(rawBody, signature);
  }

  // ── Plivo (spec §5.1) ──────────────────────────────────────────────────

  /**
   * Plivo call event callbacks — answer, hangup, recording.
   *
   * The URL includes the callback kind and our own call id (not Plivo's UUID,
   * which is not known at dial time). The V3 signature is verified over the
   * full URL + nonce, so both are reconstructed from our own configuration
   * rather than trusted from the request.
   */
  @Post('plivo/:kind/:callId')
  @Webhook('plivo')
  @HttpCode(HttpStatus.OK)
  async handlePlivo(
    @RawBody() rawBody: Buffer,
    @Param('kind') kind: string,
    @Param('callId') callId: string,
    @Req() req: Request,
  ) {
    const signature = req.headers['x-plivo-signature-v3'] as string | undefined;
    const nonce = req.headers['x-plivo-signature-v3-nonce'] as string | undefined;

    // Reconstruct the URL from our own config so the signature check is not
    // influenced by attacker-controlled Host/X-Forwarded-* headers (§12).
    const url = `${this.config.plivo.callbackBaseUrl.replace(/\/+$/, '')}${webhookPath(this.config, `plivo/${kind}/${callId}`)}`;

    return this.webhooks.handlePlivo(rawBody, signature, nonce, url);
  }

  // ── Razorpay (spec §8.1) ──────────────────────────────────────────────

  /**
   * Razorpay payment.captured / payment.failed (spec §8.1).
   */
  @Post('razorpay')
  @Webhook('razorpay')
  @HttpCode(HttpStatus.OK)
  async handleRazorpay(
    @RawBody() rawBody: Buffer,
    @Req() req: Request,
  ) {
    const signature = req.headers['x-razorpay-signature'] as string | undefined;
    const eventId = req.headers['x-razorpay-event-id'] as string | undefined;
    return this.webhooks.handleRazorpay(rawBody, signature, eventId);
  }

  // ── Email / SES (spec §6.1, §12) ──────────────────────────────────────

  /**
   * SES delivery notification (spec §6.1).
   */
  @Post('email')
  @Webhook('email')
  @HttpCode(HttpStatus.OK)
  async handleEmail(
    @RawBody() rawBody: Buffer,
    @Req() req: Request,
  ) {
    const signature = req.headers['x-email-signature'] as string | undefined;
    return this.webhooks.handleEmail(rawBody, signature);
  }
}
