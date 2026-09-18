/**
 * @module routes/super_admin
 * @description Super-admin only routes for cost-factor controls + wallet ops.
 *
 * All routes require the authenticated user to have `users.is_super_admin = 1`.
 * Non-super-admin requests get a 403. Sibling customer-facing `billing.component.ts`
 * routes are untouched — this is a separate, privileged surface.
 *
 * @packageDocumentation
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import type { MiddlewareHandler } from 'hono';
import type { Env, Variables } from '../types/env.js';
import { dbQuery, dbQueryOne, dbInsert, dbUpdate } from '../services/db.js';
import { sanitizeLikeTerm } from '../services/like_pattern.js';
import { manualAdjustment } from '../services/wallet.js';
import { isSuperAdmin } from '../services/sysadmin.js';
import { getCreditReport } from '../services/credit_monitor.js';
import { listSuppressions, removeSuppression } from '../services/email_suppressions.js';
import { invalidateFlagCache, FLAG_REGISTRY } from '../modules/feature_flags/services.js';
import { SERVICE_REGISTRY } from '../platform/service-registry.js';
import { signHs256 } from '../lib/jwt.js';
import { unauthorized, forbidden, internalError } from '@project-sites/shared';

const superAdmin = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * Require an authenticated platform super-admin (the shared {@link isSuperAdmin}
 * check: `users.is_super_admin = 1` OR an operator-allowlist email — fail-closed).
 * Anything else 401/403s before the handler runs.
 */
const requireSuperAdmin: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (
  c,
  next,
) => {
  const userId = c.get('userId');
  if (!userId) throw unauthorized();
  if (!(await isSuperAdmin(c.env, userId))) throw forbidden('Super-admin access required');
  await next();
};

superAdmin.use('/api/super-admin/*', requireSuperAdmin);

// ─── Cost categories ────────────────────────────────────────────────────────

superAdmin.get('/api/super-admin/cost-categories', async (c) => {
  const { data } = await dbQuery(
    c.env.DB,
    `SELECT slug, label, unit, base_cost_cents, markup_factor, min_charge_cents,
            billable, description, updated_by, updated_at
       FROM cost_categories ORDER BY slug`,
  );
  return c.json({ categories: data });
});

const patchCategorySchema = z
  .object({
    markup_factor: z.number().min(0.5).max(5).optional(),
    base_cost_cents: z.number().int().min(0).optional(),
    min_charge_cents: z.number().int().min(0).optional(),
    billable: z.boolean().optional(),
    description: z.string().max(500).optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'At least one field required' });

superAdmin.patch(
  '/api/super-admin/cost-categories/:slug',
  zValidator('json', patchCategorySchema),
  async (c) => {
    const slug = c.req.param('slug');
    const body = c.req.valid('json');
    const userId = c.get('userId');
    const existing = await dbQueryOne<{ slug: string }>(
      c.env.DB,
      'SELECT slug FROM cost_categories WHERE slug = ? LIMIT 1',
      [slug],
    );
    if (!existing)
      return c.json({ error: { code: 'NOT_FOUND', message: 'category not found' } }, 404);

    const patch: Record<string, unknown> = { updated_by: userId };
    if (body.markup_factor !== undefined) patch.markup_factor = body.markup_factor;
    if (body.base_cost_cents !== undefined) patch.base_cost_cents = body.base_cost_cents;
    if (body.min_charge_cents !== undefined) patch.min_charge_cents = body.min_charge_cents;
    if (body.billable !== undefined) patch.billable = body.billable ? 1 : 0;
    if (body.description !== undefined) patch.description = body.description;

    const { error: patchErr } = await dbUpdate(c.env.DB, 'cost_categories', patch, 'slug = ?', [
      slug,
    ]);
    // Without this, a failed UPDATE falls through to the re-fetch and returns
    // the STALE row as 200 — the admin sees their edit "succeed" but nothing
    // changed (lying-success).
    if (patchErr) throw internalError(`Failed to update cost category: ${patchErr}`);
    const updated = await dbQueryOne(
      c.env.DB,
      `SELECT slug, label, unit, base_cost_cents, markup_factor, min_charge_cents,
              billable, description, updated_by, updated_at
         FROM cost_categories WHERE slug = ? LIMIT 1`,
      [slug],
    );
    return c.json({ category: updated });
  },
);

// ─── Wallets list + search ──────────────────────────────────────────────────

superAdmin.get('/api/super-admin/wallets', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  const status = c.req.query('status') ?? '';
  const limit = Math.min(parseInt(c.req.query('limit') ?? '100', 10) || 100, 500);

  const where: string[] = [];
  const params: unknown[] = [];
  if (q) {
    // Strip the operator's %/_ wildcards so they match literally — an unstripped
    // wildcard-heavy term crashes the query ('LIKE pattern too complex').
    where.push('(w.org_id LIKE ? OR o.name LIKE ? OR o.slug LIKE ?)');
    const like = `%${sanitizeLikeTerm(q)}%`;
    params.push(like, like, like);
  }
  if (status && ['active', 'past_due', 'canceled', 'inactive'].includes(status)) {
    where.push('w.subscription_status = ?');
    params.push(status);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(limit);

  const { data } = await dbQuery(
    c.env.DB,
    `SELECT w.id, w.org_id, o.name AS org_name, o.slug AS org_slug,
            w.subscription_status, w.balance_cents, w.last_topup_at,
            w.auto_topup_threshold_cents, w.auto_topup_amount_cents,
            w.stripe_customer_id IS NOT NULL AS has_customer,
            w.stripe_default_payment_method IS NOT NULL AS has_pm,
            w.created_at, w.updated_at
       FROM wallet_accounts w
       LEFT JOIN orgs o ON o.id = w.org_id
       ${whereSql}
       ORDER BY w.updated_at DESC
       LIMIT ?`,
    params,
  );
  return c.json({ wallets: data });
});

// ─── Per-wallet transaction drill-down ──────────────────────────────────────

