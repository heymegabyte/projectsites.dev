/**
 * Structured logging library.
 *
 * @remarks
 * Two usage modes:
 *
 * 1. **Module-level singleton** (`log`) — same API as before, zero migration pain.
 * 2. **Scoped child logger** (`log.child('scope')`) — returns a {@link Logger} whose
 *    every call carries a `scope` field so you can grep by service area:
 *    ```ts
 *    const l = log.child('auth');
 *    l.info('magic_link_sent', { userId });
 *    // → { level:'info', scope:'auth', eventName:'magic_link_sent', … }
 *    ```
 *
 * **Production format** (`ENVIRONMENT === 'production'`):
 *   One JSON line per call: `{ts, level, scope, msg, request_id, ...safeCtx}`
 *   Written to stdout via `console.warn` (ESLint blocks `console.log`).
 *   Workers Tail picks it up automatically.
 *
 * **Local format** (all other environments):
 *   ANSI-colourised human-readable line:
 *   `[HH:MM:SS] LEVEL scope · msg · {ctx}`
 *   No extra dependencies — pure ANSI escape codes.
 *
 * **Sampling**:
 * - `error` and `warn` — always emitted.
 * - `info` — always in dev; sampled 1-in-N in production where N = `LOG_INFO_SAMPLE` (default 1 = all).
 * - `debug` — only when `LOG_LEVEL=debug` or environment is not production.
 *
 * **Redaction** (two layers):
 * 1. Allowlist — only keys in {@link SAFE_FIELD_ALLOWLIST} pass through.
 * 2. Key-pattern — values whose key matches `/(authorization|cookie|token|secret|password|key|stripe-signature)/i` become `[REDACTED]`.
 * 3. Value-pattern — values that look like known secret formats (Stripe keys, JWTs, etc.) become `[REDACTED]`.
 *
 * @example
 * ```ts
 * // Simple (back-compat with the prior stub)
 * log.info('webhook_received', { provider: 'stripe', event_id: evt.id });
 *
 * // Context-aware (auto-fills requestId/userId/orgId/env)
 * log.warn('rate_limit_exceeded', { path: c.req.path }, c);
 *
 * // Scoped child
 * const l = log.child('billing');
 * l.error('stripe_error', { code: 'card_declined' });
 * ```
 */

import type { Context } from 'hono';
import type { Env, Variables } from '../types/env.js';

// ── Public types ─────────────────────────────────────────────────────────────

/**
 * Structured fields attached to every log entry.
 * Keys must be JSON-serializable; snake_case preferred.
 */
export type LogFields = Record<string, unknown>;

/** Hono context type alias used for auto-extracting correlation IDs. */
export type LogContext = Context<{ Bindings: Env; Variables: Variables }>;

/** Log severity levels. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Scoped logger interface. Obtain one via {@link Logger.child}.
 *
 * @example
 * ```ts
 * const l: Logger = log.child('payments');
 * l.info('checkout_started', { amount: 1000 });
 * ```
 */
export interface Logger {
  debug(msg: string, ctx?: LogFields, c?: LogContext): void;
  info(msg: string, ctx?: LogFields, c?: LogContext): void;
  warn(msg: string, ctx?: LogFields, c?: LogContext): void;
  error(msg: string, ctx?: LogFields, c?: LogContext): void;
  /** Return a new Logger that inherits all fields and prepends `scope`. */
  child(scope: string): Logger;
}

// ── ANSI colour helpers ───────────────────────────────────────────────────────

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
} as const;

const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: ANSI.gray,
  info: ANSI.cyan,
  warn: ANSI.yellow,
  error: ANSI.red,
};

// ── Redaction: allowlist ──────────────────────────────────────────────────────

/**
 * Only keys present here survive the redaction pass.
 * Add a key ONLY after confirming it cannot carry PII or secrets.
 */
const SAFE_FIELD_ALLOWLIST: ReadonlySet<string> = new Set([
  'service',
  'env',
  'eventName',
  'event',
  'requestId',
  'request_id',
  'userId',
  'user_id',
  'orgId',
  'org_id',
  'apiKeyId',
  'api_key_id',
  'siteId',
  'site_id',
  'slug',
  'path',
  'method',
  'status',
  'statusCode',
  'reason',
  'durationMs',
  'duration_ms',
  'attempt',
  'max',
  'provider',
  'event_id',
  'eventId',
  'job_name',
  'jobId',
  'version',
  'release',
  'code',
  'error_code',
  'error',
  'message',
  'cause',
  'ts',
  'level',
  'scope',
  'route',
  'cf_ray',
  'colo',
  'business_name',
  'ip_hash',
  'count',
  'success',
  'failed',
  'ok',
  'total',
  'fields',
  'action',
  'r2Path',
  'r2Key',
  'hostname',
  'phase',
  'html_size',
  'quality_score',
  'social_links_found',
  'logo_found',
  'missing_sections',
  'flatPath',
  'requestPath',
  'msg',
  // Lead-capture + degraded-outcome observability (AL-836) — non-PII booleans/enums.
  'persisted',
  'notified',
  'degraded',
  'channel',
  'source',
  // Guest-acquisition search degradation observability (AL-845) — privacy-safe: qlen is the
  // QUERY LENGTH, never the raw query text (which can carry a person/business name = PII).
  'qlen',
]);

