/**
 * @module middleware/error_handler
 * @description Global Hono error handler — thin composition over
 * {@link module:middleware/error_taxonomy} (predicates + page copy) and
 * {@link module:middleware/error_render} (branded HTML page + JSON envelope).
 *
 * Behavior contract (locked by `src/__tests__/error_handler_integration.test.ts`):
 * - {@link AppError} keeps its `statusCode`/`code` and serializes via `err.toJSON()`.
 * - ZodError → `VALIDATION_ERROR` 400 with structured `details.issues[]`.
 * - Malformed JSON body → clean `BAD_REQUEST` 400, warn-logged, never Sentry.
 * - R2-disabled outage → calm `STORAGE_UNAVAILABLE` 503 + `Retry-After`.
 * - Anything else → `INTERNAL_ERROR` 500 with the GENERIC public message; the raw
 *   message/stack goes to logs + Sentry + PostHog only (never leaked to clients).
 * - `/api/*` responses are ALWAYS JSON — never the branded HTML page — even when
 *   Accept prefers text/html (fire-27: a browser `fetch('/api/…')` sends
 *   `Accept: text/html,…` but the caller expects JSON).
 *
 * @packageDocumentation
 */

import type { ErrorHandler } from 'hono';
import { AppError } from '@project-sites/shared';
import type { Env, Variables } from '../types/env.js';
import * as posthog from '../lib/posthog.js';
import { captureException } from '../lib/sentry.js';
import { createLogger } from '../observability/index.js';
import { brandedErrorPage } from '../lib/branded_error_page.js';
import { buildErrorEnvelope, prefersHtml } from './error_render.js';
import { isMalformedJsonBody, isStorageUnavailable, isZodErrorLike } from './error_taxonomy.js';

/**
 * Global error handler for the Worker's Hono app.
 *
 * @see module documentation for the behavior contract per error class.
 */
export const errorHandler: ErrorHandler<{
  Bindings: Env;
  Variables: Variables;
}> = (err, c) => {
  const requestId = c.get('requestId') ?? 'unknown';
  const url = c.req.url;
  const method = c.req.method;
  const isHtml = !c.req.path.startsWith('/api/') && prefersHtml(c.req.header('accept'));

  // Safely access executionCtx (not available in test environments)
  let ctx: ExecutionContext | undefined;
  try {
    ctx = c.executionCtx;
  } catch {
    // executionCtx not available outside Workers runtime
  }

  // AppError: known typed errors
  if (err instanceof AppError) {
    console.warn(
      JSON.stringify({
        level: err.statusCode >= 500 ? 'error' : 'warn',
        code: err.code,
        message: err.message,
        request_id: requestId,
        status: err.statusCode,
        url,
        method,
      }),
    );

    if (err.statusCode >= 500 && ctx) {
      createLogger(c.env, ctx, {
        service: 'error_handler',
        environment: c.env.ENVIRONMENT ?? 'production',
        request_id: requestId,
      }).error('unhandled_error', { code: err.code, url, method }, err);
      posthog.trackError(c.env, ctx, err.code, err.message, {
        request_id: requestId,
        status: err.statusCode,
        url,
      });
    }

    if (isHtml) {
      return new Response(
        brandedErrorPage({
          status: err.statusCode,
          code: err.code,
          message: err.message,
          requestId,
        }),
        { status: err.statusCode, headers: { 'Content-Type': 'text/html;charset=utf-8' } },
      );
    }
    return c.json(err.toJSON(), err.statusCode as 400);
  }

  // ZodError: validation failures → structured field issues, never a raw dump.
  if (isZodErrorLike(err)) {
    const zodErr = err as import('zod').ZodError;
    const issues = zodErr.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    }));

    console.warn(
      JSON.stringify({
        level: 'warn',
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        request_id: requestId,
        url,
        method,
        issues,
      }),
    );

    if (isHtml) {
      const details = issues.map((i) => `${i.path}: ${i.message}`).join('; ');
      return new Response(
        brandedErrorPage({
          status: 400,
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          requestId,
          details,
        }),
        { status: 400, headers: { 'Content-Type': 'text/html;charset=utf-8' } },
      );
    }
    return c.json(
      buildErrorEnvelope({
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        requestId,
        details: { issues },
      }),
      400,
    );
  }

  // Malformed JSON body: a CLIENT error, not a server fault.
  if (isMalformedJsonBody(err)) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        code: 'BAD_REQUEST',
        message: 'Malformed JSON in request body',
        request_id: requestId,
        url,
        method,
      }),
    );

    if (isHtml) {
      return new Response(
        brandedErrorPage({
          status: 400,
          code: 'BAD_REQUEST',
          message: 'Malformed JSON in request body',
          requestId,
        }),
        { status: 400, headers: { 'Content-Type': 'text/html;charset=utf-8' } },
      );
    }
    return c.json(
      buildErrorEnvelope({
        code: 'BAD_REQUEST',
        message: 'Malformed JSON in request body',
        requestId,
      }),
      400,
    );
  }

  // Unknown errors
  const errorMessage = err instanceof Error ? err.message : 'Unknown error';
  const errorStack = err instanceof Error ? err.stack : undefined;

  // Storage-unavailable (R2 disabled account-wide) → calm 503, not a scary 500.
  if (isStorageUnavailable(errorMessage)) {
    console.warn(
      JSON.stringify({
        level: 'error',
        code: 'STORAGE_UNAVAILABLE',
        message: errorMessage,
        request_id: requestId,
        url,
        method,
      }),
    );
    if (ctx) {
      createLogger(c.env, ctx, {
        service: 'error_handler',
        environment: c.env.ENVIRONMENT ?? 'production',
        request_id: requestId,
      }).error('storage_unavailable', { code: 'STORAGE_UNAVAILABLE', url, method }, err);
    }
    const friendly = "We're doing a quick update — back in a moment.";
    if (isHtml) {
      return new Response(
        brandedErrorPage({
          status: 503,
          code: 'STORAGE_UNAVAILABLE',
          message: friendly,
          requestId,
        }),
        {
          status: 503,
          headers: { 'Content-Type': 'text/html;charset=utf-8', 'Retry-After': '120' },
        },
      );
    }
    return c.json(
      buildErrorEnvelope({ code: 'STORAGE_UNAVAILABLE', message: friendly, requestId }),
      503,
      { 'Retry-After': '120' },
    );
  }

  console.warn(
    JSON.stringify({
      level: 'error',
      code: 'INTERNAL_ERROR',
      message: errorMessage,
      request_id: requestId,
      url,
      method,
      stack: errorStack,
    }),
  );

  if (ctx) {
    createLogger(c.env, ctx, {
      service: 'error_handler',
      environment: c.env.ENVIRONMENT ?? 'production',
      request_id: requestId,
    }).error('unhandled_error', { url, method }, err);
    posthog.trackError(c.env, ctx, 'INTERNAL_ERROR', errorMessage, { request_id: requestId, url });
    captureException(c.env, err, { path: url, method, traceId: requestId });
  }

  if (isHtml) {
    return new Response(
      brandedErrorPage({
        status: 500,
        code: 'INTERNAL_ERROR',
        message: 'Something went wrong on our end',
        requestId,
      }),
      { status: 500, headers: { 'Content-Type': 'text/html;charset=utf-8' } },
    );
  }
  return c.json(
    buildErrorEnvelope({ code: 'INTERNAL_ERROR', message: 'Internal server error', requestId }),
    500,
  );
};