superAdmin.get('/api/super-admin/wallets/:org_id/transactions', async (c) => {
  const orgId = c.req.param('org_id');
  const days = Math.min(parseInt(c.req.query('days') ?? '30', 10) || 30, 365);
  const category = c.req.query('category') ?? '';
  const direction = c.req.query('direction') ?? '';

  const where: string[] = ['org_id = ?', "created_at >= datetime('now', ?)"];
  const params: unknown[] = [orgId, `-${days} days`];
  if (category) {
    where.push('category_slug = ?');
    params.push(category);
  }
  if (direction && ['credit', 'debit', 'refund', 'adjustment'].includes(direction)) {
    where.push('direction = ?');
    params.push(direction);
  }
  const { data: txs } = await dbQuery(
    c.env.DB,
    `SELECT id, direction, category_slug, quantity, base_cost_cents, markup_factor,
            amount_cents, balance_after_cents, reference_type, reference_id,
            stripe_event_id, metadata_json, created_by, created_at
       FROM wallet_transactions
       WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT 1000`,
    params,
  );
  const wallet = await dbQueryOne(
    c.env.DB,
    `SELECT * FROM wallet_accounts WHERE org_id = ? LIMIT 1`,
    [orgId],
  );
  return c.json({ wallet, transactions: txs });
});

// ─── Margin calculator stats ───────────────────────────────────────────────

superAdmin.get('/api/super-admin/stats', async (c) => {
  const days = Math.min(parseInt(c.req.query('days') ?? '30', 10) || 30, 365);

  // Per-category aggregates: charged (markup_factor × cost) vs base cost.
  const { data: byCategory } = await dbQuery(
    c.env.DB,
    `SELECT category_slug,
            COUNT(*) AS tx_count,
            SUM(quantity) AS total_quantity,
            SUM(-amount_cents) AS gross_charged_cents,
            SUM(CASE WHEN markup_factor > 0 THEN -amount_cents / markup_factor ELSE 0 END) AS base_cost_cents,
            SUM(-amount_cents) - SUM(CASE WHEN markup_factor > 0 THEN -amount_cents / markup_factor ELSE 0 END) AS net_margin_cents
       FROM wallet_transactions
       WHERE direction = 'debit' AND created_at >= datetime('now', ?)
       GROUP BY category_slug
       ORDER BY gross_charged_cents DESC`,
    [`-${days} days`],
  );

  // Daily totals for trend chart.
  const { data: daily } = await dbQuery(
    c.env.DB,
    `SELECT substr(created_at, 1, 10) AS day,
            SUM(CASE WHEN direction='debit' THEN -amount_cents ELSE 0 END) AS gross_charged_cents,
            SUM(CASE WHEN direction='credit' THEN amount_cents ELSE 0 END) AS topup_credits_cents,
            COUNT(CASE WHEN direction='debit' THEN 1 END) AS debit_count
       FROM wallet_transactions
       WHERE created_at >= datetime('now', ?)
       GROUP BY day
       ORDER BY day`,
    [`-${days} days`],
  );

  const totals = await dbQueryOne<{
    total_orgs: number;
    active_subs: number;
    total_balance_cents: number;
  }>(
    c.env.DB,
    `SELECT COUNT(*) AS total_orgs,
            SUM(CASE WHEN subscription_status = 'active' THEN 1 ELSE 0 END) AS active_subs,
            SUM(balance_cents) AS total_balance_cents
       FROM wallet_accounts`,
  );

  const monthlyRevenue = await dbQueryOne<{ amount: number }>(
    c.env.DB,
    `SELECT COALESCE(SUM(amount_cents), 0) AS amount
       FROM wallet_transactions
       WHERE direction = 'credit' AND reference_type IN ('subscription', 'topup')
         AND created_at >= datetime('now', '-30 days')`,
  );

  const topupsToday = await dbQueryOne<{ count: number }>(
    c.env.DB,
    `SELECT COUNT(*) AS count FROM wallet_transactions
       WHERE direction = 'credit' AND reference_type = 'topup'
         AND created_at >= datetime('now', '-1 days')`,
  );

  return c.json({
    days,
    totals: {
      total_orgs: totals?.total_orgs ?? 0,
      active_subs: totals?.active_subs ?? 0,
      total_balance_cents: totals?.total_balance_cents ?? 0,
      monthly_revenue_cents: monthlyRevenue?.amount ?? 0,
      topups_today: topupsToday?.count ?? 0,
    },
    by_category: byCategory,
    daily,
  });
});

// ─── Recent transactions feed (org-wide) ───────────────────────────────────

superAdmin.get('/api/super-admin/transactions', async (c) => {
  const days = Math.min(parseInt(c.req.query('days') ?? '7', 10) || 7, 90);
  const category = c.req.query('category') ?? '';
  const direction = c.req.query('direction') ?? '';
  const limit = Math.min(parseInt(c.req.query('limit') ?? '100', 10) || 100, 500);

  const where: string[] = ["t.created_at >= datetime('now', ?)"];
  const params: unknown[] = [`-${days} days`];
  if (category) {
    where.push('t.category_slug = ?');
    params.push(category);
  }
  if (direction && ['credit', 'debit', 'refund', 'adjustment'].includes(direction)) {
    where.push('t.direction = ?');
    params.push(direction);
  }
  params.push(limit);

  const { data } = await dbQuery(
    c.env.DB,
    `SELECT t.id, t.org_id, o.name AS org_name, t.direction, t.category_slug,
            t.quantity, t.amount_cents, t.balance_after_cents, t.reference_type,
            t.reference_id, t.created_at
       FROM wallet_transactions t
       LEFT JOIN orgs o ON o.id = t.org_id
       WHERE ${where.join(' AND ')}
       ORDER BY t.created_at DESC
       LIMIT ?`,
    params,
  );
  return c.json({ transactions: data });
});

// ─── Manual wallet adjustment ──────────────────────────────────────────────

const adjustmentSchema = z.object({
  org_id: z.string().min(1),
  amount_cents: z
    .number()
    .int()
    .refine((n) => n !== 0, 'amount cannot be zero'),
  reason: z.string().min(3).max(500),
});

