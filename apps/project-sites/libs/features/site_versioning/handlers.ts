/**
 * @module libs/features/site_versioning/handlers
 *
 * @description
 * Hono routes for a site's **version history** — the named-snapshot rollback
 * points (D1 `site_snapshots`) and the R2-stored git-style commit chain, plus
 * a client-assembled snapshot download manifest. Every route is org-scoped via
 * `c.get('orgId')` and guards site ownership through `requireOwnedSite` (404,
 * never 403, on a missing/foreign site so cross-org sites never leak). Snapshots
 * are sparse user-named save-points; git commits are the dense per-build
 * timeline — the two are intentionally disjoint (see the list route's remarks).
 *
 * | Method | Path                                              | Auth  | Purpose                                            |
 * | ------ | ------------------------------------------------- | ----- | -------------------------------------------------- |
 * | GET    | /api/sites/:siteId/snapshots                      | orgId | List D1 snapshots + R2 git history                 |
 * | GET    | /api/sites/:siteId/snapshots/diff                 | orgId | Side-by-side file diff between two snapshots (+AI)  |
 * | POST   | /api/sites/:siteId/snapshots                      | orgId | Freeze current/specified build as a named snapshot  |
 * | DELETE | /api/sites/:siteId/snapshots/:snapshotId          | orgId | Soft-delete a snapshot row (R2 files survive 30d)   |
 * | POST   | /api/sites/:siteId/snapshots/revert               | orgId | Forward-rolling revert to an R2 git commit          |
 * | POST   | /api/sites/:siteId/snapshots/:snapshotId/restore  | orgId | Re-point live build to a snapshot's frozen version  |
 * | GET    | /api/sites/:siteId/git/history                    | orgId | Walk the R2 git commit chain from HEAD              |
 * | GET    | /api/sites/:siteId/git/diff                       | orgId | Diff two commits in the R2 git chain                |
 * | GET    | /api/sites/:siteId/git/commits/:commitId          | orgId | Read one commit's metadata + file list              |
 * | GET    | /api/sites/:id/snapshots/:snapId/download          | orgId | JSON download manifest of a snapshot's R2 files     |
 *
 * Extracted VERBATIM from the `api.ts` monolith (route-decomposition installment
 * 9) — only the route-registration receiver changed (`api.` → `siteVersioning.`);
 * the handler bodies are byte-for-byte unchanged. Bodies are read via a raw
 * `as {…}` cast (revert/create bodies) rather than a Zod schema at the boundary,
 * so there is no `schemas.ts` — the moved handlers keep their original in-body
 * validation. The private `guessContentTypeForRevert` helper moved alongside the
 * revert handler (its only caller). Dynamic ESM imports (`../../../src/services/{db,git,snapshot_restore}.js`
 * + `diff`) keep the git/diff modules out of the hot-path API bundle. Known
 * AppErrors (`unauthorized`/`badRequest`/`notFound`/`conflict`/`internalError`)
 * propagate to the app-level error handler.
 *
 * @packageDocumentation
 */

import { Hono } from 'hono';
import {
  DOMAINS,
  badRequest,
  conflict,
  internalError,
  notFound,
  unauthorized,
} from '@project-sites/shared';
import type { Env, Variables } from '../../../src/types/env.js';
import { dbQueryOne } from '../../../src/services/db.js';
import { requireOwnedSite } from '../../../src/services/site_ownership.js';
import * as auditService from '../../../src/services/audit.js';

type AppContext = { Bindings: Env; Variables: Variables };

export const siteVersioning = new Hono<AppContext>();

/**
 * List the named-snapshot rollback points for a site, paired with the
 * underlying git-style commit history pulled from R2. Snapshots are
 * named freezes ("initial", "before-redesign", "v2-launch") that the
 * UI lets a user restore from with one click; git history is the raw
 * per-build commit trail kept for forensic comparison.
 *
 * @route GET /api/sites/:siteId/snapshots
 * @auth Bearer orgId required — cross-org access collapses to 404.
 * @returns 200 OK `{ data: SiteSnapshot[], git_history: GitCommit[] }`.
 *   Snapshots ordered DESC by `created_at`. `git_history` includes
 *   `{ sha, message, date, author, fileCount, buildVersion? }` from
 *   the R2-backed git store.
 * @throws UNAUTHORIZED — missing Bearer token.
 *
 * @remarks
 * Dual-source merge intentionally NOT joined into a single timeline
 * because snapshots and commits have different semantics: snapshots
 * are intentional UI-driven save-points (sparse, user-named); commits
 * are automatic per-build (dense, AI-generated messages). The frontend
 * renders them in separate columns so the user can pick the right
 * rollback granularity.
 *
 * Soft-delete predicate `deleted_at IS NULL` excludes snapshots a user
 * has explicitly cleaned up — the underlying R2 files survive longer
 * (sweeper job reclaims R2 keys 30 days after D1 soft-delete) so
 * restoring a "deleted" snapshot is still possible during the grace
 * window via direct R2 access.
 *
 * Dynamic ESM import (`await import('../../../src/services/db.js')`) keeps the
 * git module out of the hot-path API bundle — only loaded when this
 * route fires, which is rare relative to site-serving traffic.
 */
