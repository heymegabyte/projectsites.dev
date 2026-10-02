/**
 * @module libs/features/domains/handlers
 *
 * @description
 * Hono routes for the domains feature — availability search, AI suggestions,
 * Stripe-checkout purchase, and direct CF-Registrar registration.
 *
 * | Method | Path                              | Auth   | Purpose                          |
 * | ------ | --------------------------------- | ------ | -------------------------------- |
 * | GET    | /api/domains/search-enrich        | public | RDAP + CF pricing + AI pitch     |
 * | GET    | /api/domains/search               | public | RDAP-backed legacy search shim   |
 * | POST   | /api/domains/purchase             | orgId  | Stripe checkout ($15/yr sub)     |
 * | POST   | /api/domains/register             | orgId  | Direct CF Registrar + bind       |
 * | GET    | /api/domains/suggest              | orgId  | AI domain suggestions (cached)   |
 * | POST   | /api/domains/suggest/refine       | orgId  | Refine suggestions w/ feedback   |
 * | GET    | /api/admin/profile/:site_id/context | orgId | Debug: resolved ProfileContext |
 * | POST   | /api/sites/:siteId/domains/ai-search | orgId | AI creative domain search (10 strategies) |
 * | GET    | /api/sites/:siteId/domains/availability | orgId | Single-domain availability + price probe |
 * | POST   | /api/sites/:siteId/domains/register | orgId | Register + auto-provision CF for SaaS hostname |
 * | POST   | /api/sites/:siteId/domains/:domain/transfer-out | orgId | Initiate CF Registrar port-out |
 *
 * The four `/api/sites/:siteId/domains/*` routes were folded in from the `api.ts`
 * monolith VERBATIM (route-decomposition installment 11) — only the receiver
 * changed (`api.` → `domains.`); their bodies (and the ai-search helpers
 * `AI_DOMAIN_STRATEGIES` / `parseDomainCandidates` / `readSiteAiPrompt`) are
 * byte-for-byte unchanged. They read/write bodies via a raw `as {…}` cast rather
 * than a Zod schema at the boundary, so they are not in `./schemas`.
 *
 * Extracted verbatim from the `api.ts` monolith (route-decomposition
 * installment 1). Every request body/query is validated through
 * {@link ./schemas} at the boundary (zod-everywhere) — the former
 * `/register` `as {…}` cast is now `DomainRegisterSchema`. Business logic lives
 * in `src/services/*` (cf_registrar, rdap_availability, domain_suggester,
 * profile_context, domains); handlers stay thin. Thrown `badRequest` /
 * `unauthorized` / `notFound` are caught by the app-level error handler.
 *
 * @packageDocumentation
 */

import { Hono } from 'hono';
import { badRequest, unauthorized, notFound, pickSafeRedirect, DOMAINS } from '@project-sites/shared';
import type { Env, Variables } from '../../../src/types/env.js';
import { requireOwnedSite } from '../../../src/services/site_ownership.js';
import {
  buildTldPriceMap,
  porkbunFallback,
  registerDomain as cfRegisterDomain,
} from '../../../src/services/cf_registrar.js';
import { checkBatch as rdapCheckBatch } from '../../../src/services/rdap_availability.js';
import { suggestDomains, type DomainSuggestion } from '../../../src/services/domain_suggester.js';
import { gatherProfileContext } from '../../../src/services/profile_context.js';
import { dbQueryOne } from '../../../src/services/db.js';
import { safeFetch } from '../../../src/services/safe_fetch.js';
import * as domainService from '../../../src/services/domains.js';
import * as auditService from '../../../src/services/audit.js';
import * as posthog from '../../../src/lib/posthog.js';
import {
  DomainPurchaseSchema,
  DomainRegisterSchema,
  suggestQuerySchema,
  suggestRefineSchema,
} from './schemas.js';

type AppContext = { Bindings: Env; Variables: Variables };

export const domains = new Hono<AppContext>();

