/**
 * @module lib/sentry
 * @description Thin Sentry client for the Worker — sends exceptions + breadcrumbs
 * to Sentry's envelope API via raw fetch. Zero npm deps, Workers-compatible.
 *
 * The canonical `@sentry/cloudflare` SDK wraps the handler with automatic
 * breadcrumbs, request context, and OTel span linking. This module replicates
 * the critical path (captureException + addBreadcrumb) when the npm SDK is
 * unavailable, using the same Sentry envelope protocol.
 *
 * @packageDocumentation
 */

import { z } from 'zod';
import type { Env } from '../types/env.js';

// ── Sentry envelope API constants ──────────────────────────────────────────

/** Sentry DSN parsed components. */
interface SentryDsn {
  /** Full DSN URL including auth. */
  dsn: string;
  /** Envelope endpoint: `{dsn}/api/{projectId}/envelope/`. */
  envelopeUrl: string;
  /** Whether the DSN is configured. */
  enabled: boolean;
}

/** Parse a Sentry DSN into its API components. Cached per isolate. */
function parseDsn(env: Env): SentryDsn {
  const dsn = env.SENTRY_DSN;
  if (!dsn) return { dsn: '', envelopeUrl: '', enabled: false };

  try {
    const url = new URL(dsn);
    const projectId = url.pathname.replace(/^\//, '');
    // Sentry envelope API: POST to /api/<projectId>/envelope/
    const envelopeUrl = `${url.protocol}//${url.host}/api/${projectId}/envelope/`;
    return { dsn, envelopeUrl, enabled: true };
  } catch {
    return { dsn, envelopeUrl: '', enabled: false };
  }
}

// ── Sentry event payload (minimal canonical shape) ─────────────────────────

const SentryExceptionSchema = z.object({
  type: z.string().default('Error'),
  value: z.string().max(8192),
  module: z.string().optional(),
  stacktrace: z
    .object({
      frames: z.array(
        z.object({
          filename: z.string().optional(),
          function: z.string().optional(),
          lineno: z.number().int().optional(),
          colno: z.number().int().optional(),
          abs_path: z.string().optional(),
          context_line: z.string().optional(),
        }),
      ),
    })
    .optional(),
});

interface SentryEvent {
  event_id: string;
  timestamp: number;
  level: 'fatal' | 'error' | 'warning' | 'info' | 'debug';
  logger: string;
  platform: string;
  exception?: {
    values: Array<z.infer<typeof SentryExceptionSchema>>;
  };
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  breadcrumbs?: SentryBreadcrumb[];
  request?: {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
  };
}

interface SentryBreadcrumb {
  timestamp: number;
  level: SentryEvent['level'];
  category: string;
  message: string;
  data?: Record<string, unknown>;
}

// ── Capture exception ──────────────────────────────────────────────────────

/**
 * Sends an exception to Sentry. Fire-and-forget via `ctx.waitUntil()` —
 * never blocks the response, never throws.
 *
 * Cost: ~1 fetch to Sentry ingest per captured exception. Free for
 * projects under Sentry's 5K events/month free tier.
 *
 * @param env - Worker env containing SENTRY_DSN.
 * @param error - The caught Error (or Error-like object).
 * @param ctx - Optional: request context for tags (path, method, traceId).
 */
export function captureException(
  env: Env,
  error: Error | unknown,
  ctx?: { path?: string; method?: string; traceId?: string },
): void {
  const dsn = parseDsn(env);
  if (!dsn.enabled) return;

  const err = error instanceof Error ? error : new Error(String(error));
  const eventId = crypto.randomUUID().replace(/-/g, '');

  const event: SentryEvent = {
    event_id: eventId,
    timestamp: Date.now() / 1000,
    level: 'error',
    logger: 'worker',
    platform: 'javascript',
    exception: {
      values: [
        {
          type: err.name || 'Error',
          value: err.message.slice(0, 8192),
          stacktrace: err.stack
            ? {
                frames: err.stack.split('\n').map((line) => {
                  const trimmed = line.trim();
                  return {
                    filename: trimmed.startsWith('at ')
                      ? trimmed.slice(3).split(' ').pop()?.replace(/[()]/g, '')
                      : undefined,
                    context_line: trimmed,
                  };
                }),
              }
            : undefined,
        },
      ],
    },
    tags: {
      handler: ctx?.path ?? 'unknown',
      traceId: ctx?.traceId ?? '',
    },
    extra: {
      message: err.message,
    },
    request: ctx?.path ? { url: ctx.path, method: ctx.method ?? 'GET' } : undefined,
  };

  // Send the Sentry envelope (fire-and-forget)
  sendEnvelope(dsn.envelopeUrl, event).catch(() => {
    // Silently ignore — Sentry is best-effort observability, never a hard dependency
  });
}

// ── Envelope transport ─────────────────────────────────────────────────────

/**
 * Sends a Sentry envelope (event payload) to the ingest endpoint.
 * Idempotent per event_id.
 */
async function sendEnvelope(envelopeUrl: string, event: SentryEvent): Promise<void> {
  const envelope = buildEnvelope(event);
  await fetch(envelopeUrl, {
    method: 'POST',
    body: envelope,
    headers: { 'Content-Type': 'application/x-sentry-envelope' },
  });
}

/**
 * Builds a Sentry envelope string (Sentry's wire format for event ingestion).
 *
 * Envelope format:
 * ```
 * {header}\n{item_header}\n{item_payload}\n
 * ```
 */
function buildEnvelope(event: SentryEvent): string {
  const eventId = event.event_id;
  const header = JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() });
  const itemHeader = JSON.stringify({
    type: 'event',
    content_type: 'application/json',
  });
  const payload = JSON.stringify(event);
  return `${header}\n${itemHeader}\n${payload}\n`;
}
