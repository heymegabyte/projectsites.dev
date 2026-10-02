/**
 * @module services/outbound_webhooks
 * @description Core delivery policy for Outbound Webhooks (build-first module
 * #10, P1) — customers subscribe their own endpoints to site events, delivered
 * with a signed payload + bounded retries (Svix/Stripe-style).
 *
 * This slice is the pure, deterministic heart: the signed-payload construction
 * (replay-safe — signature covers a timestamp + body), the exponential backoff
 * schedule, and the retry decision. The async HTTP send + HMAC (reusing the
 * shared `hmacSha256` helper) + the endpoint/delivery persistence land in slice
 * 2. Keeping the policy pure makes the security-critical rules unit-testable.
 *
 * @packageDocumentation
 */

import type { Env } from '../types/env.js';
import { dbQuery, dbExecute } from './db.js';
import { encrypt } from './ai_crypto.js';
import { safeFetch, SafeFetchError } from './safe_fetch.js';
import { SsrfError, type SsrfPolicy } from './ssrf_guard.js';

/**
 * SSRF policy for outbound-webhook delivery — mirrors {@link isSafeWebhookUrl}'s
 * scheme rule (https ONLY; no plaintext delivery) and the default private/reserved
 * host blocklist. Passed to {@link safeFetch} so the SAME policy re-validates the
 * initial URL AND every `Location` redirect hop (a 302 to `169.254.169.254` /
 * `localhost` / an RFC1918 host can no longer bypass a first-hop-only check).
 */
const WEBHOOK_SSRF_POLICY: SsrfPolicy = { allowedProtocols: ['https:'] };

/** Max delivery attempts before a delivery is marked permanently failed. */
export const MAX_DELIVERY_ATTEMPTS = 6;
/** First-retry delay; each subsequent attempt doubles up to {@link MAX_RETRY_DELAY_MS}. */
export const BASE_RETRY_DELAY_MS = 1000;
/** Cap on a single retry delay (1 hour). */
export const MAX_RETRY_DELAY_MS = 3_600_000;

/**
 * The exact string the signature is computed over: `<timestamp>.<body>`. Binding
 * the timestamp into the signed material is what makes a captured payload
 * un-replayable (the receiver rejects a stale timestamp).
 */
export function signedPayloadBase(timestamp: string, body: string): string {
  return `${timestamp}.${body}`;
}

/** Svix/Stripe-style signature header value: `t=<timestamp>,v1=<hex>`. */
export function buildSignatureHeader(timestamp: string, signatureHex: string): string {
  return `t=${timestamp},v1=${signatureHex}`;
}

/**
 * Backoff delay (ms) before the given 1-based attempt's retry: exponential
 * (`BASE * 2^(attempt-1)`) capped at {@link MAX_RETRY_DELAY_MS}. Deterministic
 * (no jitter) so the schedule is testable; slice 2 may add jitter at send time.
 */
export function nextRetryDelayMs(attempt: number): number {
  const exp = BASE_RETRY_DELAY_MS * 2 ** Math.max(0, attempt - 1);
  return Math.min(exp, MAX_RETRY_DELAY_MS);
}

/** A 2xx response means the endpoint accepted the delivery. */
export function isDeliverySuccess(statusCode: number): boolean {
  return statusCode >= 200 && statusCode < 300;
}

/**
 * Whether a failed attempt should be retried. Retries are bounded by
 * {@link MAX_DELIVERY_ATTEMPTS} and only fire for transient failures:
 * network error (`statusCode === 0`), `429`, or any `5xx`. A non-429 `4xx` is a
 * permanent client error (bad URL, auth) — never retried (don't hammer).
 *
 * @param attempt - 1-based attempt number that just failed.
 * @param statusCode - HTTP status (use `0` for a network-level failure).
 */
