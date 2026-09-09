/**
 * @module routes/auth_org
 * @description Custom-auth Organization/Team endpoints for `/admin/team`.
 *
 * The team SPA (`pages/auth/org-api.service.ts`) is a thin Better Auth wrapper
 * calling `/api/auth/organization/*`. Better Auth ships DARK (`better_auth` flag
 * off — the custom D1 auth over `memberships`/`users`/`team_invites` is the live
 * path), so those paths 401'd on every load → the Team panel was empty for every
 * real user. These handlers implement the same paths + the exact `FullOrganization`
 * contract over the live tables. (Same 3-layer fix as `auth_sessions.ts`: custom
 * route + `legacyPaths` allowlist in index.ts + the `org-api.service` ps_session
 * Bearer.)
 *
 * | Method | Path                                          | Notes                          |
 * | ------ | --------------------------------------------- | ------------------------------ |
 * | GET    | /api/auth/organization/get-full-organization  | → { id,name,slug,members,invitations } |
 * | POST   | /api/auth/organization/invite-member          | { email, role } → OrgInvitation (seat-capped + emails) |
 * | POST   | /api/auth/organization/cancel-invitation      | { invitationId } → { status }  |
 * | POST   | /api/auth/organization/remove-member          | { memberIdOrEmail } → { status } (never self) |
 *
 * @packageDocumentation
 */
import { Hono } from 'hono';
import { escapeHtml, internalError, notFound, sha256Hex } from '@project-sites/shared';
import type { Context } from 'hono';
import type { Env, Variables } from '../types/env.js';
import { dbQuery, dbQueryOne, dbExecute } from '../services/db.js';
import { getOrgEntitlements } from '../services/billing.js';
import { resolveSeatLimit, countSeatUsage, canInviteMember } from '../services/team_seats.js';
import { getEmailProvider } from '../platform/email-router.js';

type AppContext = { Bindings: Env; Variables: Variables };

export const authOrg = new Hono<AppContext>();

const ORG_ROLES = new Set(['owner', 'admin', 'member']);

const unauthorized = (c: Context<AppContext>) =>
  c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } }, 401);
const badRequest = (c: Context<AppContext>, message: string) =>
  c.json({ error: { code: 'VALIDATION_ERROR', message } }, 400);

/**
 * GET /api/auth/organization/get-full-organization — the caller org's members
 * (memberships JOIN users) + pending invitations (team_invites), mapped to the
 * SPA's `FullOrganization` shape.
 */
authOrg.get('/api/auth/organization/get-full-organization', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return unauthorized(c);
  const org = await dbQueryOne<{ id: string; name: string | null; slug: string | null }>(
    c.env.DB,
    `SELECT id, name, slug FROM orgs WHERE id = ? AND deleted_at IS NULL`,
    [orgId],
  );
  const { data: members } = await dbQuery<{
    id: string;
    user_id: string;
    role: string;
    created_at: string;
    email: string | null;
    display_name: string | null;
  }>(
    c.env.DB,
    `SELECT m.id, m.user_id, m.role, m.created_at, u.email, u.display_name
       FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.org_id = ? AND m.deleted_at IS NULL
      ORDER BY m.created_at ASC`,
    [orgId],
  );
  const { data: invites } = await dbQuery<{
    id: string;
    email: string;
    role: string;
    expires_at: string;
    created_at: string;
  }>(
    c.env.DB,
    `SELECT id, email, role, expires_at, created_at
       FROM team_invites
      WHERE org_id = ? AND accepted_at IS NULL AND deleted_at IS NULL AND expires_at > ?
      ORDER BY created_at DESC`,
    [orgId, new Date().toISOString()],
  );
  // Surface the AUTHORITATIVE seat cap (same entitlement the invite endpoint
  // enforces) so the UI shows the true "X of Y seats used" — not a hardcoded
  // default. `-1` = unlimited. `seatUsed` = active members + pending invites.
  const seatLimit = resolveSeatLimit(await getOrgEntitlements(c.env.DB, orgId));
  return c.json({
    id: org?.id,
    name: org?.name ?? undefined,
    slug: org?.slug ?? undefined,
    seatLimit,
    seatUsed: members.length + invites.length,
    members: members.map((m) => ({
      id: m.id,
      organizationId: orgId,
      userId: m.user_id,
      role: m.role,
      createdAt: m.created_at,
      user: { id: m.user_id, email: m.email, name: m.display_name },
      email: m.email,
      name: m.display_name,
    })),
    invitations: invites.map((i) => ({
      id: i.id,
      organizationId: orgId,
      email: i.email,
      role: i.role,
      status: 'pending',
      expiresAt: i.expires_at,
      createdAt: i.created_at,
    })),
  });
});