siteVersioning.get('/api/sites/:siteId/snapshots', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) throw unauthorized('Must be authenticated');
  const siteId = c.req.param('siteId');

  // Look up site slug for git history. Canonical org-ownership guard — 404 on
  // missing/foreign (was a latent 500: site.slug below has no null guard).
  const site = await requireOwnedSite<{ slug: string }>(c.env, orgId, siteId, 'slug');

  const { dbQuery: dbq } = await import('../../../src/services/db.js');
  const result = await dbq<{
    id: string;
    snapshot_name: string;
    build_version: string;
    description: string | null;
    created_at: string;
  }>(
    c.env.DB,
    'SELECT id, snapshot_name, build_version, description, created_at FROM site_snapshots WHERE site_id = ? AND deleted_at IS NULL ORDER BY created_at DESC',
    [siteId],
  );

  // Also fetch git commit history if site exists
  let gitHistory: Array<{
    sha: string;
    message: string;
    date: string;
    author: string;
    fileCount: number;
    buildVersion?: string;
  }> = [];
  if (site) {
    const { getHistory } = await import('../../../src/services/git.js');
    try {
      gitHistory = await getHistory(c.env.SITES_BUCKET, site.slug);
    } catch {
      // A broken git store must never fail the snapshot list — the D1 rows are
      // the source of truth for the list itself; `commit_iso` degrades to each
      // row's own `created_at` (accurate to within seconds for UI snapshots,
      // since the GitHub push fires right after the D1 insert).
      gitHistory = [];
    }
  }

  // Surface `commit_iso` per row: `build_version` IS the R2 version path, so it
  // is the join key against `gitHistory[].buildVersion`. A match means the git
  // entry's `date` is the authoritative commit timestamp; otherwise the row's
  // own `created_at` is the correct fallback.
  const data = result.data.map((row) => ({
    ...row,
    commit_iso:
      gitHistory.find((entry) => entry.buildVersion === row.build_version)?.date ??
      row.created_at,
  }));

  return c.json({ data, git_history: gitHistory });
});

/**
 * Side-by-side diff between two snapshots of the same site.
 *
 * Resolves each snapshot's build manifest from R2 (`sites/{slug}/{build_version}/`),
 * enumerates the union of files, classifies each as added / removed / modified,
 * and returns line-level hunks for modified files via the `diff.diffLines`
 * algorithm. An AI-summary header (1-2 sentences of "what changed") is
 * generated by `@cf/meta/llama-3.3-70b-instruct-fp8-fast` over the file list
 * so reviewers can scan the intent of a snapshot in seconds.
 *
 * @route GET /api/sites/:siteId/snapshots/diff?from=A&to=B
 * @auth Bearer orgId required — cross-org access collapses to 404.
 * @returns 200 OK with
 *   `{ added: [{path, contents}],`
 *   ` removed: [{path, contents}],`
 *   ` modified: [{path, before, after, hunks: [{added, removed, value}]}],`
 *   ` summary: string }`
 * @throws BAD_REQUEST — missing `from` or `to` query, or `from === to`.
 * @throws NOT_FOUND — site not found or either snapshot missing.
 *
 * @remarks
 * Only text-y files are diffed (extensions in `DIFF_TEXT_EXTS`); binary files
 * (PNG/JPG/WebP/ICO/woff2/PDF) report classification without contents so the
 * UI can show "binary file changed" without shipping megabytes back to the
 * client. Each file body is capped at 256KB to keep response payloads
 * bounded even for large refactors. Files larger than the cap are reported
 * as `truncated: true`.
 *
 * AI summary is best-effort — if the Workers AI call errors, the route still
 * returns the structural diff with `summary: ''`. Never block the diff on the
 * narrative.
 */
