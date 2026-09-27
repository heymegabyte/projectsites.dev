/**
 * @module libs/features/kv_inspector/handlers
 * @description Hono routes for the KV Namespace Inspector feature (flag: `kv_inspector`).
 *
 * | Method | Path                                         | Auth        | Purpose               |
 * | ------ | -------------------------------------------- | ----------- | --------------------- |
 * | GET    | /api/admin/kv/namespaces                     | super-admin | List known bindings   |
 * | GET    | /api/admin/kv/:binding/keys                  | super-admin | Paginated key list    |
 * | GET    | /api/admin/kv/:binding/value                 | super-admin | Get value + metadata  |
 * | PUT    | /api/admin/kv/:binding/value                 | super-admin | Write (create/edit)   |
 * | DELETE | /api/admin/kv/:binding/value                 | super-admin | Delete a key          |
 *
 * Security model:
 *   - All endpoints 404 when the `kv_inspector` flag is off (never 403 — don't leak existence).
 *   - All endpoints 404 when the caller is not a platform super-admin.
 *   - `:binding` is validated against a SERVER-SIDE allowlist — client-supplied names never
 *     reach the KV API. Unknown bindings → 404.
 *   - Writes are size-capped (never round-trip a truncated read back) and mutations are logged
 *     with the actor + resource (never the value). KV is EVENTUALLY CONSISTENT (≤~60s propagation).
 *   - Value responses are size-capped at 64 KiB with a `truncated` flag.
 *
 * @packageDocumentation
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, Variables } from '../../../src/types/env.js';
import { isFlagOn } from '../../../src/modules/feature_flags/services.js';
import { isSuperAdmin } from '../../../src/services/sysadmin.js';
import {
  KV_BINDING_ALLOWLIST,
  KvBindingSchema,
  KvListQuerySchema,
  KvValueQuerySchema,
  KvPutSchema,
  KV_VALUE_MAX_BYTES,
  type KvBinding,
} from './schemas.js';

type AppContext = { Bindings: Env; Variables: Variables };

/** Feature flag key — 404 when off so feature existence is never leaked. */
const FLAG_KEY = 'kv_inspector' as const;

export const kvInspector = new Hono<AppContext>();

// ─── Guards ──────────────────────────────────────────────────────────────────

/** Combined flag+super-admin gate. Returns 404 (not 403) on any failure. */
async function gate(c: Context<AppContext>): Promise<Response | null> {
  const flagOn = await isFlagOn(c.env, FLAG_KEY, {});
  if (!flagOn) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
  }
  const userId = c.get('userId');
  if (!userId) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
  }
  const superAdmin = await isSuperAdmin(c.env, userId);
  if (!superAdmin) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
  }
  return null; // pass
}

/** Resolve a validated binding name to the actual KV namespace on `c.env`. */
function resolveKv(env: Env, binding: KvBinding): KVNamespace {
  return env[binding] as KVNamespace;
}

/**
 * Structured operational telemetry for the KV inspector — the Data-epic's
 * "structured operational telemetry for query failures, freshness, cost" +
 * request-id correlation for Workers Tracing. `console.warn(JSON.stringify(...))`
 * is this repo's structured-log rail (`console.log` is ESLint-blocked). NEVER logs
 * key VALUES — only the operation shape, cost (keys/bytes), outcome, and latency.
 */
function logKv(c: Context<AppContext>, fields: Record<string, unknown>): void {
  console.warn(
    JSON.stringify({
      level: 'info',
      service: 'kv_inspector',
      request_id: c.get('requestId') ?? null,
      ...fields,
    }),
  );
}

// ─── GET /api/admin/kv/namespaces ────────────────────────────────────────────

kvInspector.get('/api/admin/kv/namespaces', async (c) => {
  const block = await gate(c);
  if (block) return block;

  return c.json({ namespaces: [...KV_BINDING_ALLOWLIST] });
});

// ─── GET /api/admin/kv/:binding/keys ─────────────────────────────────────────

kvInspector.get('/api/admin/kv/:binding/keys', async (c) => {
  const block = await gate(c);
  if (block) return block;

  // Validate binding against server allowlist
  const bindingParse = KvBindingSchema.safeParse(c.req.param('binding'));
  if (!bindingParse.success) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Unknown KV binding' } }, 404);
  }
  const binding = bindingParse.data;

  // Validate query params
  const queryParse = KvListQuerySchema.safeParse({
    prefix: c.req.query('prefix'),
    cursor: c.req.query('cursor'),
    limit: c.req.query('limit'),
  });
  if (!queryParse.success) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid query parameters',
          details: queryParse.error.flatten(),
        },
      },
      400,
    );
  }
  const { prefix, cursor, limit } = queryParse.data;

  const kv = resolveKv(c.env, binding);
  const listOpts: KVNamespaceListOptions = {
    limit: Math.min(limit ?? 1000, 1000),
    prefix: prefix,
    cursor: cursor,
  };

  const t0 = Date.now();
  const result = await kv.list(listOpts);
  logKv(c, {
    route: 'kv/keys',
    binding,
    outcome: 'ok',
    keys_returned: result.keys.length,
    list_complete: result.list_complete,
    latency_ms: Date.now() - t0,
  });

  return c.json({
    binding,
    keys: result.keys.map((k) => ({
      name: k.name,
      expiration: k.expiration,
      metadata: k.metadata,
    })),
    list_complete: result.list_complete,
    cursor: result.list_complete ? undefined : (result as { cursor?: string }).cursor,
  });
});

