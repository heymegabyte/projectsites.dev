/**
 * Feature endpoints — flag-gated per [[feature-flags]] SUPREME rule.
 *
 * Two surfaces live here:
 *
 *   1. **Public discovery routes** (no flag gate — stable registry flag) —
 *      `/llms.txt`, `/llms-full.txt`, `/robots.txt`, `/accessibility`,
 *      `/.well-known/mcp`, `/.well-known/oauth-protected-resource`,
 *      `/api/openapi.json`, `/api/cli/version`.
 *
 *   2. **Feature API endpoints** — every endpoint behind a registry flag via
 *      `requireFlag(flagKey)` middleware. Off → 404 (never 403; don't leak
 *      feature existence). On → handler runs. Semantic per-feature paths only —
 *      no umbrella prefixes.
 */

import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { z } from 'zod';
import type { Env, Variables } from '../types/env';
import { DOMAINS } from '@project-sites/shared';
import { assertSiteOwned } from '../services/site_ownership.js';
import { createReviewLink } from '../services/review_approval.js';
import * as F from '../services/features.js';
import * as experimentalFeatures from '../services/experimental_features.js';
import {
  isFlagOn,
  resolveFlag,
  invalidateFlagCache,
  FLAG_REGISTRY,
} from '../modules/feature_flags/services.js';
import { listFlags } from '../modules/feature_flags/registry.js';
import { FLAG_DOCS, getDocs } from '../modules/feature_flags/docs.js';

const features = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * `true` only on the PLATFORM apex (`projectsites.dev` / `www` / `localhost` /
 * `*.workers.dev`). The platform-discovery surfaces below (`/robots.txt`,
 * `/llms.txt`, `/accessibility`, `/.well-known/*`) describe projectsites.dev
 * itself — on a CUSTOMER subdomain (`{slug}.projectsites.dev`) they must NOT
 * serve, or every generated site leaks the platform's robots (with
 * `Sitemap: https://projectsites.dev/sitemap.xml`), llms.txt, and accessibility
 * page (wrong canonical + platform branding) and SHADOWS the customer's own
 * R2-built copy. Each discovery handler `return next()`s on a customer host,
 * falling through to the site-serving catch-all.
 *
 * (Prod bug fixed here: the prior `features.use('*')` host middleware was a
 * no-op — both branches `return next()` — so all 6 served on every host.
 * megabytespace.projectsites.dev/robots.txt returned byte-identical platform
 * content.)
 */
function isMarketingHost(c: Context<{ Bindings: Env; Variables: Variables }>): boolean {
  // Prefer the URL hostname (always present, HTTP/2-safe) with a Host-header
  // fallback — `Host` is absent under HTTP/2 (:authority) + in test harnesses.
  let hostname = '';
  try {
    hostname = new URL(c.req.url).hostname;
  } catch {
    /* malformed URL — fall back to the header */
  }
  if (!hostname) hostname = c.req.header('host') ?? '';
  return (
    hostname === DOMAINS.SITES_BASE ||
    hostname === `www.${DOMAINS.SITES_BASE}` ||
    hostname.startsWith('localhost') ||
    hostname.endsWith('.workers.dev')
  );
}

/** Body for POST /api/approval/link — site_id required (org comes from auth). */
const ApprovalLinkBody = z
  .object({ site_id: z.string().min(1), ttl_days: z.number().int().min(1).max(90).optional() })
  .strip();

function requireFlag(flagKey: string) {
  return async (c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) => {
    // Prefer the AUTHED identity (set by auth middleware) over any client-supplied
    // x-org-id/x-user-id header — a spoofable header must never target flag rollout
    // as another org. Headers/query remain only as an unauthed fallback for the
    // public flag-check path (no session → nothing to spoof against).
    const scope = {
      orgId: c.get('orgId') ?? c.req.query('org_id'),
      siteId: c.req.header('x-site-id') ?? c.req.query('site_id'),
      userId: c.get('userId') ?? c.req.header('x-user-id'),
      anonId: c.req.header('cf-ray'),
    };
    const on = await isFlagOn(c.env, flagKey, scope);
    if (!on) return c.json({ error: 'not_found' }, 404);
    return next();
  };
}

