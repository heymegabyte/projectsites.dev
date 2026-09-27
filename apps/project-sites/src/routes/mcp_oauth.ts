/**
 * @module routes/mcp_oauth
 * @description Per-site MCP (Model Context Protocol) connection layer.
 *
 * Endpoints:
 * - `GET  /api/mcp/:provider/connect?site_id=…&return_url=…` — Build the
 *   authorize URL with PKCE state, or return a paste-key form spec when
 *   the provider has no OAuth.
 * - `GET  /api/mcp/:provider/callback?code=…&state=…` — Exchange the
 *   authorization code, encrypt + upsert tokens into `mcp_connections`,
 *   and redirect back to the dashboard MCP tab.
 * - `POST /api/mcp/:provider/paste` — Paste-key flow for providers
 *   without OAuth (Resend, internal webhooks).
 *
 * Supported providers: MailChimp, Stripe, HubSpot, Slack, Notion, GitHub,
 * Linear, Discord, Google Calendar, Calendly, Airtable, Zapier, Cal.com,
 * Sentry, PagerDuty, PostHog, Vercel, Netlify — plus paste-key fallback
 * for Resend.
 *
 * For OAuth-supported providers that lack a configured client_id (no
 * `{PROVIDER}_OAUTH_CLIENT_ID` worker secret), `/connect` returns HTTP
 * 501 `{ error: 'oauth_not_configured', provider }` so the admin UI can
 * fall back to the paste-API-key flow with a friendly toast instead of
 * opening a broken popup.
 *
 * @packageDocumentation
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { safeRelativePath } from '@project-sites/shared';
import type { Env, Variables } from '../types/env.js';
import { getAdapter, type Provider } from '../services/mcp_client.js';
import { encrypt } from '../services/ai_crypto.js';
import * as auditService from '../services/audit.js';
import { assertSiteOwned } from '../services/site_ownership.js';
import { generateCodeVerifier } from '../services/mcp_pkce.js';

/** Boundary contract for the paste-key flow — a non-empty secret string. */
const PasteKeyBodySchema = z.object({ api_key: z.string().min(1) });

/** OAuth/paste state rows older than this are rejected (replay protection). */
const STATE_TTL = "datetime('now', '-10 minutes')";

export const mcpOauth = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * Map of providers → the env-keys their authorize URL needs. When ALL
 * listed keys resolve to a non-empty string, we treat OAuth as configured
 * and let the adapter build the authorize URL. Providers that connect
 * exclusively via paste-key (Resend, internal webhooks) are omitted —
 * those still take the `__paste_key__` branch below.
 *
 * Naming convention going forward: `{PROVIDER}_OAUTH_CLIENT_ID` +
 * `{PROVIDER}_OAUTH_CLIENT_SECRET`. Historical keys
 * (`MAILCHIMP_CLIENT_ID`, `HUBSPOT_CLIENT_ID`, `STRIPE_CONNECT_CLIENT_ID`)
 * are kept as aliases so existing secrets keep working.
 */
const OAUTH_CLIENT_ID_ENV: Partial<Record<Provider, readonly (keyof Env)[]>> = {
  mailchimp: ['MAILCHIMP_CLIENT_ID', 'MAILCHIMP_OAUTH_CLIENT_ID' as keyof Env],
  hubspot: ['HUBSPOT_CLIENT_ID', 'HUBSPOT_OAUTH_CLIENT_ID' as keyof Env],
  stripe: ['STRIPE_CONNECT_CLIENT_ID', 'STRIPE_OAUTH_CLIENT_ID' as keyof Env],
  slack: ['SLACK_CLIENT_ID' as keyof Env, 'SLACK_OAUTH_CLIENT_ID' as keyof Env],
  notion: ['NOTION_OAUTH_CLIENT_ID' as keyof Env],
  github: ['GITHUB_CLIENT_ID', 'GITHUB_OAUTH_CLIENT_ID' as keyof Env],
  linear: ['LINEAR_OAUTH_CLIENT_ID' as keyof Env],
  discord: ['DISCORD_CLIENT_ID' as keyof Env, 'DISCORD_OAUTH_CLIENT_ID' as keyof Env],
  google_calendar: ['GOOGLE_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_ID' as keyof Env],
  calendly: ['CALENDLY_OAUTH_CLIENT_ID' as keyof Env],
  // Turn 5 — additional providers flipped to OAuth-first in the catalogue.
  // All use the new `{PROVIDER}_OAUTH_CLIENT_ID` naming convention; no
  // historical aliases since none of these previously had a paste-key path.
  airtable: ['AIRTABLE_OAUTH_CLIENT_ID' as keyof Env],
  zapier: ['ZAPIER_OAUTH_CLIENT_ID' as keyof Env],
  cal_com: ['CAL_COM_OAUTH_CLIENT_ID' as keyof Env, 'CALCOM_OAUTH_CLIENT_ID' as keyof Env],
  sentry: ['SENTRY_OAUTH_CLIENT_ID' as keyof Env],
  pagerduty: ['PAGERDUTY_OAUTH_CLIENT_ID' as keyof Env],
  posthog: ['POSTHOG_OAUTH_CLIENT_ID' as keyof Env],
  vercel: ['VERCEL_OAUTH_CLIENT_ID' as keyof Env],
  netlify: ['NETLIFY_OAUTH_CLIENT_ID' as keyof Env],
};