export function shouldRetry(attempt: number, statusCode: number): boolean {
  if (attempt >= MAX_DELIVERY_ATTEMPTS) return false;
  if (isDeliverySuccess(statusCode)) return false;
  if (statusCode === 0 || statusCode === 429 || statusCode >= 500) return true;
  return false; // permanent 4xx
}

/** Site events a customer endpoint may subscribe to (allowlist). */
export const WEBHOOK_EVENT_TYPES = [
  'site.published',
  'form.submitted',
  'payment.succeeded',
  'review.received',
  'build.failed',
  'domain.active',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export interface EndpointValidation {
  ok: boolean;
  errors: string[];
}

/**
 * Validate a subscription before persisting: the URL must be a valid **https**
 * URL (no plaintext delivery), and every event must be on the allowlist (a typo
 * can't subscribe to a phantom event). SSRF hardening (block internal/localhost
 * hosts) is a noted follow-up for the dispatch slice.
 */
export function validateEndpointInput(url: string, eventTypes: string[]): EndpointValidation {
  const errors: string[] = [];

  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    errors.push('Endpoint URL is not a valid URL.');
  }
  if (parsed && parsed.protocol !== 'https:') errors.push('Endpoint URL must use https.');

  if (!Array.isArray(eventTypes) || eventTypes.length === 0) {
    errors.push('Subscribe to at least one event type.');
  } else {
    for (const e of eventTypes) {
      if (!(WEBHOOK_EVENT_TYPES as readonly string[]).includes(e)) {
        errors.push(`Unknown event "${e}". Allowed: ${WEBHOOK_EVENT_TYPES.join(', ')}.`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Mask a signing secret for display (show only the last 4 chars). */
export function maskSecret(secret: string): string {
  return secret.length <= 4 ? '••••' : `••••${secret.slice(-4)}`;
}

/** True when `host` is a private/reserved IPv4 literal (SSRF-blocked). */
function isPrivateIPv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return false;
  const [a, b] = o as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true; // this-host / private / loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata (169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

/**
 * SSRF guard for a webhook destination — call BEFORE fetching a customer URL in
 * the dispatcher. Requires https and rejects localhost, `.local`/`.localhost`,
 * IPv6 loopback/link-local/ULA, and private/reserved IPv4 literals (incl. the
 * cloud metadata endpoint 169.254.169.254).
 *
 * Note: this blocks literal-IP + obvious-name SSRF. A hostname that DNS-resolves
 * to a private IP (DNS rebinding) needs connect-time IP pinning — a deeper
 * hardening tracked for the dispatcher.
 */
export function isSafeWebhookUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  return isSafePublicHost(u.hostname);
}

/**
 * True when `host` is NOT a private/reserved/internal SSRF target — the shared
 * blocklist behind both {@link isSafeWebhookUrl} (https-only) and
 * {@link isSafeCrawlUrl} (http+https). Strips IPv6 brackets, then rejects
 * localhost, `.local`/`.localhost`, IPv6 loopback/link-local/ULA, IPv4-mapped/
 * compat IPv6, and private/reserved IPv4 (incl. cloud metadata 169.254.169.254).
 *
 * The IPv6 ULA/link-local prefix checks only fire on actual IPv6 literals (host
 * contains `:`) so a dotted public hostname like `fcbarcelona.com` is NOT a
 * false reject.
 *
 * @param host - URL hostname (may include `[...]` IPv6 brackets)
 * @returns true when the host is a public, non-internal target
 * @example isSafePublicHost('169.254.169.254') // false
 * @example isSafePublicHost('example.com') // true
 */
export function isSafePublicHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return false;
  // IPv6-literal-only checks (a dotted hostname can't be an IPv6 literal).
  if (h.includes(':')) {
    if (h === '::1' || h === '0:0:0:0:0:0:0:1') return false; // IPv6 loopback
    if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return false; // link-local / ULA
    // IPv4-mapped / IPv4-compatible IPv6 (e.g. [::ffff:127.0.0.1] → '::ffff:7f00:1')
    // sails past the dotted-quad isPrivateIPv4 check, so [::ffff:169.254.169.254]
    // would reach cloud metadata. No legitimate public target is one of these.
    if (h.startsWith('::ffff:') || h.startsWith('::')) return false;
  }
  if (isPrivateIPv4(h)) return false;
  return true;
}

/**
 * SSRF guard for the build crawler — call BEFORE fetching ANY discovered URL.
 * Unlike {@link isSafeWebhookUrl} it allows `http:` as well as `https:` (legacy
 * source sites are frequently http) but applies the SAME internal-host blocklist
 * via {@link isSafePublicHost}, so a crawl can never reach localhost, RFC1918,
 * link-local, or the cloud-metadata endpoint — including via a sitemap entry,
 * a robots.txt line, or a homepage `<a href>` the BFS pass follows.
 *
 * @remarks Defense-in-depth at the fetch layer; the import route already guards
 *   the SEED url. Redirect-following (`fetch redirect:'follow'`) can still hop to
 *   an internal target after a safe first URL — connect-time IP pinning is the
 *   deeper fix, tracked with the dispatcher's DNS-rebinding hardening.
 *
 * @param url - candidate URL to fetch
 * @returns true when the URL is safe to fetch server-side
 * @example isSafeCrawlUrl('http://example.com/about') // true
 * @example isSafeCrawlUrl('http://169.254.169.254/latest/meta-data') // false
 */
export function isSafeCrawlUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return isSafePublicHost(u.hostname);
}

export interface StoredEndpoint {
  id: string;
  url: string;
  eventTypes: string[];
  enabled: boolean;
}
export interface CreateEndpointResult {
  ok: boolean;
  id?: string;
  /** Plaintext signing secret — returned ONCE at creation, never stored unencrypted. */
  secret?: string;
  errors?: string[];
}

/** Validate, generate + encrypt a signing secret, and persist a subscription (org+site scoped). */
export async function createWebhookEndpoint(
  env: Env,
  orgId: string,
  siteId: string,
  url: string,
  eventTypes: string[],
): Promise<CreateEndpointResult> {
  const v = validateEndpointInput(url, eventTypes);
  if (!v.ok) return { ok: false, errors: v.errors };

  const secret = `whsec_${crypto.randomUUID().replace(/-/g, '')}${crypto.randomUUID().replace(/-/g, '')}`;
  const secretEncrypted = await encrypt(env, secret);
  const id = crypto.randomUUID();
  const res = await dbExecute(
    env.DB,
    `INSERT INTO webhook_endpoints (id, site_id, org_id, url, secret_encrypted, event_types)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, siteId, orgId, url, secretEncrypted, JSON.stringify(eventTypes)],
  );
  if (res.error) return { ok: false, errors: [res.error] };
  return { ok: true, id, secret };
}

/** List a site's endpoints (org+site scoped) — NEVER includes the secret. */
export async function listWebhookEndpoints(
  env: Env,
  orgId: string,
  siteId: string,
): Promise<StoredEndpoint[]> {
  const { data } = await dbQuery<{ id: string; url: string; event_types: string; enabled: number }>(
    env.DB,
    `SELECT id, url, event_types, enabled FROM webhook_endpoints
     WHERE org_id = ? AND site_id = ? AND deleted_at IS NULL ORDER BY created_at DESC`,
    [orgId, siteId],
  );
  return data.map((r) => ({
    id: r.id,
    url: r.url,
    eventTypes: JSON.parse(r.event_types) as string[],
    enabled: r.enabled === 1,
  }));
}

export interface EndpointForDispatch {
  id: string;
  url: string;
  eventTypes: string[];
  enabled: boolean;
}
export interface PlannedDelivery {
  endpointId: string;
  url: string;
  /** The exact JSON body to POST (the signature covers `timestamp.body`). */
  body: string;
  timestamp: string;
  /** `signedPayloadBase(timestamp, body)` — HMAC this with the endpoint's secret. */
  signatureBase: string;
}
export interface DispatchPlan {
  deliveries: PlannedDelivery[];
  skipped: Array<{ endpointId: string; reason: 'disabled' | 'not_subscribed' | 'unsafe_url' }>;
}

/**
 * Pure dispatch planner: given an event + the site's endpoints, compute which
 * deliveries to attempt and which to skip (disabled / not subscribed to this
 * event / SSRF-unsafe URL). The worker dispatcher then, per delivery, decrypts
 * the endpoint secret, HMACs `signatureBase`, and POSTs `body` with the
 * signature header — retrying via `shouldRetry`/`nextRetryDelayMs`.
 *
 * Pure (timestamp injected) so the match + skip logic is unit-testable.
 */
export function planDeliveries(
  event: { type: string; payload: unknown },
  endpoints: EndpointForDispatch[],
  timestamp: string,
): DispatchPlan {
  const body = JSON.stringify({ type: event.type, payload: event.payload, timestamp });
  const deliveries: PlannedDelivery[] = [];
  const skipped: DispatchPlan['skipped'] = [];

  for (const e of endpoints) {
    if (!e.enabled) {
      skipped.push({ endpointId: e.id, reason: 'disabled' });
      continue;
    }
    if (!e.eventTypes.includes(event.type)) {
      skipped.push({ endpointId: e.id, reason: 'not_subscribed' });
      continue;
    }
    if (!isSafeWebhookUrl(e.url)) {
      skipped.push({ endpointId: e.id, reason: 'unsafe_url' });
      continue;
    }
    deliveries.push({
      endpointId: e.id,
      url: e.url,
      body,
      timestamp,
      signatureBase: signedPayloadBase(timestamp, body),
    });
  }

  return { deliveries, skipped };
}

export interface DeliveryAttemptResult {
  statusCode: number;
  ok: boolean;
  error?: 'unsafe_url' | 'network_error';
}

/**
 * Perform ONE delivery attempt for a planned delivery, given the precomputed
 * HMAC signature (the caller decrypts the endpoint secret + `hmacSha256` over
 * `delivery.signatureBase`). POSTs the body with Svix/Stripe-style signature +
 * timestamp headers.
 *
 * SSRF is enforced on EVERY hop: the POST goes through {@link safeFetch} with
 * {@link WEBHOOK_SSRF_POLICY} (https-only, mirroring {@link isSafeWebhookUrl}) and
 * `redirect: 'manual'`, so a registered endpoint that 302-redirects to an internal
 * host (cloud metadata `169.254.169.254`, `localhost`, an RFC1918 host) is BLOCKED
 * — a first-hop-only check (`fetch redirect:'follow'`) would have followed the
 * redirect and POSTed the signed payload to the internal target (CWE-918 blind
 * SSRF, `[[ssrf-redirect-follow-bypasses-host-allowlist-revalidate-every-hop]]`).
 * A pre-check on the seed URL short-circuits before any network call.
 *
 * An SSRF rejection (initial URL or any redirect hop) — and a redirect-loop
 * ({@link SafeFetchError}) — FAILS CLOSED as the `unsafe_url` outcome, which the
 * dispatcher treats as a PERMANENT block (never retried). Any other throw (a real
 * network/transport failure) maps to the transient `network_error` outcome.
 *
 * `fetch` is injected so the headers + outcome mapping are unit-testable (it is
 * passed straight through to `safeFetch` as its fetch impl, so a test's mock can
 * drive redirect chains deterministically). The dispatcher wraps this with retry
 * (`shouldRetry`/`nextRetryDelayMs`) via a Queue/Workflow and records each attempt.
 */
export async function attemptDelivery(
  fetchFn: typeof fetch,
  delivery: PlannedDelivery,
  signatureHex: string,
): Promise<DeliveryAttemptResult> {
  if (!isSafeWebhookUrl(delivery.url)) return { statusCode: 0, ok: false, error: 'unsafe_url' };
  try {
    const res = await safeFetch(delivery.url, {
      policy: WEBHOOK_SSRF_POLICY,
      fetchImpl: fetchFn as unknown as NonNullable<Parameters<typeof safeFetch>[1]>['fetchImpl'],
      init: {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'webhook-signature': buildSignatureHeader(delivery.timestamp, signatureHex),
          'webhook-timestamp': delivery.timestamp,
        },
        body: delivery.body,
      },
    });
    return { statusCode: res.status, ok: isDeliverySuccess(res.status) };
  } catch (e) {
    // An SSRF-blocked host/hop (incl. a redirect to an internal target) or a
    // redirect loop is a PERMANENT block — fail closed, never retry it.
    if (e instanceof SsrfError || e instanceof SafeFetchError) {
      return { statusCode: 0, ok: false, error: 'unsafe_url' };
    }
    return { statusCode: 0, ok: false, error: 'network_error' };
  }
}

export interface DeliveryRecord {
  endpointId: string;
  siteId: string;
  eventType: string;
  statusCode: number;
  ok: boolean;
  attempt: number;
  error?: string;
}

/** Append a delivery-attempt row to the log (the orchestrator calls this per attempt). */
export async function recordDelivery(env: Env, rec: DeliveryRecord): Promise<void> {
  const { error } = await dbExecute(
    env.DB,
    `INSERT INTO webhook_deliveries (id, endpoint_id, site_id, event_type, status_code, ok, attempt, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      crypto.randomUUID(),
      rec.endpointId,
      rec.siteId,
      rec.eventType,
      rec.statusCode,
      rec.ok ? 1 : 0,
      rec.attempt,
      rec.error ?? null,
    ],
  );
  // Best-effort delivery-attempt log — never break the webhook flow (the delivery already
  // happened), but LOG a dropped write so a gap in the delivery history is observable.
  if (error) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'outbound_webhooks',
        message: 'dropped webhook_deliveries log write',
        endpoint_id: rec.endpointId,
        site_id: rec.siteId,
        error,
      }),
    );
  }
}