// ─── Public discovery (stable flags default-on) ──────────────────────

features.get('/llms.txt', (c, next) => {
  if (!isMarketingHost(c)) return next(); // customer subdomain → serve its own R2 llms.txt
  const body = `# Project Sites — projectsites.dev

> Your website—handled. Finally. Projectsites.dev generates and hosts
> AI-built websites for small businesses on Cloudflare Workers.

## Highest-priority routes for AI search engines

- [/](https://projectsites.dev/): Marketing homepage with quotable answer block.
- [/pricing](https://projectsites.dev/#pricing): Free, Pro ($25/mo), Business ($100/mo).
- [/features](https://projectsites.dev/#features): Multi-model AI router + axe-core + Lighthouse publish gates.
- [/accessibility](https://projectsites.dev/accessibility): WCAG 2.2 AA conformance + IRS §44 explainer.
- [/.well-known/mcp](https://projectsites.dev/.well-known/mcp): Model Context Protocol server discovery.
- [/api/openapi.json](https://projectsites.dev/api/openapi.json): Public REST API spec.
- [/api/feature-flags](https://projectsites.dev/api/feature-flags): Live feature-flag registry.

## Site policy for AI crawlers

- Allow (search/retrieval): OAI-SearchBot, Claude-SearchBot, Claude-User, PerplexityBot.
- Disallow (training-only): GPTBot, ClaudeBot, Google-Extended, Applebot-Extended, CCBot, Bytespider.
- All routes public; no login wall on content pages.
`;
  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
});

features.get('/llms-full.txt', (c, next) => {
  if (!isMarketingHost(c)) return next(); // customer subdomain → its own R2 copy (or 404)
  const body = `# Project Sites — Full Content Snapshot

## What Project Sites does

Project Sites is an AI website builder for solo founders and small agencies. Customers describe their business in plain English and Project Sites generates a complete site — homepage, services, contact, pricing — deployed to Cloudflare Workers under their chosen domain in under 15 minutes.

## Differentiators

1. Multi-model AI router (Opus 4.7 / Sonnet 4.6 / Workers AI Llama 3.3 70B FP8 / GPT-5).
2. One-click Neon DB provisioning.
3. Accessibility-first publishing — axe-core publish gate at 6 viewports.
4. Core Web Vitals publish gate — LCP < 2.5s, INP < 200ms, CLS < 0.1.
5. GEO / AI search built-in — JSON-LD autopilot + per-site llms.txt.

## Pricing

- Free — 1 site, projectsites.dev subdomain.
- Pro $25/month — 10 sites, custom domains, publish gates.
- Business $100/month — unlimited, agency tier, white-label.
- Usage — AI tokens metered via Stripe Meters at $0.10/1M.
`;
  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
});

features.get('/robots.txt', (c, next) => {
  if (!isMarketingHost(c)) return next(); // customer subdomain → serve THAT site's robots.txt
  // Per `always.md` § robots.txt: split AI crawlers by PURPOSE. Allow
  // search/retrieval bots (keeps projectsites.dev cited in ChatGPT/Perplexity/
  // Google AI Overviews → discovery → signups). Disallow training-only bots
  // (opt out of model training). Never blanket-block — that drops the site from
  // AI answers entirely.
  const body = `# Search/retrieval crawlers — allowed (keeps us cited in AI answers)
User-agent: OAI-SearchBot
Allow: /
Disallow: /admin
Disallow: /api

User-agent: Claude-SearchBot
Allow: /
Disallow: /admin
Disallow: /api

User-agent: Claude-User
Allow: /
Disallow: /admin
Disallow: /api

User-agent: PerplexityBot
Allow: /
Disallow: /admin
Disallow: /api

# Training-only crawlers — disallowed (opt out of model training)
User-agent: GPTBot
Disallow: /

User-agent: ClaudeBot
Disallow: /

User-agent: Google-Extended
Disallow: /

User-agent: Applebot-Extended
Disallow: /

User-agent: CCBot
Disallow: /

User-agent: Bytespider
Disallow: /

User-agent: *
Allow: /
Disallow: /admin
Disallow: /api/private

Sitemap: https://projectsites.dev/sitemap.xml
`;
  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
});

