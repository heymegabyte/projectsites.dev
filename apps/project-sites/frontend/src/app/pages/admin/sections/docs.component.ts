import {
  Component,
  Injectable,
  computed,
  inject,
  signal,
  type OnInit,
  type Signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ApiService } from '../../../services/api.service';
import { HlmInputDirective } from '../../../ui';
import { BrnTooltipImports } from '@spartan-ng/brain/tooltip';
import { RollingCounterComponent } from '../../../components/rolling-counter/rolling-counter.component';
import { RevealDirective } from '../../../directives/reveal.directive';

/**
 * One operation in the OpenAPI document. Flattened from `paths[path][method]`
 * so the UI can sort + filter + group with a single `Array.prototype.filter`.
 *
 * Exported so the per-endpoint child route component can re-use the same
 * shape — both the parent shell (left rail) and the child (detail card)
 * read from the same spec source via {@link DocsSpecService}.
 */
export interface Operation {
  /** Upper-case HTTP method (`GET`, `POST`, ...). */
  readonly method: string;
  /** OpenAPI-style path with `{param}` segments. */
  readonly path: string;
  /** Short summary — the right-pane title and the row label. */
  readonly summary: string;
  /** First tag — used to group endpoints in the left rail. */
  readonly tag: string;
  /** Stable operation id (e.g. `get_api_auth_me`) used as the route param. */
  readonly operationId: string;
  /** `true` when the path declares `security: [{ bearerAuth: [] }]`. */
  readonly authRequired: boolean;
  /** Path parameters extracted from the spec. */
  readonly parameters: ReadonlyArray<{ name: string; in: string; description?: string }>;
  /** Optional request-body JSON schema. */
  readonly requestBody?: unknown;
  /** Optional example response body. */
  readonly responseExample?: unknown;
  /** Human-facing category from `x-category` (broader than `tag`). */
  readonly category: string;
  /** Rate limit from `x-rate-limit` — `null` when unbounded. */
  readonly rateLimit: { requests: number; windowSeconds: number } | null;
  /** ISO-8601 ship date from `x-added-at`. */
  readonly addedAt: string | null;
}

/** Top-level OpenAPI spec shape we actually consume. */
export interface OpenApiSpec {
  readonly openapi: string;
  readonly info: { title: string; version: string; description?: string };
  readonly tags?: Array<{ name: string; description?: string }>;
  readonly paths: Record<string, Record<string, RawOp>>;
}

interface RawOp {
  summary?: string;
  tags?: string[];
  operationId?: string;
  security?: unknown[];
  parameters?: Array<{ name: string; in: string; description?: string }>;
  requestBody?: { content?: { 'application/json'?: { schema?: unknown } } };
  responses?: Record<string, { content?: { 'application/json'?: { example?: unknown } } }>;
  ['x-category']?: string;
  ['x-rate-limit']?: { requests: number; windowSeconds: number };
  ['x-added-at']?: string;
}

/** Shape returned by `GET /api/admin/docs/stats`. */
export interface DocsStats {
  readonly total: number;
  readonly public: number;
  readonly authed: number;
  readonly rate_limited: number;
  readonly recent: ReadonlyArray<{
    method: string;
    path: string;
    addedAt: string;
    category?: string;
  }>;
  readonly category_counts: Readonly<Record<string, number>>;
  readonly generated_at: string;
}

/**
 * Per-endpoint enrichment loaded over the top of the OpenAPI summary. Keyed by
 * `${METHOD} ${path}` where path uses the OpenAPI `{param}` form. Anything not
 * mapped here falls back to the spec-derived defaults.
 *
 * The map intentionally lives in the admin SPA (not the worker) because Brian
 * wants the prose to evolve faster than the worker deploys — a typo fix here
 * ships with the next R2 push, not the next `wrangler deploy`.
 */
export interface EndpointMeta {
  /** One-paragraph human description — what it does, when to use. */
  readonly description: string;
  /** Optional override for the auth chip ("yes" / "no" / "optional"). */
  readonly auth?: 'yes' | 'no' | 'optional';
  /** Extra request headers beyond `Authorization` + `Content-Type`. */
  readonly extraHeaders?: ReadonlyArray<{ name: string; value: string; note?: string }>;
  /** Response shape — short JSON-looking string rendered in a `<pre>`. */
  readonly responseShape?: string;
  /** Error codes this endpoint specifically returns (in addition to the global set). */
  readonly errorCodes?: ReadonlyArray<string>;
}

