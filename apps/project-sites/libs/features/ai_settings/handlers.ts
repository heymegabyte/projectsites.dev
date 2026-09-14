/**
 * @module libs/features/ai_settings/handlers
 *
 * @description
 * Hono routes for a site's **per-site AI configuration** — the router prompt,
 * chat persona/system prompt, contact + reply email, brand/locale echo, the
 * web-research + Drive-connection state read-back, the "Improve with AI" rewrite
 * helper, and the per-site monthly AI **credit cap**. Every route requires both
 * an `orgId` and a `userId` on the request context — the {@link need} helper
 * throws `HTTPError(401)` when either is missing — and guards site ownership
 * through {@link siteOwned} (404, never 403, on a missing/foreign site so
 * cross-org sites never leak).
 *
 * | Method | Path                                          | Auth         | Purpose                                                   |
 * | ------ | --------------------------------------------- | ------------ | -------------------------------------------------------- |
 * | GET    | /api/sites/:siteId/ai-settings                | orgId+userId | Read router prompt + chat persona + contact + Drive state |
 * | PUT    | /api/sites/:siteId/ai-settings                | orgId+userId | Upsert per-site AI settings (partial saves; email-gated)  |
 * | POST   | /api/sites/:siteId/ai-settings/improve        | orgId+userId | LLM-rewrite a persona / system-prompt string (Workers AI) |
 * | GET    | /api/sites/:siteId/credit-cap                 | orgId+userId | Read the site's monthly AI credit cap                     |
 * | PUT    | /api/sites/:siteId/credit-cap                 | orgId+userId | Set / clear the site's monthly AI credit cap              |
 *
 * Extracted VERBATIM from the `ai_admin.ts` monolith (route-decomposition
 * installment 18) — only the route-registration receiver changed (`aiAdmin.` →
 * `aiSettings.`); the handler bodies are byte-for-byte unchanged. The module
 * imports its error/auth scaffolding (the `HTTPError` class, the `need(c)` /
 * `siteOwned(...)` helpers, and a byte-identical `onError`) from the SHARED
 * `src/lib/ai_admin_kit.ts` kit — no local copies — so behavior is identical: it
 * contains ONLY these ai_admin-sourced routes, so exact reproduction =
 * byte-identical behavior (no re-throw needed — this module has no pre-existing
 * shared-`AppError` routes to fall through to). Bodies are read via a raw `as {…}`
 * cast + `.catch(() => ({}))` rather than a Zod schema at the boundary (the PUT
 * ai-settings handler layers its own `z`-based email gate inline), so there is no
 * `schemas.ts` — the moved handlers keep their original in-body validation.
 *
 * @packageDocumentation
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { Env, Variables } from '../../../src/types/env.js';
import {
  HTTPError,
  need,
  siteOwned,
  safeJson,
  aiAdminOnError,
} from '../../../src/lib/ai_admin_kit.js';
import {
  DEFAULT_ROUTER_PROMPT,
  DEFAULT_CHAT_SYSTEM_PROMPT,
} from '../../../src/services/form_router.js';
import { dbQuery } from '../../../src/services/db.js';
import * as auditService from '../../../src/services/audit.js';

type AppContext = { Bindings: Env; Variables: Variables };

export const aiSettings = new Hono<AppContext>();

// Error/auth scaffolding (HTTPError · need · siteOwned · onError) is shared via
// src/lib/ai_admin_kit.ts — imported above (route-decomposition installment 18).
// Byte-identical behavior to the ai_admin.ts inline copies; see the kit module
// doc for the siteOwned-vs-requireOwnedSite rationale.
aiSettings.onError(aiAdminOnError);

/* ────────────────────────── AI Site Settings (router prompt + chat + contact) ────────────────────────── */

/**
 * `GET /api/sites/:siteId/ai-settings` — Fetch the per-site AI router prompt,
 * chat persona, contact email and Google Drive connection state.
 *
 * @remarks
 * Returns sane defaults from {@link DEFAULT_ROUTER_PROMPT} and
 * {@link DEFAULT_CHAT_SYSTEM_PROMPT} when the row has never been written,
 * plus a `drive_connected` boolean derived from whether an encrypted access
 * token is on file (never returns the token itself).
 *
 * @throws 401 UNAUTHORIZED when org/user context is missing.
 * @throws 403 FORBIDDEN when the site is not owned by the caller's org.
 */