// ─── Domain Search Enrich (RDAP + CF Registrar pricing + Workers AI reasoning) ─
domains.get('/api/domains/search-enrich', async (c) => {
  const query = (c.req.query('q') || '').trim().toLowerCase().slice(0, 63);
  const business = (c.req.query('business') || '').trim().slice(0, 80);
  if (query.length < 2) {
    return c.json({ results: [] });
  }

  // Strip anything that isn't a-z/0-9/dash/dot.
  const sanitised = query.replace(/[^a-z0-9.-]/g, '');
  if (!sanitised || sanitised.length < 2) return c.json({ results: [] });

  // Literal `foo.tld` mode vs TLD fan-out mode.
  const TOP_TLDS = ['com', 'app', 'io', 'dev', 'co', 'ai', 'org', 'net', 'me', 'xyz'];
  const isLiteral = /^[a-z0-9-]+\.[a-z0-9-]+$/.test(sanitised);
  const candidates: string[] = isLiteral
    ? [sanitised]
    : TOP_TLDS.map((tld) => `${sanitised.replace(/\./g, '')}.${tld}`);

  // Fan out availability + pricing in parallel.
  const [rdapResults, tldMap] = await Promise.all([
    rdapCheckBatch(c.env, candidates),
    buildTldPriceMap(c.env),
  ]);

  type Row = {
    domain: string;
    tld: string;
    available: boolean;
    status: 'available' | 'taken' | 'unknown';
    price_usd_yr: number | null;
    can_register_inline: boolean;
    fallback_url: string | null;
  };
  const rows: Row[] = candidates.map((domain, i) => {
    const probe = rdapResults[i];
    const tld = domain.slice(domain.lastIndexOf('.') + 1);
    const priceRow = tldMap.get(tld);
    const price = priceRow?.registration_price_usd_yr ?? null;
    const cfCarries = !!priceRow?.can_register;
    return {
      domain,
      tld,
      available: probe?.available ?? false,
      status: probe?.status ?? 'unknown',
      price_usd_yr: price != null ? Math.round(price) : null,
      can_register_inline: cfCarries && probe?.available === true,
      fallback_url: cfCarries ? null : porkbunFallback(domain),
    };
  });

  // Deterministic fallback reason + pitch — cinematic-punchline voiced.
  const fallback = (r: Row): { reason: string; pitch: string } => {
    const tldNote: Record<string, string> = {
      com: 'Universal trust signal; safest pick.',
      ai: 'Premium .ai TLD; AI-brand resonance.',
      dev: 'Developer-coded; signals craft.',
      app: 'App-store adjacency; mobile cue.',
      io: 'Tech-startup vernacular; punchy.',
      co: 'Short company tag; modern shorthand.',
      org: 'Mission-driven; nonprofit trust.',
      net: 'Infrastructure cue; legacy weight.',
      me: 'Personal-brand cue; portfolio-ready.',
      xyz: 'Web3/modern cue; stands out in search.',
    };
    const note = tldNote[r.tld] || 'Distinctive TLD; stands out in search.';
    const priceTail = r.price_usd_yr ? `$${r.price_usd_yr}/yr.` : 'Pricing on register.';
    return {
      reason: `Matches ${business || query} + memorable .${r.tld}.`.slice(0, 80),
      pitch: `${note} ${priceTail}`.slice(0, 120),
    };
  };

  // Workers AI single-shot — batch all rows into ONE call.
  const aiBatch: Record<string, { reason: string; pitch: string }> = {};
  try {
    const prompt = `You are a domain-naming concierge for a website builder. For each candidate below, return ONE line per domain in the exact shape:
DOMAIN|||REASON|||PITCH

REASON must be <=80 chars, persona-voiced, cinematic-punchline style — say WHY this domain fits "${business || query}".
PITCH must be <=120 chars — TLD value + price + emotional hook. Example: "Premium .ai TLD; AI brand resonance; $69/yr."

Never repeat the literal domain inside REASON or PITCH. Never use the words "great" or "perfect" or "amazing". Be specific.

Candidates:
${rows.map((r) => `- ${r.domain} (.${r.tld}, ${r.status}, ${r.price_usd_yr != null ? `$${r.price_usd_yr}/yr` : 'price tbd'})`).join('\n')}`;

    const aiRes = (await c.env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [
        {
          role: 'system',
          content:
            'You write tight, specific domain pitches. Always respond in the requested format. No preamble.',
        },
        { role: 'user', content: prompt },
      ],
      max_tokens: 600,
    } as never)) as { response?: string };

    const text = aiRes?.response || '';
    for (const line of text.split('\n')) {
      const [dom, reason, pitch] = line.split('|||').map((s) => (s || '').trim());
      if (dom && reason && pitch) {
        aiBatch[dom.toLowerCase()] = {
          reason: reason.slice(0, 80),
          pitch: pitch.slice(0, 120),
        };
      }
    }
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'domain_search_enrich',
        message: 'Workers AI failed, using deterministic fallback',
        error: String(err),
      }),
    );
  }

  const enriched = rows.map((r) => {
    const ai = aiBatch[r.domain.toLowerCase()] || fallback(r);
    return {
      domain: r.domain,
      available: r.available,
      status: r.status,
      reason: ai.reason,
      pitch: ai.pitch,
      price_usd_yr: r.price_usd_yr,
      can_register_inline: r.can_register_inline,
      fallback_url: r.fallback_url ?? undefined,
    };
  });

  return c.json({ results: enriched });
});

// ─── Domain Search (legacy compat — RDAP-backed) ─────────────
domains.get('/api/domains/search', async (c) => {
  const query = c.req.query('q');
  if (!query || query.trim().length < 2 || query.trim().length > 63) {
    return c.json({ data: [] });
  }
  const sanitised = query
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, '');
  if (!sanitised) return c.json({ data: [] });

  const TOP_TLDS = ['com', 'app', 'io', 'dev', 'co', 'ai', 'org', 'net', 'me', 'xyz'];
  const isLiteral = /^[a-z0-9-]+\.[a-z0-9-]+$/.test(sanitised);
  const candidates = isLiteral
    ? [sanitised]
    : TOP_TLDS.map((tld) => `${sanitised.replace(/\./g, '')}.${tld}`);

  const [rdapResults, tldMap] = await Promise.all([
    rdapCheckBatch(c.env, candidates),
    buildTldPriceMap(c.env),
  ]);

  const data = candidates.map((domain, i) => {
    const tld = domain.slice(domain.lastIndexOf('.') + 1);
    const usd = tldMap.get(tld)?.registration_price_usd_yr ?? 0;
    const probe = rdapResults[i];
    return {
      domain,
      available: probe?.available ?? false,
      // Surface the RDAP status so callers can distinguish a genuinely-registered
      // domain (`taken`) from one whose availability check FAILED (`unknown`).
      status: probe?.status ?? 'unknown',
      price: Math.round((usd || 0) * 100),
      zone: tld,
      path: '',
    };
  });

  // Honest degradation: if EVERY candidate's check failed (RDAP fully down),
  // carry a stable _error so callers show "temporarily unavailable" instead of a
  // misleading "all taken". A partial outage still returns per-item `status`.
  if (data.length > 0 && data.every((d) => d.status === 'unknown')) {
    return c.json({
      data,
      _error: {
        code: 'SEARCH_PROVIDER_UNAVAILABLE',
        status: 503,
        message: 'Domain availability lookup (RDAP) is temporarily unavailable',
      },
    });
  }

  return c.json({ data });
});