/** POST /api/auth/organization/invite-member — seat-capped invite + email. */
authOrg.post('/api/auth/organization/invite-member', async (c) => {
  const orgId = c.get('orgId');
  const userId = c.get('userId') ?? null;
  if (!orgId) return unauthorized(c);
  const body = (await c.req.json().catch(() => ({}))) as { email?: unknown; role?: unknown };
  const email = String(body.email ?? '')
    .trim()
    .toLowerCase();
  const role = String(body.role ?? 'member');
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) {
    return badRequest(c, 'A valid email address is required.');
  }
  if (!ORG_ROLES.has(role)) return badRequest(c, 'Role must be owner, admin, or member.');
  // Seat cap: active members + pending invites both consume a seat.
  const seatLimit = resolveSeatLimit(await getOrgEntitlements(c.env.DB, orgId));
  const decision = canInviteMember(await countSeatUsage(c.env, orgId), seatLimit);
  if (!decision.allowed) {
    return c.json(
      { error: { code: 'CONFLICT', message: decision.reason ?? 'Seat limit reached.' } },
      409,
    );
  }
  const id = crypto.randomUUID();
  const token = crypto.randomUUID().replace(/-/g, '');
  const tokenHash = await sha256Hex(token);
  const expires = new Date(Date.now() + 14 * 86400 * 1000).toISOString();
  await c.env.DB.prepare(
    `INSERT INTO team_invites (id, org_id, email, role, token_hash, invited_by, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, orgId, email, role, tokenHash, userId, expires)
    .run();
  // Best-effort invite email (Amazon SES when configured) — the invite
  // row is already persisted, so email failure never fails the request.
  const subject = 'You’ve been invited to a Project Sites team';
  const text = `You were invited as ${role}. Accept here: https://projectsites.dev/admin/accept-invite?token=${token}`;
  if (c.env.AWS_ACCESS_KEY_ID && c.env.AWS_SECRET_ACCESS_KEY && c.env.SES_FROM_EMAIL) {
    await getEmailProvider(c.env)
      .sendTransactional({
        kind: 'transactional',
        from: 'team@projectsites.dev',
        to: email,
        subject,
        html: `<pre>${escapeHtml(text)}</pre>`,
      })
      .catch(() => {});
  }
  // Resend removed 2026-09-09 (Brian directive) — Amazon SES is the sole provider; invite email is best-effort (the invite row is already persisted).
  return c.json(
    {
      id,
      organizationId: orgId,
      email,
      role,
      status: 'pending',
      expiresAt: expires,
      inviterId: userId,
      createdAt: new Date().toISOString(),
    },
    201,
  );
});

/** POST /api/auth/organization/cancel-invitation — soft-delete a pending invite. */
authOrg.post('/api/auth/organization/cancel-invitation', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return unauthorized(c);
  const body = (await c.req.json().catch(() => ({}))) as { invitationId?: unknown };
  const id = String(body.invitationId ?? '').trim();
  if (!id) return badRequest(c, 'An invitationId is required.');
  const now = new Date().toISOString();
  const { error, changes } = await dbExecute(
    c.env.DB,
    `UPDATE team_invites SET deleted_at = ? WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
    [now, id, orgId],
  );
  if (error) throw internalError(`Failed to cancel invitation: ${error}`);
  // The WHERE (id + org_id) is the SOLE ownership guard — 0 rows means the invite
  // doesn't exist, isn't this org's, or was already cancelled. Never a lying 200.
  if (changes === 0) throw notFound('Invitation not found or already cancelled.');
  return c.json({ status: true });
});

/**
 * POST /api/auth/organization/remove-member — soft-delete a membership by id or
 * email. Never removes the CALLER's own membership (last-owner protection).
 */
authOrg.post('/api/auth/organization/remove-member', async (c) => {
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  if (!orgId) return unauthorized(c);
  const body = (await c.req.json().catch(() => ({}))) as { memberIdOrEmail?: unknown };
  const target = String(body.memberIdOrEmail ?? '').trim();
  if (!target) return badRequest(c, 'A memberIdOrEmail is required.');
  const now = new Date().toISOString();
  const { error, changes } = await dbExecute(
    c.env.DB,
    `UPDATE memberships SET deleted_at = ?, updated_at = ?
       WHERE org_id = ? AND deleted_at IS NULL AND user_id != ?
         AND (id = ? OR user_id = (SELECT id FROM users WHERE email = ? AND deleted_at IS NULL))`,
    [now, now, orgId, userId ?? '', target, target],
  );
  if (error) throw internalError(`Failed to remove member: ${error}`);
  // Sole-guard WHERE (org_id + not-self + id/email match) — 0 rows means the member
  // isn't in this org, is the caller themselves, or was already removed. Not a lying 200.
  if (changes === 0) throw notFound('Member not found or cannot be removed.');
  return c.json({ status: true });
});