/**
 * Credit or debit an org's wallet manually. `reason` is mandatory (3-500 chars)
 * — it surfaces in the customer's ledger. {@link manualAdjustment} writes the
 * wallet transaction and the audit row atomically.
 */
superAdmin.post(
  '/api/super-admin/manual-adjustment',
  zValidator('json', adjustmentSchema),
  async (c) => {
    const body = c.req.valid('json');
    const userId = c.get('userId') as string;
    const result = await manualAdjustment(c.env, body.org_id, {
      amount_cents: body.amount_cents,
      reason: body.reason,
      actor_id: userId,
    });
    return c.json(result);
  },
);

// ─── Public: am-I-super-admin check (used by frontend guard) ──────────────

/**
 * Frontend guard probe. Returns `{ is_super_admin: true }` unconditionally
 * because {@link requireSuperAdmin} already rejected non-admins with 401/403.
 */
superAdmin.get('/api/super-admin/whoami', async (c) => {
  return c.json({ is_super_admin: true, user_id: c.get('userId') });
});

/**
 * API CREDIT MONITOR (§ ops-console) — the normalized balance/quota of every credit-based
 * third-party provider (DeepSeek, Anthropic, Stability, Deepgram, ElevenLabs, …). The recurring
 * build-LLM blocker (DeepSeek at a negative balance silently failing every site build) is now
 * visible at a glance. KV-cached 5 min so the widget never hammers provider APIs; `?refresh=1`
 * forces a fresh read.
 */
superAdmin.get('/api/super-admin/credits', async (c) => {
  const CACHE_KEY = 'superadmin:credits';
  if (c.req.query('refresh') !== '1') {
    const cached = await c.env.CACHE_KV?.get(CACHE_KEY, 'json').catch(() => null);
    if (cached) return c.json({ ...(cached as object), cached: true });
  }
  const report = await getCreditReport(c.env);
  await c.env.CACHE_KV?.put(CACHE_KEY, JSON.stringify(report), { expirationTtl: 300 }).catch(() => {});
  return c.json({ ...report, cached: false });
});

/**
 * FLEET HEALTH (§ ops-console) — the core product's operational pulse: every generated site
 * grouped by lifecycle status, the current build-error backlog, and the recent build success
 * rate. A sysadmin sees stuck/errored builds immediately. Fail-soft: a query error degrades to a
 * partial payload, never a 500.
 */
superAdmin.get('/api/super-admin/fleet-health', async (c) => {
  const out: Record<string, unknown> = { byStatus: [], recentErrors: [], successRate7d: null };
  try {
    const { data } = await dbQuery<{ status: string; n: number }>(
      c.env.DB,
      `SELECT status, COUNT(*) AS n FROM sites WHERE deleted_at IS NULL GROUP BY status ORDER BY n DESC`,
    );
    out.byStatus = data;
    out.total = data.reduce((s, r) => s + Number(r.n), 0);
  } catch (e) {
    out.byStatusError = String(e).slice(0, 80);
  }
  try {
    const { data } = await dbQuery<{ slug: string; business_name: string; updated_at: string }>(
      c.env.DB,
      `SELECT slug, business_name, updated_at FROM sites
        WHERE status = 'error' AND deleted_at IS NULL
        ORDER BY updated_at DESC LIMIT 12`,
    );
    out.recentErrors = data;
  } catch (e) {
    out.recentErrorsError = String(e).slice(0, 80);
  }
  try {
    const row = await dbQueryOne<{ published: number; errored: number }>(
      c.env.DB,
      `SELECT SUM(CASE WHEN status='published' THEN 1 ELSE 0 END) AS published,
              SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errored
         FROM sites
        WHERE deleted_at IS NULL AND created_at >= datetime('now', '-7 days')`,
    );
    const pub = Number(row?.published ?? 0);
    const err = Number(row?.errored ?? 0);
    out.successRate7d = pub + err > 0 ? Math.round((pub / (pub + err)) * 100) : null;
  } catch (e) {
    out.successRateError = String(e).slice(0, 80);
  }
  return c.json(out);
});

/**
 * GROWTH PULSE (§ ops-console) — new orgs / users / delivered sites across rolling 24h · 7d · 30d
 * windows, so a sysadmin reads acquisition + delivery velocity at a glance. Fail-soft per metric.
 */
superAdmin.get('/api/super-admin/growth', async (c) => {
  const windows: Array<[string, string]> = [
    ['d1', '-1 day'],
    ['d7', '-7 days'],
    ['d30', '-30 days'],
  ];
  const metric = async (table: string, statusClause = '') => {
    const row: Record<string, number> = {};
    for (const [key, offset] of windows) {
      try {
        const r = await dbQueryOne<{ n: number }>(
          c.env.DB,
          `SELECT COUNT(*) AS n FROM ${table} WHERE deleted_at IS NULL ${statusClause} AND created_at >= datetime('now', ?)`,
          [offset],
        );
        row[key] = Number(r?.n ?? 0);
      } catch {
        row[key] = -1; // sentinel: query failed for this window/table
      }
    }
    return row;
  };
  return c.json({
    orgs: await metric('orgs'),
    users: await metric('users'),
    sitesPublished: await metric('sites', `AND status = 'published'`),
    sitesCreated: await metric('sites'),
  });
});

/**
 * DELIVERABILITY (§ ops-console) — the transactional-email health surface: the current SES
 * suppression backlog (bounced/complained recipients that will silently drop mail) + the most
 * recent suppressions. Reuses {@link listSuppressions}. Fail-soft.
 */
superAdmin.get('/api/super-admin/deliverability', async (c) => {
  try {
    const suppressions = await listSuppressions(c.env.DB, 12);
    const total = await dbQueryOne<{ n: number }>(
      c.env.DB,
      `SELECT COUNT(*) AS n FROM email_suppressions WHERE deleted_at IS NULL`,
    ).catch(() => ({ n: suppressions.length }));
    return c.json({ suppressionCount: Number(total?.n ?? suppressions.length), recent: suppressions });
  } catch (e) {
    return c.json({ suppressionCount: null, recent: [], error: String(e).slice(0, 80) });
  }
});