/* eslint-disable max-len */
export const ENDPOINT_META: Record<string, EndpointMeta> = {
  // ─── auth ───
  'GET /api/auth/me': {
    description:
      'Returns the currently signed-in user and the active session. Used by every admin page to hydrate the avatar, role chips, and feature-flag mask. Returns 401 when the bearer token is missing, expired, or revoked — clients should treat 401 here as "sign back in" not "retry".',
    auth: 'yes',
    responseShape: `{ "data": { "user": { "id": "uuid", "email": "string", "name": "string|null" }, "session": { "expires_at": "ISO-8601" } } }`,
    errorCodes: ['UNAUTHORIZED'],
  },
  'POST /api/auth/magic-link': {
    description:
      'Send a magic-link email to the given address. The link resolves to `/api/auth/magic-link/verify?token=…` and is single-use, 15-minute TTL. Rate-limited to 3 requests per email per 10 minutes to prevent inbox flooding. Always returns 200 even when the email is unknown (to avoid account enumeration).',
    auth: 'no',
    responseShape: `{ "data": { "sent": true, "expires_in_seconds": 900 } }`,
    errorCodes: ['BAD_REQUEST', 'RATE_LIMITED'],
  },
  'POST /api/auth/magic-link/verify': {
    description:
      'Programmatic magic-link verification — exchange a one-time `token` for a long-lived bearer session token. Use this from CLIs / mobile apps that intercept the email link out-of-band. Browsers should use the GET form, which sets the session cookie + redirects to the admin shell.',
    auth: 'no',
    responseShape: `{ "data": { "token": "hex-32", "user_id": "uuid", "expires_at": "ISO-8601" } }`,
    errorCodes: ['UNAUTHORIZED', 'NOT_FOUND'],
  },
  'GET /api/auth/google': {
    description:
      "Start the Google OAuth 2.0 PKCE flow. Returns a 302 redirect to Google's consent screen with `code_challenge`, `state`, and the projectsites.dev callback URL pre-wired. The matching `state` is stored in D1 `oauth_states` for callback validation.",
    auth: 'no',
    responseShape: `302 redirect → https://accounts.google.com/o/oauth2/v2/auth?…`,
    errorCodes: ['INTERNAL_ERROR'],
  },
  'GET /api/auth/google/callback': {
    description:
      'Google OAuth callback. Exchanges the `code` for an id_token, upserts the user, mints a session, sets the cookie, and redirects to `/admin` (or `?return_url=` if provided). Validates `state` against D1 — invalid state returns 400 instead of issuing a session.',
    auth: 'no',
    responseShape: `302 redirect → /admin (Set-Cookie: ps_session=…)`,
    errorCodes: ['BAD_REQUEST', 'UNAUTHORIZED'],
  },

  // ─── sites ───
  'GET /api/sites': {
    description:
      'List every site the signed-in user owns or has access to via their organization memberships. Includes status, slug, plan, primary hostname, and the latest workflow snapshot. Use this to power the admin sidebar site picker.',
    auth: 'yes',
    responseShape: `{ "data": Site[], "meta": { "total": 12 } }`,
  },
  'POST /api/sites': {
    description:
      'Create a new site row manually (most users go through `/api/sites/create-from-search` which also kicks the AI workflow). Provide `slug`, `name`, and optional `business_type`. The slug is validated for uniqueness — collisions return 409.',
    auth: 'yes',
    responseShape: `{ "data": { "id": "uuid", "slug": "string", "status": "draft" } }`,
    errorCodes: ['CONFLICT', 'VALIDATION_ERROR'],
  },
  'GET /api/sites/{id}': {
    description:
      'Get one site by its UUID. Returns the full site row including research data, brand JSON, hostname list, and current workflow status. 404 when the site does not exist or the caller has no access (we return 404 instead of 403 to avoid leaking existence).',
    auth: 'yes',
    responseShape: `{ "data": Site }`,
    errorCodes: ['NOT_FOUND'],
  },
  'POST /api/sites/{id}/reset': {
    description:
      'Wipe the generated assets in R2 and trigger a full rebuild from scratch. Useful when research drifted or when the user re-uploaded brand assets after the first build. Does NOT delete snapshots — those are immutable per the snapshot contract.',
    auth: 'yes',
    responseShape: `{ "data": { "workflow_id": "uuid", "started_at": "ISO-8601" } }`,
    errorCodes: ['NOT_FOUND', 'CONFLICT'],
  },
  'POST /api/sites/{id}/deploy': {
    description:
      'Deploy a pre-built ZIP straight to R2 — bypasses the AI workflow. Body is `multipart/form-data` with a `zip` file part. Used by the bolt editor "Publish" button and by CI pipelines uploading externally-built artifacts.',
    auth: 'yes',
    extraHeaders: [
      { name: 'Content-Type', value: 'multipart/form-data', note: 'overrides default' },
    ],
    responseShape: `{ "data": { "deployed_at": "ISO-8601", "files": 47 } }`,
    errorCodes: ['PAYLOAD_TOO_LARGE', 'NOT_FOUND'],
  },
  'POST /api/sites/{id}/publish-bolt': {
    description:
      "Receive a bolt.diy editor PostMessage payload (`PS_FILES_READY`) and persist the file tree to R2 under the site's slug. Diffs against the previous version, snapshots the prior build, and purges the CDN for the affected paths.",
    auth: 'yes',
    responseShape: `{ "data": { "snapshot_id": "uuid", "files_changed": 12 } }`,
  },
  'GET /api/sites/{id}/logs': {
    description:
      'Return the append-only audit log filtered to a single site. Includes deploys, hostname changes, billing events, AI workflow steps, and user-attribution metadata. Paginate with `?limit` (default 100, max 200) + `?offset`; `meta.total` is the full match count and `meta.has_more` says whether another page exists.',
    auth: 'yes',
    responseShape: `{ "data": AuditLog[], "meta": { "limit": 100, "offset": 0, "total": 213, "has_more": true } }`,
  },
  'GET /api/sites/{id}/workflow': {
    description:
      'Get the current Cloudflare Workflow status for a site build — phase, step, retries, elapsed wall-clock, and the partial research JSON. Frontend polls this on the waiting screen and shows the inline progress meter on `/admin/editor`.',
    auth: 'yes',
    responseShape: `{ "data": { "id": "uuid", "status": "running|complete|errored", "step": "container-build", "progress": 0.72 } }`,
  },
  'DELETE /api/sites/{id}': {
    description:
      'Soft-delete a site (sets `deleted_at`). The R2 assets are retained for 30 days then garbage-collected by the nightly cron. Hostnames are released back to the pool immediately.',
    auth: 'yes',
    responseShape: `{ "data": { "deleted_at": "ISO-8601" } }`,
    errorCodes: ['NOT_FOUND'],
  },

  // ─── snapshots ───
  'GET /api/sites/{siteId}/snapshots': {
    description:
      'List every snapshot for a site, newest first. Each snapshot is an immutable point-in-time copy of the file tree in R2, accessible at `{slug}-{snapshot_name}.projectsites.dev`. The first snapshot of every site is auto-named `initial`; later ones are AI-named from the diff.',
    auth: 'yes',
    responseShape: `{ "data": Snapshot[], "meta": { "total": 8 } }`,
  },
  'POST /api/sites/{siteId}/snapshots': {
    description:
      'Freeze the current site state as a new snapshot. Idempotent against `Idempotency-Key` for 24h. The snapshot inherits the current primary hostname mapping but lives at its own subdomain forever.',
    auth: 'yes',
    extraHeaders: [{ name: 'Idempotency-Key', value: 'uuid', note: 'optional but recommended' }],
    responseShape: `{ "data": { "id": "uuid", "name": "string", "created_at": "ISO-8601" } }`,
  },
  'POST /api/sites/{siteId}/snapshots/revert': {
    description:
      'Promote a snapshot back to the live site — copies its file tree over the current R2 prefix and purges the CDN. The previous live state is itself snapshotted first, so revert is always reversible.',
    auth: 'yes',
    responseShape: `{ "data": { "previous_snapshot_id": "uuid", "reverted_to": "uuid" } }`,
    errorCodes: ['NOT_FOUND'],
  },

  // ─── hostnames ───
  'GET /api/sites/{siteId}/hostnames': {
    description:
      'List every custom hostname attached to a site, plus the default `{slug}.projectsites.dev`. Includes Cloudflare-for-SaaS verification status (`pending|active|moved`) and SSL state.',
    auth: 'yes',
    responseShape: `{ "data": Hostname[] }`,
  },
  'POST /api/sites/{siteId}/hostnames': {
    description:
      'Provision a custom hostname via Cloudflare for SaaS. Returns the CNAME target the user must add at their DNS provider. SSL is issued automatically once the CNAME resolves; status flips from `pending` to `active`.',
    auth: 'yes',
    responseShape: `{ "data": { "id": "uuid", "hostname": "www.example.com", "cname_target": "cname.projectsites.dev", "status": "pending" } }`,
    errorCodes: ['CONFLICT', 'DOMAIN_PROVISIONING_ERROR'],
  },
  'PUT /api/sites/{siteId}/hostnames/{hostnameId}/primary': {
    description:
      'Mark a hostname as the canonical one. The canonical hostname is used for sitemap.xml URLs, OG meta `og:url`, and the `<link rel="canonical">` tag injected into every rendered page.',
    auth: 'yes',
    responseShape: `{ "data": { "primary_hostname_id": "uuid" } }`,
  },

  // ─── billing ───
  'POST /api/billing/checkout': {
    description:
      'Create a Stripe Checkout session (hosted page). Body takes `price_id` plus optional `success_url` / `cancel_url`. Returns the Stripe-hosted URL the client should redirect to. We webhook back to `/webhooks/stripe` for entitlement updates.',
    auth: 'yes',
    responseShape: `{ "data": { "url": "https://checkout.stripe.com/c/pay/cs_…", "session_id": "cs_…" } }`,
    errorCodes: ['STRIPE_ERROR'],
  },
  'POST /api/billing/embedded-checkout': {
    description:
      'Like `/checkout` but returns a `client_secret` for the Stripe.js Embedded Checkout component — used by the in-product paywall modal so users never leave projectsites.dev.',
    auth: 'yes',
    responseShape: `{ "data": { "client_secret": "cs_…_secret_…" } }`,
    errorCodes: ['STRIPE_ERROR'],
  },
  'GET /api/billing/subscription': {
    description:
      "Current Stripe subscription state for the user's active org. Includes plan, status (`active|past_due|canceled`), `current_period_end`, and trial info. Returns `{ data: null }` when the user is on the free tier.",
    auth: 'yes',
    responseShape: `{ "data": { "plan": "pro", "status": "active", "current_period_end": "ISO-8601" } | null }`,
  },
  'POST /api/billing/portal': {
    description:
      'Create a Stripe Customer Portal session — the user can update payment methods, view invoices, and cancel from a Stripe-hosted page. Returns the portal URL.',
    auth: 'yes',
    responseShape: `{ "data": { "url": "https://billing.stripe.com/p/session/…" } }`,
    errorCodes: ['STRIPE_ERROR'],
  },
  'GET /api/billing/entitlements': {
    description:
      "Resolve the user's plan to a flat entitlement object — `{ ai_endpoints: 100, custom_domains: 5, snapshots: unlimited, … }`. Cached per session for 60s. The frontend gates feature buttons against this map.",
    auth: 'yes',
    responseShape: `{ "data": { "ai_endpoints": 100, "custom_domains": 5, "snapshots": "unlimited" } }`,
  },

  // ─── analytics ───
  'GET /api/analytics/{siteId}': {
    description:
      'Pull aggregated visit + funnel metrics for a site from Workers Analytics Engine. Query `?period=24h|7d|30d|90d`. Returns time-bucketed counters for pageviews, unique visitors, and the configured funnel events (form submits, donation clicks, booking starts).',
    auth: 'yes',
    extraHeaders: [{ name: 'X-Period', value: '7d', note: 'or pass as ?period query string' }],
    responseShape: `{ "data": { "pageviews": [{ "ts": "ISO-8601", "n": 142 }], "visitors": [...], "events": {...} } }`,
  },

  // ─── audit logs ───
  'GET /api/audit-logs': {
    description:
      'Org-scoped audit log feed. Filter via `?action=site.deploy|hostname.add|…` and `?site_slug=…`. Paginate with `?limit&offset`. Includes who, what, when, request_id, and the diff payload for change events.',
    auth: 'yes',
    responseShape: `{ "data": AuditEntry[], "meta": { "total": 4213, "limit": 50, "offset": 0 } }`,
  },

  // ─── forms ───
  'POST /api/v1/forms/submit': {
    description:
      "Public form ingest. Called from every generated site's contact / donation / signup form. Validates the Turnstile token, dedupes by `email + form_id` within 30s, persists to D1, and fans out to the site's configured channels (email via Resend, webhook, MCP). NO auth header — Turnstile is the abuse gate.",
    auth: 'no',
    extraHeaders: [
      { name: 'CF-Turnstile-Token', value: 'string', note: 'required — invisible Turnstile token' },
      {
        name: 'Origin',
        value: 'https://{slug}.projectsites.dev',
        note: "validated against site's allowed origins",
      },
    ],
    responseShape: `{ "data": { "submission_id": "uuid", "queued_for_delivery": true } }`,
    errorCodes: ['BAD_REQUEST', 'RATE_LIMITED', 'VALIDATION_ERROR'],
  },
  'GET /api/sites/{id}/form-submissions': {
    description:
      'List form submissions for a site — newest first, paginated. Each entry includes the raw payload, the form_id, the AI-extracted summary (if `ai_routing` is enabled), and the delivery status per channel.',
    auth: 'yes',
    responseShape: `{ "data": FormSubmission[], "meta": { "total": 218 } }`,
  },

  // ─── mcp ───
  'GET /api/mcp/{provider}/connect': {
    description:
      "Start OAuth flow for an MCP provider (mailchimp | stripe | hubspot | github | slack | notion | linear | discord | google-calendar | calendly). Returns a 302 to the provider's authorize URL. When the provider has no OAuth client configured, returns `501 oauth_not_configured` so the UI can render a paste-key fallback.",
    auth: 'yes',
    responseShape: `302 redirect → provider authorize URL`,
    errorCodes: ['BAD_REQUEST'],
  },
  'GET /api/mcp/{provider}/callback': {
    description:
      'OAuth callback for an MCP provider. Exchanges the code for tokens, encrypts at rest, and upserts the connection in `mcp_connections`. Redirects to `/admin/settings#mcp` on success.',
    auth: 'no',
    responseShape: `302 redirect → /admin/settings#mcp`,
    errorCodes: ['BAD_REQUEST', 'UNAUTHORIZED'],
  },
  'POST /api/mcp/{provider}/paste': {
    description:
      'Paste-key fallback for MCP providers without OAuth (Resend, generic webhooks). Body takes the raw API key + provider-specific config. Encrypted with AES-256-GCM before D1 write.',
    auth: 'yes',
    responseShape: `{ "data": { "connection_id": "uuid", "provider": "resend" } }`,
    errorCodes: ['VALIDATION_ERROR'],
  },

  // ─── search ───
  'GET /api/search/businesses': {
    description:
      'Google Places proxy — searches for businesses by name + optional `?location=`. Caps results at 10. Cached for 24h per query. No auth required — this powers the homepage search box for un-signed-in visitors.',
    auth: 'no',
    responseShape: `{ "data": Business[], "meta": { "cached": true, "ttl_remaining_s": 79213 } }`,
  },
  'GET /api/search/address': {
    description:
      "Google Places address autocomplete proxy. Returns up to 5 predictions. Used in the create-from-search wizard's address field.",
    auth: 'no',
    responseShape: `{ "data": [{ "place_id": "string", "description": "123 Main St, Newark NJ" }] }`,
  },
  'GET /api/sites/search': {
    description:
      'Search projectsites.dev for already-built sites by name or slug. Powers "the customer is already on our platform" detection on the homepage. SQL LIKE under the hood — case-insensitive.',
    auth: 'no',
    responseShape: `{ "data": Site[] }`,
  },
};
/* eslint-enable max-len */

