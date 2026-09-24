/**
 * @module libs/features/kv_inspector/handlers
 * @description Hono routes for the KV Namespace Inspector feature (flag: `kv_inspector`).
 *
 * | Method | Path                                         | Auth        | Purpose              |
 * | ------ | -------------------------------------------- | ----------- | -------------------- |
 * | GET    | /api/admin/kv/namespaces                     | super-admin | List known bindings  |
 * | GET    | /api/admin/kv/:binding/keys                  | super-admin | Paginated key list   |
 * | GET    | /api/admin/kv/:binding/value                 | super-admin | Get value + metadata |
 *
 * Security model:
 *   - All endpoints 404 when the `kv_inspector` flag is off (never 403 — don't leak existence).
 *   - All endpoints 404 when the caller is not a platform super-admin.
 *   - `:binding` is validated against a SERVER-SIDE allowlist — client-supplied names never
 *     reach the KV API. Unknown bindings → 404.
 *   - Read-only: no write/delete operations exposed.
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

  const result = await kv.list(listOpts);

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
  const { value, metadata } = await kv.getWithMetadata(key, { type: 'text' });

  let finalValue: string | null = value;
  let truncated = false;

  if (typeof finalValue === 'string' && finalValue.length > KV_VALUE_MAX_BYTES) {
    finalValue = finalValue.slice(0, KV_VALUE_MAX_BYTES);
    truncated = true;
  }

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