/**
 * Read-only platform service catalog (§66). {@link SERVICE_REGISTRY} is the
 * source of truth kept in lockstep with reality; drives `/admin/system-services`.
 */
superAdmin.get('/api/super-admin/services', async (c) => {
  return c.json({
    services: SERVICE_REGISTRY,
    counts: {
      total: SERVICE_REGISTRY.length,
      production: SERVICE_REGISTRY.filter((s) => s.status === 'production').length,
      integrated: SERVICE_REGISTRY.filter((s) => s.status === 'integrated').length,
      scaffolded: SERVICE_REGISTRY.filter((s) => s.status === 'scaffolded').length,
      planned: SERVICE_REGISTRY.filter((s) => s.status === 'planned').length,
    },
  });
});

// ─── Audit helper — every super-admin write goes through here ─────────────

async function audit(
  c: {
    env: Env;
    get: (k: string) => string | undefined;
    req: { header: (k: string) => string | undefined };
  },
  action: string,
  detail: {
    target_kind?: string;
    target_id?: string;
    before?: unknown;
    after?: unknown;
    reason?: string;
  },
): Promise<void> {
  try {
    await c.env.DB.prepare(
      `INSERT INTO super_admin_audit (actor_user_id, action, target_kind, target_id, before_json, after_json, reason, ip_address, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        c.get('userId') ?? '?',
        action,
        detail.target_kind ?? null,
        detail.target_id ?? null,
        detail.before === undefined ? null : JSON.stringify(detail.before),
        detail.after === undefined ? null : JSON.stringify(detail.after),
        detail.reason ?? null,
        c.req.header('cf-connecting-ip') ?? null,
        c.req.header('user-agent') ?? null,
      )
      .run();
  } catch {
    /* best effort */
  }
}

// ─── Pro grant / revoke ────────────────────────────────────────────────────

const proGrantSchema = z.object({
  user_id: z.string().min(1),
  reason: z.enum(['subscription', 'comp', 'lifetime', 'beta']),
  expires_at: z.string().datetime().nullable().optional(),
});

superAdmin.post('/api/super-admin/pro/grant', zValidator('json', proGrantSchema), async (c) => {
  const body = c.req.valid('json');
  const userId = c.get('userId') as string;
  await c.env.DB.prepare(
    `UPDATE users
        SET is_pro = 1, pro_granted_at = COALESCE(pro_granted_at, CURRENT_TIMESTAMP),
            pro_grant_reason = ?, pro_granted_by = ?, pro_expires_at = ?,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
  )
    .bind(body.reason, userId, body.expires_at ?? null, body.user_id)
    .run();
  await audit(c, 'pro_grant', { target_kind: 'user', target_id: body.user_id, after: body });
  return c.json({ ok: true });
});

superAdmin.post(
  '/api/super-admin/pro/revoke',
  zValidator('json', z.object({ user_id: z.string(), reason: z.string() })),
  async (c) => {
    const body = c.req.valid('json');
    await c.env.DB.prepare(
      `UPDATE users SET is_pro = 0, pro_grant_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    )
      .bind(`revoked:${body.reason}`, body.user_id)
      .run();
    await audit(c, 'pro_revoke', {
      target_kind: 'user',
      target_id: body.user_id,
      reason: body.reason,
    });
    return c.json({ ok: true });
  },
);

// ─── Coupons ───────────────────────────────────────────────────────────────

superAdmin.get('/api/super-admin/coupons', async (c) => {
  const { data } = await dbQuery(
    c.env.DB,
    `SELECT code, kind, amount, max_redemptions, redeemed_count, applies_to,
            stripe_coupon_id, expires_at, created_by, created_at
       FROM coupons ORDER BY created_at DESC LIMIT 500`,
  );
  return c.json({ coupons: data });
});

const couponSchema = z.object({
  code: z.string().regex(/^[A-Z0-9_-]{3,40}$/),
  kind: z.enum(['pct', 'flat', 'comp_months']),
  amount: z.number().int().min(1).max(10000),
  max_redemptions: z.number().int().min(1).optional(),
  applies_to: z.enum(['all', 'pro', 'wallet_topup', 'template']).default('all'),
  expires_at: z.string().datetime().optional(),
});

superAdmin.post('/api/super-admin/coupons', zValidator('json', couponSchema), async (c) => {
  const body = c.req.valid('json');
  const userId = c.get('userId') as string;
  await c.env.DB.prepare(
    `INSERT INTO coupons (code, kind, amount, max_redemptions, applies_to, expires_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      body.code,
      body.kind,
      body.amount,
      body.max_redemptions ?? null,
      body.applies_to,
      body.expires_at ?? null,
      userId,
    )
    .run();
  await audit(c, 'coupon_create', { target_kind: 'coupon', target_id: body.code, after: body });
  return c.json({ code: body.code }, 201);
});

superAdmin.delete('/api/super-admin/coupons/:code', async (c) => {
  const code = c.req.param('code');
  await c.env.DB.prepare('DELETE FROM coupons WHERE code = ?').bind(code).run();
  await audit(c, 'coupon_delete', { target_kind: 'coupon', target_id: code });
  return c.json({ ok: true });
});

// ─── Refunds ──────────────────────────────────────────────────────────────

const refundSchema = z.object({
  org_id: z.string().min(1),
  stripe_charge_id: z.string().optional(),
  amount_cents: z.number().int().min(1).max(1_000_000),
  reason: z.enum(['requested_by_customer', 'duplicate', 'fraudulent', 'other']),
  notes: z.string().max(500).optional(),
});

/**
 * Issue a Stripe refund + matching wallet adjustment. Calls the Stripe Refunds
 * API (when a charge id is supplied) then writes a `direction='refund'` row.
 */
superAdmin.post('/api/super-admin/refunds', zValidator('json', refundSchema), async (c) => {
  const body = c.req.valid('json');
  const userId = c.get('userId') as string;
  const id = `ref_${crypto.randomUUID()}`;

  // Call the Stripe Refunds API when a charge id is supplied; otherwise record a
  // pending manual refund the operator reconciles out-of-band.
  let stripeRefundId: string | null = null;
  let status = 'pending';
  if (body.stripe_charge_id) {
    const params = new URLSearchParams({
      charge: body.stripe_charge_id,
      amount: String(body.amount_cents),
      'metadata[org_id]': body.org_id,
      'metadata[initiated_by]': userId,
    });
    // Stripe only accepts these three reason codes; 'other' is omitted.
    if (body.reason !== 'other') params.set('reason', body.reason);
    let res: Response;
    try {
      res = await fetch('https://api.stripe.com/v1/refunds', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${c.env.STRIPE_SECRET_KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Idempotency-Key': id, // safe retry — Stripe dedupes on our refund id
        },
        body: params.toString(),
      });
    } catch (err) {
      await audit(c, 'refund_failed', {
        target_kind: 'org',
        target_id: body.org_id,
        after: { ...body, error: err instanceof Error ? err.message : 'fetch failed' },
      });
      return c.json({ error: { code: 'BAD_GATEWAY', message: 'Could not reach Stripe' } }, 502);
    }
    const data = (await res.json().catch(() => ({}))) as {
      id?: string;
      status?: string;
      error?: { message?: string };
    };
    if (!res.ok || !data.id) {
      await audit(c, 'refund_failed', {
        target_kind: 'org',
        target_id: body.org_id,
        after: { ...body, stripe_error: data.error?.message ?? `http ${res.status}` },
      });
      return c.json(
        { error: { code: 'STRIPE_ERROR', message: data.error?.message ?? 'Stripe refund failed' } },
        502,
      );
    }
    stripeRefundId = data.id;
    // Stripe returns succeeded | pending | failed | canceled — trust it, default to pending.
    status = data.status ?? 'pending';
  }

  const { error: refundErr } = await dbInsert(c.env.DB, 'refunds', {
    id,
    org_id: body.org_id,
    stripe_charge_id: body.stripe_charge_id ?? null,
    stripe_refund_id: stripeRefundId,
    amount_cents: body.amount_cents,
    reason: body.reason,
    notes: body.notes ?? null,
    initiated_by: userId,
    status,
  });
  if (refundErr) {
    // The Stripe refund already SUCCEEDED — money is out and cannot be reversed,
    // and Stripe's Idempotency-Key (`id`) blocks a double-refund on retry. So we
    // cannot compensate; instead preserve the recoverable stripe_refund_id in the
    // audit trail and surface a precise error — never a lying 201 that hides an
    // un-recorded refund.
    await audit(c, 'refund_record_failed', {
      target_kind: 'org',
      target_id: body.org_id,
      after: { ...body, stripe_refund_id: stripeRefundId, status, db_error: refundErr },
    });
    throw internalError(
      `Refund issued at Stripe (${stripeRefundId ?? 'no-charge'}) but recording it failed: ${refundErr}`,
    );
  }
  await audit(c, 'refund_initiate', {
    target_kind: 'org',
    target_id: body.org_id,
    after: { ...body, stripe_refund_id: stripeRefundId, status },
  });
  return c.json({ id, status, stripe_refund_id: stripeRefundId }, 201);
});