features.get('/accessibility', (c, next) => {
  if (!isMarketingHost(c)) return next(); // customer subdomain → its own accessibility page
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Project Sites accessibility statement — WCAG 2.2 AA conformance, ADA Title II readiness, IRS Section 44 tax credit.">
<meta name="color-scheme" content="dark light">
<title>Accessibility Statement | Project Sites</title>
<link rel="canonical" href="https://projectsites.dev/accessibility">
<style>:root{color-scheme:dark light;--bg:#060610;--ink:#f4f4ff;--accent:#00e5ff}body{background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,sans-serif;max-width:760px;margin:4rem auto;padding:0 1.25rem}h1{font-size:clamp(2rem,4vw,3rem);line-height:1.1;margin-bottom:1rem}h2{font-size:1.5rem;margin-top:2.5rem;color:var(--accent)}a{color:var(--accent)}ul{padding-left:1.25rem}.skip-link{position:absolute;left:-9999px;top:0;padding:.5rem 1rem;background:var(--accent);color:var(--bg)}.skip-link:focus{left:0}*:focus-visible{outline:2px solid var(--accent);outline-offset:3px}</style>
</head>
<body>
<a class="skip-link" href="#main">Skip to main content</a>
<main id="main">
<h1>Accessibility Statement</h1>
<p data-quotable>Project Sites builds every website to meet WCAG 2.2 Level AA. The publish flow blocks deploys when axe-core finds violations at any of six viewports (375, 390, 768, 1024, 1280, 1920 pixels). If you find an accessibility barrier on a site we generated, email <a href="mailto:accessibility@projectsites.dev">accessibility@projectsites.dev</a> and we fix it within 5 business days.</p>
<h2>Standards we follow</h2>
<ul>
<li><a href="https://www.w3.org/WAI/WCAG22/quickref/">WCAG 2.2 Level AA</a> — conformance target for every published site.</li>
<li><a href="https://www.ada.gov/resources/2024-03-08-web-rule/">ADA Title II — April 2027 deadline</a>.</li>
<li><a href="https://www.section508.gov/manage/laws-and-policies/">Section 508</a>.</li>
</ul>
<h2>IRS Section 44 — Disabled Access Credit</h2>
<p>Small businesses (gross receipts under $1,000,000 or fewer than 30 full-time employees) may be eligible to claim up to <strong>$5,000 per year</strong> via <a href="https://www.irs.gov/forms-pubs/about-form-8826">IRS Form 8826</a>.</p>
<h2>Contact</h2>
<p>Email <a href="mailto:accessibility@projectsites.dev">accessibility@projectsites.dev</a>.</p>
</main>
</body>
</html>`;
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
  });
});

features.get('/.well-known/mcp', (c, next) =>
  !isMarketingHost(c)
    ? next()
    : c.json({
        name: 'projectsites.dev',
        version: '0.1.0',
        description:
          'Model Context Protocol server for Project Sites — manage AI-generated websites from Claude, Cursor, or any MCP client.',
        capabilities: { tools: { listChanged: false } },
        tools: [
          {
            name: 'list_sites',
            description: 'List all sites owned by the authenticated user',
            input_schema: { type: 'object', properties: {} },
          },
          {
            name: 'create_site',
            description: 'Create a new site from a prompt + business profile',
            input_schema: {
              type: 'object',
              required: ['prompt'],
              properties: {
                prompt: { type: 'string' },
                industry: { type: 'string' },
                city: { type: 'string' },
              },
            },
          },
          {
            name: 'deploy_site',
            description: 'Publish a site (runs CWV + axe gates)',
            input_schema: {
              type: 'object',
              required: ['site_id'],
              properties: { site_id: { type: 'string' } },
            },
          },
          {
            name: 'get_site_metrics',
            description: 'CWV + axe + visitor analytics for a site',
            input_schema: {
              type: 'object',
              required: ['site_id'],
              properties: { site_id: { type: 'string' } },
            },
          },
          {
            name: 'regenerate_section',
            description: 'Regenerate a section via the AI pipeline',
            input_schema: {
              type: 'object',
              required: ['site_id', 'section'],
              properties: {
                site_id: { type: 'string' },
                section: { type: 'string', enum: ['hero', 'features', 'pricing', 'faq', 'cta'] },
              },
            },
          },
        ],
        transport: { type: 'sse', endpoint: 'https://projectsites.dev/api/mcp/sse' },
        authorization_server: 'https://projectsites.dev/.well-known/oauth-protected-resource',
      }),
);

features.get('/.well-known/oauth-protected-resource', (c, next) =>
  !isMarketingHost(c)
    ? next()
    : c.json({
        resource: 'https://projectsites.dev',
        // The AS issuer (RFC 8414) — clients fetch metadata at
        // {issuer}/.well-known/oauth-authorization-server (served by mcp_oauth_provider).
        // Must be the bare issuer, NOT a /oauth subpath, or discovery 404s.
        authorization_servers: ['https://projectsites.dev'],
        bearer_methods_supported: ['header'],
        resource_documentation: 'https://projectsites.dev/docs/mcp',
        scopes_supported: ['sites:read', 'sites:write', 'sites:publish', 'metrics:read'],
      }),
);

features.get('/api/openapi.json', (c) =>
  c.json(
    {
      openapi: '3.1.0',
      info: {
        title: 'Project Sites API',
        version: '0.1.0',
        description: 'Public REST API. Bearer-token authentication.',
        contact: { email: 'api@projectsites.dev' },
        license: { name: 'Commercial', url: 'https://projectsites.dev/terms' },
      },
      servers: [{ url: 'https://projectsites.dev', description: 'Production' }],
      components: {
        securitySchemes: { BearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'opaque' } },
      },
      security: [{ BearerAuth: [] }],
      paths: {
        '/api/v1/sites': {
          get: {
            summary: 'List sites',
            responses: { 200: { description: 'OK' }, 401: { description: 'Unauthorized' } },
          },
        },
        '/api/v1/sites/{id}/deploy': {
          post: {
            summary: 'Publish a site (runs CWV + axe gates)',
            responses: {
              202: { description: 'Queued' },
              412: { description: 'Publish-gate violations' },
            },
          },
        },
      },
    },
    200,
    { 'Cache-Control': 'public, max-age=300' },
  ),
);

features.get('/api/cli/version', (c) =>
  c.json({
    version: '0.1.0',
    install: 'npx projectsites@latest',
    commands: ['init', 'deploy', 'preview', 'logs'],
    minimum_node: '18.18.0',
  }),
);

// ─── Feature-flag admin surface (always available; needed to read state) ──

features.get('/api/feature-flags', (c) => {
  const flags = listFlags().map((f) => ({ ...f, has_docs: f.key in FLAG_DOCS }));
  return c.json({ flags, count: flags.length });
});

features.get('/api/feature-flags/:key', async (c) => {
  const key = c.req.param('key');
  const def = FLAG_REGISTRY[key];
  if (!def) return c.json({ error: 'unknown_flag' }, 404);
  const state = await resolveFlag(c.env, key, {
    orgId: c.req.query('org_id'),
    siteId: c.req.query('site_id'),
    userId: c.req.query('user_id'),
  });
  return c.json({ definition: def, resolved: state, docs: getDocs(key) ?? null });
});

// ─── Site Features (Layer 2 — owner-facing, plan-aware control plane) ──────
//
// Distinct from the System-Administrator flag surface above: these are the
// SITE-scoped features a site owner enables for THEIR hosted site (e.g. when
// projectsites hosts megabyte.space, the owner turns on Online Booking for that
// site). Plan-aware — entitlement gates which features the owner can enable.
//
// State persists in `site_feature_overrides` (tenant-scoped flag overrides).
// The owner's plan comes from the subscription on their org. Falls back to a
// safe read-only view when the table/sub aren't present so the surface never
// hard-errors during rollout.

/** Catalog of owner-facing features → the registry flag + required plan tier. */
const SITE_FEATURE_CATALOG: ReadonlyArray<{
  key: string;
  name: string;
  description: string;
  requiredPlan: 'free' | 'pro' | 'business' | 'enterprise';
  isAddon: boolean;
  category: string;
}> = [
  // ── Idea-merge wave 2026-06-08: owner-facing per-site capabilities.
];

const PLAN_RANK: Record<string, number> = { free: 0, pro: 1, business: 2, enterprise: 3 };

/** Read the caller's org plan tier (best-effort; defaults to 'free'). */
async function readOrgPlan(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  orgId: string | undefined,
): Promise<'free' | 'pro' | 'business' | 'enterprise'> {
  if (!orgId) return 'free';
  try {
    // Resolve the plan through the shared status-gated SSOT (`status IN
    // ('active','trialing')`). The old query had NO status filter (`ORDER BY
    // updated_at DESC LIMIT 1` over any non-deleted row) → a PAST_DUE org (payment
    // failed: status='past_due' but `plan` stays 'paid') resolved to the 'enterprise'
    // tier and could ENABLE every paid site-feature (the toggle handler below gates
    // `enabled` on this tier) — a revenue leak that kept premium features for a
    // non-paying org, while the build-quota gate already dropped them to free. Routing
    // through resolveActiveOrgPlan makes the two entitlement gates consistent + honors
    // the documented past_due-revokes-entitlements intent (iter-137 sibling drift).
    const { resolveActiveOrgPlan } = await import('../services/build_limits.js');
    const plan = ((await resolveActiveOrgPlan(c.env.DB, orgId)) ?? 'free').toLowerCase();
    // A generic 'paid' subscription (legacy value) is a full paid tier, not free.
    if (plan === 'paid') return 'enterprise';
    return plan === 'pro' || plan === 'business' || plan === 'enterprise' ? plan : 'free';
  } catch {
    return 'free';
  }
}

/** Read tenant-scoped enable/preview state for a site's features. */
async function readSiteFeatureState(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  siteId: string | undefined,
): Promise<Record<string, { enabled: boolean; preview: boolean }>> {
  const out: Record<string, { enabled: boolean; preview: boolean }> = {};
  if (!siteId) return out;
  try {
    const rows = await c.env.DB.prepare(
      `SELECT flag_key, value_json FROM flag_overrides WHERE scope = 'tenant' AND scope_id = ? AND deleted_at IS NULL`,
    )
      .bind(siteId)
      .all<{ flag_key: string; value_json: string }>();
    for (const r of rows.results ?? []) {
      try {
        const v = JSON.parse(r.value_json) as { enabled?: boolean; preview?: boolean };
        out[r.flag_key] = { enabled: !!v.enabled, preview: !!v.preview };
      } catch {
        /* skip malformed override */
      }
    }
  } catch {
    /* table absent during rollout — empty state */
  }
  return out;
}

/**
 * `GET /api/site-features` — owner-facing feature catalog with per-feature
 * entitlement + enable/preview state for the caller's selected site.
 */
features.get('/api/site-features', async (c) => {
  // Org comes from the AUTHED session ONLY — never a client `org_id` param. The
  // old `?? c.req.query('org_id')` fallback let an UNAUTHENTICATED caller read any
  // org's plan + any site's feature-override state cross-tenant (x-org-id IDOR
  // class). Mirrors the POST handler below + the burn-meter (AL-061).
  const orgId = c.get('orgId');
  if (!orgId) return c.json({ error: 'unauthorized' }, 401);
  const siteId = c.req.query('site_id') ?? undefined;
  // Tenant isolation — a caller may only read feature state for a site they own.
  // 404 (never 403) so a foreign site id can't be probed. No site_id → the
  // plan-only view (catalog + registry defaults, no tenant overrides).
  if (siteId && !(await assertSiteOwned(c.env, orgId, siteId))) {
    return c.json({ error: 'not_found' }, 404);
  }
  const plan = await readOrgPlan(c, orgId);
  const state = await readSiteFeatureState(c, siteId);
  const featureList = SITE_FEATURE_CATALOG.map((f) => {
    const entitled =
      PLAN_RANK[plan] >= PLAN_RANK[f.requiredPlan]
        ? 'available'
        : f.isAddon
          ? 'addon-required'
          : 'upgrade-required';
    // A site's per-feature state = its explicit tenant override, else the platform
    // registry default (default_enabled). Without this fallback a feature enabled at
    // the registry level shows OFF in the admin even though isFlagOn resolves true.
    const s = state[f.key] ?? {
      enabled: FLAG_REGISTRY[f.key]?.default_enabled ?? false,
      preview: false,
    };
    return { ...f, entitled, enabled: s.enabled, preview: s.preview };
  });
  return c.json({ features: featureList, plan });
});

const siteFeatureToggleSchema = z.object({
  site_id: z.string().min(1),
  enabled: z.boolean().optional(),
  preview: z.boolean().optional(),
});

/**
 * `POST /api/site-features/:key` — owner enables/disables a site feature for
 * THEIR site. Entitlement-checked server-side (free→404 the gated feature is
 * never exposed; an under-entitled enable is rejected 403). Tenant-scoped.
 */
features.post('/api/site-features/:key', async (c) => {
  const key = c.req.param('key');
  const def = SITE_FEATURE_CATALOG.find((f) => f.key === key);
  if (!def) return c.json({ error: 'not_found' }, 404);
  const parsed = siteFeatureToggleSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success)
    return c.json({ error: 'validation_error', details: parsed.error.flatten() }, 400);
  const body = parsed.data;

  const orgId = (c as unknown as { get(k: string): string | undefined }).get('orgId') ?? undefined;
  // Tenant isolation — never let a caller mutate a site they don't own. 404
  // (never 403) so site existence doesn't leak.
  if (!(await assertSiteOwned(c.env, orgId, body.site_id))) {
    return c.json({ error: 'not_found' }, 404);
  }
  const plan = await readOrgPlan(c, orgId);
  const entitled = PLAN_RANK[plan] >= PLAN_RANK[def.requiredPlan];
  if (body.enabled && !entitled) {
    return c.json({ error: 'upgrade_required', required_plan: def.requiredPlan }, 403);
  }

  const value = JSON.stringify({ enabled: !!body.enabled, preview: !!body.preview });
  try {
    // `id` is an explicit UUID — `flag_overrides.id` is a TEXT PRIMARY KEY, so
    // omitting it inserts NULL PKs that accumulate. The unique index
    // `idx_flag_overrides_unique` is PARTIAL (WHERE deleted_at IS NULL), so the
    // ON CONFLICT target MUST repeat that predicate — WITHOUT it SQLite raises
    // "ON CONFLICT clause does not match any … UNIQUE constraint" on EVERY
    // execution (matching super_admin.ts's canonical writer). The empty catch
    // that used to swallow this turned a broken toggle into a lying-success.
    await c.env.DB.prepare(
      `INSERT INTO flag_overrides (id, scope, scope_id, flag_key, value_json, updated_at)
         VALUES (?, 'tenant', ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(scope, scope_id, flag_key) WHERE deleted_at IS NULL DO UPDATE SET
         value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP, deleted_at = NULL`,
    )
      .bind(crypto.randomUUID(), body.site_id, key, value)
      .run();
  } catch (err) {
    // The override MUST persist for the toggle to take effect — never a
    // lying-success. Surface a real failure instead of returning { ok: true }.
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'site-features',
        message: 'flag_override_write_failed',
        site_id: body.site_id,
        key,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return c.json(
      { error: 'toggle_failed', message: 'Could not save the feature toggle. Please try again.' },
      500,
    );
  }
  // Bust the 60s KV cache `resolveFlag` keeps per `flag:<key>:<siteId>:<orgId>`,
  // or the just-written tenant override stays invisible to `isFlagOn` for up to
  // KV_TTL — a toggle that silently no-ops from the owner's perspective.
  await invalidateFlagCache(c.env, key);
  return c.json({ ok: true, key, enabled: !!body.enabled, preview: !!body.preview });
});

