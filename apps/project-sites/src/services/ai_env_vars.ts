/**
 * @module services/ai_env_vars
 * @description Customizable per-org/per-site/per-MCP/per-endpoint/per-agent
 * key-value store that the AI and MCP-connectable surfaces can read at
 * inference time. Values are encrypted at rest via AES-GCM using the
 * existing `MCP_ENCRYPTION_KEY` (see {@link ./ai_crypto.ts}).
 *
 * ## Scope precedence
 *
 * Resolved at LLM/tool-dispatch time by {@link resolveEnvVarsForAI}:
 *
 *   org → site → mcp → endpoint → agent
 *
 * Each later scope overrides earlier scopes when the same key is defined at
 * multiple levels. The merge is performed in {@link resolveEnvVarsForAI}.
 *
 * Only rows with `exposed_to_ai = 1` flow into the AI context. Rows with
 * `exposed_to_ai = 0` stay backend-only (e.g. MCP-specific overrides used
 * inside `mcp_client.ts` but never surfaced to the LLM).
 *
 * ## Usage from LLM dispatch
 *
 * ```ts
 * import { resolveEnvVarsForAI, injectIntoSystemPrompt } from './ai_env_vars.js';
 *
 * const resolved = await resolveEnvVarsForAI(env, {
 *   orgId,
 *   siteId,
 *   endpointId,   // optional — overrides org/site/mcp when set
 *   agentId,      // optional — overrides everything when set
 * });
 * const augmented = injectIntoSystemPrompt(systemPrompt, resolved);
 * ```
 *
 * @packageDocumentation
 */
import type { Env } from '../types/env.js';
import { encrypt, decrypt } from './ai_crypto.js';
import { dbQuery, dbQueryOne, dbExecute } from './db.js';

/**
 * Scope an env var applies at.
 *
 * - `org` — applies to every AI/LLM call within the org
 * - `site` — overrides org for calls bound to a specific site
 * - `mcp` — overrides for a specific MCP provider (e.g. mailchimp, stripe)
 * - `endpoint` — overrides for a specific AI endpoint (custom model/provider config)
 * - `agent` — overrides for a specific agent (highest precedence)
 */
export type EnvVarScope = 'org' | 'site' | 'mcp' | 'endpoint' | 'agent';

/** All scopes ordered by resolve-time precedence (lowest → highest). */
const SCOPE_ORDER: readonly EnvVarScope[] = ['org', 'site', 'mcp', 'endpoint', 'agent'] as const;

