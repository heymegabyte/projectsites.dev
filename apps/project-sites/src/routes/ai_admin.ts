/**
 * @module routes/ai_admin
 * @description Authenticated admin surface for the AI platform.
 *
 * Mounted by `index.ts`. Every route requires both an `orgId` and a
 * `userId` on the request context — the {@link need} helper throws
 * `HTTPError(401)` when either is missing. The public form-ingest
 * counterpart lives in `forms.ts`.
 *
 * @packageDocumentation
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { Env, Variables } from '../types/env.js';
import { HTTPError, need, siteOwned, aiAdminOnError, type Ctx } from '../lib/ai_admin_kit.js';
import { listUserSessions, revokeUserSession, revokeOtherUserSessions } from '../services/auth.js';
import {
  transferOwnership,
  canInviteMember,
  countSeatUsage,
  resolveSeatLimit,
} from '../services/team_seats.js';
import { getOrgEntitlements } from '../services/billing.js';
import * as auditService from '../services/audit.js';
import { escapeHtml } from '@project-sites/shared';
import { getEmailProvider } from '../platform/email-router.js';

export const aiAdmin = new Hono<{ Bindings: Env; Variables: Variables }>();

// Error/auth scaffolding (HTTPError · need · siteOwned · onError) is shared via
// src/lib/ai_admin_kit.ts — imported above (route-decomposition installment 17,
// DRY consolidation). Byte-identical behavior to the prior inline copies; see the
// kit module doc for the siteOwned-vs-requireOwnedSite rationale.
aiAdmin.onError(aiAdminOnError);

// Per-site read-only activity — form submissions + AI logs — moved to
// `libs/features/site_activity/handlers.ts` (route-decomposition installment 19):
//   GET /api/sites/:siteId/form-submissions, GET …/form-submissions/:subId,
//   GET /api/sites/:siteId/ai-logs, GET …/ai-logs/:logId.
// Backs BOTH the admin Forms inbox (form_submissions) + the AI-Logs view (ai_form_logs).

// Per-site AI settings (GET/PUT /api/sites/:siteId/ai-settings) + the
// "Improve with AI" rewrite (POST …/ai-settings/improve) + the per-site AI
// credit cap (GET/PUT /api/sites/:siteId/credit-cap) moved to
// `libs/features/ai_settings/handlers.ts` (route-decomposition installment 18).

// AI credit balance/top-up + per-site cost rollup moved to
// `libs/features/billing/handlers.ts` (route-decomposition installment 14):
//   GET  /api/billing/credits, POST /api/billing/credits/topup, GET /api/billing/site-costs.
// The canonical spend-alerts surface lives in `libs/features/billing/handlers.ts`
// (behind `createSpendAlertSchema` + the migration-0024 `spend_alerts` schema).

// Per-site MCP connection management (list + disconnect) moved to
// `libs/features/mcp_connections/handlers.ts` (route-decomposition installment 19):
//   GET /api/sites/:siteId/mcp/connections, DELETE …/mcp/connections/:id.

/* ────────────────────────── Team (Settings → Team) ────────────────────────── */

/**
 * `GET /api/team` — List active members + pending invites for the caller's org.
 *
 * @throws 401 UNAUTHORIZED when org/user context is missing.
 */
