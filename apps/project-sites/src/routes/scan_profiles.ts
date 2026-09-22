/**
 * Scan-profile CRUD route (SCOPE.md:68) — the editable "what to hunt" config for
 * the automatic Lead Scanner, persisted in D1.
 *
 * `GET/POST/PATCH/DELETE /api/admin/scan-profiles` expose the pure profile
 * contract ({@link ScanProfileConfigSchema} in `services/scan_profiles.ts` —
 * geo bboxes / categories / providers / filters / cadence) over HTTP so the
 * Super-Admin scanner UI can create, tune, pause and delete profiles, and the
 * cron geo-sweep can iterate the due ones.
 *
 * Guards (in order), matching every sibling lead-scanner route:
 *   auth required (401) → flag-gated `scan_profiles` (404, never 403, so the
 *   feature's existence never leaks) → super-admin (403) → Zod `safeParse`
 *   (400) → store.
 *
 * Ownership: this is a platform-operator surface (the lead scanner is
 * super-admin only), so the tenant boundary is the ORG on the profile row, not
 * a site. Every store call is org-scoped by `row.org_id` (and the UPDATE/DELETE
 * WHERE clauses carry `org_id` too) — no `assertSiteOwned` here because no
 * route takes a `:siteId`.
 *
 * @packageDocumentation
 */

import { Hono } from 'hono';
import { z } from 'zod';

import type { Env, Variables } from '../types/env.js';
import { isFlagOn } from '../modules/feature_flags/services.js';
import { isSuperAdmin } from '../services/sysadmin.js';
import { uuidv7 } from '../lib/uuid.js';
import { ScanProfileConfigSchema, defaultScanProfile } from '../services/scan_profiles.js';
import {
  listScanProfiles,
  insertScanProfile,
  updateScanProfile,
  deleteScanProfile,
  getScanProfile,
} from '../services/scan_profile_store.js';

/** Feature flag key gating every scan-profile route. */
export const SCAN_PROFILES_FLAG = 'scan_profiles';

/** The editable fields a create accepts — `id`/`lastRunAt` are server-owned. */
const CreateBodySchema = ScanProfileConfigSchema.omit({ id: true, lastRunAt: true })
  .partial({ enabled: true, categories: true, providers: true, filters: true, source: true })
  .strict();

/** A PATCH is any subset of the editable fields, but at least one. */
const UpdateBodySchema = ScanProfileConfigSchema.omit({ id: true })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Empty patch' });

const ListQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(200).optional() })
  .strip();

/** Build the RFC7807-ish error envelope used across the worker. */
function errorBody(code: string, message: string, requestId: string | undefined) {
  return { error: { code, message, request_id: requestId ?? null } };
}

/**
 * Run the auth → flag (404, never 403) → super-admin (403) gate chain shared by
 * every scan-profile route. Returns a JSON error Response to short-circuit, or
 * `null` when the caller is an authorized super-admin.
 */
async function gateScanProfiles(
  c: import('hono').Context<{ Bindings: Env; Variables: Variables }>,
): Promise<Response | null> {
  const requestId = c.get('requestId');
  const userId = c.get('userId');
  if (!userId) return c.json(errorBody('UNAUTHORIZED', 'Sign in required', requestId), 401);
  if (!(await isFlagOn(c.env, SCAN_PROFILES_FLAG, { orgId: c.get('orgId'), userId }))) {
    return c.json(errorBody('NOT_FOUND', 'Not found', requestId), 404);
  }
  if (!(await isSuperAdmin(c.env, userId))) {
    return c.json(errorBody('FORBIDDEN', 'Super-admin access required', requestId), 403);
  }
  return null;
}

export const scanProfiles = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * `GET /api/admin/scan-profiles` — list the platform's live scan profiles
 * (newest first) for the Super-Admin scanner UI. Read-only.
 */
