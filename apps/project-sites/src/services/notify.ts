/**
 * @module services/notify
 *
 * Server-side psnotify trigger — the worker arm of the psnotify doctrine
 * (DO-based unified notification center). Fires a psnotify event for a
 * subscriber so the in-app bell (and email/push channels) light up on real
 * platform events (publish, build, domain, AI, billing). Pairs with the
 * frontend `notif-bell` which renders the same subscriber's feed.
 *
 * Safe by design: returns `{ ok: false }` (never throws) when psnotify is
 * unavailable, so callers can `c.executionCtx.waitUntil(notifyUser(...))`
 * fire-and-forget without risking the request. The subscriberId MUST match
 * what the bell uses for that user (their email / `session.identifier`).
 *
 * @example
 * c.executionCtx.waitUntil(
 *   notifyUser(c.env, { subscriberId: ownerEmail, subject: 'Site published 🎉', body: `${slug}.projectsites.dev is live.` })
 * );
 */
import type { Env } from '../types/env.js';
import { PsnotifyEventSchema, renderPsnotifyEvent, triggerPsnotify } from './psnotify.js';
import { tryEmitEvent } from './emit_event.js';

/**
 * Redact an email for logs: `brian@megabyte.space` → `b***@megabyte.space`. Mirrors the
 * site-generation workflow's `workflow.owner_notified` redaction so the whole notification
 * path logs the same masked shape — never a raw address.
 *
 * @param email - The address to mask; a non-email string is returned unchanged.
 * @returns The masked address.
 * @example redactEmailForLog('brian@megabyte.space'); // 'b***@megabyte.space'
 */
export function redactEmailForLog(email: string): string {
  return typeof email === 'string' ? email.replace(/^(.).*(@.*)$/, '$1***$2') : '';
}

/** The structured events the notification send-path emits (for OTLP/Sentry correlation). */
export type NotifyLogEvent =
  | 'notify.sent'
  | 'notify.skipped'
  | 'notify.error'
  | 'notify.owner_missing'
  | 'notify.owner_lookup_failed'
  | 'notify.invalid_event';

/**
 * Build ONE structured, correlated notification log line (pure → unit-testable). Every send-path
 * outcome logs the SAME shape carrying `orgId` + a redacted `subscriber` + `workflowId` + the
 * psnotify `txId`, so a failed owner-notify is attributable to a specific org (the prior gap: the
 * error path logged only a bare message). Secrets are never included; the email is redacted.
 *
 * @param event - Which send-path outcome this line records.
 * @param fields - Correlation fields; `subscriberId` is redacted, unset fields are omitted.
 * @returns A JSON string ready for `console.warn(...)` (the repo's structured-log transport).
 * @example
 * notifyLogLine('notify.owner_lookup_failed', { orgId: 'org-1', reason: 'lookup_failed' });
 * // '{"level":"warn","event":"notify.owner_lookup_failed","orgId":"org-1","reason":"lookup_failed"}'
 */
export function notifyLogLine(
  event: NotifyLogEvent,
  fields: {
    subscriberId?: string;
    orgId?: string;
    workflowId?: string;
    txId?: string;
    reason?: string;
  } = {},
): string {
  const line: Record<string, unknown> = {
    level: event === 'notify.sent' || event === 'notify.skipped' ? 'info' : 'warn',
    event,
  };
  if (fields.orgId) line.orgId = fields.orgId;
  if (fields.subscriberId) line.subscriber = redactEmailForLog(fields.subscriberId);
  if (fields.workflowId) line.workflowId = fields.workflowId;
  if (fields.txId) line.txId = fields.txId;
  if (fields.reason) line.reason = fields.reason;
  return JSON.stringify(line);
}