aiAdmin.get('/api/team', async (c) => {
  const { orgId } = need(c);
  const members = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.display_name AS name, m.role, m.created_at
     FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.org_id = ? AND m.deleted_at IS NULL ORDER BY m.created_at ASC`,
  )
    .bind(orgId)
    .all();
  const invites = await c.env.DB.prepare(
    `SELECT id, email, role, created_at, expires_at FROM team_invites
     WHERE org_id = ? AND accepted_at IS NULL AND deleted_at IS NULL ORDER BY created_at DESC`,
  )
    .bind(orgId)
    .all();
  return c.json({ data: { members: members.results ?? [], invites: invites.results ?? [] } });
});

/**
 * `POST /api/team/invites` — Invite a new member to the caller's org.
 *
 * @remarks
 * Body: `{ email, role }`. Generates a one-shot invite token and sends a
 * magic-link email via Resend. Audit-logged. Idempotent on `(org, email)`
 * — re-invites refresh the token rather than creating duplicates.
 *
 * @throws 400 BAD_REQUEST when email is invalid or role is unknown.
 * @throws 401 UNAUTHORIZED when org/user context is missing.
 * @throws 409 CONFLICT when the email already belongs to the org.
 */
aiAdmin.post('/api/team/invites', async (c) => {
  const { orgId, userId } = need(c);
  // Zod boundary (zod-everywhere): `role` is privilege-bearing — the old cast
  // let ANY string land in `team_invites.role` (e.g. an injected 'superadmin'),
  // and a malformed JSON body threw an unhandled 500. Constrain role to the real
  // enum + require a non-empty email; every failure → the same 400.
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HTTPError(400, 'email + role required');
  }
  const parsed = z
    .object({ email: z.string().min(1), role: z.enum(['owner', 'editor', 'viewer']) })
    .safeParse(raw);
  if (!parsed.success) throw new HTTPError(400, 'email + role required');
  const { email, role } = parsed.data;

  // Seat-cap enforcement (#8): active members + pending invites both consume a
  // seat. The limit is resolved from the org's plan entitlements (free=1,
  // paid=10, -1=unlimited) — not a new table or flag. 409 + reason when full.
  const seatLimit = resolveSeatLimit(await getOrgEntitlements(c.env.DB, orgId));
  const decision = canInviteMember(await countSeatUsage(c.env, orgId), seatLimit);
  if (!decision.allowed) throw new HTTPError(409, decision.reason ?? 'Seat limit reached');

  const id = crypto.randomUUID();
  const token = crypto.randomUUID().replace(/-/g, '');
  const tokenHash = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))),
  )
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const expires = new Date(Date.now() + 14 * 86400 * 1000).toISOString();
  await c.env.DB.prepare(
    `INSERT INTO team_invites (id, org_id, email, role, token_hash, invited_by, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, orgId, email, role, tokenHash, userId, expires)
    .run();
  // Invites route through SES when configured (Resend removed 2026-09-09). The SES
  // seam is html-only, so the plain-text invite is wrapped in an escaped <pre>.
  // Fire-and-forget — the invite row is already persisted.
  const inviteSubject = 'You’ve been invited to a Project Sites team';
  const inviteText = `You were invited as ${role}. Accept here: https://projectsites.dev/admin/accept-invite?token=${token}`;
  if (c.env.AWS_ACCESS_KEY_ID && c.env.AWS_SECRET_ACCESS_KEY && c.env.SES_FROM_EMAIL) {
    await getEmailProvider(c.env)
      .sendTransactional({
        kind: 'transactional',
        from: 'team@projectsites.dev',
        to: email,
        subject: inviteSubject,
        html: `<pre>${escapeHtml(inviteText)}</pre>`,
      })
      .catch(() => {});
  }
  // Resend removed 2026-09-09 (Brian directive) — Amazon SES is the sole provider; invite email is best-effort.

  c.executionCtx.waitUntil(
    auditService.writeAuditLog(c.env.DB, {
      org_id: orgId,
      actor_id: userId,
      action: 'team.invite_sent',
      message: `Team invite sent to '${email}' as '${role}'`,
      target_type: 'team_invite',
      target_id: id,
      metadata_json: { email, role, expires_at: expires },
      request_id: c.get('requestId'),
    }),
  );

  // Typed in-app bell event for the org owner (best-effort, never blocks).
  c.executionCtx.waitUntil(
    (async () => {
      try {
        const { notifyOwnerEvent } = await import('../services/notify.js');
        await notifyOwnerEvent(c.env, c.env.DB, {
          orgId,
          event: { event: 'member.invited', tenantId: orgId, email, role },
        });
      } catch {
        /* bell is best-effort */
      }
    })(),
  );

  return c.json({ data: { id, token } }, 201);
});