siteVersioning.get('/api/sites/:siteId/snapshots/diff', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) throw unauthorized('Must be authenticated');
  const siteId = c.req.param('siteId');
  const fromId = c.req.query('from');
  const toId = c.req.query('to');

  if (!fromId || !toId) throw badRequest('Both `from` and `to` snapshot ids are required');
  if (fromId === toId) throw badRequest('`from` and `to` must be different snapshots');

  // Canonical org-ownership guard: 404 (never 403) so cross-org sites don't leak.
  const site = await requireOwnedSite<{ slug: string }>(c.env, orgId, siteId, 'slug');

  const { dbQueryOne: dbq1 } = await import('../../../src/services/db.js');
  const [fromSnap, toSnap] = await Promise.all([
    dbq1<{ id: string; build_version: string; snapshot_name: string }>(
      c.env.DB,
      'SELECT id, build_version, snapshot_name FROM site_snapshots WHERE id = ? AND site_id = ? AND deleted_at IS NULL',
      [fromId, siteId],
    ),
    dbq1<{ id: string; build_version: string; snapshot_name: string }>(
      c.env.DB,
      'SELECT id, build_version, snapshot_name FROM site_snapshots WHERE id = ? AND site_id = ? AND deleted_at IS NULL',
      [toId, siteId],
    ),
  ]);
  if (!fromSnap || !toSnap) throw notFound('Snapshot not found');

  // Bounded text-file allow-list. Binary assets (images, fonts, pdfs) report
  // membership but skip body load — keeps the response under 10MB even for
  // 200-file diffs that include hero images on both sides.
  const DIFF_TEXT_EXTS = new Set([
    'html',
    'htm',
    'css',
    'scss',
    'sass',
    'js',
    'mjs',
    'cjs',
    'ts',
    'tsx',
    'jsx',
    'json',
    'md',
    'txt',
    'xml',
    'svg',
    'yml',
    'yaml',
    'toml',
    'webmanifest',
  ]);
  const MAX_FILE_BYTES = 256 * 1024;

  const fromPrefix = `sites/${site.slug}/${fromSnap.build_version}/`;
  const toPrefix = `sites/${site.slug}/${toSnap.build_version}/`;

  async function listKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await c.env.SITES_BUCKET.list({ prefix, cursor, limit: 1000 });
      for (const obj of page.objects) keys.push(obj.key.slice(prefix.length));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return keys;
  }

  async function loadText(
    prefix: string,
    path: string,
  ): Promise<{ value: string; truncated: boolean } | null> {
    const obj = await c.env.SITES_BUCKET.get(prefix + path);
    if (!obj) return null;
    if (obj.size > MAX_FILE_BYTES) {
      const stream = obj.body.getReader();
      const { value: chunk } = await stream.read();
      try {
        stream.cancel();
      } catch {
        /* noop */
      }
      const decoded = chunk ? new TextDecoder().decode(chunk).slice(0, MAX_FILE_BYTES) : '';
      return { value: decoded, truncated: true };
    }
    return { value: await obj.text(), truncated: false };
  }

  const [fromKeys, toKeys] = await Promise.all([listKeys(fromPrefix), listKeys(toPrefix)]);
  const fromSet = new Set(fromKeys);
  const toSet = new Set(toKeys);
  const allKeys = new Set([...fromKeys, ...toKeys]);

  const { diffLines } = await import('diff');

  type Hunk = { added: boolean; removed: boolean; value: string };
  type Modified = {
    path: string;
    before: string;
    after: string;
    hunks: Hunk[];
    truncated: boolean;
  };
  type Plain = { path: string; contents: string; binary: boolean; truncated: boolean };

  const added: Plain[] = [];
  const removed: Plain[] = [];
  const modified: Modified[] = [];

  await Promise.all(
    Array.from(allKeys).map(async (path) => {
      const ext = path.split('.').pop()?.toLowerCase() ?? '';
      const isText = DIFF_TEXT_EXTS.has(ext);
      const inFrom = fromSet.has(path);
      const inTo = toSet.has(path);

      if (inFrom && !inTo) {
        const body = isText ? await loadText(fromPrefix, path) : null;
        removed.push({
          path,
          contents: body?.value ?? '',
          binary: !isText,
          truncated: body?.truncated ?? false,
        });
      } else if (!inFrom && inTo) {
        const body = isText ? await loadText(toPrefix, path) : null;
        added.push({
          path,
          contents: body?.value ?? '',
          binary: !isText,
          truncated: body?.truncated ?? false,
        });
      } else if (inFrom && inTo && isText) {
        const [b, a] = await Promise.all([loadText(fromPrefix, path), loadText(toPrefix, path)]);
        const before = b?.value ?? '';
        const after = a?.value ?? '';
        if (before === after) return;
        const hunks: Hunk[] = diffLines(before, after).map((part) => ({
          added: !!part.added,
          removed: !!part.removed,
          value: part.value,
        }));
        modified.push({
          path,
          before,
          after,
          hunks,
          truncated: (b?.truncated ?? false) || (a?.truncated ?? false),
        });
      }
    }),
  );

  // AI summary header — best effort. The model only sees file paths +
  // classification (no contents), so the call is cheap and bounded.
  let summary = '';
  try {
    const fileList = [
      ...added.map((f) => `+ ${f.path}`),
      ...removed.map((f) => `- ${f.path}`),
      ...modified.map((f) => `~ ${f.path}`),
    ].slice(0, 80);
    const prompt = `You are a senior code reviewer summarizing a website-snapshot diff.\nSnapshots: "${fromSnap.snapshot_name}" -> "${toSnap.snapshot_name}".\nFiles (+ added, - removed, ~ modified):\n${fileList.join('\n')}\n\nWrite ONE paragraph (max 2 sentences) describing what likely changed at a high level. No bullet list, no preamble.`;
    const ai = c.env.AI as unknown as {
      run: (
        model: string,
        input: { messages: Array<{ role: string; content: string }>; max_tokens?: number },
      ) => Promise<{ response?: string }>;
    };
    const res = await ai.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 180,
    });
    summary = (res?.response ?? '').trim();
  } catch (err) {
    console.warn('snapshot-diff: ai summary failed', { error: String(err) });
    summary = '';
  }

  return c.json({
    from: { id: fromSnap.id, name: fromSnap.snapshot_name, build_version: fromSnap.build_version },
    to: { id: toSnap.id, name: toSnap.snapshot_name, build_version: toSnap.build_version },
    added,
    removed,
    modified,
    summary,
  });
});

/**
 * Freeze the current (or a specified) build version as a named
 * snapshot so it can be served at the `{slug}-{snapshot}.projectsites.dev`
 * preview subdomain and restored to "current" with one click later.
 *
 * @route POST /api/sites/:siteId/snapshots
 * @auth Bearer orgId required — cross-org access collapses to 404.
 * @body application/json `{ name: string, description?: string, build_version?: string }`.
 *   `name` mandatory; normalized to URL-safe slug (lowercase, alnum
 *   only, max 30 chars). `build_version` optional override — defaults
 *   to the site's `current_build_version`.
 * @returns 200 OK `{ data: SiteSnapshot }` — the inserted row.
 * @throws UNAUTHORIZED — missing Bearer token.
 * @throws BAD_REQUEST — name missing OR name normalized to empty
 *   (e.g. all special chars stripped).
 *
 * @remarks
 * Slug normalization rules:
 * 1. Trim + lowercase.
 * 2. Replace any non-`[a-z0-9]` run with single `-`.
 * 3. Strip leading/trailing hyphens.
 * 4. Truncate to 30 chars.
 *
 * Hard cap chosen because the snapshot slug appears in subdomain DNS
 * (`{site-slug}-{snapshot-slug}.projectsites.dev`) where the total
 * label is capped at 63 chars per RFC 1035 — 30 + site-slug + `-` +
 * suffix fits even for 30-char site slugs.
 *
 * First snapshot per site is conventionally named `"initial"` and
 * auto-created at site-creation time so users always have a baseline
 * rollback target.
 */