aiSettings.get('/api/sites/:siteId/ai-settings', async (c) => {
  const { orgId } = need(c);
  const siteId = c.req.param('siteId');
  const site = await siteOwned(c, orgId, siteId);
  const row = await c.env.DB.prepare(
    `SELECT chat_persona, chat_system_prompt, form_router_prompt, reply_email,
            contact_email, brand_tone, brand_primary, brand_accent, timezone,
            default_locale, search_synonyms_json, enabled_mcps_json, updated_at,
            allow_web_research, drive_folder_id, drive_folder_name,
            drive_last_synced_at,
            CASE WHEN drive_access_token_enc IS NOT NULL THEN 1 ELSE 0 END AS drive_connected
     FROM ai_site_settings WHERE site_id = ?`,
  )
    .bind(siteId)
    .first<Record<string, string | number | null>>();
  return c.json({
    data: {
      site_id: siteId,
      slug: site.slug,
      business_name: site.business_name,
      chat_persona: (row?.chat_persona as string | null) ?? null,
      chat_system_prompt: (row?.chat_system_prompt as string | null) ?? null,
      chat_system_prompt_default: DEFAULT_CHAT_SYSTEM_PROMPT,
      form_router_prompt: (row?.form_router_prompt as string | null) ?? null,
      form_router_prompt_default: DEFAULT_ROUTER_PROMPT,
      // The forms-designer MCP selection (which connected MCPs the router may use).
      // Returned so the designer's pills reflect the SERVER value cross-device, not
      // just the localStorage cache.
      enabled_mcps: ((): string[] => {
        try {
          const arr = JSON.parse((row?.enabled_mcps_json as string | null) ?? '[]');
          return Array.isArray(arr) ? arr.filter((v): v is string => typeof v === 'string') : [];
        } catch {
          return [];
        }
      })(),
      reply_email: (row?.reply_email as string | null) ?? null,
      contact_email: (row?.contact_email as string | null) ?? null,
      brand_tone: (row?.brand_tone as string | null) ?? null,
      // Settings → General brand + locale (0611) — returned so the tab reloads
      // the saved values instead of reverting to hardcoded FE defaults.
      brand_primary: (row?.brand_primary as string | null) ?? null,
      brand_accent: (row?.brand_accent as string | null) ?? null,
      timezone: (row?.timezone as string | null) ?? null,
      default_locale: (row?.default_locale as string | null) ?? null,
      search_synonyms: row?.search_synonyms_json
        ? safeJson(row.search_synonyms_json as string)
        : {},
      allow_web_research: !!row?.allow_web_research,
      drive_connected: !!row?.drive_connected,
      drive_folder_id: (row?.drive_folder_id as string | null) ?? null,
      drive_folder_name: (row?.drive_folder_name as string | null) ?? null,
      drive_last_synced_at: (row?.drive_last_synced_at as string | null) ?? null,
      updated_at: (row?.updated_at as string | null) ?? null,
    },
  });
});

/**
 * `PUT /api/sites/:siteId/ai-settings` — Update the per-site AI settings
 * (router prompt, chat persona, contact email, web-research toggle, etc.).
 *
 * @remarks
 * Body accepts any subset of: `chat_persona`, `chat_system_prompt`,
 * `form_router_prompt`, `reply_email`, `contact_email`, `brand_tone`,
 * `search_synonyms_json`, `allow_web_research`. Performs an upsert and
 * writes an audit entry on success.
 *
 * @throws 401 UNAUTHORIZED when org/user context is missing.
 * @throws 403 FORBIDDEN when the site is not owned by the caller's org.
 */