/** Raw D1 row shape (numeric booleans as stored). */
interface EnvVarRow {
  id: string;
  org_id: string;
  scope: EnvVarScope;
  site_id: string | null;
  mcp_provider: string | null;
  endpoint_id: string | null;
  agent_id: string | null;
  key: string;
  value_encrypted: string;
  description: string | null;
  is_secret: number;
  exposed_to_ai: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

/** Public-facing env var shape returned by `listEnvVars` (never includes plaintext). */
export interface EnvVar {
  id: string;
  org_id: string;
  scope: EnvVarScope;
  site_id: string | null;
  mcp_provider: string | null;
  endpoint_id: string | null;
  agent_id: string | null;
  key: string;
  /** Always returned. `••••` + last 4 chars when `is_secret=1`, plaintext when `is_secret=0`. */
  value_masked: string;
  /** Only present when `opts.unmask === true` was passed. */
  value?: string;
  description: string | null;
  is_secret: boolean;
  exposed_to_ai: boolean;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

/** Arguments to {@link setEnvVar}. */
export interface SetEnvVarArgs {
  orgId: string;
  scope: EnvVarScope;
  siteId?: string;
  mcpProvider?: string;
  endpointId?: string;
  agentId?: string;
  key: string;
  value: string;
  description?: string;
  isSecret?: boolean;
  exposedToAi?: boolean;
  createdBy?: string;
}

/** Arguments to {@link listEnvVars}. */
export interface ListEnvVarsOpts {
  scope?: EnvVarScope;
  siteId?: string;
  mcpProvider?: string;
  endpointId?: string;
  agentId?: string;
  /**
   * When `true`, also returns the decrypted plaintext `value` on each row.
   * SERVER-SIDE ONLY — never expose to a browser-facing endpoint.
   */
  unmask?: boolean;
}

/** Arguments to {@link resolveEnvVarsForAI}. */
export interface ResolveEnvVarsArgs {
  orgId: string;
  siteId?: string;
  mcpProvider?: string;
  endpointId?: string;
  agentId?: string;
}

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_KEY_LEN = 128;
const MAX_VALUE_LEN = 64 * 1024; // 64 KiB ciphertext-input cap

/**
 * Validate and normalise the per-scope required fields. Throws a descriptive
 * `Error` whose message is safe to surface in a route JSON envelope.
 */
function validateScopeFields(
  args: Pick<
    SetEnvVarArgs,
    'scope' | 'siteId' | 'mcpProvider' | 'endpointId' | 'agentId' | 'key' | 'value'
  >,
): void {
  if (!SCOPE_ORDER.includes(args.scope)) {
    throw new Error(`invalid scope: ${args.scope}`);
  }
  if (args.scope === 'site' && !args.siteId) {
    throw new Error('siteId required when scope=site');
  }
  if (args.scope === 'mcp' && !args.mcpProvider) {
    throw new Error('mcpProvider required when scope=mcp');
  }
  if (args.scope === 'endpoint' && !args.endpointId) {
    throw new Error('endpointId required when scope=endpoint');
  }
  if (args.scope === 'agent' && !args.agentId) {
    throw new Error('agentId required when scope=agent');
  }
  if (!args.key || typeof args.key !== 'string') {
    throw new Error('key required');
  }
  if (args.key.length > MAX_KEY_LEN) {
    throw new Error(`key too long (max ${MAX_KEY_LEN})`);
  }
  if (!KEY_PATTERN.test(args.key)) {
    throw new Error('key must match /^[A-Za-z_][A-Za-z0-9_]*$/');
  }
  if (typeof args.value !== 'string') {
    throw new Error('value required (string)');
  }
  if (args.value.length > MAX_VALUE_LEN) {
    throw new Error(`value too long (max ${MAX_VALUE_LEN})`);
  }
}

/**
 * Mask a secret value as `••••` + last 4 plaintext characters. Returns the
 * plaintext unchanged when the value is short enough that masking would leak
 * more than it hides (≤4 chars).
 */
function maskValue(plaintext: string): string {
  if (plaintext.length <= 4) return '••••';
  return `••••${plaintext.slice(-4)}`;
}

/**
 * Translate a raw DB row into the public {@link EnvVar} shape. Decrypts the
 * value when needed for masking / unmasking.
 */
async function rowToEnvVar(env: Env, row: EnvVarRow, unmask: boolean): Promise<EnvVar> {
  const isSecret = row.is_secret === 1;
  let plaintext: string;
  try {
    plaintext = await decrypt(env, row.value_encrypted);
  } catch (err) {
    console.warn(
      JSON.stringify({
        service: 'ai_env_vars',
        event: 'decrypt_failed',
        id: row.id,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    plaintext = '';
  }
  const masked = isSecret ? maskValue(plaintext) : plaintext;
  const out: EnvVar = {
    id: row.id,
    org_id: row.org_id,
    scope: row.scope,
    site_id: row.site_id,
    mcp_provider: row.mcp_provider,
    endpoint_id: row.endpoint_id,
    agent_id: row.agent_id,
    key: row.key,
    value_masked: masked,
    description: row.description,
    is_secret: isSecret,
    exposed_to_ai: row.exposed_to_ai === 1,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (unmask) out.value = plaintext;
  return out;
}

/**
 * Upsert an env var. The unique key is
 * `(org_id, scope, site_id, mcp_provider, endpoint_id, agent_id, key)` —
 * re-setting the same tuple replaces the value + description in place.
 *
 * Per-scope PARTIAL unique indexes enforce uniqueness within their slot (see
 * migration 0041 + 0045). Because each scope has its own partial index (there is
 * no single composite unique constraint), the ON CONFLICT target is built
 * per-scope to match the relevant index — see the `conflictTarget` map below.
 *
 * @returns The masked {@link EnvVar} representation of the stored row.
 */
export async function setEnvVar(env: Env, args: SetEnvVarArgs): Promise<EnvVar> {
  validateScopeFields(args);
  const now = Date.now();
  const id = crypto.randomUUID();
  const valueEncrypted = await encrypt(env, args.value);
  const isSecret = args.isSecret === undefined ? 1 : args.isSecret ? 1 : 0;
  const exposedToAi = args.exposedToAi === undefined ? 1 : args.exposedToAi ? 1 : 0;
  const siteId = args.scope === 'site' ? (args.siteId ?? null) : null;
  const mcpProvider = args.scope === 'mcp' ? (args.mcpProvider ?? null) : null;
  const endpointId = args.scope === 'endpoint' ? (args.endpointId ?? null) : null;
  const agentId = args.scope === 'agent' ? (args.agentId ?? null) : null;

  // Each scope has its OWN partial unique index (migration 0041 + 0045):
  //   uniq_env_vars_<scope> ON (org_id, <slot>, key) WHERE scope='<scope>' AND deleted_at IS NULL
  // A single unified `ON CONFLICT(org_id, scope, COALESCE(...), key)` target matches
  // NONE of them → SQLITE_ERROR "ON CONFLICT clause does not match any PRIMARY KEY or
  // UNIQUE constraint", so EVERY create/upsert failed (surfaced as a misleading 400).
  // The conflict target must match the ONE partial index for this row's scope — its
  // exact columns AND its exact WHERE predicate.
  const conflictTarget: Record<EnvVarScope, string> = {
    org: `(org_id, key) WHERE scope = 'org' AND deleted_at IS NULL`,
    site: `(org_id, site_id, key) WHERE scope = 'site' AND deleted_at IS NULL`,
    mcp: `(org_id, mcp_provider, key) WHERE scope = 'mcp' AND deleted_at IS NULL`,
    endpoint: `(org_id, endpoint_id, key) WHERE scope = 'endpoint' AND deleted_at IS NULL`,
    agent: `(org_id, agent_id, key) WHERE scope = 'agent' AND deleted_at IS NULL`,
  };
  const sql = `
    INSERT INTO ai_env_vars
      (id, org_id, scope, site_id, mcp_provider, endpoint_id, agent_id, key,
       value_encrypted, description, is_secret, exposed_to_ai, created_by,
       created_at, updated_at, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT ${conflictTarget[args.scope]} DO UPDATE SET
      value_encrypted = excluded.value_encrypted,
      description = excluded.description,
      is_secret = excluded.is_secret,
      exposed_to_ai = excluded.exposed_to_ai,
      updated_at = excluded.updated_at,
      deleted_at = NULL
  `;
  const { error } = await dbExecute(env.DB, sql, [
    id,
    args.orgId,
    args.scope,
    siteId,
    mcpProvider,
    endpointId,
    agentId,
    args.key,
    valueEncrypted,
    args.description ?? null,
    isSecret,
    exposedToAi,
    args.createdBy ?? null,
    now,
    now,
  ]);
  if (error) throw new Error(`setEnvVar failed: ${error}`);

  // Re-fetch the canonical row (may be the upsert target, not the new id).
  const row = await dbQueryOne<EnvVarRow>(
    env.DB,
    `SELECT * FROM ai_env_vars
       WHERE org_id = ? AND scope = ?
         AND COALESCE(site_id, '') = COALESCE(?, '')
         AND COALESCE(mcp_provider, '') = COALESCE(?, '')
         AND COALESCE(endpoint_id, '') = COALESCE(?, '')
         AND COALESCE(agent_id, '') = COALESCE(?, '')
         AND key = ?
         AND deleted_at IS NULL`,
    [args.orgId, args.scope, siteId, mcpProvider, endpointId, agentId, args.key],
  );
  if (!row) throw new Error('setEnvVar: stored row not found after upsert');
  return rowToEnvVar(env, row, false);
}

/**
 * List env vars for an org, optionally filtered by scope/site/mcp/endpoint/agent.
 * NEVER returns plaintext unless `opts.unmask === true` is explicitly passed
 * (server-side only — see {@link ListEnvVarsOpts.unmask}).
 *
 * Order: scope rank (org→site→mcp→endpoint→agent), then key alphabetical.
 */
export async function listEnvVars(
  env: Env,
  orgId: string,
  opts: ListEnvVarsOpts = {},
): Promise<EnvVar[]> {
  const where: string[] = ['org_id = ?', 'deleted_at IS NULL'];
  const params: unknown[] = [orgId];
  if (opts.scope) {
    where.push('scope = ?');
    params.push(opts.scope);
  }
  if (opts.siteId) {
    where.push('site_id = ?');
    params.push(opts.siteId);
  }
  if (opts.mcpProvider) {
    where.push('mcp_provider = ?');
    params.push(opts.mcpProvider);
  }
  if (opts.endpointId) {
    where.push('endpoint_id = ?');
    params.push(opts.endpointId);
  }
  if (opts.agentId) {
    where.push('agent_id = ?');
    params.push(opts.agentId);
  }
  const sql = `
    SELECT * FROM ai_env_vars
     WHERE ${where.join(' AND ')}
     ORDER BY CASE scope
                WHEN 'org' THEN 0
                WHEN 'site' THEN 1
                WHEN 'mcp' THEN 2
                WHEN 'endpoint' THEN 3
                WHEN 'agent' THEN 4
                ELSE 5
              END,
              key ASC
  `;
  const { data } = await dbQuery<EnvVarRow>(env.DB, sql, params);
  const out: EnvVar[] = [];
  for (const row of data) {
    out.push(await rowToEnvVar(env, row, opts.unmask === true));
  }
  return out;
}

/**
 * Soft-delete an env var (`deleted_at = now`). Returns true when a row was
 * actually flipped (id present + not already deleted), false otherwise.
 */
export async function deleteEnvVar(env: Env, orgId: string, id: string): Promise<boolean> {
  const now = Date.now();
  const { error, changes } = await dbExecute(
    env.DB,
    `UPDATE ai_env_vars SET deleted_at = ?, updated_at = ?
       WHERE org_id = ? AND id = ? AND deleted_at IS NULL`,
    [now, now, orgId, id],
  );
  if (error) throw new Error(`deleteEnvVar failed: ${error}`);
  return changes > 0;
}

/**
 * Resolve the effective env-var set for an AI/LLM call. Merges in priority
 * order:
 *
 *   org → site → mcp → endpoint → agent
 *
 * Each later scope OVERRIDES earlier scopes when the same key is defined at
 * multiple levels. Only rows with `exposed_to_ai = 1` and `deleted_at IS NULL`
 * are included. Values are decrypted.
 *
 * ## Example
 *
 * Given:
 * - org-scope `API_TOKEN=org-default`
 * - site-scope `API_TOKEN=site-override`
 * - agent-scope `API_TOKEN=agent-override` (agentId=foo)
 *
 * `resolveEnvVarsForAI(env, { orgId, siteId, agentId: 'foo' })` returns
 * `{ API_TOKEN: 'agent-override' }` — agent beats site beats org.
 *
 * Call this inside any LLM/tool-call dispatch path (see
 * {@link ../services/external_llm.ts} and {@link ../services/mcp_client.ts})
 * to surface user-defined env vars to the AI.
 */
export async function resolveEnvVarsForAI(
  env: Env,
  args: ResolveEnvVarsArgs,
): Promise<Record<string, string>> {
  // Pull all candidate rows in one query — keeps the merge in-memory.
  const orClauses: string[] = [`scope = 'org'`];
  const params: unknown[] = [args.orgId];
  if (args.siteId) {
    orClauses.push(`(scope = 'site' AND site_id = ?)`);
    params.push(args.siteId);
  }
  if (args.mcpProvider) {
    orClauses.push(`(scope = 'mcp' AND mcp_provider = ?)`);
    params.push(args.mcpProvider);
  }
  if (args.endpointId) {
    orClauses.push(`(scope = 'endpoint' AND endpoint_id = ?)`);
    params.push(args.endpointId);
  }
  if (args.agentId) {
    orClauses.push(`(scope = 'agent' AND agent_id = ?)`);
    params.push(args.agentId);
  }
  const conds: string[] = [
    'org_id = ?',
    'deleted_at IS NULL',
    'exposed_to_ai = 1',
    `(${orClauses.join(' OR ')})`,
  ];

  const sql = `SELECT * FROM ai_env_vars WHERE ${conds.join(' AND ')}`;
  const { data } = await dbQuery<EnvVarRow>(env.DB, sql, params);

  // Merge in scope-precedence order: org < site < mcp < endpoint < agent.
  const merged: Record<string, string> = {};
  const byScope: Record<EnvVarScope, EnvVarRow[]> = {
    org: [],
    site: [],
    mcp: [],
    endpoint: [],
    agent: [],
  };
  for (const row of data) byScope[row.scope].push(row);
  for (const scope of SCOPE_ORDER) {
    for (const row of byScope[scope]) {
      try {
        merged[row.key] = await decrypt(env, row.value_encrypted);
      } catch (err) {
        console.warn(
          JSON.stringify({
            service: 'ai_env_vars',
            event: 'resolve_decrypt_failed',
            id: row.id,
            scope: row.scope,
            key: row.key,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }
  }
  return merged;
}

/**
 * Resolve the effective env-var set for a site's **Functions** endpoints
 * (ADR-0035 §6, Stage 4.1) — the `env.SECRETS.<KEY>` map the runtime injects.
 *
 * Merges **org → site** (site overrides org on a key clash). Unlike
 * {@link resolveEnvVarsForAI}, it does NOT filter on `exposed_to_ai`: a site's
 * `functions/` code is the OWNER's own code, so it receives ALL of the org+site
 * env-vars, not only those flagged for the AI context. Values are decrypted; a
 * per-row decrypt failure is logged + skipped (fail-soft) so one bad row can't
 * strand the rest.
 *
 * @returns `{ KEY: value }`, decrypted, org-then-site merged
 * @example await resolveEnvVarsForFunctions(env, orgId, siteId) // { STRIPE_KEY: 'sk_…' }
 */
export async function resolveEnvVarsForFunctions(
  env: Env,
  orgId: string,
  siteId: string,
): Promise<Record<string, string>> {
  const sql = `SELECT * FROM ai_env_vars
     WHERE org_id = ? AND deleted_at IS NULL
       AND (scope = 'org' OR (scope = 'site' AND site_id = ?))`;
  const { data } = await dbQuery<EnvVarRow>(env.DB, sql, [orgId, siteId]);
  const merged: Record<string, string> = {};
  // org first, site second → site overrides org on a key clash.
  for (const scope of ['org', 'site'] as const) {
    for (const row of data) {
      if (row.scope !== scope) continue;
      try {
        merged[row.key] = await decrypt(env, row.value_encrypted);
      } catch (err) {
        console.warn(
          JSON.stringify({
            service: 'ai_env_vars',
            event: 'functions_resolve_decrypt_failed',
            id: row.id,
            scope: row.scope,
            key: row.key,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }
  }
  return merged;
}

/**
 * Append a `## Custom environment` block to a system prompt listing each
 * resolved key as `KEY=VALUE`. Returns the augmented system prompt unchanged
 * when `resolved` is empty (so callers can chain unconditionally).
 *
 * The format is deliberately bash-compatible so the LLM can quote values
 * verbatim into tool calls or code snippets.
 */
export function injectIntoSystemPrompt(
  systemPrompt: string,
  resolved: Record<string, string>,
): string {
  const keys = Object.keys(resolved);
  if (keys.length === 0) return systemPrompt;
  const lines = keys
    .sort()
    .map((k) => `${k}=${resolved[k]}`)
    .join('\n');
  const block = `\n\n## Custom environment\n${lines}`;
  return `${systemPrompt}${block}`;
}