superAdmin.get('/api/super-admin/refunds', async (c) => {
  const { data } = await dbQuery(
    c.env.DB,
    `SELECT id, org_id, amount_cents, reason, notes, initiated_by, status, created_at
       FROM refunds ORDER BY created_at DESC LIMIT 500`,
  );
  return c.json({ refunds: data });
});

// ─── Broadcasts (email / banner / in-app) ─────────────────────────────────

const broadcastSchema = z.object({
  channel: z.enum(['email', 'banner', 'in_app']),
  segment: z.record(z.unknown()),
  subject: z.string().max(140).optional(),
  body_md: z.string().min(3).max(8000),
  cta_label: z.string().max(40).optional(),
  cta_url: z.string().url().optional(),
  scheduled_at: z.string().datetime().optional(),
});

superAdmin.post('/api/super-admin/broadcasts', zValidator('json', broadcastSchema), async (c) => {
  const body = c.req.valid('json');
  const userId = c.get('userId') as string;
  const id = `bc_${crypto.randomUUID()}`;
  const { error: bcErr } = await dbInsert(c.env.DB, 'broadcasts', {
    id,
    channel: body.channel,
    segment_json: JSON.stringify(body.segment),
    subject: body.subject ?? null,
    body_md: body.body_md,
    cta_label: body.cta_label ?? null,
    cta_url: body.cta_url ?? null,
    scheduled_at: body.scheduled_at ?? null,
    created_by: userId,
  });
  if (bcErr) throw internalError(`Failed to create broadcast: ${bcErr}`);
  await audit(c, 'broadcast_create', { target_kind: 'broadcast', target_id: id, after: body });
  return c.json({ id }, 201);
});

superAdmin.get('/api/super-admin/broadcasts', async (c) => {
  const { data } = await dbQuery(
    c.env.DB,
    `SELECT id, channel, subject, scheduled_at, sent_at, recipient_count,
            opened_count, clicked_count, created_at
       FROM broadcasts ORDER BY created_at DESC LIMIT 200`,
  );
  return c.json({ broadcasts: data });
});

// ─── Announcements (admin banners, marketing release notes) ───────────────

const announcementSchema = z.object({
  title: z.string().min(2).max(120),
  body_md: z.string().min(3).max(2000),
  kind: z.enum(['info', 'warning', 'maintenance', 'release']).default('info'),
  shows_in: z.enum(['admin', 'marketing', 'both']).default('admin'),
  starts_at: z.string().datetime().optional(),
  ends_at: z.string().datetime().optional(),
  active: z.boolean().default(true),
});

superAdmin.get('/api/super-admin/announcements', async (c) => {
  const { data } = await dbQuery(
    c.env.DB,
    `SELECT id, title, body_md, kind, active, shows_in, starts_at, ends_at, created_at
       FROM announcements ORDER BY created_at DESC LIMIT 100`,
  );
  return c.json({ announcements: data });
});