/**
 * `POST /api/team/transfer-ownership` — Hand org ownership to an existing member.
 *
 * @remarks
 * Body: `{ targetUserId }`. Only the current owner may transfer, and only to an
 * existing team member; the old owner steps down to `admin`. Org-scoped +
 * audit-logged. Adopts the {@link transferOwnership} policy (#8).
 *
 * @throws 400 BAD_REQUEST when targetUserId is missing or the transfer is not allowed.
 * @throws 401 UNAUTHORIZED when org/user context is missing.
 */
aiAdmin.post('/api/team/transfer-ownership', async (c) => {
  const { orgId, userId } = need(c);
  const { targetUserId } = (await c.req.json().catch(() => ({}))) as { targetUserId?: string };
  if (!targetUserId) throw new HTTPError(400, 'targetUserId required');

  const res = await transferOwnership(c.env, orgId, userId, targetUserId);
  if (!res.ok) throw new HTTPError(400, res.error ?? 'Ownership transfer failed');

  c.executionCtx.waitUntil(
    auditService.writeAuditLog(c.env.DB, {
      org_id: orgId,
      actor_id: userId,
      action: 'team.ownership_transferred',
      message: `Ownership transferred from '${userId}' to '${targetUserId}'`,
      target_type: 'membership',
      target_id: targetUserId,
      metadata_json: { from: userId, to: targetUserId },
      request_id: c.get('requestId'),
    }),
  );

  return c.json({ ok: true });
});

/**
 * `DELETE /api/team/invites/:id` — Cancel a pending team invite.
 *
 * @throws 401 UNAUTHORIZED when org/user context is missing.
 * @throws 404 NOT_FOUND when the invite id doesn't exist for the caller's org.
 */
aiAdmin.delete('/api/team/invites/:id', async (c) => {
  const { orgId } = need(c);
  const inviteId = c.req.param('id');
  const invite = await c.env.DB.prepare(
    `SELECT email, role FROM team_invites WHERE id = ? AND org_id = ?`,
  )
    .bind(inviteId, orgId)
    .first<{ email: string; role: string }>();
  await c.env.DB.prepare(`DELETE FROM team_invites WHERE id = ? AND org_id = ?`)
    .bind(inviteId, orgId)
    .run();

  c.executionCtx.waitUntil(
    auditService.writeAuditLog(c.env.DB, {
      org_id: orgId,
      actor_id: c.get('userId') ?? null,
      action: 'team.invite_revoked',
      message: `Team invite revoked for '${invite?.email ?? 'unknown'}' (${invite?.role ?? 'unknown role'})`,
      target_type: 'team_invite',
      target_id: inviteId,
      metadata_json: { email: invite?.email ?? null, role: invite?.role ?? null },
      request_id: c.get('requestId'),
    }),
  );

  return c.json({ data: { revoked: true } });
});

/**
 * `DELETE /api/team/members/:userId` — Remove a member from the caller's org.
 *
 * @remarks
 * Soft-deletes the `memberships` row. The user keeps their account but
 * loses access to org resources. Audit-logged. The org's last admin
 * cannot be removed.
 *
 * @throws 400 BAD_REQUEST when removing the last admin.
 * @throws 401 UNAUTHORIZED when org/user context is missing.
 * @throws 404 NOT_FOUND when the userId isn't a current member.
 */