siteVersioning.post('/api/sites/:siteId/snapshots', async (c) => {
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  if (!orgId) throw unauthorized('Must be authenticated');
  const siteId = c.req.param('siteId');
  const body = (await c.req.json().catch(() => ({}))) as {
    name: string;
    description?: string;
    build_version?: string;
  };

  if (!body.name?.trim()) {
    throw badRequest('Snapshot name is required');
  }

  // Normalize snapshot name to URL-safe slug
  const snapshotName = body.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 30);
  if (!snapshotName || snapshotName.length < 1) {
    throw badRequest('Invalid snapshot name');
  }

  // Canonical org-ownership guard — 404 (was badRequest 400, the wrong status for a
  // missing/foreign site; 404 never 403 per the fires 30-36 protocol).
  const site = await requireOwnedSite<{ current_build_version: string | null; slug: string }>(
    c.env,
    orgId,
    siteId,
    'current_build_version, slug',
  );

  const buildVersion = body.build_version || site.current_build_version;
  if (!buildVersion) {
    throw badRequest('Site has no published version to snapshot');
  }

  // Verify the version exists in R2
  const r2Check = await c.env.SITES_BUCKET.head(`sites/${site.slug}/${buildVersion}/index.html`);
  if (!r2Check) {
    throw badRequest('Build version not found in storage');
  }

  const { dbInsert: dbIns } = await import('../../../src/services/db.js');
  const id = crypto.randomUUID();
  const snapIns = await dbIns(c.env.DB, 'site_snapshots', {
    id,
    site_id: siteId,
    snapshot_name: snapshotName,
    build_version: buildVersion,
    description: body.description || null,
    created_by: userId || null,
  });
  // UNIQUE(site_id, snapshot_name): an ignored error here was a lying-success — a
  // duplicate name returned 200 with NOTHING persisted AND still fired the quality
  // workflow below. Surface it as a 409 so the caller picks another name.
  if (snapIns.error) {
    throw conflict(`A snapshot named '${snapshotName}' already exists for this site`);
  }

  const snapshotUrl = `https://${site.slug}-${snapshotName}${DOMAINS.SITES_SUFFIX}`;

  c.executionCtx.waitUntil(
    auditService.writeAuditLog(c.env.DB, {
      org_id: orgId,
      actor_id: userId ?? null,
      action: 'site.snapshot.created',
      message: `Snapshot '${snapshotName}' created on '${site.slug}' (build version '${buildVersion}')`,
      target_type: 'site_snapshot',
      target_id: id,
      metadata_json: {
        site_id: siteId,
        slug: site.slug,
        snapshot_name: snapshotName,
        build_version: buildVersion,
      },
      request_id: c.get('requestId'),
    }),
  );

  // Auto-fire the snapshot quality workflow so every newly-frozen snapshot
  // gets its quality matrix captured without a separate user step.
  // Best-effort — silently no-ops when the binding isn't bound (local dev).
  if (c.env.SNAPSHOT_QUALITY_WORKFLOW) {
    c.executionCtx.waitUntil(
      c.env.SNAPSHOT_QUALITY_WORKFLOW.create({
        params: {
          snapshotId: id,
          siteId,
          slug: site.slug,
          snapshotName,
          buildVersion,
          capturedVia: 'workflow',
        },
      }).catch((err: unknown) => {
        console.warn(
          JSON.stringify({
            level: 'warn',
            service: 'snapshot-quality',
            message: 'auto-fire on snapshot create failed',
            snapshot_id: id,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }),
    );
  }

  return c.json(
    {
      data: {
        id,
        snapshot_name: snapshotName,
        build_version: buildVersion,
        url: snapshotUrl,
      },
    },
    201,
  );
});

/**
 * Soft-delete a named D1 snapshot (the user-saved row), not the underlying
 * R2 build files. The associated build version remains in
 * `sites/{slug}/{version}/` on R2 for a 30-day grace window so a deletion
 * is recoverable for ~a month via direct R2 fetch + a fresh snapshot row
 * pointing at the same version. After 30 days the R2 sweeper reclaims the
 * orphaned version path.
 *
 * @route DELETE /api/sites/:siteId/snapshots/:snapshotId
 * @auth Bearer token (org-scoped)
 *
 * @param siteId     - URL param. Site UUID (present for URL symmetry — not
 *   used in the WHERE clause because `snapshotId` is globally unique. A
 *   wrong `siteId` plus a real `snapshotId` still soft-deletes the row).
 * @param snapshotId - URL param. Snapshot UUID. Idempotent: deleting an
 *   already-deleted snapshot returns 200 (D1 UPDATE matches 0 rows but
 *   doesn't throw).
 *
 * @returns 200 with `{ data: { deleted: true } }`.
 *
 * @remarks
 * Soft-delete via `deleted_at = NOW()` so the snapshot can be force-undeleted
 * with a direct D1 query during the grace window (`UPDATE site_snapshots
 * SET deleted_at = NULL WHERE id = ?`). After the R2 sweeper runs, the
 * snapshot is restorable only from R2 git history (see `GET /api/sites/
 * :siteId/git/history`).
 *
 * Hard-delete is intentionally NOT exposed via API — would orphan R2 build
 * files and leave the published version pointer hanging. The R2 sweeper
 * handles physical reclamation on a background schedule.
 *
 * Cross-org guard is implicit: `snapshotId` is a UUID, so brute-force
 * deletion-by-guessing is computationally infeasible. We intentionally
 * skip the JOIN to `sites` for performance.
 *
 * @throws {AppError} 401 UNAUTHORIZED — missing/invalid Bearer.
 *
 * @example
 * ```bash
 * curl -X DELETE \
 *   -H "Authorization: Bearer $TOKEN" \
 *   https://projectsites.dev/api/sites/$SITE_ID/snapshots/$SNAPSHOT_ID
 * # → 200 { "data": { "deleted": true } }
 * ```
 */
siteVersioning.delete('/api/sites/:siteId/snapshots/:snapshotId', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) throw unauthorized('Must be authenticated');
  const siteId = c.req.param('siteId');
  const snapshotId = c.req.param('snapshotId');

  const { dbQueryOne: dbq1, dbUpdate: dbUpd } = await import('../../../src/services/db.js');
  // Org-ownership guard (IDOR fix): the snapshot must belong to a site owned by the
  // caller's org. The prior query filtered on `id` ALONE — any authed user could
  // soft-delete ANY org's snapshot by id. Scope via the sites join; 404 (never 403)
  // when not-found-or-not-owned. Capture the update result (dbUpdate never throws) so
  // a failed delete can't return a lying `{ deleted: true }`.
  const snap = await dbq1<{ snapshot_name: string }>(
    c.env.DB,
    `SELECT ss.snapshot_name FROM site_snapshots ss
       JOIN sites s ON s.id = ss.site_id
      WHERE ss.id = ? AND ss.site_id = ? AND s.org_id = ? AND ss.deleted_at IS NULL`,
    [snapshotId, siteId, orgId],
  );
  if (!snap) throw notFound('Snapshot not found');
  const del = await dbUpd(
    c.env.DB,
    'site_snapshots',
    { deleted_at: new Date().toISOString() },
    'id = ? AND site_id = ?',
    [snapshotId, siteId],
  );
  if (del.error) throw internalError(`Snapshot delete failed: ${del.error}`);

  const siteLabel = await auditService.auditSiteLabelDb(c.env.DB, siteId);
  c.executionCtx.waitUntil(
    auditService.writeAuditLog(c.env.DB, {
      org_id: orgId,
      actor_id: c.get('userId') ?? null,
      action: 'site.snapshot.deleted',
      message: `Snapshot '${snap?.snapshot_name ?? snapshotId}' deleted from site '${siteLabel}'`,
      target_type: 'site_snapshot',
      target_id: snapshotId,
      metadata_json: { site_id: siteId, snapshot_name: snap?.snapshot_name ?? null },
      request_id: c.get('requestId'),
    }),
  );

  return c.json({ data: { deleted: true } });
});