/** Tooltip copy for the standard error envelope codes. */
export const ERROR_CODE_BLURBS: Record<string, string> = {
  BAD_REQUEST: 'Malformed JSON, missing required field, or invalid query param.',
  UNAUTHORIZED: 'No bearer token, expired token, or revoked session.',
  FORBIDDEN: 'Authenticated but not allowed (wrong org, wrong plan, RBAC denied).',
  NOT_FOUND: 'Entity does not exist or you do not have access to it.',
  CONFLICT: 'Duplicate slug, duplicate hostname, or violating a uniqueness constraint.',
  PAYLOAD_TOO_LARGE:
    'Body exceeded the 256 KB request-size cap (file uploads use a separate route).',
  RATE_LIMITED: 'Over 60 req/min on this token — honor the Retry-After header.',
  VALIDATION_ERROR: 'Zod validation failed — check the details[] array in the response.',
  INTERNAL_ERROR: 'Server crashed. Quote the request_id when filing a bug.',
  WEBHOOK_SIGNATURE_INVALID: 'Stripe webhook signature did not match the configured secret.',
  WEBHOOK_DUPLICATE: 'Event already processed (idempotent replay).',
  STRIPE_ERROR: 'Stripe API rejected the call. The Stripe error code is in details.',
  DOMAIN_PROVISIONING_ERROR:
    'Cloudflare for SaaS rejected the hostname (invalid, restricted, or quota).',
  AI_GENERATION_ERROR: 'Model call failed — timeout, rate limit, or invalid output schema.',
};

/**
 * Build a minimal example object from a JSON schema. Recursive — handles
 * `object|array|string|number|boolean` and respects `example` when set.
 */
export function buildExampleFromSchema(schema: unknown): unknown {
  if (typeof schema !== 'object' || schema === null) return null;
  const s = schema as {
    type?: string;
    properties?: Record<string, unknown>;
    items?: unknown;
    example?: unknown;
  };
  if (s.example !== undefined) return s.example;
  if (s.type === 'object' && s.properties) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s.properties)) {
      out[k] = buildExampleFromSchema(v);
    }
    return out;
  }
  if (s.type === 'array') return [buildExampleFromSchema(s.items ?? {})];
  if (s.type === 'string') return '';
  if (s.type === 'number') return 0;
  if (s.type === 'boolean') return false;
  return null;
}