// ─── GET /api/admin/kv/:binding/value ────────────────────────────────────────

kvInspector.get('/api/admin/kv/:binding/value', async (c) => {
  const block = await gate(c);
  if (block) return block;

  // Validate binding against server allowlist
  const bindingParse = KvBindingSchema.safeParse(c.req.param('binding'));
  if (!bindingParse.success) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Unknown KV binding' } }, 404);
  }
  const binding = bindingParse.data;

  // Validate key query param
  const queryParse = KvValueQuerySchema.safeParse({ key: c.req.query('key') });
  if (!queryParse.success) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: '`key` query param is required',
          details: queryParse.error.flatten(),
        },
      },
      400,
    );
  }
  const { key } = queryParse.data;

  const kv = resolveKv(c.env, binding);
  const t0 = Date.now();
  const { value, metadata } = await kv.getWithMetadata(key, { type: 'text' });

  let finalValue: string | null = value;
  let truncated = false;

  if (typeof finalValue === 'string' && finalValue.length > KV_VALUE_MAX_BYTES) {
    finalValue = finalValue.slice(0, KV_VALUE_MAX_BYTES);
    truncated = true;
  }
  logKv(c, {
    route: 'kv/value',
    binding,
    outcome: value === null ? 'miss' : 'ok',
    value_bytes: finalValue ? finalValue.length : 0,
    truncated,
    latency_ms: Date.now() - t0,
  });

  // Calculate approximate TTL: KV does not expose TTL directly, we use expiration
  // from a list call would be expensive. Set to null — callers see metadata for TTL hints.
  const ttl: number | null = null;

  return c.json({
    binding,
    key,
    value: finalValue,
    metadata,
    truncated,
    ttl,
  });
});

/**
 * Compute the `KVNamespace.put` options for a value EDIT that PRESERVES the key's existing metadata +
 * expiration "unless explicitly changed" (the KV epic's mandate) — because CF KV `put()` REPLACES the
 * whole entry: omitting `metadata` wipes it, and omitting expiration makes a TTL'd key permanent.
 *
 * Rules (in precedence): an explicit `expirationTtl` WINS (a deliberate new TTL). Else `clearExpiration`
 * makes the key PERMANENT (the explicit opt-in to drop a TTL — do NOT re-apply the existing one). Else
 * the existing absolute `expiration` is re-applied — but only when it's still ≥60s in the future (KV
 * rejects an expiration in the past / under the 60s floor; a near-expired key is left to expire as
 * scheduled). Existing metadata is always re-attached (no metadata-edit path yet → never "explicitly
 * changed"). Returns `undefined` when there's nothing to set (a plain create / cleared + no metadata). Pure.
 *
 * @example buildKvPutOptions({ existingExpiration: 9_999_999_999, nowSec: 1_000 }) // { expiration: 9999999999 }
 * @example buildKvPutOptions({ expirationTtl: 300, existingExpiration: 9e9, nowSec: 1 }) // { expirationTtl: 300 }
 * @example buildKvPutOptions({ clearExpiration: true, existingExpiration: 9e9, nowSec: 1 }) // undefined (permanent)
 */
export function buildKvPutOptions(args: {
  expirationTtl?: number;
  clearExpiration?: boolean;
  existingMetadata?: unknown;
  existingExpiration?: number;
  nowSec: number;
}): { expiration?: number; expirationTtl?: number; metadata?: unknown } | undefined {
  const opts: { expiration?: number; expirationTtl?: number; metadata?: unknown } = {};

  if (args.expirationTtl) {
    opts.expirationTtl = args.expirationTtl; // caller deliberately set a new TTL → honor it
  } else if (args.clearExpiration) {
    // Explicit "make permanent" — deliberately do NOT re-apply the existing expiration.
  } else if (typeof args.existingExpiration === 'number' && args.existingExpiration > args.nowSec + 60) {
    opts.expiration = args.existingExpiration; // preserve the existing absolute expiration (KV floor +60s)
  }

  if (args.existingMetadata !== undefined && args.existingMetadata !== null) {
    opts.metadata = args.existingMetadata; // preserve existing metadata (no metadata-edit UI yet)
  }

  return Object.keys(opts).length > 0 ? opts : undefined;
}

