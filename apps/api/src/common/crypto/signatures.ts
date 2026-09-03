import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhook signature verification — spec §12.
 *
 * "Every inbound webhook (Meta, Plivo, Razorpay) is signature-verified before
 * processing." These functions are used identically in mock and live mode: the
 * mock providers sign their callbacks with the configured secret, so the
 * verification path is exercised by the test suite rather than bypassed in
 * development and first executed in production.
 *
 * Every comparison is timing-safe. An HMAC compared with `===` leaks, byte by
 * byte, how much of a guess was right, which is enough to forge a signature given
 * enough attempts — and a forged Razorpay `payment.captured` credits a wallet.
 */

/**
 * Constant-time comparison of two hex digests.
 *
 * Length is compared first and separately. `timingSafeEqual` throws on a length
 * mismatch rather than returning false, and the length of a digest is not the
 * secret.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function timingSafeEqualBase64(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'base64');
  const right = Buffer.from(b, 'base64');
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function hmacSha256Hex(secret: string, payload: string | Buffer): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function hmacSha256Base64(secret: string, payload: string | Buffer): string {
  return createHmac('sha256', secret).update(payload).digest('base64');
}

/**
 * Meta / WhatsApp Cloud API — `X-Hub-Signature-256: sha256=<hex>`, HMAC-SHA256 of
 * the raw request body keyed by the app secret.
 */
export function signMeta(appSecret: string, rawBody: Buffer | string): string {
  return `sha256=${hmacSha256Hex(appSecret, rawBody)}`;
}

export function verifyMetaSignature(appSecret: string, rawBody: Buffer | string, header: string | undefined): boolean {
  if (!header || !appSecret) return false;
  const [algorithm, digest] = header.split('=');
  if (algorithm !== 'sha256' || !digest) return false;
  return timingSafeEqualHex(hmacSha256Hex(appSecret, rawBody), digest);
}

/**
 * Razorpay webhooks — `X-Razorpay-Signature`, HMAC-SHA256 hex of the raw body
 * keyed by the webhook secret (distinct from the API key secret).
 */
export function signRazorpayWebhook(webhookSecret: string, rawBody: Buffer | string): string {
  return hmacSha256Hex(webhookSecret, rawBody);
}

export function verifyRazorpayWebhookSignature(
  webhookSecret: string,
  rawBody: Buffer | string,
  header: string | undefined,
): boolean {
  if (!header || !webhookSecret) return false;
  return timingSafeEqualHex(hmacSha256Hex(webhookSecret, rawBody), header);
}

/**
 * Razorpay Checkout handler signature — HMAC-SHA256 of `order_id|payment_id`
 * keyed by the API key secret.
 *
 * This is the browser-side confirmation, and it is *not* a substitute for the
 * webhook: the browser can be closed before the handler fires. Spec §8.1 treats
 * the webhook as authoritative and this as an optimistic fast path, both funnelling
 * into the same idempotent credit keyed on `razorpay_payment_id`.
 */
export function signRazorpayPayment(keySecret: string, orderId: string, paymentId: string): string {
  return hmacSha256Hex(keySecret, `${orderId}|${paymentId}`);
}

export function verifyRazorpayPaymentSignature(
  keySecret: string,
  orderId: string,
  paymentId: string,
  signature: string | undefined,
): boolean {
  if (!signature || !keySecret) return false;
  return timingSafeEqualHex(signRazorpayPayment(keySecret, orderId, paymentId), signature);
}

/**
 * Plivo V3 signature — `X-Plivo-Signature-V3` plus `X-Plivo-Signature-V3-Nonce`.
 *
 * Base64 HMAC-SHA256 of `<url><nonce>` keyed by the auth token, where `url` is the
 * callback URL *as Plivo called it*. That last part matters: a proxy that rewrites
 * the host or drops the scheme breaks verification, so the URL is passed in
 * explicitly by the controller rather than reconstructed here from headers.
 */
export function signPlivoV3(authToken: string, url: string, nonce: string): string {
  return hmacSha256Base64(authToken, `${url}${nonce}`);
}

export function verifyPlivoV3Signature(
  authToken: string,
  url: string,
  nonce: string | undefined,
  signature: string | undefined,
): boolean {
  if (!signature || !nonce || !authToken) return false;
  return timingSafeEqualBase64(signPlivoV3(authToken, url, nonce), signature);
}

/**
 * Email delivery callbacks.
 *
 * Real SNS notifications are RSA-signed against a rotating Amazon certificate,
 * which needs a fetch-and-cache of the signing cert — out of scope here, and the
 * live adapter documents it as the remaining work for production SES. What ships
 * is a shared-secret HMAC over the raw body, which is what the mock provider signs
 * and what an SMTP-side relay or API Gateway mapping can be configured to send.
 * The verification path is therefore real; only the SNS-specific key material is
 * not.
 */
export function signEmailWebhook(secret: string, rawBody: Buffer | string): string {
  return hmacSha256Hex(secret, rawBody);
}

export function verifyEmailWebhookSignature(
  secret: string,
  rawBody: Buffer | string,
  header: string | undefined,
): boolean {
  if (!header || !secret) return false;
  return timingSafeEqualHex(hmacSha256Hex(secret, rawBody), header);
}