scanProfiles.get('/api/admin/scan-profiles', async (c) => {
  const requestId = c.get('requestId');
  const blocked = await gateScanProfiles(c);
  if (blocked) return blocked;

  const parsed = ListQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json(errorBody('VALIDATION_ERROR', 'Invalid list query', requestId), 400);
  }

  const profiles = await listScanProfiles(
    c.env.DB,
    c.get('orgId') ?? 'system',
    parsed.data.limit ?? 100,
  );
  return c.json({ profiles, count: profiles.length }, 200);
});

/**
 * `POST /api/admin/scan-profiles` — create a scan profile. The body is the
 * editable config (Zod `safeParse`, 400 on failure); `id` is a server-minted
 * UUIDv7 and `lastRunAt` starts null. Returns 201 with the created profile.
 */
scanProfiles.post('/api/admin/scan-profiles', async (c) => {
  const requestId = c.get('requestId');
  const blocked = await gateScanProfiles(c);
  if (blocked) return blocked;

  const raw = await c.req.json().catch(() => ({}));
  const parsed = CreateBodySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      {
        ...errorBody('VALIDATION_ERROR', 'Invalid scan profile', requestId),
        errors: parsed.error.flatten().fieldErrors,
      },
      400,
    );
  }

  const profile = defaultScanProfile(uuidv7());
  // Overlay the caller's fields onto the starter profile so unspecified keys
  // take the schema defaults (a create with only a name works).
  const merged = ScanProfileConfigSchema.parse({
    ...profile,
    ...parsed.data,
    id: profile.id,
    lastRunAt: null,
  });

  const { error } = await insertScanProfile(c.env.DB, merged, c.get('orgId') ?? 'system');
  if (error) {
    return c.json(errorBody('INTERNAL_ERROR', 'Could not save scan profile', requestId), 500);
  }
  return c.json({ profile: merged }, 201);
});

/**
 * `PATCH /api/admin/scan-profiles/:id` — patch an existing profile. 404 when the
 * profile is missing / soft-deleted / another org's; 400 on an invalid or empty
 * patch body.
 */
scanProfiles.patch('/api/admin/scan-profiles/:id', async (c) => {
  const requestId = c.get('requestId');
  const blocked = await gateScanProfiles(c);
  if (blocked) return blocked;

  const raw = await c.req.json().catch(() => ({}));
  const parsed = UpdateBodySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      {
        ...errorBody('VALIDATION_ERROR', 'Invalid scan profile patch', requestId),
        errors: parsed.error.flatten().fieldErrors,
      },
      400,
    );
  }

  const id = c.req.param('id');
  const orgId = c.get('orgId') ?? 'system';
  const { error, changes } = await updateScanProfile(c.env.DB, orgId, id, parsed.data);
  if (error) {
    return c.json(errorBody('INTERNAL_ERROR', 'Could not update scan profile', requestId), 500);
  }
  if (changes === 0) {
    return c.json(errorBody('NOT_FOUND', 'Scan profile not found', requestId), 404);
  }
  const profile = await getScanProfile(c.env.DB, orgId, id);
  return c.json({ profile, updated: true }, 200);
});

/**
 * `DELETE /api/admin/scan-profiles/:id` — soft-delete a profile (sets
 * `deleted_at`; the row is retained so an undo stays possible). 404 when there
 * is no such live profile.
 */
scanProfiles.delete('/api/admin/scan-profiles/:id', async (c) => {
  const requestId = c.get('requestId');
  const blocked = await gateScanProfiles(c);
  if (blocked) return blocked;

  const { error, changes } = await deleteScanProfile(
    c.env.DB,
    c.get('orgId') ?? 'system',
    c.req.param('id'),
  );
  if (error) {
    return c.json(errorBody('INTERNAL_ERROR', 'Could not delete scan profile', requestId), 500);
  }
  if (changes === 0) {
    return c.json(errorBody('NOT_FOUND', 'Scan profile not found', requestId), 404);
  }
  return c.json({ deleted: true }, 200);
});