/**
 * Revert a site to an earlier R2 git snapshot, creating a forward-rolling
 * "revert commit" rather than rewriting history. The original commits
 * remain intact in the chain — undoing the revert is itself a revert.
 *
 * @route POST /api/sites/:siteId/snapshots/revert
 * @auth Bearer token (org-scoped)
 *
 * @body {{ commit_id: string }} - SHA-like commit identifier from
 *   `GET /api/sites/:siteId/git/history`. Trimmed and required.
 *
 * @returns 200 with `{ data: { commit_id, version, files_restored,
 *   snapshot_id } }`. `commit_id` is the NEW revert-commit SHA (not the
 *   target). `version` is the new R2 path component (`v${Date.now()}`).
 *   `snapshot_id` is the D1 row tagged `revert-{first-8-chars}`.
 *
 * @remarks
 * Four-stage flow (all stages must succeed or partial state is left for
 * the next call to clean up):
 * 1. **Git revert** — `revertToSnapshot()` reads the target commit's
 *    file blobs from R2, computes the forward-rolling revert commit, and
 *    writes the new commit object to R2 git history.
 * 2. **R2 publish** — `Promise.all(r2.put())` uploads every reverted file
 *    to `sites/{slug}/{version}/{filename}` with derived content-types.
 *    Latency = slowest file (parallel writes).
 * 3. **Manifest + D1 pointer flip** — write `_manifest.json` with the new
 *    version + ISO timestamp, then atomic D1 UPDATE flipping
 *    `current_build_version` and setting `status='published'`. Once D1
 *    commits, public traffic immediately serves the reverted version on
 *    next KV miss (cache TTL 60s).
 * 4. **D1 snapshot row + audit log** — insert `site_snapshots` row tagged
 *    `revert-{first-8-chars-of-target-commit}` so the revert is itself
 *    listable + revertable.
 *
 * Cache invalidation: best-effort KV delete on `host:{slug}{SITES_SUFFIX}`
 * (silently swallowed via `.catch(() => {})`). Worst case: 60s of stale
 * served pages before TTL expiry.
 *
 * No locking — concurrent reverts on the same site will both succeed but
 * the second-committer wins the D1 pointer race. Acceptable because (a)
 * revert is a rare/manual operation and (b) the losing commit is still
 * in R2 git history and listable as a snapshot.
 *
 * @throws {AppError} 400 BAD_REQUEST — `commit_id` missing or empty.
 * @throws {AppError} 401 UNAUTHORIZED — missing/invalid Bearer.
 * @throws {AppError} 404 NOT_FOUND — site does not exist in caller's org.
 * @throws {Error} - Bubbles from `revertToSnapshot()` when target commit
 *   doesn't exist in R2 git history. R2 .put() errors during stage 2 leave
 *   partial files at `sites/{slug}/{version}/` — these get orphaned but
 *   are harmless because the manifest is written only after all uploads
 *   succeed.
 *
 * @example
 * ```bash
 * # 1. List history to find target commit
 * curl -H "Authorization: Bearer $TOKEN" \
 *   https://projectsites.dev/api/sites/$SITE_ID/git/history
 * # → [{ id: "a1b2c3d4...", message: "...", timestamp: "..." }, ...]
 *
 * # 2. Revert to chosen commit
 * curl -X POST -H "Authorization: Bearer $TOKEN" \
 *   -H "Content-Type: application/json" \
 *   -d '{ "commit_id": "a1b2c3d4..." }' \
 *   https://projectsites.dev/api/sites/$SITE_ID/snapshots/revert
 * # → { data: { commit_id: "newSHA...", version: "v1735012345678",
 * #            files_restored: 42, snapshot_id: "uuid..." } }
 * ```
 */
