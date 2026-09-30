/**
 * @module services/ai_key_grants
 * @description Durable GrantRecord storage attached to `api_tokens` rows
 * (campaign lane-3, CAMPAIGN-cf-native-ai §5) — the layer the Settings
 * "AI API Keys" UI and the /v1 executor consume.
 *
 * One `ai_api_key_grants` row per psk_ token (migration 0649,
 * `token_id` UNIQUE) holding the mint-time SNAPSHOT of CONCRETE ids
 * (sites / connections / actions / models), limits, approval policy and
 * expiry as Zod-validated `grant_json`. Shapes are the SHARED ai-policy
 * layer (`GrantRecordSchema` from `@project-sites/shared`) — never
 * redefined here; {@link GrantInputSchema} is a `.pick()` DERIVATION of the
 * caller-selectable fields, so the two can never drift.
 *
 * Invariants:
 * - **Server constructs the record** — id (UUIDv7), `api_key` principal
 *   (refId = token id), orgId and revision are NEVER caller-supplied.
 * - **Revision is authoritative** — bumped on every put/revoke; the column
 *   mirrors `grant_json.revision` so `effectiveAllow`'s live_state leg can
 *   compare cheaply (stale snapshots never authorize).
 * - **Fail closed** — reads validate via `GrantRecordSchema`; a corrupt or
 *   schema-drifted row reads as `null` (no grant → no AI allowance), and
 *   `revokeGrant` soft-deletes an unparseable row rather than leaving it.
 * - A token WITHOUT a grant row has NO AI allowance — existing tokens keep
 *   working without silently gaining AI/publish/integration access.
 *
 * @packageDocumentation
 */

import { forbidden, type GrantRecord, GrantRecordSchema } from '@project-sites/shared';
import { z } from 'zod';

import { uuidv7 } from '../lib/uuid.js';

/**
 * The caller-selectable mint-time fields — a strict `.pick()` of
 * `GrantRecordSchema` (identity/lineage fields `id`, `principal`, `orgId`,
 * `revision`, `revokedAt` are server-controlled and NOT pickable).
 * `limits`/`approvalPolicy` keep their schema defaults; `expiresAt` stays
 * REQUIRED (no perpetual credentials).
 */
export const GrantInputSchema = GrantRecordSchema.pick({
  actionIds: true,
  approvalPolicy: true,
  connectionIds: true,
  expiresAt: true,
  limits: true,
  modelIds: true,
  siteIds: true,
});

export type GrantInput = z.infer<typeof GrantInputSchema>;

/** List-surface summary — counts + lifecycle, NEVER the full id arrays. */
export interface GrantSummary {
  siteCount: number;
  connectionCount: number;
  actionCount: number;
  modelCount: number;
  approvalPolicy: GrantRecord['approvalPolicy'];
  revision: number;
  expiresAt: string;
  revokedAt?: string;
}

interface GrantRow {
  id: string;
  token_id: string;
  org_id: string;
  grant_json: string;
  revision: number;
}

/** Reduce a full grant to the counts the list/create responses expose. */
export function summarizeGrant(grant: GrantRecord): GrantSummary {
  return {
    actionCount: grant.actionIds.length,
    approvalPolicy: grant.approvalPolicy,
    connectionCount: grant.connectionIds.length,
    expiresAt: grant.expiresAt,
    modelCount: grant.modelIds.length,
    revision: grant.revision,
    siteCount: grant.siteIds.length,
    ...(grant.revokedAt !== undefined ? { revokedAt: grant.revokedAt } : {}),
  };
}

/** Parse+validate a stored grant_json — `null` (fail closed) on any defect. */
function parseStoredGrant(raw: string, tokenId: string): GrantRecord | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    console.warn(
      JSON.stringify({ kind: 'json', msg: 'ai_key_grants.corrupt_grant_json', tokenId }),
    );
    return null;
  }
  const parsed = GrantRecordSchema.safeParse(json);
  if (!parsed.success) {
    console.warn(
      JSON.stringify({ kind: 'schema', msg: 'ai_key_grants.invalid_grant_record', tokenId }),
    );
    return null;
  }
  return parsed.data;
}

/**
 * Create or replace the grant attached to a token (one grant per token).
 *
 * Validates the caller-selected fields via {@link GrantInputSchema}, then
 * constructs + `GrantRecordSchema`-validates the FULL record server-side:
 * fresh UUIDv7 id on create (stable id on update), `api_key` principal bound
 * to the token, revision `1` on create / `existing + 1` on update. An update
 * also clears `deleted_at`/`revokedAt` (an edit re-activates the grant at a
 * NEW revision — old snapshots fail the live_state revision check).
 *
 * @throws {AppError} 403 when the token's existing grant belongs to another org.
 * @throws {z.ZodError} when the input (or constructed record) is invalid — before any write.
 */