function readEnvString(env: Env, key: keyof Env): string {
  const raw = (env as unknown as Record<string, unknown>)[key as string];
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * `true` when at least one of the provider's expected client_id env keys
 * resolves to a non-empty string. Returns `true` for providers that don't
 * appear in {@link OAUTH_CLIENT_ID_ENV} so paste-key adapters still work.
 */
function isOauthConfigured(env: Env, provider: Provider): boolean {
  const keys = OAUTH_CLIENT_ID_ENV[provider];
  if (!keys) return true;
  return keys.some((k) => readEnvString(env, k).length > 0);
}

/**
 * `GET /api/mcp/:provider/connect?site_id=…&return_url=…` — Start an MCP
 * provider connection (OAuth authorize redirect OR paste-key spec).
 *
 * @remarks
 * Generates a one-shot `state` + PKCE `code_verifier`, persists them in
 * `mcp_oauth_states`, and either:
 * - **OAuth providers** — returns a `302` redirect to the authorize URL
 *   built by {@link getAdapter}'s `authorizeUrl`.
 * - **Paste-key providers** (Resend, internal webhooks) — returns
 *   `{ data: { mode: 'paste_key', provider, state, post_to, instructions } }`
 *   so the UI can render the paste form.
 *
 * @throws 400 BAD_REQUEST when `site_id` is missing.
 * @throws 401 UNAUTHORIZED when org/user context is missing.
 * @throws 404 NOT_FOUND when the provider doesn't have an adapter.
 * @throws 501 NOT_IMPLEMENTED when the provider has OAuth but the worker
 *   lacks `{PROVIDER}_OAUTH_CLIENT_ID`. The UI falls back to paste-key.
 */
mcpOauth.get('/api/mcp/:provider/connect', async (c) => {
  const orgId = c.get('orgId') as string | undefined;
  const userId = c.get('userId') as string | undefined;
  if (!orgId || !userId) return c.json({ error: { message: 'auth required' } }, 401);
  const provider = c.req.param('provider') as Provider;
  const adapter = getAdapter(provider);
  if (!adapter) return c.json({ error: { message: 'unknown provider' } }, 404);
  const siteId = c.req.query('site_id');
  if (!siteId) return c.json({ error: { message: 'site_id required' } }, 400);
  if (!isOauthConfigured(c.env, provider)) {
    return c.json({ error: 'oauth_not_configured', provider }, 501);
  }
  // Ownership check — never bind a connection to a site the caller doesn't own.
  // Canonical IDOR/CWE-639 guard (404 never 403 — never leak existence).
  if (!(await assertSiteOwned(c.env, orgId, siteId))) {
    return c.json({ error: { message: 'site not found' } }, 404);
  }
  // Sanitize to a same-origin relative path — the callback composes
  // `https://projectsites.dev${returnUrl}`, so an unchecked `@evil.com` /
  // `//evil.com` would be an open redirect. (Stored safe → callback is safe.)
  const returnUrl = safeRelativePath(c.req.query('return_url'), '/admin/mcp');
  const state = crypto.randomUUID().replace(/-/g, '');
  // RFC 7636 PKCE verifier — shared helper (services/mcp_pkce.ts) rather than an
  // inline re-implementation, so the one canonical generator is imported here and
  // unit-tested there. Emits a base64url verifier in the spec's [43,128] range.
  const codeVerifier = generateCodeVerifier();

  await c.env.DB.prepare(
    `INSERT INTO mcp_oauth_states (state, org_id, site_id, provider, code_verifier, return_url)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(state, orgId, siteId, provider, codeVerifier, returnUrl)
    .run();

  const url = adapter.authorizeUrl(c.env, {
    state,
    codeVerifier,
    returnUrl: `https://projectsites.dev${returnUrl}`,
  });
  if (url.startsWith('__paste_key__')) {
    // Provider has no OAuth — return paste-key spec.
    return c.json({
      data: {
        mode: 'paste_key',
        provider,
        state,
        post_to: `/api/mcp/${provider}/paste?state=${state}`,
        instructions:
          provider === 'resend'
            ? 'Paste your Resend API key (starts with re_). Find it at https://resend.com/api-keys.'
            : 'Paste the API key.',
      },
    });
  }
  // Return the authorize URL as JSON rather than a 302. This route is
  // bearer-auth-gated (orgId/userId required above), so a `window.location.href`
  // browser navigation can't authenticate and 401s with "auth required" (the
  // MailChimp / Stripe / HubSpot connect bug). The admin fetches this WITH the
  // bearer, then navigates the top window to `authorize_url` itself.
  return c.json({ data: { mode: 'oauth', authorize_url: url } });
});

