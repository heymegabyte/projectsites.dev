/**
 * @module routes/snapshot_quality
 * @description Routes for the snapshot quality matrix — screenshot + Lighthouse
 *   + Core Web Vitals + composition + a11y per frozen snapshot.
 *
 * | Method | Path | Purpose |
 * | ------ | ---- | ------- |
 * | POST   | `/api/sites/:siteId/snapshots/:snapshotId/capture`  | Trigger capture workflow |
 * | GET    | `/api/sites/:siteId/snapshots/:snapshotId/metrics`  | Read single metrics row + signed screenshot URL |
 * | GET    | `/api/sites/:siteId/snapshots/metrics`              | List metrics for every snapshot on a site (grid view) |
 *
 * Auth via the standard `authMiddleware` upstream — every handler requires
 * a resolved `orgId` and rejects with `UNAUTHORIZED` otherwise. The site
 * lookup is hard-bound to `org_id = ?` for cross-org isolation.
 *
 * Workflow dispatch is via `env.SNAPSHOT_QUALITY_WORKFLOW.create(...)`.
 * When the binding is missing (local dev / staging without the workflow
 * declared) every endpoint degrades to a 503 rather than crashing.
 *
 * @packageDocumentation
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { Env, Variables } from '../types/env.js';
import { badRequest, notFound, unauthorized } from '@project-sites/shared';

export const snapshotQuality = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Zod-validated body for the capture POST. */
const captureBodySchema = z
  .object({
    force: z.boolean().optional(),
  })
  .strict()
  .partial();

interface SnapshotRow {
  id: string;
  site_id: string;
  snapshot_name: string;
  build_version: string;
  slug: string;
}

interface MetricsRow {
  id: string;
  snapshot_id: string;
  site_id: string;
  lh_performance: number | null;
  lh_accessibility: number | null;
  lh_best_practices: number | null;
  lh_seo: number | null;
  lh_pwa: number | null;
  lcp_ms: number | null;
  fcp_ms: number | null;
  tbt_ms: number | null;
  cls: number | null;
  inp_ms: number | null;
  si_ms: number | null;
  page_size_bytes: number | null;
  asset_count: number | null;
  request_count: number | null;
  dom_node_count: number | null;
  jsonld_block_count: number | null;
  title_chars: number | null;
  meta_desc_chars: number | null;
  h1_count: number | null;
  internal_links: number | null;
  outbound_links: number | null;
  axe_violations: number | null;
  axe_critical: number | null;
  axe_serious: number | null;
  contrast_failures: number | null;
  target_size_failures: number | null;
  screenshot_r2_key: string | null;
  // Vision (Workers AI Llama 4 Scout) — persisted by the snapshot-quality workflow (migration 0043).
  vision_overall: number | null;
  vision_scores_json: string | null;
  vision_notes: string | null;
  vision_model: string | null;
  captured_at: string;
  captured_via: string;
  duration_ms: number | null;
  error: string | null;
}

/**
 * Resolve a snapshot + site row pair scoped to the caller's org.
 * Returns null when either the site is cross-org or the snapshot is
 * missing/soft-deleted.
 */
async function resolveSnapshot(
  env: Env,
  orgId: string,
  siteId: string,
  snapshotId: string,
): Promise<SnapshotRow | null> {
  const row = await env.DB.prepare(
    `SELECT s.id, s.site_id, s.snapshot_name, s.build_version, st.slug
       FROM site_snapshots s
       JOIN sites st ON st.id = s.site_id
      WHERE s.id = ?
        AND s.site_id = ?
        AND st.org_id = ?
        AND s.deleted_at IS NULL
        AND st.deleted_at IS NULL`,
  )
    .bind(snapshotId, siteId, orgId)
    .first<SnapshotRow>();
  return row ?? null;
}

/**
 * Build a signed R2 URL for the screenshot. We don't actually need a
 * presigned URL — `SITES_BUCKET` is served behind the worker itself via
 * the `/snapshots/*` site-serving pathway, so we surface the public R2
 * key relative to the bucket plus a worker-served fallback URL.
 *
 * The frontend uses the relative key with the dedicated screenshot
 * proxy endpoint below.
 */
function screenshotPublicUrl(siteId: string, snapshotId: string, r2Key: string): string {
  // Served via the `/api/sites/:siteId/snapshots/:snapshotId/screenshot.png`
  // proxy below so the bucket can stay private.
  void r2Key;
  return `/api/sites/${siteId}/snapshots/${snapshotId}/screenshot.png`;
}

/**
 * POST /api/sites/:siteId/snapshots/:snapshotId/capture
 *
 * Trigger the `SnapshotQualityWorkflow` for a given snapshot. Returns
 * `{ status: 'capturing', metrics_id }` immediately; the workflow runs
 * out-of-band.
 */