// ─── Domain Purchase (Stripe subscription) ───────────────────
domains.post('/api/domains/purchase', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) throw unauthorized('Must be authenticated');

  // Zod boundary: malformed JSON → clean 400 (not an unhandled 500), and the
  // client-supplied redirect URLs MUST be https (no `javascript:`/`data:`
  // scheme injection into Stripe's hosted-checkout return URL).
  const parsed = DomainPurchaseSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw badRequest('domain and site_id are required; success_url/cancel_url must be https URLs');
  }
  const body = parsed.data;

  // Verify site ownership (also fetch the slug to build the redirect allowlist).
  const site = await requireOwnedSite<{ id: string; org_id: string; slug: string }>(
    c.env,
    orgId,
    body.site_id,
    'id, org_id, slug',
  );

  // Clamp the Stripe redirect URLs to the site's OWN domains + the platform host
  // (open-redirect / phishing guard). Graceful: an off-domain/missing URL falls
  // back to a safe default, never errors.
  const allowedHosts = new Set<string>([DOMAINS.SITES_BASE, `${site.slug}${DOMAINS.SITES_SUFFIX}`]);
  const hns = await c.env.DB.prepare(
    'SELECT hostname FROM hostnames WHERE site_id = ? AND deleted_at IS NULL',
  )
    .bind(site.id)
    .all<{ hostname: string }>()
    .catch(() => ({ results: [] as { hostname: string }[] }));
  for (const r of hns.results ?? []) allowedHosts.add(String(r.hostname).toLowerCase());
  const siteUrl = `https://${site.slug}${DOMAINS.SITES_SUFFIX}`;
  const safeSuccessUrl = pickSafeRedirect(
    body.success_url,
    `${siteUrl}/?domain_purchase=success`,
    allowedHosts,
  );
  const safeCancelUrl = pickSafeRedirect(body.cancel_url, siteUrl, allowedHosts);

  // Create a Stripe checkout for domain subscription
  const userId = c.get('userId') || '';
  const user = await dbQueryOne<{ email: string }>(
    c.env.DB,
    'SELECT email FROM users WHERE id = ?',
    [userId],
  );

  const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(c.env.STRIPE_SECRET_KEY + ':')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      mode: 'subscription',
      success_url: safeSuccessUrl,
      cancel_url: safeCancelUrl,
      customer_email: user?.email || '',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][recurring][interval]': 'year',
      'line_items[0][price_data][unit_amount]': '1500', // $15/yr default
      'line_items[0][price_data][product_data][name]': `Domain: ${body.domain}`,
      'line_items[0][price_data][product_data][description]': `Annual domain registration for ${body.domain}`,
      'line_items[0][quantity]': '1',
      'metadata[org_id]': orgId,
      'metadata[site_id]': body.site_id,
      'metadata[domain]': body.domain,
      'metadata[type]': 'domain_purchase',
    }),
  });

  if (!stripeRes.ok) {
    const errData = await stripeRes.text();
    throw badRequest('Failed to create checkout: ' + errData);
  }

  const session = (await stripeRes.json()) as { url: string; id: string };

  // Audit: domain purchase checkout initiated
  auditService
    .writeAuditLog(c.env.DB, {
      org_id: orgId,
      actor_id: c.get('userId') ?? null,
      action: 'domain.purchase_initiated',
      message: `Domain purchase started for '${body.domain}' — Stripe checkout session created`,
      target_type: 'domain',
      target_id: body.site_id,
      metadata_json: {
        domain: body.domain,
        site_id: body.site_id,
        stripe_session_id: session.id,
      },
      request_id: c.get('requestId'),
    })
    .catch(() => {});

  return c.json({
    data: {
      checkout_url: session.url,
      session_id: session.id,
    },
  });
});

// ─── Domain Registrar (direct CF Registrar via global-key auth) ────
domains.post('/api/domains/register', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) throw unauthorized('Must be authenticated');

  // Zod boundary (was an `as {…}` cast): trims + lowercases the domain and
  // shape-validates the site id. Malformed body → 400, never an unhandled 500.
  const parsed = DomainRegisterSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw badRequest('domain and site_id are required');
  const { domain, site_id: siteId } = parsed.data;

  // Verify site ownership (404 never 403 — fires 30-36 protocol).
  const site = await requireOwnedSite<{ id: string; org_id: string }>(
    c.env,
    orgId,
    siteId,
    'id, org_id',
  );

  // Pull contact info from the authenticated user — CF Registrar requires a
  // full WHOIS contact even with privacy on (the privacy flag swaps in the
  // registrar's proxy contact for the public WHOIS while the real contact stays
  // with CF).
  const userId = c.get('userId');
  const user = userId
    ? await dbQueryOne<{ email: string; display_name: string | null; phone: string | null }>(
        c.env.DB,
        'SELECT email, display_name, phone FROM users WHERE id = ? AND deleted_at IS NULL',
        [userId],
      )
    : null;

  const userName = (user?.display_name || 'Site Owner').trim();
  const nameParts = userName.split(/\s+/);
  const firstName = nameParts[0] || 'Site';
  const lastName = nameParts.slice(1).join(' ') || 'Owner';

  const accountId = '84fa0d1b16ff8086dd958c468ce7fd59';
  const purchaseId = `pur_${crypto.randomUUID()}`;

  const result = await cfRegisterDomain(c.env, {
    domain,
    account_id: accountId,
    contact: {
      first_name: firstName,
      last_name: lastName,
      email: user?.email || 'hey@projectsites.dev',
      phone: user?.phone || '+1.5555551212',
      organization: 'ProjectSites',
      address: '1 Infinite Loop',
      city: 'Newark',
      state: 'NJ',
      zip: '07102',
      country: 'US',
    },
  });

  if (!result.ok) {
    if (result.error === 'TLD_NOT_SUPPORTED') {
      return c.json(
        {
          error: {
            code: 'tld_not_supported_by_cf',
            message: result.message ?? "CF Registrar doesn't carry this TLD.",
            fallback_url: result.fallback_url,
          },
        },
        424,
      );
    }
    if (result.error === 'CF_AUTH_MISSING') {
      return c.json(
        {
          error: {
            code: 'registrar_not_configured',
            message: result.message ?? 'CF auth missing.',
            unblock_url: 'https://dash.cloudflare.com/profile/api-tokens',
          },
        },
        424,
      );
    }
    throw badRequest(result.message ?? 'Registration failed.');
  }

  // Bind to site via the existing hostnames service so CF for SaaS provisioning
  // + SSL kick off automatically. Best-effort — register already succeeded so we
  // don't unwind.
  let sslStatus: 'pending' | 'failed' = 'pending';
  let hostnameId: string | null = null;
  try {
    await domainService.provisionCustomDomain(c.env.DB, c.env, {
      org_id: orgId,
      site_id: siteId,
      hostname: domain,
    });
    const row = await dbQueryOne<{ id: string }>(
      c.env.DB,
      'SELECT id FROM hostnames WHERE hostname = ? AND deleted_at IS NULL',
      [domain],
    );
    hostnameId = row?.id ?? null;
  } catch (provErr) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'domain_register',
        message: 'hostname provisioning failed after register',
        error: String(provErr),
      }),
    );
    sslStatus = 'failed';
  }

  auditService
    .writeAuditLog(c.env.DB, {
      org_id: orgId,
      actor_id: c.get('userId') ?? null,
      action: 'domain.registered',
      message: `Domain '${domain}' registered via CF Registrar and bound to site '${siteId}'`,
      target_type: 'domain',
      target_id: siteId,
      metadata_json: {
        domain,
        site_id: siteId,
        hostname_id: hostnameId,
        purchase_id: purchaseId,
        transaction_id: result.transaction_id ?? null,
      },
      request_id: c.get('requestId'),
    })
    .catch(() => {});

  return c.json({
    data: {
      purchase_id: purchaseId,
      domain,
      hostname_id: hostnameId,
      ssl_status: sslStatus,
      transaction_id: result.transaction_id ?? null,
    },
  });
});

