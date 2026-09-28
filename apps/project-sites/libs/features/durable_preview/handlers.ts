import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { Env, Variables } from '../../../src/types/env.js';
import { unauthorized, notFound } from '../../../src/lib/feature_guard.js';
import { isFlagOn } from '../../../src/modules/feature_flags/services.js';
import { assertSiteOwned } from '../../../src/services/site_ownership.js';
import {
  FLAG_KEY,
  getWorkingTree,
  listReleases,
  upsertWorkingTree,
} from './service.js';
import {
  ReleaseListResponseSchema,
  UpsertWorkingTreeSchema,
  WorkingTreeResponseSchema,
} from './schemas.js';

type AppContext = { Bindings: Env; Variables: Variables };
export const durablePreview = new Hono<AppContext>();

/** Structured JSON log line (charter: every path a fire touches emits correlated logs). */
function log(
  c: import('hono').Context<AppContext>,
  event: string,
  extra: Record<string, unknown>,
): void {
  console.warn(
    JSON.stringify({
      level: 'info',
      service: 'durable_preview',
      event,
      requestId: c.get('requestId') ?? null,
      orgId: c.get('orgId') ?? null,
      ...extra,
    }),
  );
}

/** Auth + flag gate — Response to short-circuit, or null to proceed. Flag off → 404 (dark, never 403). */
async function guard(c: import('hono').Context<AppContext>): Promise<Response | null> {
  const userId = c.get('userId');
  if (!userId) return unauthorized(c);
  const on = await isFlagOn(c.env, FLAG_KEY, { userId, orgId: c.get('orgId') }).catch(() => false);
  if (!on) return notFound(c);
  return null;
}

// POST /api/sites/:id/preview-state — record a Preview save/generate (upsert the working tree).
// INVARIANT: Preview ONLY — this NEVER commits, deploys, or changes Production. A Promote is separate.
durablePreview.post(
  '/api/sites/:id/preview-state',
  zValidator('json', UpsertWorkingTreeSchema),
  async (c) => {
    const blocked = await guard(c);
    if (blocked) return blocked;
    const orgId = c.get('orgId');
    if (!orgId) return unauthorized(c);
    const siteId = c.req.param('id');
    // Multi-tenant ownership gate (IDOR): 404 a site that isn't the caller's org's — before any write.
    if (!(await assertSiteOwned(c.env, orgId, siteId))) return notFound(c);
    const body = c.req.valid('json');
    try {
      const res = await upsertWorkingTree(c.env, {
        siteId,
        orgId,
        baseMainSha: body.base_main_sha ?? null,
        treeDigest: body.tree_digest,
        previewDeployRevision: body.preview_deploy_revision ?? null,
        lastError: body.last_error ?? null,
      });
      if (!res.ok) {
        log(c, 'preview_state.upsert_failed', { siteId, error: res.error });
        return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Could not save preview state' } }, 500);
      }
      log(c, 'preview_state.saved', { siteId, draftRevision: res.draftRevision });
      const wt = await getWorkingTree(c.env, siteId, orgId);
      return c.json(WorkingTreeResponseSchema.parse({ working_tree: wt }), 200);
    } catch (err) {
      log(c, 'preview_state.error', {
        siteId,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Could not save preview state' } }, 500);
    }
  },
);

// GET /api/sites/:id/preview-state — this site's current Preview working-tree record.
durablePreview.get('/api/sites/:id/preview-state', async (c) => {
  const blocked = await guard(c);
  if (blocked) return blocked;
  const orgId = c.get('orgId');
  if (!orgId) return unauthorized(c);
  const siteId = c.req.param('id');
  if (!(await assertSiteOwned(c.env, orgId, siteId))) return notFound(c);
  const wt = await getWorkingTree(c.env, siteId, orgId);
  return c.json(WorkingTreeResponseSchema.parse({ working_tree: wt }));
});

// GET /api/sites/:id/releases — this site's immutable Production release history (newest first).
durablePreview.get('/api/sites/:id/releases', async (c) => {
  const blocked = await guard(c);
  if (blocked) return blocked;
  const orgId = c.get('orgId');
  if (!orgId) return unauthorized(c);
  const siteId = c.req.param('id');
  if (!(await assertSiteOwned(c.env, orgId, siteId))) return notFound(c);
  const releases = await listReleases(c.env, siteId, orgId);
  return c.json(ReleaseListResponseSchema.parse({ releases, count: releases.length }));
});