superAdmin.post(
  '/api/super-admin/announcements',
  zValidator('json', announcementSchema),
  async (c) => {
    const body = c.req.valid('json');
    const userId = c.get('userId') as string;
    const id = `ann_${crypto.randomUUID()}`;
    const { error: annErr } = await dbInsert(c.env.DB, 'announcements', {
      id,
      title: body.title,
      body_md: body.body_md,
      kind: body.kind,
      active: body.active ? 1 : 0,
      shows_in: body.shows_in,
      starts_at: body.starts_at ?? null,
      ends_at: body.ends_at ?? null,
      created_by: userId,
    });
    if (annErr) throw internalError(`Failed to create announcement: ${annErr}`);
    await audit(c, 'announcement_create', {
      target_kind: 'announcement',
      target_id: id,
      after: body,
    });
    return c.json({ id }, 201);
  },
);

// ─── Feature flags + per-org overrides ────────────────────────────────────

interface FlagOverrideValue {
  enabled?: boolean;
  rollout_percent?: number;
  kill_switch?: boolean;
  stage?: string;
}

function parseFlagValue(raw: unknown): FlagOverrideValue {
  if (typeof raw !== 'string') return {};
  try {
    return JSON.parse(raw) as FlagOverrideValue;
  } catch {
    return {};
  }
}

/**
 * List the GLOBAL operator overrides. Reads the canonical `flag_overrides`
 * table (`scope='global'`, `scope_id='*'`) — the SAME table `resolveFlag`/
 * `isFlagOn` consult at runtime — so what the operator sees is exactly what the
 * platform evaluates. Returns the legacy
 * `{ key, enabled_globally, rollout_pct, kill_switch }` shape the frontend reads.
 */