// ── Redaction: sensitive-key patterns ────────────────────────────────────────

/**
 * Keys matching this regex have their value replaced with `[REDACTED]`
 * regardless of whether they are in the allowlist.
 *
 * Catches: authorization, cookie, token, secret, password, key,
 * stripe-signature, x-api-key, etc.
 */
const SENSITIVE_KEY_RE = /(authorization|cookie|token|secret|password|key|stripe-signature)/i;

/**
 * Identifier fields whose NAME matches {@link SENSITIVE_KEY_RE} (they contain
 * "key") but whose VALUE is a safe opaque id, NOT a secret. These are correlation
 * IDs we explicitly want in logs (an API key's row id ≠ the `psk_…` secret).
 * They skip the key-name redactor; the allowlist + value-pattern gates still apply.
 */
const SAFE_ID_KEY_EXEMPT: ReadonlySet<string> = new Set(['apiKeyId', 'api_key_id']);

// ── Redaction: secret-value patterns ─────────────────────────────────────────

const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /^sk_(live|test)_[A-Za-z0-9]{16,}$/, // Stripe secret keys
  /^rk_(live|test)_[A-Za-z0-9]{16,}$/, // Stripe restricted keys
  /^whsec_[A-Za-z0-9]{16,}$/, // Stripe webhook secret
  /^re_[A-Za-z0-9]{20,}$/, // Resend
  /^SG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}$/, // SendGrid
  /^xox[bpa]-[A-Za-z0-9-]{20,}$/, // Slack
  /^ghp_[A-Za-z0-9]{30,}$/, // GitHub PAT
  /^gho_[A-Za-z0-9]{30,}$/, // GitHub OAuth
  /^Bearer\s+[A-Za-z0-9._-]{20,}$/i, // Authorization: Bearer …
  /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{20,}$/, // JWT
];

// ── Core redaction logic ──────────────────────────────────────────────────────

/**
 * Apply both allowlist and key/value pattern redaction.
 *
 * @internal
 */
function redact(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    // Key-pattern gate: always redact sensitive-named fields,
    // except known-safe identifier fields (e.g. apiKeyId — an id, not a secret).
    if (!SAFE_ID_KEY_EXEMPT.has(key) && SENSITIVE_KEY_RE.test(key)) {
      out[key] = '[REDACTED]';
      continue;
    }
    // Allowlist gate: drop fields that aren't explicitly safe
    if (!SAFE_FIELD_ALLOWLIST.has(key)) continue;
    // Value-pattern gate: redact secret-shaped string values
    if (typeof value === 'string' && SECRET_VALUE_PATTERNS.some((p) => p.test(value))) {
      out[key] = '[REDACTED]';
      continue;
    }
    out[key] = value;
  }
  return out;
}

// ── Context extraction ────────────────────────────────────────────────────────

function extractContext(c: LogContext | undefined): LogFields {
  if (!c) return {};
  const out: LogFields = {};
  try {
    const rid = c.get('requestId');
    if (rid) out.requestId = rid;
    const uid = c.get('userId');
    if (uid) out.userId = uid;
    const oid = c.get('orgId');
    if (oid) out.orgId = oid;
    const kid = c.get('apiKeyId');
    if (kid) out.apiKeyId = kid;
    const env = c.env?.ENVIRONMENT;
    if (env) out.env = env;
  } catch {
    // Non-fatal — context can be unavailable in test environments.
  }
  return out;
}

// ── Environment detection ─────────────────────────────────────────────────────

/** Return the effective environment string — works inside Workers and Node. */
function getNodeEnv(): string {
  return (typeof process !== 'undefined' && process.env?.NODE_ENV) || 'development';
}

/**
 * Returns true when the runtime is JSON-friendly (production or test).
 * Test env emits JSON so existing Jest `captureWarn` helpers can parse it.
 */
function isJsonEnv(env: string): boolean {
  return env === 'production' || env === 'test';
}

// ── Sampling ──────────────────────────────────────────────────────────────────

/**
 * Decide whether an `info` call should be emitted in production.
 *
 * Reads `LOG_INFO_SAMPLE` from `process.env` (Node/test) or the Worker global
 * `self.LOG_INFO_SAMPLE` (set via `wrangler.toml [vars]`). Defaults to `1`
 * (emit all). Set to `10` to emit 1-in-10.
 */