/**
 * Hand-rolled JSON tokenizer → HTML. Tokens: keys (amber), strings (green),
 * numbers (cyan), booleans (violet), null (grey), punctuation (faint white).
 *
 * Operates on the already-pretty-printed output of `JSON.stringify(_, null, 2)`,
 * so input is trusted-formatted but still HTML-escaped defensively.
 */
export function highlightJson(src: string): string {
  const escape = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escape(src).replace(
    /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}[\],])/g,
    (_match, str?: string, colon?: string, bool?: string, num?: string, pun?: string) => {
      if (str) {
        return colon
          ? `<span class="tk-key">${str}</span><span class="tk-pun">${colon}</span>`
          : `<span class="tk-str">${str}</span>`;
      }
      if (bool)
        return bool === 'null'
          ? `<span class="tk-null">${bool}</span>`
          : `<span class="tk-bool">${bool}</span>`;
      if (num) return `<span class="tk-num">${num}</span>`;
      if (pun) return `<span class="tk-pun">${pun}</span>`;
      return _match as string;
    },
  );
}

/**
 * Minimal markdown → HTML renderer. Supports headings (#–###), fenced code
 * blocks, inline code, unordered lists, links, bold/italic, and paragraphs.
 *
 * Kept tiny (~40 lines) so the lazy chunks stay below the 50 KB gzip budget
 * imposed on `/admin/docs/*`.
 */
export function renderMarkdown(md: string): string {
  const escapeHtml = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const fences: string[] = [];
  let src = md.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const id = fences.length;
    const raw = escapeHtml(code as string);
    // §17: surface the fenced language (```bash) as a data-lang attr + a visible
    // chip so a cURL reads differently from a JSON body. `\w*` so it's safe, but
    // escape for consistency; a language-less fence renders no chip/attr.
    const lng = (lang as string) ?? '';
    const langAttr = lng ? ` data-lang="${escapeHtml(lng)}"` : '';
    const langChip = lng
      ? `<span class="code-lang" aria-hidden="true">${escapeHtml(lng)}</span>`
      : '';
    fences.push(
      `<pre${langAttr} tabindex="0">${langChip}<button type="button" class="copy-code-btn" aria-label="Copy code">Copy</button><code>${raw}</code></pre>`,
    );
    return ` FENCE${id} `;
  });

  const blocks = src
    .split(/\n{2,}/)
    .map((blk) => blk.trim())
    .filter(Boolean);

  const html = blocks
    .map((blk) => {
      // The placeholder is ` FENCE${id} ` but `blocks` are trimmed above, so match
      // the trimmed form (the spaced-only regex never fired → a standalone fence
      // rendered as literal "<p>FENCE0</p>"; §17 fix exposed by the lang-label spec).
      if (/^FENCE\d+$/.test(blk)) {
        const idx = Number(blk.match(/\d+/)?.[0] ?? '0');
        return fences[idx] ?? '';
      }
      if (blk.startsWith('### ')) return `<h3>${inline(blk.slice(4))}</h3>`;
      if (blk.startsWith('## ')) return `<h2>${inline(blk.slice(3))}</h2>`;
      if (blk.startsWith('# ')) return `<h1>${inline(blk.slice(2))}</h1>`;
      if (/^[-*]\s/.test(blk)) {
        const items = blk
          .split('\n')
          .map((ln) => ln.replace(/^[-*]\s+/, '').trim())
          .filter(Boolean)
          .map((it) => `<li>${inline(it)}</li>`)
          .join('');
        return `<ul>${items}</ul>`;
      }
      return `<p>${inline(blk)}</p>`;
    })
    .join('\n');

  return html;

  function inline(text: string): string {
    return escapeHtml(text)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, href: string) => {
        const url = href.trim();
        // Scheme-allowlist: block javascript:/data:/vbscript: (DOM-XSS) — render
        // the label as plain text instead. Escape " so a crafted href can't break
        // out of the attribute (escapeHtml above only neutralizes & < >).
        if (!/^(?:https?:|mailto:|tel:|#|\/)/i.test(url)) return label;
        return `<a href="${url.replace(/"/g, '&quot;')}" target="_blank" rel="noopener noreferrer">${label}</a>`;
      });
  }
}

/**
 * Singleton-style spec holder. The shell loads the spec once and the
 * per-endpoint child reads from the same signal — no double-fetch when the
 * user opens an endpoint URL directly.
 *
 * Provided at component level (in {@link AdminDocsComponent}) so it survives
 * navigation between the overview and endpoint children but resets when the
 * user leaves `/admin/docs/*` entirely.
 */
@Injectable()
export class DocsSpecService {
  private api = inject(ApiService);

  private readonly _spec = signal<OpenApiSpec | null>(null);
  private readonly _loading = signal<boolean>(false);
  private readonly _error = signal<string | null>(null);
  private readonly _stats = signal<DocsStats | null>(null);

  readonly spec: Signal<OpenApiSpec | null> = this._spec.asReadonly();
  readonly loading: Signal<boolean> = this._loading.asReadonly();
  readonly error: Signal<string | null> = this._error.asReadonly();
  readonly stats: Signal<DocsStats | null> = this._stats.asReadonly();

  /** Flattened operation list — derived from the OpenAPI doc. */
  readonly operations: Signal<Operation[]> = computed(() => {
    const s = this._spec();
    if (!s) return [];
    const out: Operation[] = [];
    for (const [path, methods] of Object.entries(s.paths)) {
      for (const [method, opRaw] of Object.entries(methods)) {
        if (typeof opRaw !== 'object' || opRaw === null) continue;
        const op = opRaw as RawOp;
        const tags = op.tags ?? ['other'];
        const respExample = op.responses?.['200']?.content?.['application/json']?.example;
        const tag = tags[0] ?? 'other';
        out.push({
          method: method.toUpperCase(),
          path,
          summary: op.summary ?? `${method.toUpperCase()} ${path}`,
          tag,
          operationId: op.operationId ?? `${method}_${path}`,
          authRequired: Array.isArray(op.security) && op.security.length > 0,
          parameters: op.parameters ?? [],
          requestBody: op.requestBody?.content?.['application/json']?.schema,
          responseExample: respExample,
          // Title-case fallback so a missing `x-category` still produces a
          // readable left-rail group ("auth" → "Auth", "ai" → "AI").
          category:
            op['x-category'] ?? (tag === 'ai' ? 'AI' : tag.charAt(0).toUpperCase() + tag.slice(1)),
          rateLimit: op['x-rate-limit'] ?? null,
          addedAt: op['x-added-at'] ?? null,
        });
      }
    }
    return out.sort((a, b) =>
      a.tag === b.tag ? a.path.localeCompare(b.path) : a.tag.localeCompare(b.tag),
    );
  });

  /**
   * Load the OpenAPI spec from the worker. Safe to call multiple times —
   * subsequent calls re-fetch and refresh the signal.
   */
  load(): void {
    this._loading.set(true);
    this._error.set(null);
    this.api.get<OpenApiSpec>('/admin/docs/openapi.json').subscribe({
      next: (s) => {
        this._spec.set(s);
        this._loading.set(false);
      },
      error: (err: unknown) => {
        this._error.set(err instanceof Error ? err.message : 'Failed to load OpenAPI spec');
        this._loading.set(false);
      },
    });
  }

  /** Lookup an operation by its stable `operationId`. Returns null when missing. */
  findById(id: string | null | undefined): Operation | null {
    if (!id) return null;
    return this.operations().find((o) => o.operationId === id) ?? null;
  }

  /**
   * Fetch the aggregate counters used by the overview hero. Best-effort —
   * failures silently leave `stats()` null so the overview falls back to a
   * spec-derived summary.
   */
  loadStats(): void {
    this.api.get<{ data: DocsStats }>('/admin/docs/stats').subscribe({
      next: (r) => this._stats.set(r.data),
      error: () => this._stats.set(null),
    });
  }
}

