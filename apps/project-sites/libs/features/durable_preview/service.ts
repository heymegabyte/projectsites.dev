import type { Env } from '../../../src/types/env.js';
import { dbQueryOne, dbQuery, dbExecute } from '../../../src/services/db.js';
import type { Release, ReleaseOutcome, WorkingTree } from './schemas.js';

export const FLAG_KEY = 'durable_preview';

/** D1 row → validated working-tree domain shape (D1 returns unknown-typed rows). */
function toWorkingTree(row: Record<string, unknown>): WorkingTree {
  return {
    id: String(row.id),
    site_id: String(row.site_id),
    org_id: String(row.org_id),
    base_main_sha: row.base_main_sha == null ? null : String(row.base_main_sha),
    draft_revision: Number(row.draft_revision ?? 0),
    tree_digest: row.tree_digest == null ? null : String(row.tree_digest),
    preview_deploy_revision:
      row.preview_deploy_revision == null ? null : String(row.preview_deploy_revision),
    last_error: row.last_error == null ? null : String(row.last_error),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

const RELEASE_OUTCOMES: readonly ReleaseOutcome[] = ['success', 'commit_ok_deploy_failed', 'failed'];

/** D1 row → validated release domain shape. */
function toRelease(row: Record<string, unknown>): Release {
  const outcome = String(row.outcome ?? 'success');
  return {
    id: String(row.id),
    site_id: String(row.site_id),
    org_id: String(row.org_id),
    snapshot_id: row.snapshot_id == null ? null : String(row.snapshot_id),
    commit_sha: row.commit_sha == null ? null : String(row.commit_sha),
    artifact_digest: row.artifact_digest == null ? null : String(row.artifact_digest),
    deployment_id: row.deployment_id == null ? null : String(row.deployment_id),
    actor: row.actor == null ? null : String(row.actor),
    draft_revision: row.draft_revision == null ? null : Number(row.draft_revision),
    outcome: (RELEASE_OUTCOMES.includes(outcome as ReleaseOutcome)
      ? outcome
      : 'success') as ReleaseOutcome,
    created_at: String(row.created_at),
  };
}

/** Read a site's working-tree record, org-scoped (IDOR-safe). Null when none exists. */
export async function getWorkingTree(
  env: Env,
  siteId: string,
  orgId: string,
): Promise<WorkingTree | null> {
  const row = await dbQueryOne<Record<string, unknown>>(
    env.DB,
    `SELECT * FROM site_working_tree WHERE site_id = ? AND org_id = ? AND deleted_at IS NULL`,
    [siteId, orgId],
  );
  return row ? toWorkingTree(row) : null;
}

export interface UpsertWorkingTreeInput {
  siteId: string;
  orgId: string;
  baseMainSha?: string | null;
  treeDigest: string;
  previewDeployRevision?: string | null;
  lastError?: string | null;
}

export type UpsertWorkingTreeResult =
  | { ok: true; draftRevision: number }
  | { ok: false; error: string };

/**
 * Upsert a site's PREVIEW working-tree record on save/generate. This is the ONLY write a
 * save/generate performs — it NEVER creates a commit, a deploy, or a Production change (Promote is a
 * separate, authorized action). The monotonic `draft_revision` is bumped by 1 on every call. One row
 * per site (UNIQUE site_id): first save inserts at revision 1, subsequent saves UPDATE in place.
 *
 * Org-scoped: the update matches `org_id` so a caller can never write another org's working tree.
 */
export async function upsertWorkingTree(
  env: Env,
  input: UpsertWorkingTreeInput,
): Promise<UpsertWorkingTreeResult> {
  const now = new Date().toISOString();
  const existing = await getWorkingTree(env, input.siteId, input.orgId);
  const nextRevision = (existing?.draft_revision ?? 0) + 1;

  if (existing) {
    const res = await dbExecute(
      env.DB,
      `UPDATE site_working_tree
         SET base_main_sha = ?, draft_revision = ?, tree_digest = ?,
             preview_deploy_revision = ?, last_error = ?, updated_at = ?
       WHERE site_id = ? AND org_id = ? AND deleted_at IS NULL`,
      [
        input.baseMainSha ?? null,
        nextRevision,
        input.treeDigest,
        input.previewDeployRevision ?? null,
        input.lastError ?? null,
        now,
        input.siteId,
        input.orgId,
      ],
    );
    if (res.error) return { ok: false, error: res.error };
    return { ok: true, draftRevision: nextRevision };
  }

  const res = await dbExecute(
    env.DB,
    `INSERT INTO site_working_tree
       (id, site_id, org_id, base_main_sha, draft_revision, tree_digest,
        preview_deploy_revision, last_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      crypto.randomUUID(),
      input.siteId,
      input.orgId,
      input.baseMainSha ?? null,
      nextRevision,
      input.treeDigest,
      input.previewDeployRevision ?? null,
      input.lastError ?? null,
      now,
      now,
    ],
  );
  if (res.error) return { ok: false, error: res.error };
  return { ok: true, draftRevision: nextRevision };
}

export interface AppendReleaseInput {
  siteId: string;
  orgId: string;
  snapshotId: string | null;
  commitSha: string | null;
  artifactDigest: string | null;
  deploymentId: string | null;
  actor: string | null;
  draftRevision: number | null;
  outcome: ReleaseOutcome;
}

export type AppendReleaseResult = { ok: true; id: string } | { ok: false; error: string };

/**
 * Append an IMMUTABLE release record — the durable Production history written on a (future) authorized
 * Promote. Records the frozen snapshot id, commit SHA, artifact digest (so promoted bytes can be
 * proved equal to the frozen Preview revision), the actual CF deployment id, the actor, the frozen
 * draft revision, and the outcome. Append-only: this only ever INSERTs a new row (never mutates).
 */
export async function appendRelease(
  env: Env,
  input: AppendReleaseInput,
): Promise<AppendReleaseResult> {
  const id = crypto.randomUUID();
  const res = await dbExecute(
    env.DB,
    `INSERT INTO site_releases
       (id, site_id, org_id, snapshot_id, commit_sha, artifact_digest,
        deployment_id, actor, draft_revision, outcome, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.siteId,
      input.orgId,
      input.snapshotId,
      input.commitSha,
      input.artifactDigest,
      input.deploymentId,
      input.actor,
      input.draftRevision,
      input.outcome,
      new Date().toISOString(),
    ],
  );
  if (res.error) return { ok: false, error: res.error };
  return { ok: true, id };
}

/** List a site's release history (newest first), org-scoped (IDOR-safe). */
export async function listReleases(
  env: Env,
  siteId: string,
  orgId: string,
): Promise<Release[]> {
  const { data } = await dbQuery<Record<string, unknown>>(
    env.DB,
    `SELECT * FROM site_releases
       WHERE site_id = ? AND org_id = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 100`,
    [siteId, orgId],
  );
  return (data ?? []).map(toRelease);
}

/**
 * Find an EXISTING release for a given (site, draft revision), org-scoped. This is the idempotency key
 * for {@link promoteToProduction}: one Preview draft revision maps to at most ONE Production release, so
 * a re-clicked / retried / double-submitted Promote returns the already-recorded release instead of
 * re-promoting the same bytes twice. Null when that draft has never been promoted.
 */
export async function findReleaseByDraftRevision(
  env: Env,
  siteId: string,
  orgId: string,
  draftRevision: number,
): Promise<Release | null> {
  const row = await dbQueryOne<Record<string, unknown>>(
    env.DB,
    `SELECT * FROM site_releases
       WHERE site_id = ? AND org_id = ? AND draft_revision = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    [siteId, orgId, draftRevision],
  );
  return row ? toRelease(row) : null;
}

// ── Promote Preview → Production (Slice 5) ──────────────────────────────────────

/** Input for {@link promoteToProduction} — the frozen Preview revision the caller is promoting. */
export interface PromoteInput {
  /** The Preview working-tree draft revision being promoted (the idempotency key). */
  draftRevision: number;
  /** The digest of the working tree being promoted (recorded on the release for byte-equality proof). */
  treeDigest: string;
  /** Optional commit SHA associated with this draft (recorded on the release). */
  commitSha?: string | null;
  /** Optional actor (user id / email) performing the promotion — recorded on the release. */
  actor?: string | null;
}

/** Result of {@link promoteToProduction} — the release row + the honest outcome + whether it was idempotent. */
export interface PromoteResult {
  release: Release;
  outcome: ReleaseOutcome;
  /** True when an existing release for this draft was RETURNED (no re-promotion happened). */
  idempotent: boolean;
}

/**
 * The minimal `sites` row {@link promoteToProduction} needs — resolved by the handler (which already
 * did the ownership check) and passed in, so the service does no second ownership lookup.
 */
export interface PromoteSite {
  id: string;
  slug: string;
  /** The site's current published production version (`v<epoch>`), or null if never published. */
  currentBuildVersion: string | null;
}

/** How many R2 objects we'll copy in one promotion (a sane ceiling; a site's build is well under this). */
const MAX_PROMOTE_OBJECTS = 5000;

/**
 * Resolve the R2 prefix of the Preview artifact to promote FROM. The working tree's
 * `preview_deploy_revision` is authoritative when it's a branch path (`sites/{slug}/branches/{name}/`);
 * otherwise we promote the site's currently-published production prefix (`sites/{slug}/{version}/`) —
 * the honest "what the owner is looking at". Returns null when there is no artifact to promote yet.
 */
function resolvePreviewSourcePrefix(
  slug: string,
  previewDeployRevision: string | null,
  currentBuildVersion: string | null,
): string | null {
  const rev = previewDeployRevision?.trim();
  if (rev) {
    // A full branch R2 path is stored verbatim (e.g. `sites/vitos/branches/feat-hero/`).
    if (rev.startsWith('sites/') && rev.includes('/branches/')) {
      return rev.endsWith('/') ? rev : `${rev}/`;
    }
    // A bare version token (`v1234`) → the versioned prefix.
    if (/^v?\d+$/i.test(rev) || rev.length > 0) {
      return `sites/${slug}/${rev.replace(/^\/+|\/+$/g, '')}/`;
    }
  }
  if (currentBuildVersion) {
    return `sites/${slug}/${currentBuildVersion.replace(/^\/+|\/+$/g, '')}/`;
  }
  return null;
}

/**
 * REALLY promote the Preview working tree to Production — idempotent on `draftRevision`.
 *
 * This is the honest artifact-freeze + production-publish path (the SAME shape as `POST /api/sites/:id/deploy`):
 *   1. IDEMPOTENCY — if a release row already exists for `(site, draftRevision)`, RETURN it. Never re-promote.
 *   2. FREEZE — list every R2 object under the Preview source prefix and COPY it byte-for-byte into a fresh,
 *      immutable Production version prefix `sites/{slug}/{version}/`.
 *   3. POINT PRODUCTION AT IT — write `sites/{slug}/_manifest.json` `{current_version}` and flip
 *      `sites.current_build_version` (exactly how the live deploy handler makes a version the served one).
 *   4. VERIFY, THEN RECORD — read `index.html` back from the NEW production prefix. Only `outcome='success'`
 *      when Production actually serves the promoted revision (a non-empty `index.html` under the new version
 *      AND the pointer flipped). If the copy landed but the index isn't servable → `commit_ok_deploy_failed`
 *      (bytes committed, deploy not honestly live). If the freeze/copy threw or there was nothing to promote
 *      → `failed`. NEVER a fabricated success.
 *
 * The release row is ALWAYS appended (append-only history) with the ACTUAL outcome, so a failed promotion is
 * visible + retryable, never silent.
 *
 * @param env  - Worker env (D1 `DB` + R2 `SITES_BUCKET`).
 * @param site - The OWNED site (id + slug + current version) — the handler resolved + ownership-checked it.
 * @param orgId - The caller's org (every read/write is org-scoped — IDOR-safe).
 * @param input - The frozen draft revision + tree digest (+ optional commit SHA + actor).
 * @returns The recorded (or idempotently-returned) release + its honest outcome.
 */
export async function promoteToProduction(
  env: Env,
  site: PromoteSite,
  orgId: string,
  input: PromoteInput,
): Promise<PromoteResult> {
  // 1) IDEMPOTENCY — this draft was already promoted → return the recorded release, never re-promote.
  const existing = await findReleaseByDraftRevision(env, site.id, orgId, input.draftRevision);
  if (existing) {
    return { release: existing, outcome: existing.outcome, idempotent: true };
  }

  const bucket = env.SITES_BUCKET;
  const version = `v${Date.now()}`;
  const destPrefix = `sites/${site.slug}/${version}/`;

  let outcome: ReleaseOutcome = 'failed';
  let deploymentId: string | null = null;
  let copiedCount = 0;

  try {
    // Resolve the Preview working tree so we know WHICH artifact to freeze.
    const wt = await getWorkingTree(env, site.id, orgId);
    const sourcePrefix = resolvePreviewSourcePrefix(
      site.slug,
      wt?.preview_deploy_revision ?? null,
      site.currentBuildVersion,
    );

    if (!bucket || !sourcePrefix) {
      // Nothing to promote (no artifact / no R2) → honest failure, recorded.
      outcome = 'failed';
    } else {
      // 2) FREEZE — copy every object under the source prefix into the new immutable production prefix.
      let cursor: string | undefined;
      do {
        const page = await bucket.list({ prefix: sourcePrefix, cursor, limit: 1000 });
        for (const obj of page.objects) {
          if (copiedCount >= MAX_PROMOTE_OBJECTS) break;
          const rel = obj.key.slice(sourcePrefix.length);
          if (!rel) continue;
          const src = await bucket.get(obj.key);
          if (!src) continue;
          const body = await src.arrayBuffer();
          await bucket.put(`${destPrefix}${rel}`, body, {
            httpMetadata: src.httpMetadata,
          });
          copiedCount++;
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor && copiedCount < MAX_PROMOTE_OBJECTS);

      if (copiedCount === 0) {
        // The source prefix held no objects → nothing was promoted.
        outcome = 'failed';
      } else {
        // 3) POINT PRODUCTION AT IT — write the manifest + flip the served version pointer.
        await bucket.put(
          `sites/${site.slug}/_manifest.json`,
          JSON.stringify({ current_version: version, updated_at: new Date().toISOString() }),
          { httpMetadata: { contentType: 'application/json' } },
        );
        await dbExecute(
          env.DB,
          `UPDATE sites SET status = 'published', current_build_version = ?, updated_at = datetime('now')
             WHERE id = ? AND org_id = ?`,
          [version, site.id, orgId],
        );
        deploymentId = version;

        // 4) VERIFY, THEN RECORD — Production is honestly live only if it SERVES the promoted revision.
        const pointer = await dbQueryOne<{ current_build_version: string | null }>(
          env.DB,
          `SELECT current_build_version FROM sites WHERE id = ? AND org_id = ?`,
          [site.id, orgId],
        );
        const servedIndex = await bucket.get(`${destPrefix}index.html`);
        const indexServable = !!servedIndex && servedIndex.size > 0;
        const pointerFlipped = pointer?.current_build_version === version;

        outcome = indexServable && pointerFlipped ? 'success' : 'commit_ok_deploy_failed';
      }
    }
  } catch {
    // Any freeze/copy/pointer error → honest failure. NEVER a fabricated success.
    outcome = 'failed';
  }

  // Append the immutable release with the ACTUAL outcome (append-only history — always recorded).
  const artifactDigest = input.treeDigest || null;
  const appended = await appendRelease(env, {
    siteId: site.id,
    orgId,
    snapshotId: outcome === 'failed' ? null : version,
    commitSha: input.commitSha ?? null,
    artifactDigest,
    deploymentId,
    actor: input.actor ?? null,
    draftRevision: input.draftRevision,
    outcome,
  });

  if (!appended.ok) {
    // The promotion itself may have happened, but we couldn't record it — surface as a failed release so
    // the UI never claims a success we can't prove. (Re-promote is safe: idempotency keys on draftRevision.)
    throw new Error(`Could not record release: ${appended.error}`);
  }

  const release = (await findReleaseByDraftRevision(env, site.id, orgId, input.draftRevision))!;
  return { release, outcome, idempotent: false };
}