siteVersioning.post('/api/sites/:siteId/snapshots/revert', async (c) => {
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  if (!orgId) throw unauthorized('Must be authenticated');
  const siteId = c.req.param('siteId');
  const body = (await c.req.json().catch(() => ({}))) as { commit_id: string };

  if (!body.commit_id?.trim()) {
    throw badRequest('commit_id is required');
  }

  // Verify site ownership (404 never 403 — fires 30-36 protocol).
  const site = await requireOwnedSite<{ slug: string; current_build_version: string | null }>(
    c.env,
    orgId,
    siteId,
    'slug, current_build_version',
  );

  // Perform the revert via git service
  const { revertToSnapshot } = await import('../../../src/services/git.js');
  const result = await revertToSnapshot(
    c.env.SITES_BUCKET,
    site.slug,
    body.commit_id.trim(),
    userId ?? 'unknown',
  );

  // Deploy reverted files to a new R2 version path
  const version = `v${Date.now()}`;
  const uploadPromises = result.files.map((f) =>
    c.env.SITES_BUCKET.put(`sites/${site.slug}/${version}/${f.name}`, f.content, {
      httpMetadata: { contentType: guessContentTypeForRevert(f.name) },
    }),
  );
  await Promise.all(uploadPromises);

  // Update manifest
  const manifest = {
    current_version: version,
    updated_at: new Date().toISOString(),
    files: result.files.map((f) => `sites/${site.slug}/${version}/${f.name}`),
  };
  await c.env.SITES_BUCKET.put(`sites/${site.slug}/_manifest.json`, JSON.stringify(manifest), {
    httpMetadata: { contentType: 'application/json' },
  });

  await c.env.DB.prepare(
    "UPDATE sites SET current_build_version = ?, status = 'published', updated_at = datetime('now') WHERE id = ?",
  )
    .bind(version, siteId)
    .run();

  // Create a D1 snapshot record for the revert
  const { dbInsert: dbIns } = await import('../../../src/services/db.js');
  const snapshotId = crypto.randomUUID();
  const revertSnap = await dbIns(c.env.DB, 'site_snapshots', {
    id: snapshotId,
    site_id: siteId,
    snapshot_name: `revert-${body.commit_id.substring(0, 8)}`,
    build_version: version,
    description: `Reverted to commit ${body.commit_id.substring(0, 8)}`,
    created_by: userId || null,
  });
  if (revertSnap.error)
    console.warn('[revert] snapshot record insert failed (non-blocking):', revertSnap.error);

  // Invalidate KV cache
  await c.env.CACHE_KV.delete(`host:${site.slug}${DOMAINS.SITES_SUFFIX}`).catch(() => {});

  // Audit log
  await auditService
    .writeAuditLog(c.env.DB, {
      org_id: orgId,
      actor_id: userId ?? null,
      action: 'site.snapshot.reverted',
      message: `Reverted to snapshot commit '${body.commit_id.slice(0, 8)}' on '${site.slug}' (${result.files.length} files restored)`,
      target_type: 'site',
      target_id: siteId,
      metadata_json: {
        commit_id: body.commit_id,
        new_commit_id: result.commitId,
        new_version: version,
        files_restored: result.files.length,
        slug: site.slug,
      },
      request_id: c.get('requestId'),
    })
    .catch(() => {});

  return c.json({
    data: {
      commit_id: result.commitId,
      version,
      files_restored: result.files.length,
      snapshot_id: snapshotId,
    },
  });
});

/**
 * Restore a site to one of its named D1 `site_snapshots` by re-pointing the
 * live build version to the snapshot's frozen `build_version`.
 *
 * The clean fix for the broken revert contract: the frontend already holds the
 * `snapshot_id`, and the D1 snapshot timeline is disjoint from the R2-git
 * `commit_id` timeline the legacy `POST /snapshots/revert` consumes. Reversible
 * (the prior version's R2 files remain) and org-scoped via `restoreSnapshot`.
 *
 * @route POST /api/sites/:siteId/snapshots/:snapshotId/restore
 * @auth Bearer token (org-scoped)
 * @returns 200 `{ data: { version, slug, snapshot_id } }` on success; 404 when
 *   the snapshot/site is missing or not owned by the caller's org.
 */
siteVersioning.post('/api/sites/:siteId/snapshots/:snapshotId/restore', async (c) => {
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  if (!orgId) throw unauthorized('Must be authenticated');
  const siteId = c.req.param('siteId');
  const snapshotId = c.req.param('snapshotId');

  const { restoreSnapshot } = await import('../../../src/services/snapshot_restore.js');
  const result = await restoreSnapshot(c.env, {
    siteId,
    orgId,
    snapshotId,
    userId: userId ?? null,
    requestId: c.get('requestId'),
  });
  if (!result.ok) throw notFound(result.error ?? 'Snapshot not found');

  return c.json({
    data: { version: result.version, slug: result.slug, snapshot_id: snapshotId },
  });
});

/**
 * List the R2-stored git commit chain for a site, walking backwards from
 * HEAD. This is the AI-generated dense timeline (one entry per build),
 * intentionally separate from the sparse user-named D1 `site_snapshots`
 * timeline at `GET /api/sites/:siteId/snapshots`.
 *
 * @route GET /api/sites/:siteId/git/history
 * @auth Bearer token (org-scoped)
 *
 * @queryParam depth - Optional. How many commits to walk backward from
 *   HEAD. Defaults to 20, capped at 100 (`Math.min(depth, 100)`) to bound
 *   R2 reads. Pagination beyond 100 not yet exposed.
 *
 * @returns 200 with `{ data: [{ id, parent, message, timestamp, author,
 *   files: [{ path, size }] }, ...] }`. Empty array if site has no
 *   committed builds (e.g. site row exists but workflow never completed).
 *
 * @remarks
 * Reads from R2 at `sites/{slug}/.git/` (file-system-on-R2 git
 * implementation in `services/git.ts`). Each commit object is a separate
 * R2 key, so depth=N implies ~N R2 reads (refs cached in memory during
 * the walk). Latency scales linearly with depth.
 *
 * Dynamic import keeps the git module out of the API hot-path bundle
 * because git ops are <1% of API traffic. Trade-off: first-call latency
 * +5-10ms.
 *
 * @throws {AppError} 401 UNAUTHORIZED — missing/invalid Bearer.
 * @throws {AppError} 404 NOT_FOUND — site does not exist in caller's org.
 *
 * @example
 * ```bash
 * curl -H "Authorization: Bearer $TOKEN" \
 *   "https://projectsites.dev/api/sites/$SITE_ID/git/history?depth=10"
 * # → { data: [
 * #     { id: "a1b2...", parent: "9z8y...", message: "build via workflow",
 * #       timestamp: "2026-05-11T14:23:01Z", author: "system", files: [...] },
 * #     ...
 * #   ] }
 * ```
 *
 * @see {@link GET /api/sites/:siteId/git/diff} for comparing two commits.
 * @see {@link POST /api/sites/:siteId/snapshots/revert} for rollback.
 */
siteVersioning.get('/api/sites/:siteId/git/history', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) throw unauthorized('Must be authenticated');
  const siteId = c.req.param('siteId');
  const depth = parseInt(c.req.query('depth') ?? '20', 10);

  // Canonical org-ownership guard: 404 (never 403) so cross-org sites don't leak.
  const site = await requireOwnedSite<{ slug: string }>(c.env, orgId, siteId, 'slug');

  const { getHistory } = await import('../../../src/services/git.js');
  const history = await getHistory(c.env.SITES_BUCKET, site.slug, Math.min(depth, 100));

  return c.json({ data: history });
});