superAdmin.get('/api/super-admin/feature-flags', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT flag_key, value_json, updated_at FROM flag_overrides
       WHERE scope = 'global' AND scope_id = '*' AND deleted_at IS NULL
         AND (expires_at IS NULL OR expires_at > datetime('now'))
       ORDER BY flag_key`,
  )
    .all<{ flag_key: string; value_json: string; updated_at: string }>()
    .catch(() => ({
      results: [] as { flag_key: string; value_json: string; updated_at: string }[],
    }));
  const flags = (rows.results ?? []).map((r) => {
    const v = parseFlagValue(r.value_json);
    return {
      key: r.flag_key,
      enabled_globally: v.enabled ? 1 : 0,
      rollout_pct: Number(v.rollout_percent ?? 0),
      kill_switch: v.kill_switch ? 1 : 0,
      updated_at: r.updated_at,
    };
  });
  return c.json({ flags });
});

const flagPatchSchema = z.object({
  key: z.string().min(2).max(80),
  description: z.string().max(200).optional(),
  enabled_globally: z.boolean().optional(),
  rollout_pct: z.number().min(0).max(100).optional(),
  kill_switch: z.boolean().optional(),
  /**
   * Operator-supplied reason for a dangerous change (killswitch / global-enable /
   * large rollout jump). Persisted in the audit trail so the per-flag history
   * panel can surface "why" alongside the diff. Required by the admin UI for
   * dangerous changes; the schema keeps it optional so non-dangerous nudges
   * (small rollout tweaks) don't demand a reason.
   */
  reason: z.string().max(500).optional(),
});

superAdmin.post(
  '/api/super-admin/feature-flags',
  zValidator('json', flagPatchSchema),
  async (c) => {
    const body = c.req.valid('json');
    const userId = c.get('userId') as string;

    // Merge the patch onto the EXISTING global override (or the code-registry
    // default when none exists) so a partial nudge (e.g. rollout only) never
    // clobbers the other dimensions.
    const existingRow = await c.env.DB.prepare(
      `SELECT value_json FROM flag_overrides
         WHERE scope = 'global' AND scope_id = '*' AND flag_key = ? AND deleted_at IS NULL`,
    )
      .bind(body.key)
      .first<{ value_json: string }>()
      .catch(() => null);
    const def = FLAG_REGISTRY[body.key];
    const base: FlagOverrideValue = existingRow
      ? parseFlagValue(existingRow.value_json)
      : {
          enabled: def?.default_enabled ?? false,
          rollout_percent: def?.default_rollout_percent ?? 0,
          kill_switch: false,
        };
    const merged: FlagOverrideValue = {
      enabled: body.enabled_globally ?? base.enabled ?? false,
      rollout_percent: body.rollout_pct ?? base.rollout_percent ?? 0,
      kill_switch: body.kill_switch ?? base.kill_switch ?? false,
    };

    // Upsert the canonical runtime override row. `id` is an explicit UUID so the
    // PRIMARY KEY is never NULL; the unique index drives the ON CONFLICT merge.
    await c.env.DB.prepare(
      // The unique index `idx_flag_overrides_unique` is PARTIAL
      // (WHERE deleted_at IS NULL), so the ON CONFLICT target MUST repeat that
      // predicate or SQLite raises "ON CONFLICT does not match any … UNIQUE
      // constraint".
      `INSERT INTO flag_overrides (id, scope, scope_id, flag_key, value_json, set_by, reason, set_at, updated_at)
       VALUES (?, 'global', '*', ?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(scope, scope_id, flag_key) WHERE deleted_at IS NULL DO UPDATE SET
         value_json = excluded.value_json,
         set_by     = excluded.set_by,
         reason     = excluded.reason,
         updated_at = datetime('now')`,
    )
      .bind(crypto.randomUUID(), body.key, JSON.stringify(merged), userId, body.reason ?? null)
      .run();

    // Bust the 60s KV cache `resolveFlag` keeps under `flag:<key>:*`, or the
    // just-written global override stays invisible to `isFlagOn` until TTL.
    await invalidateFlagCache(c.env, body.key);

    await audit(c, 'feature_flag_upsert', {
      target_kind: 'feature_flag',
      target_id: body.key,
      after: body,
      reason: body.reason,
    });
    return c.json({ ok: true });
  },
);

superAdmin.get('/api/super-admin/feature-flags/:key/audit', async (c) => {
  const key = c.req.param('key');
  const { data } = await dbQuery<{
    id: string;
    actor_user_id: string;
    action: string;
    before_json: string | null;
    after_json: string | null;
    reason: string | null;
    created_at: string;
  }>(
    c.env.DB,
    `SELECT id, actor_user_id, action, before_json, after_json, reason, created_at
       FROM super_admin_audit
      WHERE target_kind = 'feature_flag' AND target_id = ?
      ORDER BY created_at DESC
      LIMIT 50`,
    [key],
  );
  const entries = (data ?? []).map((row) => ({
    id: row.id,
    actor: row.actor_user_id,
    action: row.action,
    summary: summarizeAuditRow(row.before_json, row.after_json),
    reason: row.reason,
    created_at: row.created_at,
  }));
  return c.json({ entries });
});

/**
 * Build a one-line "rollout 0% → 25%, enabled off → on" summary from the
 * persisted before/after JSON of a feature-flag audit row.
 */
function summarizeAuditRow(beforeJson: string | null, afterJson: string | null): string {
  let after: Record<string, unknown> = {};
  try {
    after = afterJson ? (JSON.parse(afterJson) as Record<string, unknown>) : {};
  } catch {
    after = {};
  }
  const parts: string[] = [];
  if (typeof after.enabled_globally === 'boolean')
    parts.push(`enabled → ${after.enabled_globally ? 'on' : 'off'}`);
  if (typeof after.rollout_pct === 'number') parts.push(`rollout → ${after.rollout_pct}%`);
  if (typeof after.kill_switch === 'boolean')
    parts.push(`kill switch → ${after.kill_switch ? 'on' : 'off'}`);
  return parts.length ? parts.join(', ') : 'flag updated';
}

// ─── Impersonation sessions ───────────────────────────────────────────────

const impersonateSchema = z.object({
  target_user_id: z.string().min(1),
  mode: z.enum(['read', 'write']).default('read'),
  reason: z.string().min(3).max(200),
});

/**
 * Start an impersonation session scoped to a target user's current org. Issues a
 * short-TTL token tagged with the original super-admin id so subsequent audit
 * rows capture both actors.
 */
superAdmin.post(
  '/api/super-admin/impersonate',
  zValidator('json', impersonateSchema),
  async (c) => {
    const body = c.req.valid('json');
    const userId = c.get('userId') as string;
    const id = `imp_${crypto.randomUUID()}`;
    // Scope impersonation to a CURRENT membership: `deleted_at IS NULL` excludes orgs
    // the target user has DEPARTED (removal soft-deletes the membership, role intact).
    // Without it a super-admin could be placed into an org the user no longer belongs to.
    const targetOrg = await dbQueryOne<{ org_id: string }>(
      c.env.DB,
      `SELECT m.org_id FROM memberships m WHERE m.user_id = ? AND m.deleted_at IS NULL ORDER BY m.created_at LIMIT 1`,
      [body.target_user_id],
    );
    const { error: impErr } = await dbInsert(c.env.DB, 'impersonation_sessions', {
      id,
      super_admin_user_id: userId,
      target_user_id: body.target_user_id,
      target_org_id: targetOrg?.org_id ?? null,
      mode: body.mode,
      reason: body.reason,
      ip_address: c.req.header('cf-connecting-ip') ?? null,
      user_agent: c.req.header('user-agent') ?? null,
    });
    // The session row IS the audit trail. If it did not persist, BLOCK the
    // impersonation — never mint the token below for an un-auditable session.
    if (impErr) throw internalError(`Failed to record impersonation session: ${impErr}`);
    await audit(c, 'impersonate_start', {
      target_kind: 'user',
      target_id: body.target_user_id,
      reason: body.reason,
      after: body,
    });

    // Issue a short-lived (30-min) signed HS256 token binding the impersonation
    // session: { sub, impersonator_id, org_id, mode, sid }. Fail-soft — when the
    // secret is unset the session row still exists; only the token is omitted.
    let token: string | null = null;
    const expiresInSec = 30 * 60;
    if (c.env.IMPERSONATION_JWT_SECRET) {
      token = await signHs256(
        {
          sub: body.target_user_id,
          impersonator_id: userId,
          org_id: targetOrg?.org_id ?? null,
          mode: body.mode,
          sid: id,
        },
        c.env.IMPERSONATION_JWT_SECRET,
        expiresInSec,
      );
    }
    return c.json({
      session_id: id,
      mode: body.mode,
      target_org_id: targetOrg?.org_id ?? null,
      token,
      expires_in: token ? expiresInSec : null,
    });
  },
);

superAdmin.post('/api/super-admin/impersonate/:id/end', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare(
    `UPDATE impersonation_sessions SET ended_at = CURRENT_TIMESTAMP WHERE id = ?`,
  )
    .bind(id)
    .run();
  await audit(c, 'impersonate_end', { target_kind: 'impersonation_session', target_id: id });
  return c.json({ ok: true });
});

// ─── Moderation queue ─────────────────────────────────────────────────────

superAdmin.get('/api/super-admin/moderation', async (c) => {
  const status = c.req.query('status') ?? 'open';
  const { data } = await dbQuery(
    c.env.DB,
    `SELECT id, kind, reference_id, org_id, reason, severity, status,
            reporter_id, resolver_id, resolution_notes, created_at, resolved_at
       FROM moderation_queue
       WHERE status = ?
       ORDER BY severity DESC, created_at DESC LIMIT 200`,
    [status],
  );
  return c.json({ items: data });
});

const moderationResolveSchema = z.object({
  status: z.enum(['resolved', 'escalated', 'dismissed']),
  notes: z.string().max(500).optional(),
});

superAdmin.post(
  '/api/super-admin/moderation/:id/resolve',
  zValidator('json', moderationResolveSchema),
  async (c) => {
    const id = c.req.param('id');
    const body = c.req.valid('json');
    const userId = c.get('userId') as string;
    await c.env.DB.prepare(
      `UPDATE moderation_queue
        SET status = ?, resolver_id = ?, resolution_notes = ?, resolved_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
    )
      .bind(body.status, userId, body.notes ?? null, id)
      .run();
    await audit(c, 'moderation_resolve', {
      target_kind: 'moderation_item',
      target_id: id,
      after: body,
    });
    return c.json({ ok: true });
  },
);