// ─── AI Domain Suggester (dropdown-fill endpoint) ───────────
domains.get('/api/domains/suggest', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) throw unauthorized('Must be authenticated');

  const parsed = suggestQuerySchema.parse({
    site_id: c.req.query('site_id'),
    count: c.req.query('count'),
    query: c.req.query('query'),
    refresh: c.req.query('refresh'),
  });

  // Verify ownership before any AI spend (404 never 403 — fires 30-36 protocol).
  await requireOwnedSite<{ id: string }>(c.env, orgId, parsed.site_id);

  const count = parsed.count ?? 10;
  const cacheKey = `domain_suggest:${parsed.site_id}:${count}`;
  const wantRefresh = parsed.refresh === 'true' || Boolean(parsed.query);

  if (!wantRefresh) {
    try {
      const cached = await c.env.CACHE_KV.get(cacheKey, 'json');
      if (cached && typeof cached === 'object' && 'suggestions' in (cached as object)) {
        return c.json(cached);
      }
    } catch {
      // KV miss is non-fatal.
    }
  }

  const suggestions = await suggestDomains(c.env, {
    siteId: parsed.site_id,
    query: parsed.query,
    count,
  });

  const ctx = await gatherProfileContext(c.env, parsed.site_id);
  const contextSummary = ctx
    ? [
        ctx.business_name,
        ctx.business_type,
        ctx.location,
        ctx.target_audience ? `for ${ctx.target_audience}` : '',
      ]
        .filter(Boolean)
        .join(' · ')
        .slice(0, 200)
    : '';

  const payload = {
    suggestions,
    context_summary: contextSummary,
    generated_at: new Date().toISOString(),
  };

  // 5-min cache — best-effort, never blocks the response.
  try {
    await c.env.CACHE_KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: 300 });
  } catch {
    // non-fatal
  }

  return c.json(payload);
});

domains.post('/api/domains/suggest/refine', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) throw unauthorized('Must be authenticated');

  // Malformed body → ZodError 400 (suggestRefineSchema required fields), not 500.
  const body = await c.req.json().catch(() => ({}));
  const parsed = suggestRefineSchema.parse(body);

  // Canonical org-ownership guard (404 never 403 — fires 30-36 protocol).
  await requireOwnedSite<{ id: string }>(c.env, orgId, parsed.site_id);

  const count = parsed.count ?? 10;

  const suggestions: DomainSuggestion[] = await suggestDomains(c.env, {
    siteId: parsed.site_id,
    feedback: parsed.feedback,
    excludeDomains: parsed.exclude_domains,
    count,
  });

  const ctx = await gatherProfileContext(c.env, parsed.site_id);
  const contextSummary = ctx
    ? [ctx.business_name, ctx.business_type, ctx.location].filter(Boolean).join(' · ').slice(0, 200)
    : '';

  const payload = {
    suggestions,
    context_summary: contextSummary,
    generated_at: new Date().toISOString(),
  };

  // Evict the GET cache so subsequent default opens see the refined set.
  try {
    await c.env.CACHE_KV.delete(`domain_suggest:${parsed.site_id}:${count}`);
  } catch {
    // non-fatal
  }

  return c.json(payload);
});

/**
 * Debug endpoint — return the full `ProfileContext` for a site. Same-org
 * ownership enforced (mirrors the rest of the `/api/admin/*` surface). Powers
 * the dashboard's "why these suggestions?" affordance.
 */
domains.get('/api/admin/profile/:site_id/context', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) throw unauthorized('Must be authenticated');

  const siteId = c.req.param('site_id');
  if (!siteId || !/^[0-9a-f-]{36}$/i.test(siteId)) {
    throw badRequest('site_id must be a UUID');
  }

  // Canonical org-ownership guard (404 never 403 — fires 30-36 protocol).
  await requireOwnedSite<{ id: string }>(c.env, orgId, siteId);

  const context = await gatherProfileContext(c.env, siteId);
  if (!context) throw notFound('Site has no resolvable profile');

  return c.json({ context });
});

