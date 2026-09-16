/**
 * @module services/social_account_ctx
 * @description Helpers to load + decrypt social_accounts rows into
 * `SocialAccountCtx` and persist refreshed tokens back. Wraps ai_crypto so
 * publishers stay decoupled from D1 details.
 */
import type { Env } from '../types/env.js';
import { decrypt, encrypt } from './ai_crypto.js';
import { dbQuery, dbQueryOne, dbUpdate } from './db.js';
import type { Platform, SocialAccountCtx } from './social_publishers/index.js';
import { safeParseJSON } from '../utils/safe-parse.js';

interface SocialAccountRow {
  id: string;
  org_id: string;
  platform: string;
  external_id: string | null;
  handle: string | null;
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  token_expires_at: string | null;
  scopes: string | null;
  metadata_json: string | null;
  status: string;
}

export async function loadAccount(env: Env, id: string): Promise<SocialAccountCtx | null> {
  const row = await dbQueryOne<SocialAccountRow>(
    env.DB,
    `SELECT id, org_id, platform, external_id, handle, access_token_encrypted,
            refresh_token_encrypted, token_expires_at, scopes, metadata_json, status
       FROM social_accounts WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
  if (!row || !row.access_token_encrypted) return null;
  return buildCtx(env, row, row.access_token_encrypted);
}

export async function loadAccountsByIds(
  env: Env,
  ids: readonly string[],
): Promise<SocialAccountCtx[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const { data } = await dbQuery<SocialAccountRow>(
    env.DB,
    `SELECT id, org_id, platform, external_id, handle, access_token_encrypted,
            refresh_token_encrypted, token_expires_at, scopes, metadata_json, status
       FROM social_accounts
      WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
    [...ids],
  );
  const out: SocialAccountCtx[] = [];
  for (const row of data) {
    if (!row.access_token_encrypted) continue;
    // The guard above narrows access_token_encrypted to `string`; pass it explicitly
    // so buildCtx needs no non-null assertion (the narrowing is lost across the call).
    out.push(await buildCtx(env, row, row.access_token_encrypted));
  }
  return out;
}

async function buildCtx(
  env: Env,
  row: SocialAccountRow,
  accessTokenEncrypted: string,
): Promise<SocialAccountCtx> {
  const access_token = await decrypt(env, accessTokenEncrypted);
  const refresh_token = row.refresh_token_encrypted
    ? await decrypt(env, row.refresh_token_encrypted)
    : null;
  // safeParseJSON: a corrupt metadata_json on any account must not throw and
  // 500 the whole publish/auto-pilot context fetch — fall back to {} (identical
  // to the null branch). The remaining stored-JSON reads in social_auto_pilot /
  // api_tokens are already try/catch-guarded; this was the last unguarded one.
  const metadata = safeParseJSON<Record<string, unknown>>(row.metadata_json, {});
  const accountId = row.id;
  return {
    id: row.id,
    org_id: row.org_id,
    platform: row.platform as Platform,
    external_id: row.external_id,
    handle: row.handle,
    access_token,
    refresh_token,
    token_expires_at: row.token_expires_at,
    scopes: row.scopes,
    metadata,
    onTokenRefresh: async (next) => {
      const updates: Record<string, unknown> = {
        access_token_encrypted: await encrypt(env, next.access_token),
        token_expires_at: next.expires_at ?? null,
      };
      if (next.refresh_token) {
        updates.refresh_token_encrypted = await encrypt(env, next.refresh_token);
      }
      const { error } = await dbUpdate(env.DB, 'social_accounts', updates, 'id = ?', [accountId]);
      // Persisting the refreshed token is what makes the refresh meaningful — a
      // silent drop leaves the account on the OLD token → the next publish 401s.
      // Callers include a publisher's inline mid-publish refresh, where a throw
      // would fail/duplicate an already-succeeded post, so surface the drop to logs
      // rather than throwing.
      if (error) {
        console.warn(
          JSON.stringify({
            level: 'warn',
            service: 'social_account_ctx',
            message: 'token_refresh_persist_failed',
            account_id: accountId,
            error,
          }),
        );
      }
    },
  };
}

/** Mark account as error (e.g. invalid token) with a human-readable reason. */
export async function markAccountError(env: Env, accountId: string, reason: string): Promise<void> {
  const { error } = await dbUpdate(
    env.DB,
    'social_accounts',
    { status: 'error', last_error: reason.slice(0, 500) },
    'id = ?',
    [accountId],
  );
  // Best-effort error-marking (callers treat it as fire-and-forget, e.g.
  // `.catch(() => undefined)`) — never throw, but log a dropped mark so a stuck
  // account state stays observable.
  if (error) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'social_account_ctx',
        message: 'mark_account_error_write_failed',
        account_id: accountId,
        error,
      }),
    );
  }
}