aiAdmin.delete('/api/team/members/:userId', async (c) => {
  const { orgId } = need(c);
  const targetUserId = c.req.param('userId');
  // Last-owner guard — every org must keep at least one owner. Refuse the
  // delete if removing this member would leave zero owners. Mirrors the
  // client-side disabled state on the Settings → Team list.
  const target = await c.env.DB.prepare(
    `SELECT role FROM memberships WHERE user_id = ? AND org_id = ? AND deleted_at IS NULL`,
  )
    .bind(targetUserId, orgId)
    .first<{ role: string }>();
  if (target?.role === 'owner') {
    const ownerCount = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM memberships WHERE org_id = ? AND role = 'owner' AND deleted_at IS NULL`,
    )
      .bind(orgId)
      .first<{ n: number }>();
    if ((ownerCount?.n ?? 0) <= 1) {
      throw new HTTPError(
        409,
        'Cannot remove the last owner. Promote another member to owner first.',
      );
    }
  }
  await c.env.DB.prepare(`DELETE FROM memberships WHERE user_id = ? AND org_id = ?`)
    .bind(targetUserId, orgId)
    .run();

  c.executionCtx.waitUntil(
    auditService.writeAuditLog(c.env.DB, {
      org_id: orgId,
      actor_id: c.get('userId') ?? null,
      action: 'team.member_removed',
      message: `Team member '${targetUserId}' removed from org`,
      target_type: 'membership',
      target_id: targetUserId,
      metadata_json: { user_id: targetUserId, prior_role: target?.role ?? null },
      request_id: c.get('requestId'),
    }),
  );

  return c.json({ data: { removed: true } });
});

// Analytics + audit-feed routes moved to their own feature modules
// (route-decomposition installment 14):
//   POST /api/analytics/track + GET /api/analytics/overview → libs/features/analytics/handlers.ts
//   GET  /api/audit/rows                                    → libs/features/audit_logs/handlers.ts

/* ────────────────────────── Team invite acceptance ────────────────────────── */
// Email link is /admin/accept-invite?token=…; the frontend POSTs back here.
// We rehash the raw token, find the pending invite row, ensure the caller's
// user matches the invite email, then insert a membership.
/**
 * `POST /api/team/invites/accept` — Accept a pending team invite via token.
 *
 * @remarks
 * Body: `{ token }`. Creates a membership row joining the caller (the
 * authenticated session user) into the invited org with the role set on
 * the invite. One-shot — the invite token is consumed regardless of
 * outcome.
 *
 * @throws 400 BAD_REQUEST when the token is missing, expired or already used.
 * @throws 401 UNAUTHORIZED when the caller isn't signed in.
 */
aiAdmin.post('/api/team/invites/accept', async (c) => {
  const { userId } = need(c);
  const body = (await c.req.json().catch(() => ({}))) as { token?: string };
  const raw = (body.token ?? '').trim();
  if (!raw) return c.json({ error: { code: 'BAD_REQUEST', message: 'token required' } }, 400);
  const hashBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  const tokenHash = Array.from(new Uint8Array(hashBytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const invite = await c.env.DB.prepare(
    `SELECT id, org_id, email, role, expires_at FROM team_invites
     WHERE token_hash = ? AND accepted_at IS NULL AND deleted_at IS NULL`,
  )
    .bind(tokenHash)
    .first<{ id: string; org_id: string; email: string; role: string; expires_at: string }>();
  if (!invite)
    return c.json(
      { error: { code: 'NOT_FOUND', message: 'Invite not found or already used' } },
      404,
    );
  if (new Date(invite.expires_at).getTime() < Date.now()) {
    return c.json(
      { error: { code: 'EXPIRED', message: 'Invite expired — ask the owner to resend' } },
      410,
    );
  }
  const me = await c.env.DB.prepare(`SELECT email FROM users WHERE id = ?`)
    .bind(userId)
    .first<{ email: string }>();
  if (me?.email?.toLowerCase() !== invite.email.toLowerCase()) {
    return c.json(
      {
        error: {
          code: 'WRONG_USER',
          message: `This invite was sent to ${invite.email}; sign in as that account first.`,
        },
      },
      403,
    );
  }
  // Insert membership (ignore conflict if user already in org).
  await c.env.DB.prepare(
    `INSERT INTO memberships (id, org_id, user_id, role, created_at, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(org_id, user_id) DO UPDATE SET role = excluded.role, deleted_at = NULL`,
  )
    .bind(crypto.randomUUID(), invite.org_id, userId, invite.role)
    .run();
  await c.env.DB.prepare(`UPDATE team_invites SET accepted_at = datetime('now') WHERE id = ?`)
    .bind(invite.id)
    .run();

  c.executionCtx.waitUntil(
    auditService.writeAuditLog(c.env.DB, {
      org_id: invite.org_id,
      actor_id: userId,
      action: 'team.invite_accepted',
      message: `Team invite accepted by '${invite.email}' — joined as '${invite.role}'`,
      target_type: 'membership',
      target_id: userId,
      metadata_json: { invite_id: invite.id, email: invite.email, role: invite.role },
      request_id: c.get('requestId'),
    }),
  );

  // Typed in-app bell event — tell the org owner a teammate joined (best-effort).
  c.executionCtx.waitUntil(
    (async () => {
      try {
        const { notifyOwnerEvent } = await import('../services/notify.js');
        await notifyOwnerEvent(c.env, c.env.DB, {
          orgId: invite.org_id,
          event: { event: 'member.joined', tenantId: invite.org_id, userId, role: invite.role },
        });
      } catch {
        /* bell is best-effort */
      }
    })(),
  );

  return c.json({ data: { joined: true, org_id: invite.org_id, role: invite.role } });
});

// Org security settings (GET/PUT /api/admin/security — session TTL, idle timeout,
// sign-in domain allowlist, 2FA-required toggle in the org_security table) moved to
// `libs/features/org_security/handlers.ts` (route-decomposition installment 20).

// "Improve with AI" (POST /api/sites/:siteId/ai-settings/improve) moved to
// `libs/features/ai_settings/handlers.ts` (route-decomposition installment 18).

/* ────────────────────────── Org deletion (real, soft + scheduled purge) ────────────────────────── */
aiAdmin.post('/api/admin/org/delete', async (c) => {
  const { orgId, userId } = need(c);
  const body = (await c.req.json().catch(() => ({}))) as { confirm?: string };
  if (body.confirm !== 'DELETE') {
    return c.json(
      { error: { code: 'BAD_REQUEST', message: 'Confirmation text must be "DELETE"' } },
      400,
    );
  }
  const me = await c.env.DB.prepare(
    `SELECT role FROM memberships WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL`,
  )
    .bind(orgId, userId)
    .first<{ role: string }>();
  if (me?.role !== 'owner') {
    return c.json(
      { error: { code: 'FORBIDDEN', message: 'Only the org owner can delete it' } },
      403,
    );
  }
  const now = new Date().toISOString();
  // Soft-delete cascade: org → sites → memberships → invites → api_keys.
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE sites SET deleted_at = ? WHERE org_id = ? AND deleted_at IS NULL`,
    ).bind(now, orgId),
    c.env.DB.prepare(
      `UPDATE memberships SET deleted_at = ? WHERE org_id = ? AND deleted_at IS NULL`,
    ).bind(now, orgId),
    c.env.DB.prepare(
      `UPDATE team_invites SET deleted_at = ? WHERE org_id = ? AND deleted_at IS NULL`,
    ).bind(now, orgId),
    c.env.DB.prepare(
      `UPDATE api_keys SET revoked_at = ? WHERE org_id = ? AND revoked_at IS NULL`,
    ).bind(now, orgId),
    c.env.DB.prepare(`UPDATE orgs SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`).bind(
      now,
      orgId,
    ),
  ]);

  c.executionCtx.waitUntil(
    auditService.writeAuditLog(c.env.DB, {
      org_id: orgId,
      actor_id: userId,
      action: 'org.deleted',
      message: `Org '${orgId}' soft-deleted by owner — full purge scheduled in 30 days`,
      target_type: 'org',
      target_id: orgId,
      metadata_json: { scheduled_purge_after_days: 30 },
      request_id: c.get('requestId'),
    }),
  );

  return c.json({ data: { deleted: true, scheduled_purge_after_days: 30 } });
});