/**
 * Read a single key's existing metadata + absolute expiration so a value edit can PRESERVE them. KV has
 * no exact-key expiration getter, so expiration comes from `list({prefix:key})` matched on the exact
 * name; metadata comes from `getWithMetadata` (exact). Fail-soft (either read failing → that field is
 * left undefined → not preserved, never a thrown write). Eventually consistent, like all KV reads.
 */
async function readKvEntryMeta(
  kv: KVNamespace,
  key: string,
): Promise<{ metadata?: unknown; expiration?: number }> {
  let metadata: unknown;
  let expiration: number | undefined;

  try {
    const gm = await kv.getWithMetadata(key);
    metadata = gm?.metadata ?? undefined;
  } catch {
    /* fail-soft: no metadata preserved */
  }

  try {
    const listed = await kv.list({ prefix: key, limit: 100 });
    const match = listed.keys.find((k) => k.name === key);
    expiration = match?.expiration;

    if ((metadata === undefined || metadata === null) && match?.metadata !== undefined) {
      metadata = match.metadata;
    }
  } catch {
    /* fail-soft: no expiration preserved */
  }

  return { metadata, expiration };
}

// ─── PUT /api/admin/kv/:binding/value ─────────────────────────────────────────
// Write (create/overwrite) a value. Super-admin + flag-dark; binding validated against the server
// allowlist (client-supplied names never reach KV). The value is size-capped (never save a truncated
// read back). KV is EVENTUALLY CONSISTENT — the write may take up to ~60s to propagate globally.
// Preserves the key's existing metadata + expiration unless the caller explicitly sets a new TTL
// (CF KV put() REPLACES the whole entry, so a naive put would silently wipe metadata + clear the TTL).
kvInspector.put('/api/admin/kv/:binding/value', async (c) => {
  const block = await gate(c);
  if (block) return block;

  const bindingParse = KvBindingSchema.safeParse(c.req.param('binding'));
  if (!bindingParse.success) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Unknown KV binding' } }, 404);
  }
  const binding = bindingParse.data;

  const bodyParse = KvPutSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!bodyParse.success) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: `A key and a value ≤${KV_VALUE_MAX_BYTES} bytes are required (expirationTtl ≥ 60s if set).`,
          details: bodyParse.error.flatten(),
        },
      },
      400,
    );
  }
  const { key, value, expirationTtl, clearExpiration } = bodyParse.data;

  const kv = resolveKv(c.env, binding);
  const t0 = Date.now();
  try {
    // Preserve the key's existing metadata + expiration unless the caller explicitly set a new TTL —
    // a bare put() would wipe metadata + clear the TTL (KV replaces the whole entry). Reads are
    // fail-soft (a missing read just means that attribute isn't preserved, never a failed write).
    const { metadata: existingMetadata, expiration: existingExpiration } = await readKvEntryMeta(kv, key);
    const putOptions = buildKvPutOptions({
      expirationTtl,
      clearExpiration,
      existingMetadata,
      existingExpiration,
      nowSec: Math.floor(Date.now() / 1000),
    });
    await kv.put(key, value, putOptions);
  } catch {
    logKv(c, { route: 'kv/put', binding, outcome: 'error', latency_ms: Date.now() - t0 });
    return c.json({ ok: false, error: 'The write failed.' }, 502);
  }
  // Audit the mutation: actor + resource + outcome, NEVER the value written.
  logKv(c, {
    route: 'kv/put',
    binding,
    key,
    actor_id: c.get('userId') ?? null,
    ttl: expirationTtl ?? null,
    value_bytes: value.length,
    outcome: 'ok',
    latency_ms: Date.now() - t0,
  });
  return c.json({ ok: true, binding, key, eventualConsistency: true });
});

// ─── DELETE /api/admin/kv/:binding/value ──────────────────────────────────────
// Delete a key. Super-admin + flag-dark; binding validated against the allowlist. KV.delete is
// idempotent (deleting an absent key succeeds). Eventually consistent (≤~60s global propagation).
kvInspector.delete('/api/admin/kv/:binding/value', async (c) => {
  const block = await gate(c);
  if (block) return block;

  const bindingParse = KvBindingSchema.safeParse(c.req.param('binding'));
  if (!bindingParse.success) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Unknown KV binding' } }, 404);
  }
  const binding = bindingParse.data;

  const queryParse = KvValueQuerySchema.safeParse({ key: c.req.query('key') });
  if (!queryParse.success) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: '`key` query param is required' } }, 400);
  }
  const { key } = queryParse.data;

  const kv = resolveKv(c.env, binding);
  const t0 = Date.now();
  try {
    await kv.delete(key);
  } catch {
    logKv(c, { route: 'kv/delete', binding, outcome: 'error', latency_ms: Date.now() - t0 });
    return c.json({ ok: false, error: 'The delete failed.' }, 502);
  }
  logKv(c, {
    route: 'kv/delete',
    binding,
    key,
    actor_id: c.get('userId') ?? null,
    outcome: 'ok',
    latency_ms: Date.now() - t0,
  });
  return c.json({ ok: true, binding, key, eventualConsistency: true });
});
