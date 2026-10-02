/**
 * @module middleware/error_render
 * @description RFC7807 JSON envelope builder. HTML page rendering delegated to `lib/error_pages.ts`.
 * This module is responsible only for JSON-format responses (API clients).
 */

/**
 * Build an RFC7807-compliant JSON error response envelope.
 */
export function buildErrorEnvelope(opts: {
  code: string;
  message: string;
  requestId: string;
  /** Structured per-branch payload (e.g. `{ issues: [...] }` for validation). */
  details?: unknown;
}): {
  error: {
    code: string;
    message: string;
    request_id: string;
    details?: unknown;
  };
} {
  const envelope: {
    error: { code: string; message: string; request_id: string; details?: unknown };
  } = {
    error: {
      code: opts.code,
      message: opts.message,
      request_id: opts.requestId,
    },
  };
  if (opts.details !== undefined) {
    envelope.error.details = opts.details;
  }
  return envelope;
}


/**
 * Determine if the request prefers HTML over JSON (browser vs API client).
 */
export function prefersHtml(accept: string | undefined): boolean {
  if (!accept) return false;
  if (!accept.includes('text/html')) return false;
  const jsonIdx = accept.indexOf('application/json');
  if (jsonIdx === -1) return true;
  return accept.indexOf('text/html') < jsonIdx;
}
