import type { AppConfig } from '../config/configuration';

/**
 * Provider callback URLs, built in exactly one place.
 *
 * This exists because of the Plivo V3 signature: it is an HMAC over `url + nonce`,
 * where `url` is the callback URL *as Plivo called it*. So the string the call
 * processor hands to Plivo when it dials, and the string the webhook controller
 * reconstructs when the callback arrives, have to be byte-identical — a missing
 * `/api` prefix or a trailing slash on one side is a 401 on every inbound
 * callback. Two functions building "the same" URL by convention is precisely the
 * kind of agreement that stops holding.
 *
 * The URL is derived from our own configuration plus the route parameters, never
 * from the inbound request's `Host` / `X-Forwarded-*` headers. Those are
 * attacker-controlled: an attacker who can choose the host string can choose what
 * gets signed, and the signature check stops meaning anything.
 */

export type PlivoCallbackKind = 'answer' | 'hangup' | 'recording';

/** The path a webhook is served at, including the API's global prefix. */
export function webhookPath(config: AppConfig, suffix: string): string {
  const prefix = config.api.globalPrefix.replace(/^\/+|\/+$/g, '');
  const tail = suffix.replace(/^\/+/, '');
  return prefix ? `/${prefix}/webhooks/${tail}` : `/webhooks/${tail}`;
}

/**
 * The absolute URL a Plivo callback is delivered to.
 *
 * `callbackBaseUrl` is configured separately from `publicBaseUrl` because in local
 * development Plivo has to reach a tunnel host, not `localhost` — but it defaults to
 * `publicBaseUrl`, which is right everywhere else.
 *
 * `callId` is our own row id rather than Plivo's call uuid: the URL is handed over
 * at dial time, when Plivo has not issued its uuid yet, and it means an access log
 * line identifies the call even for a dial that never got a provider id at all.
 */
export function plivoCallbackUrl(config: AppConfig, kind: PlivoCallbackKind, callId: string): string {
  const base = config.plivo.callbackBaseUrl.replace(/\/+$/, '');
  return `${base}${webhookPath(config, `plivo/${kind}/${callId}`)}`;
}