/* ────────────────────────── Org data export (queued job) ────────────────────────── */
aiAdmin.post('/api/admin/org/export', async (c) => {
  const { orgId, userId } = need(c);
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO org_exports (id, org_id, requested_by, status) VALUES (?, ?, ?, 'queued')`,
  )
    .bind(id, orgId, userId)
    .run();

  c.executionCtx.waitUntil(
    auditService.writeAuditLog(c.env.DB, {
      org_id: orgId,
      actor_id: userId,
      action: 'org.export_queued',
      message: `Org data export queued (export id '${id}')`,
      target_type: 'org_export',
      target_id: id,
      metadata_json: { export_id: id },
      request_id: c.get('requestId'),
    }),
  );

  // Fire-and-forget: bundle the org's D1 rows into a JSON file in R2.
  // Image/asset bundling stays deferred; this hits the 80% "give me my data" case.
  c.executionCtx.waitUntil(
    (async () => {
      try {
        const tables = ['sites', 'site_snapshots', 'ai_site_settings', 'ai_form_logs', 'hostnames'];
        const dump: Record<string, unknown[]> = {};
        for (const t of tables) {
          const rows = await c.env.DB.prepare(
            `SELECT * FROM ${t} WHERE ${t === 'sites' ? 'org_id' : 'site_id'} IN
             (SELECT id FROM sites WHERE org_id = ? AND deleted_at IS NULL) OR
             ${t === 'sites' ? 'org_id = ?' : '0'}`,
          )
            .bind(orgId, orgId)
            .all()
            .catch(() => ({ results: [] as unknown[] }));
          dump[t] = rows.results ?? [];
        }
        const memberships = await c.env.DB.prepare(
          `SELECT m.*, u.email, u.display_name FROM memberships m
         JOIN users u ON u.id = m.user_id WHERE m.org_id = ?`,
        )
          .bind(orgId)
          .all()
          .catch(() => ({ results: [] }));
        dump['team'] = memberships.results ?? [];

        const r2Key = `exports/${orgId}/${id}.json`;
        const body = new TextEncoder().encode(JSON.stringify(dump, null, 2));
        await c.env.SITES_BUCKET.put(r2Key, body, {
          httpMetadata: { contentType: 'application/json' },
        });
        await c.env.DB.prepare(
          `UPDATE org_exports SET status = 'ready', r2_key = ?, size_bytes = ?, completed_at = datetime('now') WHERE id = ?`,
        )
          .bind(r2Key, body.byteLength, id)
          .run();
      } catch (err) {
        await c.env.DB.prepare(
          `UPDATE org_exports SET status = 'error', error = ?, completed_at = datetime('now') WHERE id = ?`,
        )
          .bind(err instanceof Error ? err.message : String(err), id)
          .run()
          .catch(() => undefined);
      }
    })(),
  );
  return c.json({ data: { id, status: 'queued', poll: `/api/admin/org/export/${id}` } });
});

/**
 * `GET /api/admin/org/export/:id` — Poll status of a long-running org
 * data export job.
 *
 * @throws 401 UNAUTHORIZED when org/user context is missing.
 * @throws 404 NOT_FOUND when the export id doesn't belong to the caller's org.
 */
aiAdmin.get('/api/admin/org/export/:id', async (c) => {
  const { orgId } = need(c);
  const row = await c.env.DB.prepare(
    `SELECT id, status, size_bytes, error, created_at, completed_at, r2_key FROM org_exports
     WHERE id = ? AND org_id = ?`,
  )
    .bind(c.req.param('id'), orgId)
    .first<{
      id: string;
      status: string;
      size_bytes: number | null;
      error: string | null;
      created_at: string;
      completed_at: string | null;
      r2_key: string | null;
    }>();
  if (!row) return c.json({ error: { code: 'NOT_FOUND', message: 'Export not found' } }, 404);
  return c.json({
    data: {
      ...row,
      download_url:
        row.status === 'ready' && row.r2_key ? `/api/admin/org/export/${row.id}/download` : null,
    },
  });
});

/**
 * `GET /api/admin/org/export/:id/download` — Stream the org export ZIP
 * back to the caller once the job is complete.
 *
 * @remarks
 * Returns `application/zip` with `Content-Disposition: attachment`.
 * Export artifacts live in R2 under `exports/{org_id}/{id}.zip` and are
 * lifecycle-purged after 30 days.
 *
 * @throws 401 UNAUTHORIZED when org/user context is missing.
 * @throws 404 NOT_FOUND when the export id doesn't belong to the caller's org.
 * @throws 409 CONFLICT when the export is still in-progress.
 */
aiAdmin.get('/api/admin/org/export/:id/download', async (c) => {
  const { orgId } = need(c);
  const row = await c.env.DB.prepare(
    `SELECT r2_key FROM org_exports WHERE id = ? AND org_id = ? AND status = 'ready'`,
  )
    .bind(c.req.param('id'), orgId)
    .first<{ r2_key: string }>();
  if (!row?.r2_key) return c.json({ error: { code: 'NOT_READY' } }, 404);
  const obj = await c.env.SITES_BUCKET.get(row.r2_key);
  if (!obj) return c.json({ error: { code: 'GONE' } }, 410);
  return new Response(obj.body, {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="projectsites-export-${c.req.param('id')}.json"`,
    },
  });
});

