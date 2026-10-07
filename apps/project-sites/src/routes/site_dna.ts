/**
 * Site DNA Taste Graph routes (#7).
 *
 * Routes:
 *   POST /api/site-dna/:siteId/feedback     → record accept/reject/edit action
 *   GET  /api/site-dna/:siteId/preferences  → top-K accepted patterns by component class
 *   GET  /api/site-dna/:siteId/history      → recent feedback list (admin)
 *
 * Flag: `site_dna_taste_graph` (experimental, enabled=0, rollout=0).
 * Server guard: 404 when off.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import type { Env, Variables } from '../types/env.js';
import {
  recordDnaFeedback,
  getDnaPreferences,
  listDnaFeedback,
  type DnaAction,
} from '../services/site_dna.js';
import { isFlagOn } from '../modules/feature_flags/services.js';

const siteDna = new Hono<{ Bindings: Env; Variables: Variables }>();

const SITE_DNA_FLAG = 'site_dna_taste_graph';

// ── Flag gate helper ───────────────────────────────────────────────────────

async function assertFlagOn(env: Env, siteId?: string): Promise<boolean> {
  // Use the CANONICAL flag resolver (registry + `flag_overrides`) — the same
  // source the admin toggle and the frontend FeatureFlagService read. The old
  // bespoke `SELECT enabled FROM feature_flags WHERE key=…` hit the LEGACY
  // table (no `key` column, no row for this flag) → threw → caught → always
  // false → every route 404'd even with the flag enabled, and the FE-sees-on /
  // worker-sees-off mismatch logged console 404s on /admin/sites/:id/dna.
  return isFlagOn(env, SITE_DNA_FLAG, siteId ? { siteId } : {});
}

// ── POST /api/site-dna/:siteId/feedback ──────────────────────────────────

const DnaFeedbackBodySchema = z.object({
  component_id: z.string().min(1, 'component_id is required'),
  action: z.enum(['accept', 'reject', 'edit'] as [DnaAction, ...DnaAction[]]),
  context: z.record(z.unknown()).optional(),
});
type DnaFeedbackInput = z.infer<typeof DnaFeedbackBodySchema>;

siteDna.post(
  '/api/site-dna/:siteId/feedback',
  zValidator('json', DnaFeedbackBodySchema),
  async (c) => {
    if (!(await assertFlagOn(c.env, c.req.param('siteId')))) {
      return c.json(
        { error: { code: 'NOT_FOUND', message: 'site_dna_taste_graph not enabled' } },
        404,
      );
    }

    const siteId = c.req.param('siteId');
    const orgId = c.get('orgId');
    if (!orgId)
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);

    const body = c.req.valid('json') as DnaFeedbackInput;

    // Derive component_class from context or component_id prefix.
    const ctx = body.context ?? {};
    const componentClass =
      (ctx.component_class as string) ?? body.component_id.split('-')[0] ?? 'generic';

    const result = await recordDnaFeedback(c.env, {
      orgId,
      siteId,
      componentId: body.component_id,
      componentClass,
      action: body.action,
      context: ctx,
    });

    return c.json(
      { ...result, site_id: siteId, component_id: body.component_id, action: body.action },
      201,
    );
  },
);

// ── GET /api/site-dna/:siteId/preferences ─────────────────────────────────

siteDna.get('/api/site-dna/:siteId/preferences', async (c) => {
  if (!(await assertFlagOn(c.env, c.req.param('siteId')))) {
    return c.json(
      { error: { code: 'NOT_FOUND', message: 'site_dna_taste_graph not enabled' } },
      404,
    );
  }

  const orgId = c.get('orgId');
  if (!orgId)
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);

  const siteId = c.req.param('siteId');
  const componentClass = c.req.query('class');
  const topK = Math.min(Number(c.req.query('top_k') ?? '10'), 50);

  // Tenant isolation: scope the read to the caller's org (the service adds
  // `org_id = ?` to the WHERE) so a guessed foreign siteId returns nothing.
  const prefs = await getDnaPreferences(c.env, orgId, siteId, componentClass, topK);
  return c.json({
    site_id: siteId,
    component_class: componentClass ?? 'all',
    preferences: prefs,
    count: prefs.length,
  });
});

// ── GET /api/site-dna/:siteId/history ─────────────────────────────────────

siteDna.get('/api/site-dna/:siteId/history', async (c) => {
  if (!(await assertFlagOn(c.env, c.req.param('siteId')))) {
    return c.json(
      { error: { code: 'NOT_FOUND', message: 'site_dna_taste_graph not enabled' } },
      404,
    );
  }

  const orgId = c.get('orgId');
  if (!orgId)
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);

  const siteId = c.req.param('siteId');
  const limit = Math.min(Number(c.req.query('limit') ?? '50'), 200);
  // Tenant isolation: scope to the caller's org (service adds `org_id = ?`).
  const history = await listDnaFeedback(c.env, orgId, siteId, limit);
  return c.json({ site_id: siteId, history, count: history.length });
});

export { siteDna };