/**
 * Compact, log-safe reason for a REJECTED notification event — names the drifted
 * event + the first offending field so a silent `invalid_event` skip becomes a
 * greppable, attributable log line (the prior gap: `safeParse` failures returned
 * `invalid_event` with NO log, so every caller passing a stale event shape — e.g.
 * the legacy `{event, tenantId, …}` novu contract against the psnotify
 * `{name, subscriberId, payload}` schema — silently no-op'd forever).
 *
 * @param event - The raw (unvalidated) event object the caller passed.
 * @param error - The Zod error from the failed `safeParse`.
 * @returns e.g. `invalid_event:build.finished:name` (event name : first bad path).
 * @example invalidEventReason({ event: 'build.finished' }, err); // 'invalid_event:build.finished:name'
 */
function invalidEventReason(
  event: unknown,
  error: { issues?: ReadonlyArray<{ path?: ReadonlyArray<string | number> }> },
): string {
  const e = event as Record<string, unknown> | null;
  const name =
    e && typeof e === 'object'
      ? typeof e.name === 'string'
        ? e.name
        : typeof e.event === 'string'
          ? e.event
          : 'unknown'
      : 'unknown';
  const path = error?.issues?.[0]?.path?.join('.') || '?';
  return `invalid_event:${name}:${path}`;
}

export interface NotifyInput {
  /** psnotify subscriber id — must equal the bell's subscriberId (the user's email). */
  subscriberId: string;
  subject: string;
  body: string;
  /** Workflow trigger identifier; defaults to the shared `ps-notify` workflow. */
  workflowId?: string;
}

export interface NotifyResult {
  ok: boolean;
  /** psnotify transaction id on success, or a short reason on skip/failure. */
  detail?: string;
}

/**
 * Trigger a psnotify event for one subscriber. Never throws.
 *
 * @throws Never — all failures are caught and returned as `{ ok: false }`.
 */
export async function notifyUser(env: Env, input: NotifyInput): Promise<NotifyResult> {
  if (!input.subscriberId) {
    console.warn(notifyLogLine('notify.skipped', { reason: 'no_subscriber' }));
    return { ok: false, detail: 'no_subscriber' };
  }

  try {
    const result = await triggerPsnotify(env, {
      name: input.workflowId ?? 'ps-notify',
      subscriberId: input.subscriberId,
      payload: { subject: input.subject, body: input.body },
    });
    console.warn(
      notifyLogLine(result.success ? 'notify.sent' : 'notify.error', {
        subscriberId: input.subscriberId,
        workflowId: input.workflowId,
        txId: result.result,
        reason: result.success ? undefined : 'psnotify_unsuccessful',
      }),
    );
    return { ok: result.success, detail: result.result };
  } catch (err) {
    console.warn(
      notifyLogLine('notify.error', {
        subscriberId: input.subscriberId,
        workflowId: input.workflowId,
        reason: (err as Error)?.message || 'exception',
      }),
    );
    return { ok: false, detail: 'exception' };
  }
}

/**
 * Notify an org's owner by resolving their email from D1, then triggering psnotify.
 * For server contexts WITHOUT an authenticated user (webhooks, workflow
 * callbacks) where only `orgId` is known. The resolved email matches the bell's
 * subscriberId for that user. Never throws.
 *
 * @example
 * c.executionCtx.waitUntil(
 *   notifySiteOwner(c.env, c.env.DB, { orgId, subject: 'Payment received', body: 'Your subscription is active.' })
 * );
 */
