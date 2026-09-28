import { z } from 'zod';

/**
 * Zod boundary for the Durable Preview model (feature: durable_preview) — Slice 3, state + API only.
 * One shared source of truth: the handlers validate against these and the inferred types flow through
 * the service. `.strict()` everywhere so an unknown field is a 400, never a silent drop (zod-everywhere).
 */

/** Release outcomes — honest "commit ok / deploy failed" retry surface. */
export const ReleaseOutcome = z.enum(['success', 'commit_ok_deploy_failed', 'failed']);
export type ReleaseOutcome = z.infer<typeof ReleaseOutcome>;

/**
 * The per-site MUTABLE working-tree record — Preview state. Save/generate upserts THIS and nothing
 * else (no commit, no deploy, no Production change).
 */
export const WorkingTreeSchema = z
  .object({
    id: z.string(),
    site_id: z.string(),
    org_id: z.string(),
    base_main_sha: z.string().nullable(),
    draft_revision: z.number().int(),
    tree_digest: z.string().nullable(),
    preview_deploy_revision: z.string().nullable(),
    last_error: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .strict();
export type WorkingTree = z.infer<typeof WorkingTreeSchema>;

/** An append-only IMMUTABLE release record — the durable Production history (written on Promote). */
export const ReleaseSchema = z
  .object({
    id: z.string(),
    site_id: z.string(),
    org_id: z.string(),
    snapshot_id: z.string().nullable(),
    commit_sha: z.string().nullable(),
    artifact_digest: z.string().nullable(),
    deployment_id: z.string().nullable(),
    actor: z.string().nullable(),
    draft_revision: z.number().int().nullable(),
    outcome: ReleaseOutcome,
    created_at: z.string(),
  })
  .strict();
export type Release = z.infer<typeof ReleaseSchema>;

/**
 * Request body for a Preview save/generate → upsert the working tree. Preview ONLY. Every field is
 * optional except the digest of what's being previewed; the server bumps the monotonic draft revision.
 */
export const UpsertWorkingTreeSchema = z
  .object({
    base_main_sha: z.string().max(64).nullable().optional(),
    tree_digest: z.string().min(1).max(256),
    preview_deploy_revision: z.string().max(128).nullable().optional(),
    last_error: z.string().max(2000).nullable().optional(),
  })
  .strict();
export type UpsertWorkingTree = z.infer<typeof UpsertWorkingTreeSchema>;

export const WorkingTreeResponseSchema = z
  .object({ working_tree: WorkingTreeSchema.nullable() })
  .strict();
export type WorkingTreeResponse = z.infer<typeof WorkingTreeResponseSchema>;

export const ReleaseListResponseSchema = z
  .object({ releases: z.array(ReleaseSchema), count: z.number().int() })
  .strict();
export type ReleaseListResponse = z.infer<typeof ReleaseListResponseSchema>;