/**
 * Creative-strategy seed used by the AI domain-search fan-out. Each strategy
 * spawns an independent Workers AI inference with its own system prompt so
 * the candidate set spans different naming archetypes (literal, metaphor,
 * alliterative, ...). Deduped + availability-checked downstream.
 */
const AI_DOMAIN_STRATEGIES: ReadonlyArray<{ id: string; instruction: string }> = [
  {
    id: 'literal',
    instruction:
      'Suggest 4 literal, descriptive domain names that say exactly what the business does. Plain English, .com preferred.',
  },
  {
    id: 'metaphor',
    instruction:
      'Suggest 4 metaphor-driven domain names that evoke the business through a vivid image (e.g. "ironpaw.com" for a gym). Avoid the business type word directly.',
  },
  {
    id: 'compound',
    instruction:
      'Suggest 4 invented compound-word domain names that fuse two relevant nouns or a noun + verb. Keep them under 14 characters.',
  },
  {
    id: 'alliterative',
    instruction:
      'Suggest 4 alliterative domain names where the first letter repeats. Memorable, brand-able, .com or .co.',
  },
  {
    id: 'rhyming',
    instruction:
      'Suggest 4 rhyming or near-rhyming two-word domain names. Playful but professional.',
  },
  {
    id: 'jargon',
    instruction:
      'Suggest 4 industry-jargon domain names that insiders would instantly recognize. Authentic vocabulary, no marketing speak.',
  },
  {
    id: 'playful',
    instruction:
      'Suggest 4 playful, slightly irreverent domain names with a wink. Short. .co, .fun, .biz allowed.',
  },
  {
    id: 'minimalist',
    instruction:
      'Suggest 4 minimalist single-word or two-syllable domain names. Premium, easy to spell. .com or .io.',
  },
  {
    id: 'premium-tld',
    instruction:
      'Suggest 4 domain names paired with premium TLDs (.io, .app, .dev, .ai) where the TLD adds meaning.',
  },
  {
    id: 'geography',
    instruction:
      'Suggest 4 geography-flavored domain names that subtly include city, neighborhood, or regional flavor.',
  },
];

/**
 * Parse a Workers AI free-form response and pull out plausible domain
 * candidates. The Llama model usually returns a markdown list, sometimes a
 * comma-separated line, sometimes prose — this normalizer survives all
 * three.
 *
 * @param raw - The raw model response (string or wrapper object).
 * @returns Up to 8 lowercase domain candidates with stripped punctuation.
 */
function parseDomainCandidates(raw: unknown): string[] {
  let text = '';
  if (typeof raw === 'string') text = raw;
  else if (raw && typeof raw === 'object' && 'response' in raw)
    text = String((raw as { response?: unknown }).response ?? '');
  else if (raw && typeof raw === 'object' && 'result' in raw)
    text = String((raw as { result?: unknown }).result ?? '');
  else text = JSON.stringify(raw ?? '');

  const matches = text.match(/[a-z0-9][a-z0-9-]{1,40}\.[a-z]{2,12}\b/gi) ?? [];
  const cleaned = matches
    .map((m) => m.toLowerCase())
    .map((m) => m.replace(/[^a-z0-9.-]/g, ''))
    .filter((m) => /^[a-z0-9][a-z0-9-]*\.[a-z]{2,12}$/.test(m));
  return Array.from(new Set(cleaned)).slice(0, 8);
}

/**
 * Look up the site's AI-chat system prompt (when one has been configured)
 * so the domain-search prompts can ride along on the same brand voice.
 *
 * @returns The persisted `chat_system_prompt` or `null` when unset.
 */
async function readSiteAiPrompt(db: D1Database, siteId: string): Promise<string | null> {
  const row = await dbQueryOne<{ chat_system_prompt: string | null }>(
    db,
    'SELECT chat_system_prompt FROM ai_site_settings WHERE site_id = ?',
    [siteId],
  );
  return row?.chat_system_prompt ?? null;
}

/**
 * AI-powered creative domain search for a specific site.
 *
 * Fans out ~10 parallel Workers AI inferences (one per naming strategy),
 * aggregates the candidate set, dedupes, then checks availability + price in
 * a single bulk Cloudflare Registrar API call. Strategy metadata is
 * preserved on every candidate so the UI can render a "metaphor" /
 * "alliterative" badge per card.
 *
 * @route POST /api/sites/:siteId/domains/ai-search
 * @auth Bearer required. Site ownership is enforced via D1 `org_id` predicate.
 * @body `{ query: string }` — free-form designer brief used as extra context.
 * @returns `{ data: { available, unavailable } }` where each is an array of
 *   `{ name, tld, price_usd, available, strategy }`.
 * @throws {AppError} `UNAUTHORIZED` / `NOT_FOUND` per the standard pattern.
 *
 * @example
 * ```bash
 * curl -X POST .../api/sites/$ID/domains/ai-search \
 *   -H 'authorization: bearer $T' -d '{"query":"premium barber shop"}'
 * ```
 */