export interface StoredDelivery {
  id: string;
  endpointId: string;
  eventType: string;
  statusCode: number;
  ok: boolean;
  attempt: number;
  error: string | null;
  createdAt: string;
}

/** Recent delivery attempts for a site (newest first). Caller must own the site. */
export async function listDeliveries(
  env: Env,
  siteId: string,
  limit = 50,
): Promise<StoredDelivery[]> {
  const capped = Math.min(Math.max(1, Math.floor(limit)), 200);
  const { data } = await dbQuery<{
    id: string;
    endpoint_id: string;
    event_type: string;
    status_code: number;
    ok: number;
    attempt: number;
    error: string | null;
    created_at: string;
  }>(
    env.DB,
    `SELECT id, endpoint_id, event_type, status_code, ok, attempt, error, created_at
     FROM webhook_deliveries WHERE site_id = ? ORDER BY created_at DESC LIMIT ?`,
    [siteId, capped],
  );
  return data.map((r) => ({
    id: r.id,
    endpointId: r.endpoint_id,
    eventType: r.event_type,
    statusCode: r.status_code,
    ok: r.ok === 1,
    attempt: r.attempt,
    error: r.error,
    createdAt: r.created_at,
  }));
}

/** Soft-delete an endpoint (org+site scoped). `ok:false` when nothing matched. */
export async function deleteWebhookEndpoint(
  env: Env,
  orgId: string,
  siteId: string,
  id: string,
): Promise<{ ok: boolean }> {
  const res = await dbExecute(
    env.DB,
    "UPDATE webhook_endpoints SET deleted_at = datetime('now') WHERE id = ? AND org_id = ? AND site_id = ? AND deleted_at IS NULL",
    [id, orgId, siteId],
  );
  return { ok: !res.error && res.changes > 0 };
}