aiSettings.put('/api/sites/:siteId/ai-settings', async (c) => {
  const { orgId } = need(c);
  const siteId = c.req.param('siteId');
  await siteOwned(c, orgId, siteId);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  // FE↔BE parity ([[zod-everywhere]]): contact_email/reply_email are validated on
  // the FE (`emailInvalid()`); gate the raw API too so a NON-empty value must be a
  // real email (≤254 chars). '' or null clears the field; omitted keys stay
  // untouched (partial saves — e.g. the lone `{allow_web_research}` toggle).
  // `.passthrough()` leaves every other field to the existing allow-list below.
  const emailField = z.union([z.literal(''), z.null(), z.string().email().max(254)]).optional();
  const emailGate = z
    .object({ reply_email: emailField, contact_email: emailField })
    .passthrough()
    .safeParse(body);
  if (!emailGate.success) {
    throw new HTTPError(400, 'contact_email and reply_email must be valid email addresses');
  }
  const allowed = [
    // Write path is deliberately narrow: persona/brand/locale columns are
    // read-only here (inferred from the system prompt + logo/content). They
    // stay in the schema for existing rows + the build pipeline that READS them.
    'chat_system_prompt',
    'form_router_prompt',
    'reply_email',
    'contact_email',
  ] as const;
  const fields: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const k of allowed) if (k in body) fields[k] = body[k];
  if ('allow_web_research' in body) {
    fields['allow_web_research'] = body['allow_web_research'] ? 1 : 0;
  }
  if ('search_synonyms' in body)
    fields['search_synonyms_json'] = JSON.stringify(body['search_synonyms']);
  // The forms-designer MCP selection — an array of connected-provider ids the
  // form router may use. MUST stay allow-listed: the router filters
  // `loadAvailableTools` by it, so an unpersisted selection is a lying-success.
  if ('enabled_mcps' in body) {
    const arr = Array.isArray(body['enabled_mcps'])
      ? (body['enabled_mcps'] as unknown[]).filter((v): v is string => typeof v === 'string')
      : [];
    fields['enabled_mcps_json'] = JSON.stringify(arr);
  }
  const existing = await c.env.DB.prepare(`SELECT 1 FROM ai_site_settings WHERE site_id = ?`)
    .bind(siteId)
    .first();
  if (existing) {
    const cols = Object.keys(fields);
    const set = cols.map((k) => `${k} = ?`).join(', ');
    await c.env.DB.prepare(`UPDATE ai_site_settings SET ${set} WHERE site_id = ?`)
      .bind(...cols.map((k) => fields[k]), siteId)
      .run();
  } else {
    const cols = ['site_id', ...Object.keys(fields)];
    const placeholders = cols.map(() => '?').join(', ');
    await c.env.DB.prepare(
      `INSERT INTO ai_site_settings (${cols.join(', ')}) VALUES (${placeholders})`,
    )
      .bind(siteId, ...Object.keys(fields).map((k) => fields[k]))
      .run();
  }

  const siteLabel = await auditService.auditSiteLabelDb(c.env.DB, siteId);
  c.executionCtx.waitUntil(
    auditService.writeAuditLog(c.env.DB, {
      org_id: orgId,
      actor_id: c.get('userId') ?? null,
      action: 'ai_settings.updated',
      message: `AI settings updated for site '${siteLabel}' (${Object.keys(fields)
        .filter((k) => k !== 'updated_at')
        .join(', ')})`,
      target_type: 'ai_site_settings',
      target_id: siteId,
      metadata_json: {
        site_id: siteId,
        fields_changed: Object.keys(fields).filter((k) => k !== 'updated_at'),
      },
      request_id: c.get('requestId'),
    }),
  );

  return c.json({ data: { saved: true } });
});

/* ────────────────────────── AI Chat field "Improve with AI" ────────────────────────── */
// Rewrites a single persona or system-prompt string with the org's brand AI.
// Field type controls the rewrite goal: persona = one-line voice note; system =
// detailed instruction set. Always reads + sends the current contact_email +
// brand_tone so the rewrite stays in voice.
/**
 * `POST /api/sites/:siteId/ai-settings/improve` — Ask the AI to rewrite the
 * site's chat persona / router prompt for tone or coverage gaps.
 *
 * @remarks
 * Body: `{ target: 'persona' | 'router', instruction?: string }`. Calls
 * Workers AI Llama 3.3 70B with the existing prompt as seed and returns
 * the improved version for the user to accept before saving.
 *
 * @throws 401 UNAUTHORIZED when org/user context is missing.
 * @throws 403 FORBIDDEN when the site is not owned by the caller's org.
 */