/**
 * Diff two commits in the site's R2 git chain. Per-file change list with
 * added/removed/modified status — useful for the snapshot-revert UI
 * "what would this revert change?" preview, or for audit replay.
 *
 * @route GET /api/sites/:siteId/git/diff
 * @auth Bearer token (org-scoped)
 *
 * @queryParam base   - Commit SHA on the "before" side of the diff. Required.
 * @queryParam target - Commit SHA on the "after" side of the diff. Required.
 *
 * @returns 200 with `{ data: { added: string[], removed: string[],
 *   modified: string[], stats: { lines_added, lines_removed } } }`.
 *   File paths are relative to `sites/{slug}/{version}/`. Use
 *   `GET /api/sites/:siteId/git/commits/:commitId` to read individual
 *   file contents at either side.
 *
 * @remarks
 * `base` and `target` are unordered semantically — swap them to invert
 * the diff. `services/git.diffSnapshots` reads both commit objects from
 * R2 (~2 reads), then per-file blob reads for modified files (`O(n)`
 * reads where n=modified-file-count). Heavy on R2 for large diffs.
 *
 * @throws {AppError} 400 BAD_REQUEST — either query param missing.
 * @throws {AppError} 401 UNAUTHORIZED — missing/invalid Bearer.
 * @throws {AppError} 404 NOT_FOUND — site does not exist in caller's org,
 *   OR `base`/`target` commit not in R2 git chain.
 *
 * @example
 * ```bash
 * curl -H "Authorization: Bearer $TOKEN" \
 *   "https://projectsites.dev/api/sites/$SITE_ID/git/diff?base=abc123&target=def456"
 * # → { data: { added: ["public/new.css"], removed: [],
 * #            modified: ["src/App.tsx", "package.json"],
 * #            stats: { lines_added: 42, lines_removed: 12 } } }
 * ```
 */
siteVersioning.get('/api/sites/:siteId/git/diff', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) throw unauthorized('Must be authenticated');
  const siteId = c.req.param('siteId');
  const base = c.req.query('base');
  const target = c.req.query('target');

  if (!base || !target) {
    throw badRequest('Both "base" and "target" query params are required');
  }

  // Canonical org-ownership guard: 404 (never 403) so cross-org sites don't leak.
  const site = await requireOwnedSite<{ slug: string }>(c.env, orgId, siteId, 'slug');

  const { diffSnapshots } = await import('../../../src/services/git.js');
  const diff = await diffSnapshots(c.env.SITES_BUCKET, site.slug, base, target);

  return c.json({ data: diff });
});

/**
 * Read a single commit's metadata + file list from R2 git chain. Used
 * by the snapshot-detail UI to preview "what's in this snapshot" before
 * a user clicks Revert.
 *
 * @route GET /api/sites/:siteId/git/commits/:commitId
 * @auth Bearer token (org-scoped)
 *
 * @param commitId - URL param. Commit SHA from
 *   `GET /api/sites/:siteId/git/history`. Returns 404 if not in chain
 *   (e.g. typo, or commit was reaped by GC sweeper).
 *
 * @returns 200 with `{ data: { id, parent, message, timestamp, author,
 *   files: [{ path, size, blob_id }] } }`. The files array lists
 *   tracked paths at this commit; use `GET /api/sites/:id/files/:path{.+}`
 *   to read content at the LIVE version, or pair with a revert to read
 *   content at the historical version.
 *
 * @remarks
 * `services/git.getCommit` performs a single R2 read for the commit object
 * itself; the included `files[]` is parsed from the tree object that's
 * embedded in the commit. No blob reads — that's lazy / on-demand.
 *
 * @throws {AppError} 401 UNAUTHORIZED — missing/invalid Bearer.
 * @throws {AppError} 404 NOT_FOUND — site not in caller's org, OR commit
 *   not in R2 git chain.
 *
 * @example
 * ```bash
 * curl -H "Authorization: Bearer $TOKEN" \
 *   "https://projectsites.dev/api/sites/$SITE_ID/git/commits/abc123def456"
 * # → { data: { id: "abc...", parent: "999...", message: "build via workflow",
 * #            timestamp: "2026-05-11T14:23:01Z", author: "system",
 * #            files: [{ path: "index.html", size: 12453, blob_id: "..." },
 * #                    ...] } }
 * ```
 */
siteVersioning.get('/api/sites/:siteId/git/commits/:commitId', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) throw unauthorized('Must be authenticated');
  const siteId = c.req.param('siteId');
  const commitId = c.req.param('commitId');

  // Canonical org-ownership guard: 404 (never 403) so cross-org sites don't leak.
  const site = await requireOwnedSite<{ slug: string }>(c.env, orgId, siteId, 'slug');

  const { getCommit } = await import('../../../src/services/git.js');
  const commit = await getCommit(c.env.SITES_BUCKET, site.slug, commitId);
  if (!commit) throw notFound('Commit not found');

  return c.json({ data: commit });
});

/**
 * Map a filename to a `Content-Type` header value for R2 PUT operations
 * during snapshot revert / file republishing flows.
 *
 * @param filename - Filename (or full path; only the segment after the
 *   last `.` matters). Case-insensitive extension match.
 * @returns MIME type string, or `'application/octet-stream'` when the
 *   extension is unknown / missing.
 *
 * @remarks
 * Covers the 14 file types that appear in generated sites (`html`, `css`,
 * `js`, `json`, `svg`, `png`, `jpg/jpeg`, `gif`, `webp`, `ico`, `txt`,
 * `xml`, `woff`, `woff2`). Intentionally narrow — anything outside this
 * set falls through to `application/octet-stream` rather than guessing,
 * which forces browsers to download rather than mis-render an unknown
 * binary as text.
 *
 * Mirrors the lookup table in `services/site_serving.ts::guessContentType`
 * but lives here as a private helper so the revert hot-path doesn't
 * import the larger serving module (which pulls in additional R2 / KV
 * dependencies). Keep the two tables in sync when adding new types.
 */