function shouldSampleInfo(): boolean {
  let n = 1;
  try {
    const raw =
      (typeof process !== 'undefined' && process.env?.LOG_INFO_SAMPLE) ||
      (typeof globalThis !== 'undefined' &&
        (globalThis as Record<string, unknown>).LOG_INFO_SAMPLE);
    if (raw) n = Math.max(1, parseInt(String(raw), 10));
  } catch {
    /* ignore */
  }
  return n <= 1 || Math.random() < 1 / n;
}

// ── Emission ──────────────────────────────────────────────────────────────────

function emit(
  level: LogLevel,
  msg: string,
  fields: LogFields,
  c: LogContext | undefined,
  scope: string,
): void {
  const ctxFields = extractContext(c);
  const env = (ctxFields.env as string | undefined) ?? getNodeEnv();
  const isProd = env === 'production';

  const merged = redact({ ...ctxFields, ...fields });

  if (isJsonEnv(env)) {
    // Structured JSON — one line, Wrangler tail parseable + Jest-parseable in test.
    // `eventName` is kept for backward compat with existing log queries / tests.
    const payload: LogFields = {
      ts: new Date().toISOString(),
      level,
      scope,
      msg,
      eventName: msg, // backward-compat alias
      env,
      service: 'project-sites',
      ...merged,
    };
    console.warn(JSON.stringify(payload));
  } else {
    // Human-friendly colourised output for local dev
    const time = new Date().toTimeString().slice(0, 8);
    const colour = LEVEL_COLOR[level];
    const ctxStr =
      Object.keys(merged).length > 0 ? ` ${ANSI.dim}${JSON.stringify(merged)}${ANSI.reset}` : '';
    const scopePart = scope ? ` ${ANSI.blue}${scope}${ANSI.reset}` : '';
    console.warn(
      `${ANSI.gray}[${time}]${ANSI.reset} ${colour}${ANSI.bold}${level.toUpperCase()}${ANSI.reset}${scopePart} · ${msg}${ctxStr}`,
    );
  }
}

// ── Logger factory ────────────────────────────────────────────────────────────

function makeLogger(scope: string): Logger {
  return {
    debug(msg, ctx = {}, c): void {
      // Debug: only in non-production, unless LOG_LEVEL=debug explicitly set
      const envStr = (extractContext(c).env as string | undefined) ?? getNodeEnv();
      if (envStr === 'production') {
        const logLevel =
          (typeof process !== 'undefined' && process.env?.LOG_LEVEL) ||
          (typeof globalThis !== 'undefined' && (globalThis as Record<string, unknown>).LOG_LEVEL);
        if (logLevel !== 'debug') return;
      }
      emit('debug', msg, ctx, c, scope);
    },

    info(msg, ctx = {}, c): void {
      const envStr = (extractContext(c).env as string | undefined) ?? getNodeEnv();
      if (envStr === 'production' && !shouldSampleInfo()) return;
      emit('info', msg, ctx, c, scope);
    },

    warn(msg, ctx = {}, c): void {
      emit('warn', msg, ctx, c, scope);
    },

    error(msg, ctx = {}, c): void {
      emit('error', msg, ctx, c, scope);
    },

    child(childScope: string): Logger {
      return makeLogger(childScope ? `${scope}/${childScope}` : childScope);
    },
  };
}

// ── Root logger ───────────────────────────────────────────────────────────────

/**
 * Root structured logger. Use directly or obtain a scoped child via `.child()`.
 *
 * **Backwards-compatible** with the previous `log.info(eventName, fields, c)` call shape —
 * existing callers pass an `eventName` as the first argument and the new code maps it
 * to the `msg` field.
 *
 * @example
 * ```ts
 * log.info('site_created', { site_id, slug });
 * log.warn('retry_attempt', { attempt: 2, max: 3 }, c);
 * log.error('payment_failed', { order_id });
 *
 * const l = log.child('billing');
 * l.info('checkout_started', { amount: 1000 });
 * ```
 */
export const log: Logger = makeLogger('project-sites');

// ── Request-access-log middleware ─────────────────────────────────────────────

/**
 * Hono middleware: emit one structured log line per request.
 *
 * Mount AFTER `requestIdMiddleware` so `requestId` is already on the context.
 *
 * @example
 * ```ts
 * app.use('*', requestIdMiddleware);
 * app.use('*', requestLogger);
 * ```
 */
export async function requestLogger(c: LogContext, next: () => Promise<void>): Promise<void> {
  const start = Date.now();
  try {
    await next();
  } finally {
    const durationMs = Date.now() - start;
    try {
      log.info(
        'http_request',
        {
          method: c.req.method,
          path: new URL(c.req.url).pathname,
          status: c.res.status,
          durationMs,
        },
        c,
      );
    } catch {
      // Never let logging break a response.
    }
  }
}
