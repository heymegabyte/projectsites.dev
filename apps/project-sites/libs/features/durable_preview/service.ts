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