export async function notifySiteOwner(
  env: Env,
  db: D1Database,
  input: { orgId: string; subject: string; body: string; workflowId?: string },
): Promise<NotifyResult> {
  if (!input.orgId) return { ok: false, detail: 'no_org' };
  try {
    const row = await db
      .prepare(
        'SELECT u.email AS email FROM users u JOIN memberships m ON u.id = m.user_id WHERE m.org_id = ? AND m.deleted_at IS NULL AND u.deleted_at IS NULL ORDER BY u.created_at ASC LIMIT 1',
      )
      .bind(input.orgId)
      .first<{ email: string }>();
    if (!row?.email) {
      console.warn(
        notifyLogLine('notify.owner_missing', { orgId: input.orgId, reason: 'no_owner' }),
      );
      return { ok: false, detail: 'no_owner' };
    }
    const result = await notifyUser(env, {
      subscriberId: row.email,
      subject: input.subject,
      body: input.body,
      workflowId: input.workflowId,
    });
    if (result.ok) {
      await tryEmitEvent(
        env,
        {
          type: 'notification.workflow.triggered',
          producer: 'psnotify',
          tenantId: input.orgId,
          traceId: result.detail || input.orgId,
          data: {
            workflowId: input.workflowId ?? 'ps-notify',
            subscriberId: row.email,
            transactionId: result.detail ?? null,
            subject: input.subject,
          },
        },
        { scope: [result.detail || `${input.orgId}:notify`] },
      );
    }
    return result;
  } catch (err) {
    console.warn(
      notifyLogLine('notify.owner_lookup_failed', {
        orgId: input.orgId,
        reason: (err as Error)?.message || 'lookup_failed',
      }),
    );
    return { ok: false, detail: 'lookup_failed' };
  }
}

/**
 * Fire a TYPED platform event for one subscriber: validate against
 * {@link PsnotifyEventSchema}, render actionable bell copy via {@link renderPsnotifyEvent},
 * and dispatch over the live `notifyUser` transport. Never throws.
 *
 * @param input.event - A payload matching {@link PsnotifyEventSchema};
 *   an invalid shape returns `{ ok: false, detail: 'invalid_event' }` and never sends.
 * @example
 * c.executionCtx.waitUntil(
 *   notifyEvent(c.env, { subscriberId: ownerEmail, event: { name: 'domain_active', subscriberId: ownerEmail, payload: { hostname } } })
 * );
 * @throws Never.
 */
export async function notifyEvent(
  env: Env,
  input: { subscriberId: string; event: unknown; workflowId?: string },
): Promise<NotifyResult> {
  const parsed = PsnotifyEventSchema.safeParse(input.event);
  if (!parsed.success) {
    console.warn(
      notifyLogLine('notify.invalid_event', {
        reason: invalidEventReason(input.event, parsed.error),
        subscriberId: input.subscriberId,
        workflowId: input.workflowId,
      }),
    );
    return { ok: false, detail: 'invalid_event' };
  }
  const rendered = renderPsnotifyEvent(parsed.data);
  const payload = rendered.payload as Record<string, unknown>;
  const subject = String(payload?.subject ?? '');
  const body = String(payload?.body ?? '');
  return notifyUser(env, {
    subscriberId: input.subscriberId,
    subject,
    body,
    workflowId: input.workflowId,
  });
}

/**
 * Org-scoped variant of {@link notifyEvent}: resolve the org owner's email from
 * D1, then dispatch the typed event. For webhook/workflow contexts where only
 * `orgId` is known. Never throws.
 *
 * @example
 * c.executionCtx.waitUntil(
 *   notifyOwnerEvent(c.env, c.env.DB, { orgId, event: { name: 'payment_succeeded', subscriberId: orgId, payload: { amountCents, currency } } })
 * );
 * @throws Never.
 */
export async function notifyOwnerEvent(
  env: Env,
  db: D1Database,
  input: { orgId: string; event: unknown; workflowId?: string },
): Promise<NotifyResult> {
  const parsed = PsnotifyEventSchema.safeParse(input.event);
  if (!parsed.success) {
    console.warn(
      notifyLogLine('notify.invalid_event', {
        orgId: input.orgId,
        reason: invalidEventReason(input.event, parsed.error),
        workflowId: input.workflowId,
      }),
    );
    return { ok: false, detail: 'invalid_event' };
  }
  const rendered = renderPsnotifyEvent(parsed.data);
  const payload = rendered.payload as Record<string, unknown>;
  const subject = String(payload?.subject ?? '');
  const body = String(payload?.body ?? '');
  return notifySiteOwner(env, db, {
    orgId: input.orgId,
    subject,
    body,
    workflowId: input.workflowId,
  });
}