export async function putGrantForToken(
  db: D1Database,
  tokenId: string,
  orgId: string,
  grant: GrantInput,
): Promise<GrantRecord> {
  const input = GrantInputSchema.parse(grant);

  const existing = await db
    .prepare(`SELECT id, org_id, revision FROM ai_api_key_grants WHERE token_id = ? LIMIT 1`)
    .bind(tokenId)
    .first<Pick<GrantRow, 'id' | 'org_id' | 'revision'>>();

  if (existing && existing.org_id !== orgId) {
    throw forbidden('Grant belongs to a different organization.');
  }

  const record: GrantRecord = GrantRecordSchema.parse({
    id: existing?.id ?? uuidv7(),
    orgId,
    principal: { kind: 'api_key', refId: tokenId },
    ...input,
    revision: existing ? existing.revision + 1 : 1,
  });

  const now = new Date().toISOString();
  const grantJson = JSON.stringify(record);

  if (existing) {
    await db
      .prepare(
        `UPDATE ai_api_key_grants
         SET grant_json = ?, revision = ?, updated_at = ?, deleted_at = NULL
         WHERE token_id = ? AND org_id = ?`,
      )
      .bind(grantJson, record.revision, now, tokenId, orgId)
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO ai_api_key_grants (id, token_id, org_id, grant_json, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(record.id, tokenId, orgId, grantJson, record.revision, now, now)
      .run();
  }

  return record;
}

/**
 * Read the grant attached to a token — parse+validate on read.
 *
 * @returns The validated {@link GrantRecord}, or `null` when absent OR when
 * the stored row is corrupt/schema-drifted (fail closed: no valid grant, no
 * AI allowance). Genuine D1 errors PROPAGATE — an outage must never read as
 * "no grant" vs "can't check" (same discipline as `verifyApiToken`).
 */
export async function getGrantForToken(
  db: D1Database,
  tokenId: string,
): Promise<GrantRecord | null> {
  const row = await db
    .prepare(
      `SELECT grant_json FROM ai_api_key_grants
       WHERE token_id = ? AND deleted_at IS NULL LIMIT 1`,
    )
    .bind(tokenId)
    .first<Pick<GrantRow, 'grant_json'>>();

  if (!row) return null;
  return parseStoredGrant(row.grant_json, tokenId);
}

/**
 * Revoke the grant attached to a token (org-scoped).
 *
 * Sets `revokedAt` inside the stored record and bumps the revision (so any
 * cached snapshot immediately fails the live_state revision check). An
 * unparseable row is soft-deleted instead — fail closed, never leave an
 * un-validatable grant in the active set.
 *
 * @returns `true` when a grant was revoked, `false` when the org has none.
 */
export async function revokeGrant(
  db: D1Database,
  orgId: string,
  tokenId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT id, grant_json, revision FROM ai_api_key_grants
       WHERE token_id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1`,
    )
    .bind(tokenId, orgId)
    .first<Pick<GrantRow, 'id' | 'grant_json' | 'revision'>>();

  if (!row) return false;

  const now = new Date().toISOString();
  const grant = parseStoredGrant(row.grant_json, tokenId);

  if (!grant) {
    // Fail closed: an unparseable grant must not linger — remove it outright.
    const result = await db
      .prepare(
        `UPDATE ai_api_key_grants SET deleted_at = ?, updated_at = ?
         WHERE id = ? AND org_id = ?`,
      )
      .bind(now, now, row.id, orgId)
      .run()
      .catch(() => null);
    return (result?.meta?.changes ?? 0) > 0;
  }

  const revoked: GrantRecord = { ...grant, revision: grant.revision + 1, revokedAt: now };
  const result = await db
    .prepare(
      `UPDATE ai_api_key_grants SET grant_json = ?, revision = ?, updated_at = ?
       WHERE id = ? AND org_id = ?`,
    )
    .bind(JSON.stringify(revoked), revoked.revision, now, row.id, orgId)
    .run()
    .catch(() => null);

  return (result?.meta?.changes ?? 0) > 0;
}

/**
 * List an org's grants (newest first) for the Settings "AI API Keys" list.
 * Invalid rows are SKIPPED (warned) rather than failing the whole surface —
 * they read as "no grant", consistent with {@link getGrantForToken}.
 */
export async function listGrantsForOrg(
  db: D1Database,
  orgId: string,
): Promise<Array<{ tokenId: string; grant: GrantRecord }>> {
  const rows = await db
    .prepare(
      `SELECT token_id, grant_json FROM ai_api_key_grants
       WHERE org_id = ? AND deleted_at IS NULL
       ORDER BY created_at DESC`,
    )
    .bind(orgId)
    .all<Pick<GrantRow, 'token_id' | 'grant_json'>>()
    .catch(() => ({ results: [] as Array<Pick<GrantRow, 'token_id' | 'grant_json'>> }));

  const out: Array<{ tokenId: string; grant: GrantRecord }> = [];
  for (const row of rows.results ?? []) {
    const grant = parseStoredGrant(row.grant_json, row.token_id);
    if (grant) out.push({ grant, tokenId: row.token_id });
  }
  return out;
}
