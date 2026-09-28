import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { Env, Variables } from '../../../src/types/env.js';
import { unauthorized, notFound } from '../../../src/lib/feature_guard.js';
import { isFlagOn } from '../../../src/modules/feature_flags/services.js';
import { assertSiteOwned, requireOwnedSite } from '../../../src/services/site_ownership.js';
import {
  FLAG_KEY,
  getWorkingTree,
  listReleases,
  promoteToProduction,
  upsertWorkingTree,
} from './service.js';
import {
  PromoteRequestSchema,
  PromoteResponseSchema,
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

// POST /api/sites/:id/promote — REALLY promote the Preview working tree to Production (Slice 5).
// Idempotent on draft_revision; freezes the current Preview artifact → publishes a new production
// version → points Production at it → records the ACTUAL outcome (never a fabricated success).
durablePreview.post(
  '/api/sites/:id/promote',
  zValidator('json', PromoteRequestSchema),
  async (c) => {
    const blocked = await guard(c);
    if (blocked) return blocked;
    const orgId = c.get('orgId');
    if (!orgId) return unauthorized(c);
    const siteId = c.req.param('id');
    // Multi-tenant ownership gate (IDOR): 404 (never 403) a site that isn't the caller's org's, and
    // resolve the slug + current version in the SAME query the guard uses (no second lookup).
    const site = await requireOwnedSite<{ id: string; slug: string; current_build_version: string | null }>(
      c.env,
      orgId,
      siteId,
      'id, slug, current_build_version',
    ).catch(() => null);
    if (!site) return notFound(c);

    const body = c.req.valid('json');
    try {
      const result = await promoteToProduction(
        c.env,
        { id: site.id, slug: site.slug, currentBuildVersion: site.current_build_version ?? null },
        orgId,
        {
          draftRevision: body.draft_revision,
          treeDigest: body.tree_digest,
          commitSha: body.commit_sha ?? null,
          actor: c.get('userId') ?? null,
        },
      );
      log(c, 'promote.recorded', {
        siteId,
        draftRevision: body.draft_revision,
        outcome: result.outcome,
        idempotent: result.idempotent,
        releaseId: result.release.id,
      });
      return c.json(
        PromoteResponseSchema.parse({
          release: result.release,
          outcome: result.outcome,
          idempotent: result.idempotent,
        }),
        200,
      );
    } catch (err) {
      log(c, 'promote.error', {
        siteId,
        draftRevision: body.draft_revision,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json(
        { error: { code: 'INTERNAL_ERROR', message: 'Could not promote to Production' } },
        500,
      );
    }
  },
);