/**
 * Admin → Docs SHELL. Renders the header + left rail (search + grouped
 * endpoint list) and a `<router-outlet>` that hosts the per-route children:
 *
 *   - `/admin/docs`               → `DocsOverviewComponent`
 *   - `/admin/docs/:endpointId`   → `DocsEndpointComponent`
 *
 * The shell owns the OpenAPI spec via {@link DocsSpecService} (component
 * provider) so children read from a single shared source — no double-fetch.
 *
 * @example
 * ```ts
 * // app.routes.ts
 * {
 *   path: 'docs',
 *   loadComponent: () => import('./pages/admin/sections/docs.component').then((m) => m.AdminDocsComponent),
 *   children: [
 *     { path: '', loadComponent: () => import('./sections/docs/docs-overview.component').then((m) => m.DocsOverviewComponent) },
 *     { path: ':endpointId', loadComponent: () => import('./sections/docs/docs-endpoint.component').then((m) => m.DocsEndpointComponent) },
 *   ],
 * }
 * ```
 */
@Component({
  selector: 'app-admin-docs',
  standalone: true,
  imports: [
    FormsModule,
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    HlmInputDirective,
    RollingCounterComponent,
    RevealDirective,
    ...BrnTooltipImports,
  ],
  providers: [DocsSpecService],
  host: { '(window:keydown)': 'onWindowKeydown($event)' },
  template: `
    <div class="docs-root p-7 flex-1 overflow-y-auto animate-fade-in max-md:p-4">
      <header class="docs-header" appReveal>
        <div class="docs-title-wrap">
          <div class="docs-kicker">Developer reference</div>
          <h2 class="docs-title">
            <span class="docs-title-glyph" aria-hidden="true">
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
              </svg>
            </span>
            <span class="docs-title-text">API Docs</span>
            @if (specService.spec(); as s) {
              <span
                class="docs-version-chip"
                title="OpenAPI version"
                [attr.aria-label]="'OpenAPI version ' + s.info.version"
                >v{{ s.info.version }}</span
              >
              <span
                class="docs-count-chip"
                [attr.aria-label]="specService.operations().length + ' endpoints'"
              >
                <app-rolling-counter
                  [value]="specService.operations().length"
                  [duration]="900"
                />&nbsp;endpoints
              </span>
            }
          </h2>
          <p class="docs-subtitle">
            Interactive explorer. Every call uses your signed-in session — try any endpoint, inspect
            the live JSON, copy a cURL.
          </p>
        </div>
        <div class="docs-header-actions">
          <a
            class="docs-tab"
            routerLink="/admin/docs"
            routerLinkActive="is-active"
            ariaCurrentWhenActive="page"
            [routerLinkActiveOptions]="{ exact: true }"
            [brnTooltip]="'API overview'"
            data-testid="docs-overview-link"
            ><span class="docs-tab-label">Overview</span
            ><span class="docs-tab-underline" aria-hidden="true"></span
          ></a>
          <!-- §17: redundant header Refresh removed — spec auto-loads on init; error state has its own Retry. -->
        </div>
      </header>

      <div class="docs-divider" aria-hidden="true"></div>

      @if (specService.loading() && !specService.spec()) {
        <div
          class="card docs-loading"
          aria-busy="true"
          aria-label="Loading OpenAPI spec"
          data-testid="docs-loading"
        >
          <div class="docs-skel-block">
            <span class="glow-skel" aria-hidden="true" style="width:140px;height:14px;"></span>
            <span class="glow-skel" aria-hidden="true" style="width:90px;height:14px;"></span>
            <span class="glow-skel" aria-hidden="true" style="width:200px;height:14px;"></span>
          </div>
          <span class="docs-loading-hint"
            >Fetching the latest OpenAPI spec from /admin/docs/openapi.json…</span
          >
        </div>
      } @else if (specService.error()) {
        <div class="card docs-error" role="alert" data-testid="docs-error">
          <div class="docs-error-head">
            <span class="docs-error-glyph" aria-hidden="true">
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            </span>
            <div>
              <strong class="text-amber-300">Could not load the docs.</strong>
              <span class="docs-error-detail">{{ specService.error() }}</span>
            </div>
          </div>
          <button
            class="btn-ghost"
            type="button"
            (click)="specService.load()"
            aria-label="Retry loading the OpenAPI spec"
          >
            Retry
          </button>
        </div>
      } @else {
        <!-- AL-850: loading / error / explorer are mutually exclusive so the explorer
             MATERIALIZES in the loading card place (stable top) instead of the card
             vanishing and yanking the explorer up (the docs-explorer CLS 0.06). -->
        <div class="docs-explorer" appReveal [revealDelay]="60">
        <!-- ─── Left rail nav: search + grouped endpoint list ─── -->
        <aside class="docs-rail card" aria-label="Endpoint list">
          <div class="docs-search">
            <svg
              class="docs-search-icon"
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              #railSearch
              type="text"
              hlmInput
              class="docs-search-input"
              placeholder="Filter (/ to focus) — path, method, category…"
              [ngModel]="endpointSearchQuery()"
              (ngModelChange)="endpointSearchQuery.set($event)"
              (keydown)="onRailSearchKeydown($event)"
              aria-label="Filter endpoints"
              data-testid="docs-search"
            />
            <kbd class="docs-kbd-hint" aria-hidden="true">/</kbd>
          </div>
          <div class="docs-verb-chips" role="toolbar" aria-label="Filter by HTTP method">
            @for (v of VERBS; track v) {
              <button
                type="button"
                class="docs-verb-chip method method-{{ v.toLowerCase() }}"
                [class.is-active]="verbFilter() === v"
                (click)="toggleVerb(v)"
                [attr.aria-pressed]="verbFilter() === v"
                [attr.data-testid]="'docs-verb-chip-' + v.toLowerCase()"
              >
                {{ v }}
              </button>
            }
            @if (verbFilter()) {
              <button
                type="button"
                class="docs-verb-clear"
                (click)="verbFilter.set(null)"
                aria-label="Clear method filter"
              >
                clear
              </button>
            }
          </div>
          <div class="docs-rail-meta">
            <span
              >{{ filteredOperations().length }} endpoint{{
                filteredOperations().length === 1 ? '' : 's'
              }}</span
            >
            <span class="docs-rail-meta-dot" aria-hidden="true">·</span>
            <span
              >{{ groupedOperations().length }} group{{
                groupedOperations().length === 1 ? '' : 's'
              }}</span
            >
          </div>
          <nav class="docs-groups" aria-label="Endpoint groups">
            @for (group of groupedOperations(); track group.category) {
              <details class="docs-group" [open]="group.open">
                <summary class="docs-group-head">
                  <svg
                    class="docs-chevron"
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2.4"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                  <span class="docs-group-name">{{ group.category }}</span>
                  <span class="docs-group-count">{{ group.items.length }}</span>
                </summary>
                <div class="docs-group-items">
                  @for (op of group.items; track op.operationId) {
                    <a
                      class="endpoint-row"
                      [routerLink]="['/admin/docs', op.operationId]"
                      routerLinkActive="is-active"
                      ariaCurrentWhenActive="page"
                      [attr.data-testid]="'docs-nav-endpoint-' + op.operationId"
                      [title]="
                        op.method +
                        ' ' +
                        op.path +
                        (op.summary
                          ? '
' + op.summary
                          : '')
                      "
                    >
                      <span class="method method-{{ op.method.toLowerCase() }}">{{
                        op.method
                      }}</span>
                      <span class="endpoint-row-text">
                        <span class="path">{{ op.path }}</span>
                        <span class="endpoint-row-summary">{{ op.summary }}</span>
                      </span>
                      @if (!op.authRequired) {
                        <span
                          class="endpoint-row-badge"
                          title="No authentication required"
                          aria-label="public"
                          >pub</span
                        >
                      } @else {
                        <span
                          class="endpoint-row-badge is-auth"
                          title="Bearer token required"
                          aria-label="auth required"
                          >auth</span
                        >
                      }
                    </a>
                  }
                </div>
              </details>
            }
            @if (groupedOperations().length === 0 && specService.spec()) {
              <div class="docs-rail-empty" role="status" aria-live="polite">
                <svg
                  width="22"
                  height="22"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.4"
                  aria-hidden="true"
                >
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <div>{{ endpointEmptyHint() }}</div>
                <button
                  class="btn-ghost-mini"
                  type="button"
                  (click)="clearEndpointFilters()"
                  aria-label="Clear endpoint filters"
                >
                  Clear filters
                </button>
              </div>
            }
          </nav>
        </aside>

        <!-- ─── Child route outlet (overview OR endpoint detail) ─── -->
        <router-outlet></router-outlet>
        </div>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: contents;
      }

      .docs-root {
        --rhythm: 8px;
        --r1: var(--rhythm);
        --r2: calc(var(--rhythm) * 2);
        --r3: calc(var(--rhythm) * 3);
        --r4: calc(var(--rhythm) * 4);
        --r5: calc(var(--rhythm) * 5);
        --docs-primary: var(--ps-accent, #00e5ff);
        --docs-violet: #c084fc;
        --docs-amber: #fbbf24;
        --docs-red: #f87171;
        --docs-lime: #a3e635;
        --docs-green: #4ade80;
        --docs-line: rgba(255, 255, 255, 0.06);
        --docs-line-hi: rgba(0, 229, 255, 0.22);
        --docs-bg-soft: rgba(255, 255, 255, 0.02);
        --docs-fg: #e2e8f0;
        --docs-fg-mute: #94a3b8;
        font-feature-settings: 'tnum', 'cv11', 'ss01';
        display: flex;
        flex-direction: column;
        gap: var(--r3);
      }

      .docs-header {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        gap: var(--r3);
        flex-wrap: wrap;
      }
      .docs-title-wrap {
        display: flex;
        flex-direction: column;
        gap: 6px;
        max-width: 60ch;
      }
      .docs-kicker {
        font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.62rem;
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--ps-accent, #00e5ff);
        opacity: 0.85;
      }
      .docs-count-chip {
        font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.6rem;
        font-weight: 600;
        letter-spacing: 0.04em;
        padding: 3px 8px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.04);
        color: rgba(255, 255, 255, 0.55);
        border: 1px solid rgba(255, 255, 255, 0.08);
      }
      .docs-title {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        margin: 0;
        color: #fff;
        font-size: 1.35rem;
        line-height: 1.15;
        font-weight: 800;
        letter-spacing: -0.01em;
      }
      .docs-title-glyph {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 30px;
        height: 30px;
        border-radius: 8px;
        background: linear-gradient(135deg, rgba(0, 229, 255, 0.18), rgba(124, 58, 237, 0.18));
        border: 1px solid rgba(0, 229, 255, 0.32);
        color: var(--docs-primary);
        box-shadow: 0 0 18px -6px rgba(0, 229, 255, 0.45);
      }
      .docs-title-text {
        background: linear-gradient(
          90deg,
          #fff,
          var(--ps-accent, #00e5ff) 65%,
          var(--ps-accent-secondary, #7c3aed)
        );
        -webkit-background-clip: text;
        background-clip: text;
        color: transparent;
        text-wrap: balance;
      }
      .docs-version-chip {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.62rem;
        font-weight: 700;
        letter-spacing: 0.04em;
        padding: 3px 7px;
        border-radius: 999px;
        background: rgba(0, 229, 255, 0.08);
        color: var(--docs-primary);
        border: 1px solid rgba(0, 229, 255, 0.25);
      }
      .docs-subtitle {
        margin: 0;
        color: var(--docs-fg-mute);
        font-size: 0.82rem;
        line-height: 1.55;
        max-width: 60ch;
        text-wrap: pretty;
      }
      .docs-header-actions {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
      }
      .docs-tab {
        position: relative;
        padding: 0.5rem 0.95rem;
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.03);
        color: rgba(255, 255, 255, 0.72);
        border: 1px solid var(--docs-line);
        cursor: pointer;
        font-size: 0.76rem;
        font-weight: 600;
        letter-spacing: 0.01em;
        text-decoration: none;
        transition:
          background 160ms ease,
          border-color 160ms ease,
          color 160ms ease,
          transform 160ms ease;
      }
      .docs-tab:hover {
        background: rgba(0, 229, 255, 0.06);
        border-color: var(--docs-line-hi);
        color: #fff;
      }
      .docs-tab:focus-visible {
        outline: var(--ps-ring-focus, 2px solid #00e5ff);
        outline-offset: var(--ps-ring-focus-offset, 2px);
      }
      .docs-tab.is-active {
        background: linear-gradient(135deg, rgba(0, 229, 255, 0.16), rgba(124, 58, 237, 0.16));
        color: #fff;
        border-color: rgba(0, 229, 255, 0.45);
        box-shadow:
          0 0 0 1px rgba(0, 229, 255, 0.12) inset,
          0 6px 18px -10px rgba(0, 229, 255, 0.55);
      }
      /* Center-out cyan underline — sweeps to full width when the tab activates. */
      .docs-tab-label {
        position: relative;
        z-index: 1;
      }
      .docs-tab-underline {
        position: absolute;
        left: 50%;
        bottom: 5px;
        height: 2px;
        width: 0;
        transform: translateX(-50%);
        border-radius: 2px;
        background: linear-gradient(90deg, transparent, var(--docs-primary), transparent);
        box-shadow: 0 0 8px rgba(0, 229, 255, 0.6);
        transition: width 260ms cubic-bezier(0.16, 1, 0.3, 1);
        pointer-events: none;
      }
      .docs-tab:hover .docs-tab-underline {
        width: 40%;
      }
      .docs-tab.is-active .docs-tab-underline {
        width: calc(100% - 1.4rem);
      }

      .docs-divider {
        height: 1px;
        background: linear-gradient(90deg, transparent, rgba(0, 229, 255, 0.18), transparent);
        margin: 0;
      }

      .docs-loading {
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 1.5rem !important;
        align-items: center;
        justify-content: center;
      }
      .docs-skel-block {
        display: flex;
        gap: 10px;
        align-items: center;
        justify-content: center;
      }
      .docs-loading-hint {
        font-size: 0.7rem;
        color: var(--docs-fg-mute);
        font-family: 'JetBrains Mono', ui-monospace, monospace;
      }
      .docs-error {
        display: flex;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
        justify-content: space-between;
        background: rgba(245, 158, 11, 0.06) !important;
        border-color: rgba(245, 158, 11, 0.3) !important;
        font-size: 0.8rem;
      }
      .docs-error-head {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        min-width: 0;
      }
      .docs-error-glyph {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border-radius: 8px;
        background: rgba(245, 158, 11, 0.14);
        color: #fbbf24;
        border: 1px solid rgba(245, 158, 11, 0.32);
        flex-shrink: 0;
      }
      .docs-error-detail {
        display: block;
        font-size: 0.72rem;
        color: rgba(255, 255, 255, 0.65);
        margin-top: 2px;
        font-family: 'JetBrains Mono', ui-monospace, monospace;
      }

      /* ── Explorer grid — left rail + child router-outlet ────────────── */
      .docs-explorer {
        display: grid;
        gap: var(--r3);
        grid-template-columns: 260px minmax(0, 1fr);
        container-type: inline-size;
      }
      @media (max-width: 1024px) {
        .docs-explorer {
          grid-template-columns: 1fr;
        }
        .docs-rail {
          position: sticky;
          top: 0;
          z-index: 5;
          max-height: 42vh !important;
        }
      }

      /* ── Left rail ─────────────────────────────────────────────────── */
      .docs-rail {
        padding: var(--r2) !important;
        display: flex;
        flex-direction: column;
        gap: var(--r1);
        max-height: 78vh;
        overflow-y: auto;
        scrollbar-width: thin;
        scrollbar-color: rgba(0, 229, 255, 0.18) transparent;
      }
      .docs-rail::-webkit-scrollbar {
        width: 6px;
      }
      .docs-rail::-webkit-scrollbar-thumb {
        background: rgba(0, 229, 255, 0.18);
        border-radius: 3px;
      }
      .docs-search {
        position: relative;
      }
      .docs-search-icon {
        position: absolute;
        left: 9px;
        top: 50%;
        transform: translateY(-50%);
        color: var(--docs-fg-mute);
        pointer-events: none;
      }
      /* icon-padding + size only; hlmInput owns base + focus-ring now */
      .docs-search-input {
        width: 100%;
        padding-left: 28px !important;
        padding-right: 44px !important;
        font-size: 0.78rem;
        min-height: 32px;
      }
      .docs-kbd-hint {
        position: absolute;
        right: 8px;
        top: 50%;
        transform: translateY(-50%);
        font-family: ui-monospace, monospace;
        font-size: 0.6rem;
        color: var(--docs-fg-mute);
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid var(--docs-line);
        border-radius: 4px;
        padding: 2px 5px;
        pointer-events: none;
      }
      .docs-rail-meta {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 0.62rem;
        color: var(--docs-fg-mute);
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-weight: 700;
        padding: 2px 4px;
      }
      .docs-rail-meta-dot {
        color: rgba(255, 255, 255, 0.18);
      }
      .docs-groups {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .docs-group {
        border-radius: 8px;
      }
      .docs-group-head {
        position: sticky;
        top: -1px;
        z-index: 1;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 8px;
        background: linear-gradient(180deg, rgba(6, 6, 16, 0.92), rgba(6, 6, 16, 0.78));
        backdrop-filter: blur(6px);
        cursor: pointer;
        user-select: none;
        font-size: 0.7rem;
        color: #fff;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        border-radius: 6px;
        transition:
          color 160ms ease,
          background 160ms ease;
      }
      .docs-group-head::-webkit-details-marker {
        display: none;
      }
      .docs-group-head:hover {
        color: var(--docs-primary);
        background: linear-gradient(180deg, rgba(6, 6, 16, 0.96), rgba(0, 229, 255, 0.05));
      }
      .docs-chevron {
        color: var(--docs-fg-mute);
        transition: transform 200ms cubic-bezier(0.16, 1, 0.3, 1);
        flex-shrink: 0;
      }
      .docs-group[open] > .docs-group-head .docs-chevron {
        transform: rotate(90deg);
        color: var(--docs-primary);
      }
      .docs-group-name {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .docs-group-count {
        font-family: ui-monospace, monospace;
        font-size: 0.6rem;
        font-weight: 700;
        color: var(--docs-fg-mute);
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid var(--docs-line);
        border-radius: 999px;
        padding: 1px 7px;
        min-width: 22px;
        text-align: center;
      }
      .docs-group-items {
        display: flex;
        flex-direction: column;
        gap: 1px;
        padding: 4px 0 6px 6px;
      }

      .endpoint-row {
        position: relative;
        display: flex;
        align-items: center;
        gap: 0.55rem;
        padding: 0.42rem 0.55rem 0.42rem 0.7rem;
        border-radius: 6px;
        border: none;
        background: transparent;
        color: #cbd5e1;
        cursor: pointer;
        font-size: 0.74rem;
        text-align: left;
        width: 100%;
        text-decoration: none;
        transition:
          background 140ms ease,
          color 140ms ease,
          transform 140ms ease;
      }
      .endpoint-row::before {
        content: '';
        position: absolute;
        left: 0;
        top: 6px;
        bottom: 6px;
        width: 3px;
        border-radius: 2px;
        background: transparent;
        transition: background 180ms ease;
      }
      .endpoint-row:hover {
        background: rgba(0, 229, 255, 0.06);
        color: #fff;
      }
      .endpoint-row:hover::before {
        background: rgba(0, 229, 255, 0.35);
      }
      .endpoint-row.is-active {
        background: linear-gradient(90deg, rgba(0, 229, 255, 0.14), rgba(0, 229, 255, 0.04));
        color: #fff;
      }
      .endpoint-row.is-active::before {
        background: var(--docs-primary);
        box-shadow: 0 0 8px rgba(0, 229, 255, 0.6);
      }
      .endpoint-row:focus-visible {
        outline: 2px solid var(--docs-primary);
        outline-offset: 2px;
      }
      .endpoint-row .path {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.72rem;
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .method {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-weight: 700;
        font-size: 0.6rem;
        letter-spacing: 0.06em;
        padding: 3px 7px;
        border-radius: 5px;
        min-width: 48px;
        text-align: center;
        flex-shrink: 0;
        border: 1px solid transparent;
        font-feature-settings: 'tnum', 'cv11';
      }
      .method-get {
        background: rgba(0, 229, 255, 0.1);
        color: var(--docs-primary);
        border-color: rgba(0, 229, 255, 0.32);
      }
      .method-post {
        background: rgba(168, 85, 247, 0.12);
        color: var(--docs-violet);
        border-color: rgba(168, 85, 247, 0.32);
      }
      .method-put {
        background: rgba(245, 158, 11, 0.1);
        color: var(--docs-amber);
        border-color: rgba(245, 158, 11, 0.32);
      }
      .method-patch {
        background: rgba(163, 230, 53, 0.1);
        color: var(--docs-lime);
        border-color: rgba(163, 230, 53, 0.32);
      }
      .method-delete {
        background: rgba(239, 68, 68, 0.1);
        color: var(--docs-red);
        border-color: rgba(239, 68, 68, 0.32);
      }

      .docs-rail-empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.6rem;
        padding: var(--r3) var(--r2);
        text-align: center;
        color: var(--docs-fg-mute);
        font-size: 0.76rem;
        background: radial-gradient(circle at center top, rgba(0, 229, 255, 0.04), transparent 70%);
        border: 1px dashed rgba(0, 229, 255, 0.14);
        border-radius: 10px;
        margin-top: 6px;
      }
      .docs-rail-empty svg {
        color: rgba(0, 229, 255, 0.5);
      }
      .btn-ghost-mini {
        padding: 4px 10px;
        min-height: 24px;
        border-radius: var(--ps-radius-sm, 6px);
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(255, 255, 255, 0.1);
        color: rgba(255, 255, 255, 0.78);
        font-size: 0.66rem;
        font-weight: 600;
        cursor: pointer;
        transition:
          background var(--ps-dur-fast, 140ms) ease,
          color var(--ps-dur-fast, 140ms) ease;
      }
      .btn-ghost-mini:hover {
        background: rgba(0, 229, 255, 0.08);
        color: #fff;
      }
      .btn-ghost-mini:focus-visible {
        outline: var(--ps-ring-focus, 2px solid #00e5ff);
        outline-offset: var(--ps-ring-focus-offset, 2px);
      }
      /* Fallback local .btn-ghost used by the docs-error retry button — the
       global styles.scss .btn-ghost is also present, but scoping a small
       local copy guarantees the visual + focus behaviour even if the global
       cascade order shifts. */
      .btn-ghost {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 0.5rem 0.95rem;
        min-height: 32px;
        border-radius: var(--ps-radius-sm, 8px);
        background: rgba(255, 255, 255, 0.04);
        color: rgba(255, 255, 255, 0.78);
        border: 1px solid rgba(255, 255, 255, 0.1);
        cursor: pointer;
        font-size: 0.74rem;
        font-weight: 600;
        transition:
          background var(--ps-dur-fast, 140ms) ease,
          border-color var(--ps-dur-fast, 140ms) ease,
          color var(--ps-dur-fast, 140ms) ease;
      }
      .btn-ghost:hover {
        background: rgba(0, 229, 255, 0.08);
        border-color: var(--docs-line-hi);
        color: #fff;
      }
      .btn-ghost:focus-visible {
        outline: var(--ps-ring-focus, 2px solid #00e5ff);
        outline-offset: var(--ps-ring-focus-offset, 2px);
      }

      /* ── Verb-chip filter row ───────────────────────────────────────── */
      .docs-verb-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        padding: 2px 0 4px;
      }
      .docs-verb-chip {
        cursor: pointer;
        min-width: 0;
        opacity: 0.55;
        transition:
          opacity 140ms ease,
          transform 140ms ease,
          box-shadow 140ms ease;
      }
      .docs-verb-chip:hover {
        opacity: 0.85;
      }
      .docs-verb-chip:focus-visible {
        outline: var(--ps-ring-focus, 2px solid #00e5ff);
        outline-offset: var(--ps-ring-focus-offset, 2px);
      }
      .docs-verb-chip.is-active {
        opacity: 1;
        transform: translateY(-1px);
        box-shadow: 0 4px 12px -6px currentColor;
      }
      .docs-verb-clear {
        font-family: ui-monospace, monospace;
        font-size: 0.6rem;
        font-weight: 600;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        padding: 3px 7px;
        border-radius: 5px;
        background: transparent;
        border: 1px dashed rgba(255, 255, 255, 0.18);
        color: var(--docs-fg-mute);
        cursor: pointer;
        transition:
          color 140ms ease,
          border-color 140ms ease;
      }
      .docs-verb-clear:hover {
        color: #fff;
        border-color: rgba(0, 229, 255, 0.45);
      }

      /* ── Endpoint row text + badge stack ────────────────────────────── */
      .endpoint-row-text {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 1px;
        overflow: hidden;
      }
      .endpoint-row-summary {
        font-size: 0.64rem;
        color: rgba(255, 255, 255, 0.42);
        line-height: 1.25;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .endpoint-row.is-active .endpoint-row-summary {
        color: rgba(255, 255, 255, 0.62);
      }
      .endpoint-row-badge {
        flex-shrink: 0;
        font-family: ui-monospace, monospace;
        font-size: 0.54rem;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        padding: 2px 5px;
        border-radius: 4px;
        background: rgba(74, 222, 128, 0.1);
        color: #4ade80;
        border: 1px solid rgba(74, 222, 128, 0.24);
      }
      .endpoint-row-badge.is-auth {
        background: rgba(124, 58, 237, 0.1);
        color: #c084fc;
        border-color: rgba(124, 58, 237, 0.24);
      }

      @media (prefers-reduced-motion: reduce) {
        .docs-tab,
        .endpoint-row,
        .docs-chevron,
        .docs-group-head,
        .docs-verb-chip,
        .docs-tab-underline {
          transition: none !important;
          animation: none !important;
        }
      }
    `,
  ],
})
export class AdminDocsComponent implements OnInit {
  readonly specService = inject(DocsSpecService);
  private router = inject(Router);