/**
 * `GET /api/mcp/:provider/callback?code=…&state=…` — OAuth redirect
 * landing endpoint.
 *
 * @remarks
 * Looks up the matching `mcp_oauth_states` row, exchanges the code via
 * {@link getAdapter}'s `exchangeCode`, encrypts the resulting access
 * (and optional refresh) token via {@link encrypt} (AES-GCM with a
 * per-record IV), upserts into `mcp_connections` keyed by
 * `(site_id, provider)`, deletes the state row, writes an audit entry,
 * then `302`-redirects back to `return_url` with `?connected={provider}`.
 *
 * @throws 400 BAD_REQUEST when `code`/`state` missing or state row not found.
 * @throws 404 NOT_FOUND when the provider doesn't have an adapter.
 * @throws 502 BAD_GATEWAY when the upstream token exchange fails.
 */
mcpOauth.get('/api/mcp/:provider/callback', async (c) => {
  const provider = c.req.param('provider') as Provider;
  const adapter = getAdapter(provider);
  if (!adapter) return c.json({ error: { message: 'unknown provider' } }, 404);
  const code = c.req.query('code');

  // ── Vercel Marketplace install flow ──
  // Vercel-initiated installs hit this callback with `code` (+ `configurationId` +
  // `teamId` + `next`) but NO `state` (there's no prior /connect state row).
  // Exchange the code, store the token account-level keyed on the EXCHANGE-returned
  // identity (installation_id — the provider's authoritative claim), then redirect
  // the user back to Vercel's `next` ("installed") page.
  //
  // IDOR hardening (2026-08-20, security-review wave): the credential write was
  // previously keyed on the CLIENT-supplied `configurationId` with
  // `ON CONFLICT ... DO UPDATE` — any Vercel user could install the public
  // integration, rewrite `configurationId` to a victim's ID, and clobber that
  // victim's connection row with their own token (CWE-639). Now the row key is
  // the exchange-returned `installation_id`; a client-supplied
  // `configurationId` MUST match it (or be absent) or the write is refused 403.
  if (provider === 'vercel' && !c.req.query('state')) {
    if (!code) return c.json({ error: { message: 'code required' } }, 400);
    const configurationId = (c.req.query('configurationId') as string | undefined) ?? null;
    const teamId = c.req.query('teamId') ?? null;
    const next = c.req.query('next');
    let vx;
    try {
      vx = await adapter.exchangeCode(c.env, {
        code,
        redirectUri: 'https://projectsites.dev/api/mcp/vercel/callback',
      });
    } catch (err) {
      // Adapters (airtable/vercel/etc.) bake the raw upstream body into the thrown
      // error (`vercel oauth 400: ${await res.text()}`). Log it; return a generic
      // client message so the provider body never leaks (info-disclosure hardening).
      console.warn(
        JSON.stringify({
          level: 'error',
          service: 'mcp-oauth-callback',
          message: 'oauth exchange failed',
          provider: 'vercel',
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return c.json(
        {
          error: {
            code: 'OAUTH_EXCHANGE_FAILED',
            message: 'Connection failed — please try again.',
          },
        },
        502,
      );
    }
    const installationId = vx.metadata?.installation_id as string | undefined;
    if (!installationId) {
      // The exchange gave us no authoritative identity — refuse rather than
      // fall back to the client-supplied id (that was the vulnerability).
      console.warn(
        JSON.stringify({
          level: 'error',
          service: 'mcp-oauth-callback',
          message: 'vercel exchange returned no installation_id',
          provider: 'vercel',
        }),
      );
      return c.json(
        {
          error: {
            code: 'OAUTH_EXCHANGE_FAILED',
            message: 'Connection failed — please try again.',
          },
        },
        502,
      );
    }
    if (configurationId && configurationId !== installationId) {
      // The client-supplied configurationId does NOT match the installation the
      // exchanged code actually authorizes — a cross-installation clobber
      // attempt. Refuse before any write.
      console.warn(
        JSON.stringify({
          level: 'warn',
          service: 'mcp-oauth-callback',
          message: 'vercel configurationId mismatch rejected',
          provider: 'vercel',
          expected: configurationId,
          actual: installationId,
        }),
      );
      return c.json({ error: { code: 'FORBIDDEN', message: 'Configuration mismatch.' } }, 403);
    }
    const encTok = await encrypt(c.env, vx.access_token);
    await c.env.DB.prepare(
      `INSERT INTO mcp_connections (id, org_id, site_id, provider, display_name,
         access_token_encrypted, refresh_token_encrypted, token_expires_at, account_metadata_json, status)
       VALUES (?, 'vercel-marketplace', ?, 'vercel', 'Vercel (marketplace)', ?, NULL, NULL, ?, 'active')
       ON CONFLICT(site_id, provider) DO UPDATE SET
         access_token_encrypted = excluded.access_token_encrypted,
         account_metadata_json = excluded.account_metadata_json,
         status = 'active', updated_at = datetime('now')`,
    )
      .bind(
        crypto.randomUUID(),
        `vercel:${installationId}`,
        encTok,
        JSON.stringify({ ...vx.metadata, configurationId, teamId }),
      )
      .run();
    // Open-redirect defense: only bounce back to Vercel's own host.
    if (next && /^https:\/\/vercel\.com\//.test(next)) return c.redirect(next, 302);
    return c.json({ ok: true, connected: 'vercel' });
  }

  const state = c.req.query('state');
  if (!code || !state) return c.json({ error: { message: 'code + state required' } }, 400);

  const stateRow = await c.env.DB.prepare(
    `SELECT org_id, site_id, code_verifier, return_url FROM mcp_oauth_states
       WHERE state = ? AND created_at > ${STATE_TTL}`,
  )
    .bind(state)
    .first<{ org_id: string; site_id: string; code_verifier: string; return_url: string }>();
  if (!stateRow) return c.json({ error: { message: 'invalid or expired state' } }, 400);

  let exchange;
  try {
    exchange = await adapter.exchangeCode(c.env, {
      code,
      codeVerifier: stateRow.code_verifier,
      redirectUri: `https://projectsites.dev/api/mcp/${provider}/callback`,
    });
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'error',
        service: 'mcp-oauth-callback',
        message: 'oauth exchange failed',
        provider,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return c.json(
      {
        error: { code: 'OAUTH_EXCHANGE_FAILED', message: 'Connection failed — please try again.' },
      },
      502,
    );
  }
  const enc = await encrypt(c.env, exchange.access_token);
  const encRefresh = exchange.refresh_token ? await encrypt(c.env, exchange.refresh_token) : null;
  const expiresAt = exchange.expires_in
    ? new Date(Date.now() + exchange.expires_in * 1000).toISOString()
    : null;
  const id = crypto.randomUUID();
  // Upsert by (site_id, provider).
  await c.env.DB.prepare(
    `INSERT INTO mcp_connections (id, org_id, site_id, provider, display_name,
       access_token_encrypted, refresh_token_encrypted, token_expires_at, account_metadata_json, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
     ON CONFLICT(site_id, provider) DO UPDATE SET
       access_token_encrypted = excluded.access_token_encrypted,
       refresh_token_encrypted = excluded.refresh_token_encrypted,
       token_expires_at = excluded.token_expires_at,
       account_metadata_json = excluded.account_metadata_json,
       status = 'active',
       updated_at = datetime('now')`,
  )
    .bind(
      id,
      stateRow.org_id,
      stateRow.site_id,
      provider,
      `${provider} connection`,
      enc,
      encRefresh,
      expiresAt,
      exchange.metadata ? JSON.stringify(exchange.metadata) : null,
    )
    .run();
  await c.env.DB.prepare(`DELETE FROM mcp_oauth_states WHERE state = ?`).bind(state).run();

  // Resolve the slug so the audit message names the site, not a raw UUID.
  const oauthSiteRow = await c.env.DB.prepare(`SELECT slug FROM sites WHERE id = ?`)
    .bind(stateRow.site_id)
    .first<{ slug: string }>();

  c.executionCtx.waitUntil(
    auditService.writeAuditLog(c.env.DB, {
      org_id: stateRow.org_id,
      actor_id: null,
      action: 'mcp.connected',
      message: `MCP '${provider}' connected via OAuth to site '${auditService.auditSiteLabel(oauthSiteRow?.slug, stateRow.site_id)}'`,
      target_type: 'mcp_connection',
      target_id: stateRow.site_id,
      metadata_json: { provider, site_id: stateRow.site_id, flow: 'oauth' },
      request_id: c.get('requestId'),
    }),
  );

  // Render a tiny "connected" page that messages the opener (the admin tab that
  // launched the popup) and closes itself — rather than 302-redirecting the
  // POPUP to the dashboard, which loaded the full SPA inside the 560×720 window.
  // The opener listens for `ps:mcp:connected` and reloads its connection list so
  // the provider flips to "Connected" live; the self-close also trips the
  // opener's `popup.closed` poll as a belt-and-suspenders fallback. If the
  // browser blocks `window.close()` (rare for script-opened windows), we bounce
  // back to the return URL so the user is never stranded on a blank popup.
  const returnUrl = `https://projectsites.dev${stateRow.return_url}?connected=${provider}`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connected</title><style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#060610;color:#f4f4ff;display:grid;place-items:center;min-height:100vh;margin:0}.c{text-align:center;max-width:24rem;padding:1.5rem}.dot{color:#00e5ff;font-size:2rem;line-height:1}p{opacity:.8;font-size:.9rem;margin:.6rem 0 0}</style></head><body><div class="c"><div class="dot">✓</div><p>${provider} connected. You can close this window.</p></div><script>(function(){var provider=${JSON.stringify(provider)};var returnUrl=${JSON.stringify(returnUrl)};try{if(window.opener){window.opener.postMessage({type:"ps:mcp:connected",provider:provider},"https://projectsites.dev");}}catch(e){}setTimeout(function(){try{window.close();}catch(e){}setTimeout(function(){try{window.location.replace(returnUrl);}catch(e){}},500);},120);})();</script></body></html>`;
  return c.html(html);
});

/**
 * `POST /api/mcp/:provider/paste?state=…&site_id=…` — Paste-key flow for
 * providers with no OAuth (Resend, internal webhooks).
 *
 * @remarks
 * Body: `{ api_key }`. Encrypts the key via {@link encrypt} (AES-GCM
 * per-record IV) and upserts into `mcp_connections` keyed by
 * `(site_id, provider)`. `site_id` is resolved from the `state` row
 * created by `/connect` or accepted directly as a query param. Audit-logged.
 *
 * @throws 400 BAD_REQUEST when `api_key` or `site_id` is missing.
 * @throws 401 UNAUTHORIZED when org context is missing.
 */
mcpOauth.post('/api/mcp/:provider/paste', async (c) => {
  const orgId = c.get('orgId') as string | undefined;
  if (!orgId) return c.json({ error: { message: 'auth required' } }, 401);
  const provider = c.req.param('provider') as Provider;
  const state = c.req.query('state');
  // Zod boundary (zod-everywhere): a malformed JSON body previously threw an
  // unhandled 500; now both unparseable JSON and a missing/non-string api_key
  // resolve to a clean 400. The key is a secret — never trust the cast.
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: { message: 'api_key required' } }, 400);
  }
  const parsed = PasteKeyBodySchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: { message: 'api_key required' } }, 400);
  const { api_key } = parsed.data;
  const stateRow = state
    ? await c.env.DB.prepare(
        `SELECT site_id FROM mcp_oauth_states WHERE state = ? AND org_id = ? AND created_at > ${STATE_TTL}`,
      )
        .bind(state, orgId)
        .first<{ site_id: string }>()
    : null;
  const siteId = stateRow?.site_id ?? (c.req.query('site_id') as string | undefined);
  if (!siteId) return c.json({ error: { message: 'site_id required' } }, 400);
  // Ownership check — the `site_id` query fallback (no state) is attacker-controlled;
  // never write a credential onto a site the caller's org doesn't own (IDOR).
  if (!(await assertSiteOwned(c.env, orgId, siteId))) {
    return c.json({ error: { message: 'site not found' } }, 404);
  }
  const enc = await encrypt(c.env, api_key);
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO mcp_connections (id, org_id, site_id, provider, display_name,
       access_token_encrypted, status)
     VALUES (?, ?, ?, ?, ?, ?, 'active')
     ON CONFLICT(site_id, provider) DO UPDATE SET
       access_token_encrypted = excluded.access_token_encrypted,
       status = 'active',
       updated_at = datetime('now')`,
  )
    .bind(id, orgId, siteId, provider, `${provider} (pasted key)`, enc)
    .run();
  if (state)
    await c.env.DB.prepare(`DELETE FROM mcp_oauth_states WHERE state = ?`).bind(state).run();

  // Resolve the slug so the audit message names the site, not a raw UUID.
  const pasteSiteRow = await c.env.DB.prepare(`SELECT slug FROM sites WHERE id = ?`)
    .bind(siteId)
    .first<{ slug: string }>();

  c.executionCtx.waitUntil(
    auditService.writeAuditLog(c.env.DB, {
      org_id: orgId,
      actor_id: c.get('userId') ?? null,
      action: 'mcp.connected',
      message: `MCP '${provider}' connected via pasted API key to site '${auditService.auditSiteLabel(pasteSiteRow?.slug, siteId)}'`,
      target_type: 'mcp_connection',
      target_id: siteId,
      metadata_json: { provider, site_id: siteId, flow: 'paste_key' },
      request_id: c.get('requestId'),
    }),
  );

  return c.json({ data: { connected: true } });
});

/**
 * `GET /api/mcp/connections` — list the caller org's MCP connections. Returns
 * safe columns ONLY — encrypted access/refresh tokens are never selected, so a
 * leak here exposes nothing sensitive. Newest first.
 *
 * Optional scope filters (all AND-combined with the org scope):
 * - `site_id` OR `siteId` — restrict to one site. Consumers disagree on casing
 *   (env-vars-attachment sends `site_id`; voice/mcps sends `siteId`), so BOTH are
 *   accepted. Previously ignored → both surfaces showed EVERY org connection
 *   regardless of the site in context (a contract mismatch each worked around as
 *   "best-effort"). Now honored so the connection list is truly site-scoped.
 * - `provider` — restrict to one provider (mailchimp/stripe/resend/…).
 *
 * With NO filter the endpoint stays org-wide (its original contract). Only
 * `site_id`/`provider` are real `mcp_connections` columns; `endpoint_id`/`agent_id`
 * (which env-vars-attachment sends for those kinds) are not — connections aren't
 * scoped to endpoints/agents, so those params are intentionally not filters.
 *
 * @remarks Powers the v2 admin Integrations/MCP surface + the env-var attachment
 * picker + the voice MCP-attachment picker. Org-scoped via the session `orgId`
 * (no `x-org-id` header dependency).
 * @throws 401 UNAUTHORIZED when org context is missing.
 */
mcpOauth.get('/api/mcp/connections', async (c) => {
  const orgId = c.get('orgId') as string | undefined;
  if (!orgId) return c.json({ error: { message: 'auth required' } }, 401);

  // Optional scope filters. Accept both casings for the site filter (two
  // consumers, two conventions). Absent filters → org-wide (original contract).
  const siteId = c.req.query('site_id') ?? c.req.query('siteId');
  const provider = c.req.query('provider');
  const where: string[] = ['org_id = ?'];
  const binds: unknown[] = [orgId];
  if (siteId) {
    where.push('site_id = ?');
    binds.push(siteId);
  }
  if (provider) {
    where.push('provider = ?');
    binds.push(provider);
  }

  const rows = await c.env.DB.prepare(
    `SELECT id, site_id, provider, display_name, status, scopes_json,
            token_expires_at, connected_at, updated_at
       FROM mcp_connections WHERE ${where.join(' AND ')}
       ORDER BY connected_at DESC`,
  )
    .bind(...binds)
    .all<Record<string, unknown>>();
  const data = (rows.results ?? []).map((r) => ({
    ...r,
    scopes: r['scopes_json'] ? (JSON.parse(r['scopes_json'] as string) as unknown[]) : [],
  }));
  return c.json({ data });
});