domains.post('/api/sites/:siteId/domains/ai-search', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) throw unauthorized('Must be authenticated');

  const siteId = c.req.param('siteId');
  // Canonical org-ownership guard: 404 (never 403) so cross-org sites don't leak.
  // ⚠️ Select ONLY real `sites` columns. `business_type` does NOT exist (the
  // columns are business_name/phone/email/address/website) — selecting it threw
  // `no such column`, which dbQueryOne SWALLOWS → null → requireOwnedSite 404'd
  // EVERY site (owned or not), so ai-search was 100% broken in prod (a silent
  // schema-drift-as-404, per the swallowed-SQL-error class).
  const site = await requireOwnedSite<{
    id: string;
    business_name: string | null;
    business_address: string | null;
  }>(c.env, orgId, siteId, 'id, business_name, business_address');

  const body = (await c.req.json().catch(() => ({}))) as { query?: unknown };
  const query = typeof body.query === 'string' ? body.query.trim().slice(0, 200) : '';

  const sitePrompt = await readSiteAiPrompt(c.env.DB, siteId);
  const businessName = site.business_name ?? 'the business';
  // No business_type column exists; the designer query + brand-voice prompt below
  // carry the domain-naming specificity. Default keeps the AI context well-formed.
  const businessType = 'small business';
  const address = site.business_address ?? '';

  const baseContext = [
    `Business name: ${businessName}`,
    `Business type: ${businessType}`,
    address ? `Location: ${address}` : '',
    query ? `Designer brief: ${query}` : '',
    sitePrompt ? `Brand voice (extract): ${sitePrompt.slice(0, 300)}` : '',
    'Output strict format: a markdown list, one candidate per line, "domain.tld" only, no commentary.',
    'Avoid hyphens unless musically helpful. Prefer ≤14 chars. Never reuse the exact business name verbatim.',
  ]
    .filter(Boolean)
    .join('\n');

  const deadline = Date.now() + 25_000;

  // Fan out one inference per strategy in parallel. Each promise resolves to a
  // typed `{strategy, candidates[]}` regardless of model failure so the
  // aggregator can keep partial results.
  const strategyRuns = AI_DOMAIN_STRATEGIES.map(async (strategy) => {
    try {
      const remaining = deadline - Date.now();
      if (remaining <= 200) return { strategy: strategy.id, candidates: [] as string[] };
      const ai = c.env.AI as unknown as {
        run: (model: string, opts: unknown) => Promise<unknown>;
      };
      // Clear the race-timeout once AI.run wins, else the dangling setTimeout
      // keeps the runtime alive (the f87/discover-images uncleaned-race-timer
      // class — caused the domains-ai-search suite force-exit).
      let raceTimer: ReturnType<typeof setTimeout> | undefined;
      const raw = await Promise.race([
        ai.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
          messages: [
            { role: 'system', content: strategy.instruction },
            { role: 'user', content: baseContext },
          ],
          max_tokens: 256,
        }),
        new Promise((resolve) => {
          raceTimer = setTimeout(() => resolve(null), Math.min(remaining, 12_000));
        }),
      ]);
      clearTimeout(raceTimer);
      return { strategy: strategy.id, candidates: parseDomainCandidates(raw) };
    } catch (err) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          service: 'ai_domain_search',
          message: 'strategy_failed',
          strategy: strategy.id,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return { strategy: strategy.id, candidates: [] };
    }
  });

  const strategyResults = await Promise.all(strategyRuns);

  // Dedupe across strategies; first writer wins so the strategy badge stays
  // stable on subsequent re-renders.
  const seen = new Map<string, string>();
  for (const { strategy, candidates } of strategyResults) {
    for (const name of candidates) {
      if (!seen.has(name)) seen.set(name, strategy);
    }
  }

  const allNames = Array.from(seen.keys()).slice(0, 50);
  if (allNames.length === 0) {
    return c.json({ data: { available: [], unavailable: [] } });
  }

  // The availability provider (RDAP via checkDomainAvailability) is SECONDARY
  // enrichment on top of the AI-generated candidates — the domain IDEAS are the
  // primary value. checkBatch never throws on an RDAP hiccup (returns 'unknown'),
  // but keep the try/catch as defense-in-depth: a dynamic-import failure or future
  // provider rewire must NOT 502 the whole search. On any failure each row just
  // shows "availability unknown" instead of a price/available flag.
  // (Historic bug: the old CF Registrar path 404'd and THREW AppError(502), hiding
  // every suggestion until this catch was added.)
  let availabilityResult: Awaited<ReturnType<typeof domainService.checkDomainAvailability>> | null =
    null;
  try {
    availabilityResult = await domainService.checkDomainAvailability(c.env, allNames);
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'ai_domain_search',
        message: 'availability_check_failed',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  // Soft failure: surface every candidate as "availability unknown" rather
  // than empty.
  const availabilityRows = Array.isArray(availabilityResult)
    ? availabilityResult
    : allNames.map((n) => ({
        name: n,
        tld: n.split('.').slice(1).join('.'),
        available: false,
        price_usd: 0,
      }));

  type Card = {
    name: string;
    tld: string;
    price_usd: number;
    available: boolean;
    strategy: string;
  };
  const available: Card[] = [];
  const unavailable: Card[] = [];

  for (const row of availabilityRows) {
    const card: Card = {
      name: row.name,
      tld: row.tld,
      price_usd: row.price_usd,
      available: row.available,
      strategy: seen.get(row.name) ?? 'literal',
    };
    (card.available ? available : unavailable).push(card);
  }

  // Fire-and-forget analytics: never block the user response on PostHog.
  try {
    posthog.trackDomain(c.env, c.executionCtx, 'ai_searched', c.get('userId') || orgId, {
      site_id: siteId,
      available_count: available.length,
      unavailable_count: unavailable.length,
      query_length: query.length,
    });
  } catch {
    /* ignore — analytics never blocks */
  }

  return c.json({ data: { available, unavailable } });
});

/**
 * Single-domain availability + pricing probe via RDAP (checkDomainAvailability).
 *
 * @route GET /api/sites/:siteId/domains/availability
 * @auth Bearer required. Site ownership enforced.
 * @queryParam name - Fully-qualified domain to check.
 * @returns `{ data: { name, available, price_usd, tld } }`.
 *
 * @example
 * ```bash
 * curl '.../api/sites/$ID/domains/availability?name=acme.com'
 * ```
 */
domains.get('/api/sites/:siteId/domains/availability', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) throw unauthorized('Must be authenticated');

  const siteId = c.req.param('siteId');
  // Canonical org-ownership guard: 404 (never 403) so cross-org sites don't leak.
  const site = await requireOwnedSite<{ id: string }>(c.env, orgId, siteId);

  const name = (c.req.query('name') ?? '').toLowerCase().trim();
  if (!/^[a-z0-9][a-z0-9-]*\.[a-z]{2,12}$/.test(name)) {
    throw badRequest('Provide a valid `name` query parameter');
  }

  const result = await domainService.checkDomainAvailability(c.env, [name]);
  if (!Array.isArray(result)) {
    return c.json({
      data: { name, available: false, price_usd: 0, tld: name.split('.').slice(1).join('.') },
    });
  }
  return c.json({ data: result[0] });
});