// Org-scoped programmatic API keys (psk_live_*: list/mint/revoke) + the module-
// private `hashApiKey` helper moved to `libs/features/api_keys/handlers.ts`
// (route-decomposition installment 19):
//   GET /api/admin/api-keys, POST /api/admin/api-keys, DELETE /api/admin/api-keys/:id.

/* ────────────────────────── Active sessions (account security) ────────────────────────── */
// Backs the /admin/user "Active sessions" panel — real D1 `sessions` rows,
// list + revoke, scoped to the caller.

/** Extract the caller's raw bearer token (to flag the CURRENT session row). */
function bearerToken(c: Ctx): string | undefined {
  const h = c.req.header('Authorization');
  return h && h.startsWith('Bearer ') ? h.slice(7) : undefined;
}

/**
 * `GET /api/admin/sessions` — List the caller's active sessions (real D1 rows),
 * most-recently-active first, with the current session flagged.
 *
 * @throws 401 UNAUTHORIZED when user context is missing.
 */
aiAdmin.get('/api/admin/sessions', async (c) => {
  const { userId } = need(c);
  const rows = await listUserSessions(c.env.DB, userId, bearerToken(c));
  return c.json({ data: rows });
});

/**
 * `DELETE /api/admin/sessions/:id` — Revoke one of the caller's own sessions.
 * Only succeeds when the session belongs to the caller (no cross-user revoke).
 *
 * @throws 401 UNAUTHORIZED when user context is missing.
 * @throws 404 NOT_FOUND when the session isn't the caller's.
 */