// ─── Semantic per-feature endpoints (every endpoint flag-gated) ──────

// Token-burn meter — org comes from the AUTHED session (c.get('orgId')), NEVER a
// client org_id param. token_events is billing data; a client-supplied org_id let
// any caller read (GET burn) or pollute (POST record) another org's spend (IDOR).
features.get('/api/usage/burn', requireFlag('token_burn_meter'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return c.json({ error: 'unauthorized' }, 401);
  return c.json(await F.getMonthlyBurn(c.env, orgId));
});
features.post('/api/usage/record', requireFlag('token_burn_meter'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return c.json({ error: 'unauthorized' }, 401);
  const body = (await c.req.json().catch(() => ({}))) as {
    model?: F.ModelId;
    input_tokens?: number;
    output_tokens?: number;
  };
  return c.json(
    await F.recordTokenEvent(c.env, {
      orgId,
      model: body.model ?? '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      inputTokens: body.input_tokens ?? 0,
      outputTokens: body.output_tokens ?? 0,
    }),
  );
});

// Approval workflow — owned, auth + ownership-guarded (NO demo defaults).
// The agency org is the caller's authed session org (set by the auth

// ── 30 advanced features — semantic per-feature endpoints ──────────────

const json = async (c: { req: { json: () => Promise<unknown> } }) =>
  (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

// ── 3 NEW: IDE Sandbox + multi-agent + progressive skeleton ──────────

// ── 10 experimental features — semantic per-feature endpoints ────────────────────

// #1 Site-as-MCP-server — REMOVED with the child-site feature cut (commit d0fd4949,
// "🔥 remove(child-site) batch 4"). The registry flag `site_mcp_server` was dropped
// then, but these two /mcp/discovery routes lingered as orphan dead code (gated on a
// now-unresolvable flag → permanent 404). Removed here to complete that deletion;
// no frontend caller existed. (buildSiteMcpManifest is left for a separate knip sweep.)

// AI model router — folded under model_registry (the AI-model platform flag);
// the standalone ai_auto_router flag was retired 2026-08-14 as a duplicate.
features.post('/api/router/pick', requireFlag('model_registry'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return c.json({ error: 'unauthorized' }, 401);
  const body = (await c.req.json().catch(() => ({}))) as { prompt?: string };
  return c.json(
    await experimentalFeatures.autoRoutePrompt(c.env, {
      prompt: body.prompt ?? 'demo prompt',
      orgId,
    }),
  );
});
features.get('/api/router/stats', requireFlag('model_registry'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return c.json({ error: 'unauthorized' }, 401);
  return c.json(await experimentalFeatures.getRouterStats(c.env, orgId));
});

export default features;
