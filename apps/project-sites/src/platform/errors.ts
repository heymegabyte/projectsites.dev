/**
 * @module platform/errors
 *
 * @description
 * Shared error taxonomy (convergence §62). Every API failure maps to a stable
 * `code` + HTTP `status` + `retryable` flag + user-safe message, and serializes
 * through `toErrorResponse` into the platform envelope
 * `{ error: { code, message, request_id, retryable? } }` (§7.3). Handlers throw a
 * typed `AppError`; the route catch calls `toErrorResponse`.
 *
 * @see docs/architecture/service-registry.md
 */

/** Base for every typed application error. */
export abstract class AppError extends Error {
  abstract readonly code: string;
  abstract readonly status: number;
  readonly retryable: boolean = false;
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  readonly code = 'VALIDATION_ERROR';
  readonly status = 400;
}
export class BadRequestError extends AppError {
  readonly code = 'BAD_REQUEST';
  readonly status = 400;
}
export class UnauthorizedError extends AppError {
  readonly code = 'UNAUTHORIZED';
  readonly status = 401;
}
export class ForbiddenError extends AppError {
  readonly code = 'FORBIDDEN';
  readonly status = 403;
}
export class NotFoundError extends AppError {
  readonly code = 'NOT_FOUND';
  readonly status = 404;
}
export class EntitlementError extends AppError {
  readonly code = 'ENTITLEMENT_REQUIRED';
  readonly status = 402;
}
export class QuotaExceededError extends AppError {
  readonly code = 'QUOTA_EXCEEDED';
  readonly status = 429;
}
export class RateLimitedError extends AppError {
  readonly code = 'RATE_LIMITED';
  readonly status = 429;
  override readonly retryable = true;
}
export class ProviderUnavailableError extends AppError {
  readonly code = 'PROVIDER_UNAVAILABLE';
  readonly status = 503;
  override readonly retryable = true;
}
/** A downstream job dispatch (workflow/queue/plane) failed. */
export class JobDispatchError extends AppError {
  readonly code = 'JOB_DISPATCH_ERROR';
  readonly status = 502;
  override readonly retryable = true;
}

/** The serialized error envelope + the HTTP status to send. */
export interface ErrorResponse {
  readonly body: {
    error: { code: string; message: string; request_id: string; retryable?: boolean };
  };
  readonly status: number;
}

/**
 * Map any thrown value to the platform error envelope. `AppError`s use their own
 * code/status; foreign errors named `*InputError`/`*ContextError` (the port
 * validation errors) become 400 VALIDATION_ERROR; everything else is a 500.
 *
 * @example const { body, status } = toErrorResponse(err, requestId); return c.json(body, status);
 */
export function toErrorResponse(err: unknown, requestId: string): ErrorResponse {
  if (err instanceof AppError) {
    return {
      body: {
        error: {
          code: err.code,
          message: err.message,
          request_id: requestId,
          retryable: err.retryable,
        },
      },
      status: err.status,
    };
  }
  // Port-layer validation errors (JobContextError / EmailInputError / EmailEventError)
  // are caller mistakes → 400, not 500. Matched by name to avoid import cycles.
  if (err instanceof Error && /(InputError|ContextError|EventError)$/.test(err.name)) {
    return {
      body: { error: { code: 'VALIDATION_ERROR', message: err.message, request_id: requestId } },
      status: 400,
    };
  }
  return {
    body: {
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error', request_id: requestId },
    },
    status: 500,
  };
}