  /** Verb chips ordered by frequency in a typical REST API. */
  readonly VERBS: ReadonlyArray<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'> = [
    'GET',
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
  ];

  /** Left-rail search query — filters endpoint list by path | method | tag | summary. */
  readonly endpointSearchQuery = signal<string>('');

  /** Optional verb filter — when set, only that method is shown in the rail. */
  readonly verbFilter = signal<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | null>(null);

  readonly filteredOperations = computed<Operation[]>(() => {
    const q = this.endpointSearchQuery().trim().toLowerCase();
    const v = this.verbFilter();
    let all = this.specService.operations();
    if (v) all = all.filter((op) => op.method === v);
    if (!q) return all;
    return all.filter(
      (op) =>
        op.path.toLowerCase().includes(q) ||
        op.summary.toLowerCase().includes(q) ||
        op.method.toLowerCase().includes(q) ||
        op.tag.toLowerCase().includes(q) ||
        op.category.toLowerCase().includes(q),
    );
  });

  readonly groupedOperations = computed(() => {
    const groups = new Map<string, Operation[]>();
    for (const op of this.filteredOperations()) {
      const arr = groups.get(op.category);
      if (arr) arr.push(op);
      else groups.set(op.category, [op]);
    }
    return Array.from(groups.entries())
      .map(([category, items]) => ({ category, items, open: true }))
      .sort((a, b) => a.category.localeCompare(b.category));
  });

  /**
   * Human no-match hint for the rail's empty branch. Names whichever filter(s)
   * are active so a verb-only filter doesn't render the misleading `No endpoints
   * match ""` (empty quotes) the old single-query message produced.
   */
  readonly endpointEmptyHint = computed<string>(() => {
    const q = this.endpointSearchQuery().trim();
    const v = this.verbFilter();
    if (q && v) return `No ${v} endpoints match “${q}”.`;
    if (q) return `No endpoints match “${q}”.`;
    if (v) return `No ${v} endpoints.`;
    return 'No endpoints.';
  });

  /** Reset BOTH rail filters (search + verb) so a single "Clear" always restores results. */
  clearEndpointFilters(): void {
    this.endpointSearchQuery.set('');
    this.verbFilter.set(null);
  }

  toggleVerb(v: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'): void {
    this.verbFilter.set(this.verbFilter() === v ? null : v);
  }

  /**
   * `/` shortcut focuses the rail search box (unless typing in another input).
   * `Esc` clears the search query so the rail snaps back to the full list.
   */
  onWindowKeydown(ev: KeyboardEvent): void {
    const target = ev.target as HTMLElement | null;
    const isTyping =
      target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;
    if (ev.key === '/' && !isTyping) {
      ev.preventDefault();
      const el = document.querySelector<HTMLInputElement>('input.docs-search-input');
      el?.focus();
      el?.select();
    } else if (ev.key === 'Escape' && (this.endpointSearchQuery() || this.verbFilter())) {
      // Only fire when there's an active filter so we don't fight other Esc
      // handlers (modals, popovers, drawers).
      this.endpointSearchQuery.set('');
      this.verbFilter.set(null);
    }
  }

  /** Arrow-up/down inside the rail-search input navigates to next/prev endpoint. */
  onRailSearchKeydown(ev: KeyboardEvent): void {
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp' && ev.key !== 'Enter') return;
    const ops = this.filteredOperations();
    if (ops.length === 0) return;
    const currentId = (this.router.url.split('?')[0] ?? '').split('/admin/docs/')[1] ?? '';
    const idx = ops.findIndex((o) => o.operationId === currentId);
    let nextIdx = idx;
    if (ev.key === 'ArrowDown') nextIdx = idx < 0 ? 0 : Math.min(ops.length - 1, idx + 1);
    else if (ev.key === 'ArrowUp') nextIdx = idx < 0 ? 0 : Math.max(0, idx - 1);
    else if (ev.key === 'Enter' && idx < 0) nextIdx = 0;
    if (nextIdx === idx && ev.key !== 'Enter') return;
    const target = ops[nextIdx];
    if (!target) return;
    ev.preventDefault();
    void this.router.navigate(['/admin/docs', target.operationId]);
  }

  ngOnInit(): void {
    this.specService.load();
    this.specService.loadStats();
  }
}