function guessContentTypeForRevert(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  const types: Record<string, string> = {
    html: 'text/html',
    css: 'text/css',
    js: 'application/javascript',
    json: 'application/json',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    ico: 'image/x-icon',
    txt: 'text/plain',
    xml: 'text/xml',
    woff: 'font/woff',
    woff2: 'font/woff2',
  };
  return types[ext ?? ''] ?? 'application/octet-stream';
}

/**
 * Generate a downloadable JSON manifest of a snapshot's R2 files.
 *
 * @route GET /api/sites/:id/snapshots/:snapId/download
 * @auth Bearer orgId required.
 * @param id     - Site UUID.
 * @param snapId - `site_snapshots.id`.
 * @returns `{ data: { snapshot_id, build_version, generated_at,
 *   expires_at, files: Array<{ key, size, etag, content_type, url }> } }`.
 *
 * @remarks
 * **Why a JSON manifest and NOT a server-side zip?**
 *
 * 1. **No native zip primitive in Workers.** There is no `@cf/wasm-zip` /
 *    `Bun.zip` available in the Cloudflare Workers runtime; the only options
 *    are (a) `jszip` running on the Worker (loads ~150 KB of CPU-bound JS
 *    every request and would push us past the 50ms CPU cap on snapshots
 *    larger than ~30 files), or (b) spinning a Container DO with `zip(1)` —
 *    massive over-engineering for a download that the client can assemble
 *    in 200 lines of `jszip` browser-side.
 *
 * 2. **Manifest scales linearly + streams.** The manifest endpoint returns
 *    pre-signed URLs (here: ordinary R2 public-prefix URLs — the bucket is
 *    public for site-serving) so the browser parallelises N file fetches
 *    against R2's edge CDN, hits zero Worker CPU after manifest issuance,
 *    and the client zips in a Web Worker without blocking the main thread.
 *
 * 3. **Resumable + auditable.** A failed mid-zip on the server forces a
 *    full re-zip; a client-side failure can retry individual files using
 *    the manifest's per-file `key` + `etag`. The audit log captures the
 *    manifest issuance, not every byte transferred — keeping the audit
 *    surface honest about what *was* served.
 *
 * Client UX: pair this endpoint with browser-side `jszip` from
 * `https://cdn.jsdelivr.net/npm/jszip` — fetch each `files[i].url`,
 * `zip.file(files[i].key, blob)`, then `zip.generateAsync({ type: 'blob' })`
 * + `URL.createObjectURL()` for a single-click download.
 *
 * @throws UNAUTHORIZED, NOT_FOUND (site or snapshot not found / cross-org).
 */
siteVersioning.get('/api/sites/:id/snapshots/:snapId/download', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) throw unauthorized('Must be authenticated');

  const siteId = c.req.param('id');
  const snapId = c.req.param('snapId');

  // Canonical org-ownership guard: 404 (never 403) so cross-org sites don't leak.
  const site = await requireOwnedSite<{ slug: string }>(c.env, orgId, siteId, 'slug');

  const snap = await dbQueryOne<{
    id: string;
    snapshot_name: string;
    build_version: string;
  }>(
    c.env.DB,
    'SELECT id, snapshot_name, build_version FROM site_snapshots WHERE id = ? AND site_id = ? AND deleted_at IS NULL',
    [snapId, siteId],
  );
  if (!snap) throw notFound('Snapshot not found');

  const prefix = `sites/${site.slug}/${snap.build_version}/`;
  // R2 list is capped at 1000 objects per call; snapshots rarely exceed this
  // but we paginate via `cursor` defensively up to 5 pages (5000 files).
  const collected: R2Object[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 5; i++) {
    const page = await c.env.SITES_BUCKET.list({ prefix, cursor, limit: 1000 });
    for (const obj of page.objects) collected.push(obj);
    if (!page.truncated || !page.cursor) break;
    cursor = page.cursor;
  }

  const baseUrl = `https://${site.slug}${DOMAINS.SITES_SUFFIX}`;
  const generatedAt = new Date().toISOString();
  // R2 bucket is public for site-serving — the "pre-signed" URLs are just
  // the canonical site URLs. If we ever flip the bucket private, swap this
  // for `bucket.createSignedUrl(...)` (Workers R2 API) without touching
  // the manifest shape.
  const files = collected.map((obj) => ({
    key: obj.key.slice(prefix.length),
    size: obj.size,
    etag: obj.etag,
    content_type: obj.httpMetadata?.contentType ?? null,
    url: `${baseUrl}/${obj.key.slice(prefix.length)}`,
  }));

  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1h

  c.executionCtx.waitUntil(
    auditService.writeAuditLog(c.env.DB, {
      org_id: orgId,
      actor_id: c.get('userId') ?? null,
      action: 'site.snapshot.download_manifest',
      message: `Snapshot download manifest issued for '${snap.snapshot_name}' on site '${site.slug}' — ${files.length} files`,
      target_type: 'site_snapshot',
      target_id: snapId,
      metadata_json: {
        site_id: siteId,
        snapshot_name: snap.snapshot_name,
        build_version: snap.build_version,
        file_count: files.length,
        total_bytes: files.reduce((acc, f) => acc + f.size, 0),
      },
      request_id: c.get('requestId'),
    }),
  );

  return c.json({
    data: {
      snapshot_id: snap.id,
      snapshot_name: snap.snapshot_name,
      build_version: snap.build_version,
      generated_at: generatedAt,
      expires_at: expiresAt,
      base_url: baseUrl,
      file_count: files.length,
      total_bytes: files.reduce((acc, f) => acc + f.size, 0),
      manifest_format: 'json-v1',
      client_hint:
        'Use jszip browser-side: for each file in `files`, `fetch(file.url)` → `zip.file(file.key, blob)` → `zip.generateAsync({type:"blob"})`.',
      files,
    },
  });
});