aiAdmin.delete('/api/admin/sessions/:id', async (c) => {
  const { userId } = need(c);
  const revoked = await revokeUserSession(c.env.DB, userId, c.req.param('id'));
  if (!revoked) throw new HTTPError(404, 'Session not found');
  return c.json({ data: { revoked: true } });
});

/**
 * `POST /api/admin/sessions/revoke-others` — Sign out every OTHER device,
 * keeping the caller's current session. Returns the count revoked.
 *
 * @throws 401 UNAUTHORIZED when user context is missing.
 */
aiAdmin.post('/api/admin/sessions/revoke-others', async (c) => {
  const { userId } = need(c);
  const count = await revokeOtherUserSessions(c.env.DB, userId, bearerToken(c));
  return c.json({ data: { revoked: count } });
});

// Domains aggregator (GET /api/admin/domains — every non-deleted org site with its
// custom-hostname rows attached) folded into `libs/features/hostnames/handlers.ts`
// (route-decomposition installment 20), which already owns the rest of the
// /api/admin/domains/* family (summary/verify/health/deprovision).

// Cloudflare account provisioning (GET /api/admin/cloudflare/status +
// POST /api/admin/cloudflare/auto-setup — WFP dispatch-namespace status + idempotent
// setup) moved to `libs/features/cloudflare_setup/handlers.ts` (route-decomposition
// installment 20).

// Admin AI Chat (POST /api/admin/ai-chat) moved to
// `libs/features/admin_ai/handlers.ts` (route-decomposition installment 18).