// ─── AI prompt blocklist ──────────────────────────────────────────────────

superAdmin.get('/api/super-admin/ai-blocklist', async (c) => {
  const { data } = await dbQuery(
    c.env.DB,
    `SELECT id, pattern, pattern_kind, reason, enabled, added_by, added_at
       FROM ai_blocklist ORDER BY added_at DESC LIMIT 500`,
  );
  return c.json({ patterns: data });
});

const blocklistSchema = z.object({
  pattern: z.string().min(2).max(500),
  pattern_kind: z.enum(['regex', 'substring', 'embedding_id']).default('regex'),
  reason: z.string().max(200).optional(),
});

superAdmin.post('/api/super-admin/ai-blocklist', zValidator('json', blocklistSchema), async (c) => {
  const body = c.req.valid('json');
  const userId = c.get('userId') as string;
  await c.env.DB.prepare(
    `INSERT INTO ai_blocklist (pattern, pattern_kind, reason, added_by) VALUES (?, ?, ?, ?)`,
  )
    .bind(body.pattern, body.pattern_kind, body.reason ?? null, userId)
    .run();
  await audit(c, 'ai_blocklist_add', { after: body });
  return c.json({ ok: true }, 201);
});

// ─── Org tags ─────────────────────────────────────────────────────────────

const tagSchema = z.object({ org_id: z.string(), tag: z.string().regex(/^[a-z0-9_-]{2,40}$/) });

superAdmin.post('/api/super-admin/tags', zValidator('json', tagSchema), async (c) => {
  const body = c.req.valid('json');
  const userId = c.get('userId') as string;
  await c.env.DB.prepare(`INSERT OR IGNORE INTO org_tags (org_id, tag, tagged_by) VALUES (?, ?, ?)`)
    .bind(body.org_id, body.tag, userId)
    .run();
  return c.json({ ok: true });
});

superAdmin.delete('/api/super-admin/tags', zValidator('json', tagSchema), async (c) => {
  const body = c.req.valid('json');
  await c.env.DB.prepare(`DELETE FROM org_tags WHERE org_id = ? AND tag = ?`)
    .bind(body.org_id, body.tag)
    .run();
  return c.json({ ok: true });
});

// ─── Rate-limit overrides ─────────────────────────────────────────────────

const rateLimitSchema = z.object({
  org_id: z.string().optional(),
  route_pattern: z.string().min(1).max(200),
  limit_per_min: z.number().int().min(1).max(100000),
  reason: z.string().max(200).optional(),
  expires_at: z.string().datetime().optional(),
});

superAdmin.post(
  '/api/super-admin/rate-limit-overrides',
  zValidator('json', rateLimitSchema),
  async (c) => {
    const body = c.req.valid('json');
    const userId = c.get('userId') as string;
    await c.env.DB.prepare(
      `INSERT INTO rate_limit_overrides (org_id, route_pattern, limit_per_min, reason, set_by, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        body.org_id ?? null,
        body.route_pattern,
        body.limit_per_min,
        body.reason ?? null,
        userId,
        body.expires_at ?? null,
      )
      .run();
    await audit(c, 'rate_limit_override', { after: body });
    return c.json({ ok: true }, 201);
  },
);

// ─── Audit log viewer ─────────────────────────────────────────────────────

superAdmin.get('/api/super-admin/audit', async (c) => {
  const action = c.req.query('action') ?? '';
  const actor = c.req.query('actor') ?? '';
  const days = Math.min(parseInt(c.req.query('days') ?? '7', 10) || 7, 90);
  const where: string[] = ["created_at >= datetime('now', ?)"];
  const params: unknown[] = [`-${days} days`];
  if (action) {
    where.push('action = ?');
    params.push(action);
  }
  if (actor) {
    where.push('actor_user_id = ?');
    params.push(actor);
  }
  params.push(500);
  const { data } = await dbQuery(
    c.env.DB,
    `SELECT id, actor_user_id, action, target_kind, target_id, reason,
            ip_address, user_agent, created_at
       FROM super_admin_audit
       WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC LIMIT ?`,
    params,
  );
  return c.json({ audit: data });
});

// ─── Operations: kill switch / maintenance / cache purge ──────────────────

superAdmin.post('/api/super-admin/cache/purge', async (c) => {
  const body = (await c.req.json<{ key?: string; all?: boolean }>().catch(() => ({}))) as {
    key?: string;
    all?: boolean;
  };
  if (body.all === true) {
    await audit(c, 'cache_purge_all', { reason: 'bulk' });
    return c.json({
      ok: true,
      note: 'bulk purge requires KV bulk-delete cron — best-effort logged',
    });
  }
  if (typeof body.key === 'string' && body.key.length > 0) {
    await c.env.CACHE_KV.delete(body.key);
    await audit(c, 'cache_purge_key', { target_kind: 'kv_key', target_id: body.key });
    return c.json({ ok: true });
  }
  return c.json({ error: { code: 'BAD_REQUEST', message: 'key or all required' } }, 400);
});

// ─── Email deliverability — SES suppression list (§42/ADR-0019) ───────────

/**
 * Addresses suppressed by SES hard bounces / complaints, newest first (capped
 * 1000). Read-only operator view.
 */
superAdmin.get('/api/super-admin/email-suppressions', async (c) => {
  const parsed = Number(c.req.query('limit') ?? '200');
  const rows = await listSuppressions(c.env.DB, Number.isFinite(parsed) ? parsed : 200);
  return c.json({ data: rows, count: rows.length });
});

/**
 * Manually un-suppress an address (a customer who fixed their mailbox).
 * Idempotent; audited.
 */
superAdmin.delete('/api/super-admin/email-suppressions/:email', async (c) => {
  const email = decodeURIComponent(c.req.param('email')).trim().toLowerCase();
  const result = await removeSuppression(c.env.DB, email);
  await audit(c, 'email.unsuppress', { target_kind: 'email', target_id: email });
  return c.json({ removed: result.removed, email });
});

export { superAdmin };