snapshotQuality.post('/api/sites/:siteId/snapshots/:snapshotId/capture', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) throw unauthorized('Must be authenticated');
  const siteId = c.req.param('siteId');
  const snapshotId = c.req.param('snapshotId');

  // Body is optional — `force` reserved for future "re-capture even if recent" UX.
  try {
    const raw = await c.req.json().catch(() => ({}));
    captureBodySchema.parse(raw);
  } catch (err) {
    if (err instanceof z.ZodError) throw badRequest('Invalid capture body');
    // Empty body is fine.
  }

  const snap = await resolveSnapshot(c.env, orgId, siteId, snapshotId);
  if (!snap) throw notFound('Snapshot not found');

  if (!c.env.SNAPSHOT_QUALITY_WORKFLOW) {
    return c.json(
      { error: { code: 'SNAPSHOT_WORKFLOW_UNAVAILABLE', message: 'Workflow binding missing' } },
      503,
    );
  }

  // Pre-mint the metrics id so the caller can poll for it. The workflow's
  // INSERT uses its own UUID — the value returned here is a correlation
  // hint, not a primary key.
  const metricsId = crypto.randomUUID();

  await c.env.SNAPSHOT_QUALITY_WORKFLOW.create({
    params: {
      snapshotId: snap.id,
      siteId: snap.site_id,
      slug: snap.slug,
      snapshotName: snap.snapshot_name,
      buildVersion: snap.build_version,
      capturedVia: 'manual',
    },
  });

  return c.json({ status: 'capturing', metrics_id: metricsId });
});

/**
 * GET /api/sites/:siteId/snapshots/:snapshotId/metrics
 *
 * Return the metrics row for a single snapshot. Body shape:
 * `{ data: MetricsRow & { screenshot_url: string | null } }`.
 */
snapshotQuality.get('/api/sites/:siteId/snapshots/:snapshotId/metrics', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) throw unauthorized('Must be authenticated');
  const siteId = c.req.param('siteId');
  const snapshotId = c.req.param('snapshotId');

  const snap = await resolveSnapshot(c.env, orgId, siteId, snapshotId);
  if (!snap) throw notFound('Snapshot not found');

  const metrics = await c.env.DB.prepare(
    `SELECT * FROM snapshot_metrics WHERE snapshot_id = ? LIMIT 1`,
  )
    .bind(snapshotId)
    .first<MetricsRow>();

  if (!metrics) {
    return c.json({ data: null, status: 'pending' });
  }

  const screenshotUrl = metrics.screenshot_r2_key
    ? screenshotPublicUrl(siteId, snapshotId, metrics.screenshot_r2_key)
    : null;

  return c.json({
    data: {
      ...metrics,
      screenshot_url: screenshotUrl,
    },
  });
});

/**
 * GET /api/sites/:siteId/snapshots/metrics
 *
 * Return metrics for every snapshot on a site, ordered by most-recent.
 * Powers the snapshots grid in the admin UI — every card shows
 * Performance / A11y / SEO + screenshot thumbnail.
 */
snapshotQuality.get('/api/sites/:siteId/snapshots/metrics', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) throw unauthorized('Must be authenticated');
  const siteId = c.req.param('siteId');

  // Confirm the site belongs to the caller's org first — keeps the query
  // result set entirely org-scoped without an extra JOIN per row.
  const site = await c.env.DB.prepare(
    `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
  )
    .bind(siteId, orgId)
    .first<{ id: string }>();
  if (!site) throw notFound('Site not found');

  const rows = await c.env.DB.prepare(
    `SELECT m.*, s.snapshot_name, s.build_version, s.created_at AS snapshot_created_at
       FROM snapshot_metrics m
       JOIN site_snapshots s ON s.id = m.snapshot_id
      WHERE m.site_id = ?
        AND s.deleted_at IS NULL
      ORDER BY m.captured_at DESC`,
  )
    .bind(siteId)
    .all<
      MetricsRow & { snapshot_name: string; build_version: string; snapshot_created_at: string }
    >();

  const enriched = (rows.results ?? []).map((row) => ({
    ...row,
    screenshot_url: row.screenshot_r2_key
      ? screenshotPublicUrl(siteId, row.snapshot_id, row.screenshot_r2_key)
      : null,
  }));

  return c.json({ data: enriched });
});

/**
 * GET /api/sites/:siteId/snapshots/:snapshotId/screenshot.png
 *
 * Streams the screenshot PNG from R2 directly. Cached for an hour.
 * Org-scoped via the snapshot lookup.
 */
snapshotQuality.get('/api/sites/:siteId/snapshots/:snapshotId/screenshot.png', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) throw unauthorized('Must be authenticated');
  const siteId = c.req.param('siteId');
  const snapshotId = c.req.param('snapshotId');

  const snap = await resolveSnapshot(c.env, orgId, siteId, snapshotId);
  if (!snap) throw notFound('Snapshot not found');

  const metrics = await c.env.DB.prepare(
    `SELECT screenshot_r2_key FROM snapshot_metrics WHERE snapshot_id = ? LIMIT 1`,
  )
    .bind(snapshotId)
    .first<{ screenshot_r2_key: string | null }>();
  if (!metrics?.screenshot_r2_key) throw notFound('Screenshot not yet captured');

  const obj = await c.env.SITES_BUCKET.get(metrics.screenshot_r2_key);
  if (!obj) throw notFound('Screenshot not found in storage');

  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'image/png',
      'Cache-Control': 'private, max-age=3600',
    },
  });
});