// Per-site AI credit cap (GET/PUT /api/sites/:siteId/credit-cap) moved to
// `libs/features/ai_settings/handlers.ts` (route-decomposition installment 18).

/* ────────────────────────── Transfer org ownership (14-day pending) ────────────────────────── */
aiAdmin.post('/api/team/transfer', async (c) => {
  const { orgId, userId } = need(c);
  const body = (await c.req.json().catch(() => ({}))) as { to_email?: string };
  const toEmail = (body.to_email ?? '').trim().toLowerCase();
  if (!toEmail.includes('@')) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'valid to_email required' } }, 400);
  }
  // Caller must be a CURRENT owner. `deleted_at IS NULL` excludes soft-deleted
  // memberships — a member removed via /api/auth/organization/remove-member is
  // soft-deleted with their `role` intact, so without this filter a removed owner
  // could still pass this gate and initiate a transfer of an org they no longer
  // belong to. Matches every other membership role check in the worker.
  const me = await c.env.DB.prepare(
    `SELECT role FROM memberships WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL`,
  )
    .bind(orgId, userId)
    .first<{ role: string }>();
  if (me?.role !== 'owner') {
    return c.json(
      { error: { code: 'FORBIDDEN', message: 'Only the owner can transfer ownership.' } },
      403,
    );
  }
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO org_transfers (id, org_id, from_user_id, to_email, status, expires_at, created_at)
     VALUES (?, ?, ?, ?, 'pending', datetime('now','+14 days'), datetime('now'))`,
  )
    .bind(id, orgId, userId, toEmail)
    .run();
  return c.json({ data: { id, to_email: toEmail, status: 'pending', expires_in_days: 14 } });
});

/**
 * `GET /api/team/transfer` — List pending ownership-transfer requests
 * for the caller's org.
 *
 * @throws 401 UNAUTHORIZED when org/user context is missing.
 */
aiAdmin.get('/api/team/transfer', async (c) => {
  const { orgId } = need(c);
  const rows = await c.env.DB.prepare(
    `SELECT id, to_email, status, expires_at, created_at FROM org_transfers
     WHERE org_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 5`,
  )
    .bind(orgId)
    .all();
  return c.json({ data: rows.results ?? [] });
});

/**
 * `DELETE /api/team/transfer/:id` — Cancel a pending ownership-transfer
 * request before the recipient accepts it.
 *
 * @throws 401 UNAUTHORIZED when org/user context is missing.
 * @throws 404 NOT_FOUND when the transfer id doesn't belong to the caller's org.
 */
aiAdmin.delete('/api/team/transfer/:id', async (c) => {
  const { orgId } = need(c);
  await c.env.DB.prepare(
    `UPDATE org_transfers SET status = 'cancelled' WHERE id = ? AND org_id = ? AND status = 'pending'`,
  )
    .bind(c.req.param('id'), orgId)
    .run();
  return c.json({ data: { cancelled: true } });
});

// Workflow status proxy (GET /api/sites/:siteId/workflows/:wfName/:id — drive-sync +
// image-generation instance .status()) moved to `libs/features/workflow_status/handlers.ts`
// (route-decomposition installment 20).

// AI Explain Trace (POST /api/admin/traces/:traceId/explain) + AI
// Natural-Language Search (POST /api/admin/search/ai) moved to
// `libs/features/admin_ai/handlers.ts` (route-decomposition installment 18).

// AI Cost Forecaster #95 (GET /api/admin/forecast/cost — 30-day usage rollup →
// next-month USD forecast + one AI savings tip) moved to
// `libs/features/cost_forecast/handlers.ts` (route-decomposition installment 20).

// Cmd-K Inline AI Streaming (POST /api/admin/ai/stream/palette) + the AI Chat
// Widget SSE handler (POST /api/admin/ai/stream/chat, incl. its EDITOR_TOOL_SURFACE
// const) moved to `libs/features/admin_ai/handlers.ts` (route-decomposition
// installment 18).