aiSettings.post('/api/sites/:siteId/ai-settings/improve', async (c) => {
  const { orgId } = need(c);
  const siteId = c.req.param('siteId');
  await siteOwned(c, orgId, siteId);
  const body = (await c.req.json().catch(() => ({}))) as {
    field?: 'persona' | 'system';
    value?: string;
  };
  const field = body.field === 'persona' || body.field === 'system' ? body.field : 'persona';
  const value = (body.value ?? '').trim();

  const brand = await c.env.DB.prepare(
    `SELECT brand_tone, contact_email FROM ai_site_settings WHERE site_id = ?`,
  )
    .bind(siteId)
    .first<{ brand_tone: string | null; contact_email: string | null }>();
  const tone = brand?.brand_tone?.trim() || 'warm, plainspoken, never pushy';

  const goal =
    field === 'persona'
      ? 'Rewrite the chat persona — one short sentence (≤15 words) describing the voice the AI should use.'
      : 'Rewrite this AI chat system prompt to be tighter, clearer, more actionable. Keep all factual constraints. Add 1-3 concrete behavioral rules if the original lacks them. Plain English, no marketing fluff.';
  const sys = `You are a senior brand copy editor. Brand tone: "${tone}". ${goal} Return ONLY the rewritten text — no quotes, no preamble.`;
  const user =
    value ||
    (field === 'persona'
      ? 'A helpful concierge.'
      : 'You are a helpful AI for this business. Be concise.');

  try {
    const result = (await c.env.AI.run(
      '@cf/meta/llama-3.1-8b-instruct-fp8' as Parameters<typeof c.env.AI.run>[0],
      {
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user },
        ],
        max_tokens: 250,
      } as Parameters<typeof c.env.AI.run>[1],
    )) as { response?: string };
    const improved = (result?.response ?? '').replace(/^["']|["']$/g, '').trim();
    return c.json({ data: { field, original: value, improved: improved || value, tone } });
  } catch (err) {
    return c.json(
      {
        error: {
          code: 'AI_UNAVAILABLE',
          message: err instanceof Error ? err.message : 'AI is offline right now',
        },
      },
      502,
    );
  }
});

/* ────────────────────────── Per-site AI credit cap ────────────────────────── */

/**
 * `GET /api/credit-caps` — Batch-read EVERY site's monthly AI credit cap for the
 * caller's org in ONE org-scoped query.
 *
 * @remarks
 * Kills an N+1 waterfall on the admin billing page, which previously fired one
 * `GET /api/sites/:siteId/credit-cap` per site (~110 sequential requests / ~9s
 * load on a large roster) purely to seed each row's cap draft. This returns the
 * whole set at once. Only rows the caller's org owns are returned (`WHERE org_id
 * = ?`), so no cross-org cap ever leaks. Sites without a cap row simply don't
 * appear — the client treats a missing entry as "no cap", identical to the
 * single-site route's `monthly_credit_cap: null`.
 *
 * @returns `{ data: Array<{ site_id: string; monthly_credit_cap: number | null }> }`
 * @throws 401 UNAUTHORIZED when org/user context is missing.
 */
aiSettings.get('/api/credit-caps', async (c) => {
  const { orgId } = need(c);
  const { data } = await dbQuery<{ site_id: string; monthly_credit_cap: number | null }>(
    c.env.DB,
    `SELECT site_id, monthly_credit_cap FROM site_credit_caps WHERE org_id = ?`,
    [orgId],
  );
  return c.json({ data });
});

aiSettings.get('/api/sites/:siteId/credit-cap', async (c) => {
  const { orgId } = need(c);
  const row = await c.env.DB.prepare(
    `SELECT site_id, monthly_credit_cap, updated_at FROM site_credit_caps WHERE org_id = ? AND site_id = ?`,
  )
    .bind(orgId, c.req.param('siteId'))
    .first<{ site_id: string; monthly_credit_cap: number; updated_at: string }>();
  return c.json({ data: row ?? { site_id: c.req.param('siteId'), monthly_credit_cap: null } });
});

/**
 * `PUT /api/sites/:siteId/credit-cap` — Set the monthly credit cap for a
 * single site.
 *
 * @remarks
 * Body: `{ cap: number | null }`. `null` removes the cap. Caps are soft
 * — exceeding them disables AI features until the next month rolls over
 * or the cap is raised.
 *
 * @throws 401 UNAUTHORIZED when org/user context is missing.
 * @throws 403 FORBIDDEN when the site is not owned by the caller's org.
 */
aiSettings.put('/api/sites/:siteId/credit-cap', async (c) => {
  const { orgId } = need(c);
  const body = (await c.req.json().catch(() => ({}))) as { monthly_credit_cap?: number | null };
  const cap =
    body.monthly_credit_cap == null
      ? null
      : Math.max(0, Math.min(1_000_000, Number(body.monthly_credit_cap) || 0));
  await c.env.DB.prepare(
    `INSERT INTO site_credit_caps (org_id, site_id, monthly_credit_cap, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(org_id, site_id) DO UPDATE SET monthly_credit_cap = excluded.monthly_credit_cap, updated_at = excluded.updated_at`,
  )
    .bind(orgId, c.req.param('siteId'), cap)
    .run();
  return c.json({ data: { site_id: c.req.param('siteId'), monthly_credit_cap: cap } });
});