/**
 * Register a domain through Cloudflare Registrar AND automatically provision
 * a Cloudflare for SaaS custom hostname for the requesting site so DNS +
 * SSL come up in a single user-visible step.
 *
 * @route POST /api/sites/:siteId/domains/register
 * @auth Bearer required. Site ownership enforced.
 * @body `{ domain: string }`.
 * @returns `{ data: { domain, hostname_id, status } }`.
 * @throws {AppError} `DOMAIN_PROVISIONING_ERROR` when CF Registrar refuses.
 *
 * @example
 * ```bash
 * curl -X POST .../api/sites/$ID/domains/register \
 *   -d '{"domain":"acme.com"}'
 * ```
 */
domains.post('/api/sites/:siteId/domains/register', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) throw unauthorized('Must be authenticated');

  const siteId = c.req.param('siteId');
  // Canonical org-ownership guard: 404 (never 403) so cross-org sites don't leak.
  const site = await requireOwnedSite<{ id: string; slug: string }>(
    c.env,
    orgId,
    siteId,
    'id, slug',
  );

  const body = (await c.req.json().catch(() => ({}))) as { domain?: unknown };
  const domain = typeof body.domain === 'string' ? body.domain.toLowerCase().trim() : '';
  if (!/^[a-z0-9][a-z0-9-]*\.[a-z]{2,12}$/.test(domain)) {
    throw badRequest('`domain` must be a valid FQDN like "acme.com"');
  }

  // 1. Register at Cloudflare Registrar.
  const registration = await domainService.registerDomain(c.env, domain);

  // 2. Provision the matching CF for SaaS custom hostname (sets up SSL +
  //    routes traffic to this Worker). Wrap in try/catch — we never want the
  //    hostname step to roll back a successful registration silently.
  let hostnameResult: { hostname: string; status: string } | null = null;
  try {
    const r = await domainService.provisionCustomDomain(c.env.DB, c.env, {
      org_id: orgId,
      site_id: siteId,
      hostname: domain,
    });
    hostnameResult = { hostname: r.hostname, status: r.status };
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'domain_register',
        message: 'hostname_provision_failed_after_registration',
        domain,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  // Look up the resulting hostname row so the UI can navigate by ID.
  const hostnameRow = await dbQueryOne<{ id: string; status: string }>(
    c.env.DB,
    'SELECT id, status FROM hostnames WHERE site_id = ? AND hostname = ? AND deleted_at IS NULL',
    [siteId, domain],
  );

  await auditService.writeAuditLog(c.env.DB, {
    org_id: orgId,
    actor_id: c.get('userId') ?? null,
    action: 'domain.registered',
    message: `Domain '${domain}' registered via Cloudflare for site '${siteId}'`,
    target_type: 'domain',
    target_id: hostnameRow?.id ?? siteId,
    metadata_json: {
      site_id: siteId,
      domain,
      registrar: 'cloudflare',
      expires_at: registration.expires_at,
      hostname_provisioned: Boolean(hostnameResult),
    },
    request_id: c.get('requestId'),
  });

  try {
    posthog.trackDomain(c.env, c.executionCtx, 'registered', c.get('userId') || orgId, {
      site_id: siteId,
      domain,
    });
  } catch {
    /* ignore */
  }

  return c.json(
    {
      data: {
        domain,
        hostname_id: hostnameRow?.id ?? null,
        status: hostnameRow?.status ?? registration.status,
      },
    },
    201,
  );
});

/**
 * Initiate a port-out for a domain previously registered through
 * Cloudflare. Unlocks the domain, fetches the EPP auth code and surfaces it
 * to the user along with instructions for the gaining registrar.
 *
 * @route POST /api/sites/:siteId/domains/:domain/transfer-out
 * @auth Bearer required. Site ownership enforced AND the hostname row must
 *   belong to the same site (defence in depth).
 * @body `{ new_registrar?: string }` — optional, recorded in the audit log.
 * @returns `{ data: { auth_code, registrar_locked, instructions_url } }`.
 *
 * @example
 * ```bash
 * curl -X POST .../api/sites/$ID/domains/acme.com/transfer-out \
 *   -d '{"new_registrar":"namecheap"}'
 * ```
 */
domains.post('/api/sites/:siteId/domains/:domain/transfer-out', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) throw unauthorized('Must be authenticated');

  const siteId = c.req.param('siteId');
  const domain = (c.req.param('domain') ?? '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.[a-z]{2,12}$/.test(domain)) {
    throw badRequest('Invalid domain in path');
  }

  // Canonical org-ownership guard: 404 (never 403) so cross-org sites don't leak.
  const site = await requireOwnedSite<{ id: string }>(c.env, orgId, siteId);

  // Verify the domain belongs to this site (and is not already deleted).
  const hostnameRow = await dbQueryOne<{ id: string; hostname: string }>(
    c.env.DB,
    'SELECT id, hostname FROM hostnames WHERE site_id = ? AND hostname = ? AND deleted_at IS NULL',
    [siteId, domain],
  );
  if (!hostnameRow) throw notFound('Domain not found for this site');

  const body = (await c.req.json().catch(() => ({}))) as { new_registrar?: unknown };
  const newRegistrar = typeof body.new_registrar === 'string' ? body.new_registrar : undefined;

  const transfer = await domainService.initiateDomainTransfer(c.env, domain);

  await auditService.writeAuditLog(c.env.DB, {
    org_id: orgId,
    actor_id: c.get('userId') ?? null,
    action: 'domain.transfer_out_initiated',
    message: `Domain '${domain}' transfer-out initiated${newRegistrar ? ` to '${newRegistrar}'` : ''}`,
    target_type: 'domain',
    target_id: hostnameRow.id,
    metadata_json: {
      site_id: siteId,
      domain,
      new_registrar: newRegistrar ?? null,
      registrar_locked: false,
    },
    request_id: c.get('requestId'),
  });

  return c.json({ data: transfer });
});

// ── Domain Availability (public, for conversion flow) ──────────────
// Folded VERBATIM from the `search.ts` monolith (route-decomposition installment 24)
// into this module, which already owns the rest of `/api/domains/*`. Public (no auth);
// checks a base name across popular TLDs + variations via WhoisXML with an inline RDAP
// fallback, KV-cached 5 min. The handler-local `const domains` (candidate list) safely
// block-shadows the module `domains` Hono app — different scopes, zero conflict.
domains.get('/api/domains/availability', async (c) => {
  const name = c.req
    .query('name')
    ?.trim()
    .replace(/[^a-z0-9-]/gi, '')
    .toLowerCase();
  if (!name || name.length < 2) {
    return c.json(
      { error: { code: 'BAD_REQUEST', message: 'Name must be at least 2 characters' } },
      400,
    );
  }

  const apiKey = c.env.WHOISXML_API_KEY;

  const baseName = name.replace(/\.[a-z]+$/i, ''); // strip TLD if provided
  // Check the base name across popular TLDs + creative variations likely to be available.
  const exactTlds = ['com', 'net', 'io', 'co', 'dev', 'site'];
  const variations = [
    ...exactTlds.map((tld) => `${baseName}.${tld}`),
    `get${baseName}.com`,
    `my${baseName}.com`,
    `${baseName}hq.com`,
    `the${baseName}.com`,
    `${baseName}.app`,
    `${baseName}.org`,
  ];
  const domains = [...new Set(variations)];

  /**
   * RDAP fallback for domain availability. Verisign (.com/.net) is queried
   * directly; others go through rdap.org bootstrap. RDAP returns 404 for
   * unregistered domains and 200 for registered ones. Used when WhoisXML credits
   * are exhausted or the API key is missing.
   */
  const rdapServers: Record<string, string> = {
    com: 'https://rdap.verisign.com/com/v1/domain',
    net: 'https://rdap.verisign.com/net/v1/domain',
  };

  async function checkViaRdap(domain: string): Promise<{ domain: string; available: boolean }> {
    const tld = domain.split('.').pop() || '';
    const server = rdapServers[tld];
    const url = server ? `${server}/${domain}` : `https://rdap.org/domain/${domain}`;
    const controller = new AbortController();
    // `clearTimeout` in `finally` so a thrown fetch (catch path) can't leak the
    // 8s abort-timer (the abort-timer-leak class; sibling sites in
    // external_llm/newsletter_dispatch already clear in finally).
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    try {
      // SSRF-safe: `url` carries a user-derived `domain` in its path; safeFetch forces
      // redirect:'manual' and re-validates the host allowlist on every hop so an RDAP
      // 3xx can't be followed into an internal host. A blocked host throws → the catch
      // below conservatively marks the domain unavailable.
      const rdapRes = await safeFetch(url, {
        init: { signal: controller.signal, headers: { Accept: 'application/rdap+json' } },
      });
      // 404 = not registered = available; 200 = registered = unavailable.
      return { domain, available: rdapRes.status === 404 };
    } catch (err) {
      // Network error or timeout — conservatively mark as unavailable.
      console.warn(`[domain-availability] RDAP check failed for ${domain}:`, err);
      return { domain, available: false };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // Check all TLDs in parallel via WhoisXML (with RDAP fallback).
  const results = await Promise.allSettled(
    domains.map(async (domain) => {
      // KV cache first (5 min TTL).
      const cacheKey = `domavail:${domain}`;
      const cached = await c.env.CACHE_KV.get(cacheKey);
      if (cached !== null) {
        return { domain, available: cached === '1' };
      }

      if (!apiKey) {
        const result = await checkViaRdap(domain);
        await c.env.CACHE_KV.put(cacheKey, result.available ? '1' : '0', {
          expirationTtl: 300,
        }).catch(() => {});
        return result;
      }

      const res = await fetch(
        `https://domain-availability.whoisxmlapi.com/api/v1?apiKey=${apiKey}&domainName=${encodeURIComponent(domain)}&credits=DA`,
      );

      // Parse body regardless of status — WhoisXML may return 200 with an error body.
      const data = (await res.json().catch(() => ({}))) as {
        DomainInfo?: { domainAvailability?: string };
        code?: number;
        messages?: string;
      };

      // Fall back to RDAP on non-OK status, error code in body, or credits-exhausted message.
      const isApiError =
        !res.ok ||
        (typeof data.code === 'number' && data.code >= 400) ||
        (typeof data.messages === 'string' && data.messages.toLowerCase().includes('credit'));

      if (isApiError || !data.DomainInfo) {
        console.warn(
          `[domain-availability] WhoisXML failed for ${domain} (status=${res.status}, code=${data.code}, msg=${data.messages}), using RDAP fallback`,
        );
        const result = await checkViaRdap(domain);
        await c.env.CACHE_KV.put(cacheKey, result.available ? '1' : '0', {
          expirationTtl: 300,
        }).catch(() => {});
        return result;
      }

      const available = data.DomainInfo.domainAvailability === 'AVAILABLE';

      await c.env.CACHE_KV.put(cacheKey, available ? '1' : '0', { expirationTtl: 300 }).catch(
        () => {},
      );

      return { domain, available };
    }),
  );

  const data = results
    .filter(
      (r): r is PromiseFulfilledResult<{ domain: string; available: boolean }> =>
        r.status === 'fulfilled',
    )
    .map((r) => r.value);

  return c.json({ data });
});
