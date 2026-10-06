/**
 * @module mocks/fixtures/docs
 *
 * @description
 * Mock fixtures for the admin **Docs** section (`pages/admin/sections/docs.component.ts` + the
 * `docs/` child components — the interactive OpenAPI explorer). The shell is a left-rail +
 * `<router-outlet>` that hosts the overview (`/admin/docs`) and per-endpoint (`/admin/docs/:id`)
 * children; every surface reads from the ONE shared {@link import('../../pages/admin/sections/docs.component').DocsSpecService},
 * which self-fetches through {@link import('../../services/api.service').ApiService} on init. The
 * section is otherwise **not** static content — it is driven by THREE authenticated GET reads, so
 * serving these three factories lights up the whole explorer on `?mock=1` with ZERO backend.
 *
 * **Flag-gating:** NONE. All three routes in `routes/docs.ts` are gated by `requireUser` only
 * (auth, not a feature flag). So the demo needs NO flag flip — the Docs tab renders fully on
 * `?mock=1` as soon as the admin shell is reached.
 *
 * | Registry key                    | Factory                      | Worker contract (traced to `routes/docs.ts`)                               |
 * | ------------------------------- | ---------------------------- | -------------------------------------------------------------------------- |
 * | `GET /admin/docs/openapi.json`  | {@link docsOpenApiFixture}   | the BARE OpenAPI 3.1 spec object (`c.json(spec)` — NOT a `{data}` envelope) |
 * | `GET /admin/docs/stats`         | {@link docsStatsFixture}     | `{ data: DocsStats }` (`docs.ts:917`)                                       |
 * | `GET /admin/docs/app-overview`  | {@link docsAppOverviewFixture}| `{ data: { markdown, generated_at } }` (`docs.ts:966`)                     |
 *
 * NOTE `GET /admin/docs/openapi.json` has a real `.json` extension — `toRegistryKey` preserves it
 * (it only strips the `/api` prefix, the trailing slash, and the query), so the key is literally
 * `GET /admin/docs/openapi.json`. The shell's `DocsSpecService.load()` reads it as JSON via
 * `api.get<OpenApiSpec>`; the overview's "Raw OpenAPI" button ALSO fetches the same URL as a blob
 * via `getBlobAbsolute` — the interceptor serves the parsed spec object either way (the JSON read
 * is the surface-rendering path; the blob is a copy-to-tab convenience).
 *
 * @remarks
 * - Believable, internally-consistent data, not lorem: a realistic cross-section of the REAL API
 *   surface (health · search · auth · sites · billing · analytics · audit · admin) spanning public
 *   + bearer-authed endpoints, path `{param}` segments, a rate-limited route, request bodies, and
 *   `x-category` / `x-rate-limit` / `x-added-at` vendor extensions — enough variety that every
 *   left-rail group, method chip, auth/pub badge, version + endpoint counter, and the overview's
 *   "Recent additions" + category leaderboard all render with real texture.
 * - `docsStatsFixture` is kept **internally consistent with the spec** (`total` === path-op count,
 *   `public + authed` === total, `category_counts` sums to total, `recent` ⊆ the `x-added-at` set)
 *   so the overview hero numbers never contradict the rail — mirrors the worker, which derives both
 *   from the same `API_SURFACE` source.
 * - `state` variants: `empty` → the honest brand-new surface (a VALID but minimal spec — one
 *   `/health` probe so the explorer never crashes on a path-less doc — plus all-zero stats + a
 *   stub overview); `error` is handled by the interceptor (it throws a 500 before these run);
 *   `populated`/`loading`/default → the rich believable set.
 * - No per-site `:param` here — all three routes are org/account-level (the per-ENDPOINT child
 *   reads the SAME shared spec signal, it does not fetch a per-endpoint route).
 */
import type { FixtureFactory, MockState } from './index';

// ───────────────────────── shared raw-operation shape ─────────────────────────

/** A raw OpenAPI operation as `buildOpenApiSpec` emits it (the `paths[path][method]` value). */
interface RawOp {
  summary: string;
  tags: string[];
  operationId: string;
  responses: Record<string, unknown>;
  security?: Array<{ bearerAuth: string[] }>;
  parameters?: Array<{ name: string; in: string; required?: boolean; schema?: unknown }>;
  requestBody?: { required: boolean; content: { 'application/json': { schema: unknown } } };
  ['x-category']?: string;
  ['x-rate-limit']?: { requests: number; windowSeconds: number };
  ['x-added-at']?: string;
}

/** The top-level OpenAPI spec the worker returns bare from `GET /admin/docs/openapi.json`. */
export interface DocsOpenApiSpec {
  openapi: string;
  info: {
    title: string;
    version: string;
    description?: string;
    contact?: { name: string; url: string };
  };
  servers?: Array<{ url: string; description?: string }>;
  tags?: Array<{ name: string; description?: string }>;
  components?: Record<string, unknown>;
  paths: Record<string, Record<string, RawOp>>;
}

/** A believable anchor so `x-added-at` reads as real recent ISO dates (relative to the demo now). */
const ANCHOR = Date.parse('2026-10-06T13:00:00Z');
const daysAgoIso = (days: number): string => new Date(ANCHOR - days * 86_400_000).toISOString();

/** Build a `responses` map mirroring the worker's `standardResponses(...)`. */
function responses(authed: boolean, example?: Record<string, unknown>): Record<string, unknown> {
  const ok: Record<string, unknown> = {
    description: 'Success',
    content: { 'application/json': example ? { example } : {} },
  };
  const out: Record<string, unknown> = { '200': ok };
  if (authed) out['401'] = { description: 'Unauthorized', $ref: '#/components/schemas/Error' };
  return out;
}

/**
 * A seed row for the fixture surface. Mirrors one `API_SURFACE` entry; `buildCandidates`-style
 * flattening into the OpenAPI `paths` shape happens in {@link buildSpec}.
 */
interface Seed {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  summary: string;
  tag: string;
  category: string;
  authRequired: boolean;
  rateLimit?: { requests: number; windowSeconds: number };
  addedAt?: string;
  requestBody?: unknown;
  responseExample?: Record<string, unknown>;
}

/**
 * A realistic cross-section of the real projectsites.dev API surface — 16 endpoints across eight
 * categories, spanning public + authed, `{param}` paths, a rate-limited route, request bodies, and
 * recent `x-added-at` dates. Rich enough that every left-rail group + badge + the overview's
 * leaderboards render, small enough to stay a readable fixture.
 */
const SEEDS: readonly Seed[] = [
  // ── Health (public) ──
  { method: 'GET', path: '/health', summary: 'Liveness probe (KV + R2 latency)', tag: 'health', category: 'Health', authRequired: false },
  // ── Search (public) ──
  {
    method: 'GET',
    path: '/api/search/businesses',
    summary: 'Google Places business search proxy (max 10)',
    tag: 'search',
    category: 'Search',
    authRequired: false,
    rateLimit: { requests: 30, windowSeconds: 60 },
    responseExample: { data: [{ place_id: 'abc', name: "Vito's Mens Salon" }], meta: { cached: true } },
  },
  { method: 'GET', path: '/api/sites/search', summary: 'Pre-built site lookup (LIKE)', tag: 'search', category: 'Search', authRequired: false },
  // ── Auth ──
  {
    method: 'POST',
    path: '/api/auth/magic-link',
    summary: 'Request a magic-link sign-in email',
    tag: 'auth',
    category: 'Auth',
    authRequired: false,
    rateLimit: { requests: 3, windowSeconds: 600 },
    requestBody: { type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' } } },
    responseExample: { data: { sent: true, expires_in_seconds: 900 } },
  },
  { method: 'GET', path: '/api/auth/me', summary: 'Current signed-in user + session', tag: 'auth', category: 'Auth', authRequired: true, responseExample: { data: { user: { id: 'u_1', email: 'owner@example.com' } } } },
  { method: 'GET', path: '/api/auth/google', summary: 'Start the Google OAuth 2.0 PKCE flow', tag: 'auth', category: 'Auth', authRequired: false },
  // ── Sites ──
  { method: 'GET', path: '/api/sites', summary: "List the signed-in user's sites", tag: 'sites', category: 'Sites', authRequired: true, responseExample: { data: [], meta: { total: 3 } } },
  {
    method: 'POST',
    path: '/api/sites/create-from-search',
    summary: 'Create a site + kick the AI build workflow',
    tag: 'sites',
    category: 'Sites',
    authRequired: true,
    addedAt: daysAgoIso(5),
    requestBody: { type: 'object', required: ['place_id'], properties: { place_id: { type: 'string' }, name: { type: 'string' } } },
    responseExample: { data: { id: 's_1', status: 'draft' } },
  },
  { method: 'GET', path: '/api/sites/{id}', summary: 'Get one site by its UUID', tag: 'sites', category: 'Sites', authRequired: true },
  { method: 'GET', path: '/api/sites/{id}/workflow', summary: 'Current AI build workflow status', tag: 'sites', category: 'Sites', authRequired: true },
  { method: 'POST', path: '/api/sites/{id}/publish-bolt', summary: 'Publish the bolt editor file tree to R2', tag: 'sites', category: 'Sites', authRequired: true, addedAt: daysAgoIso(12) },
  // ── Billing ──
  { method: 'POST', path: '/api/billing/checkout', summary: 'Create a Stripe Checkout session', tag: 'billing', category: 'Billing', authRequired: true, responseExample: { data: { url: 'https://checkout.stripe.com/c/pay/cs_test' } } },
  { method: 'GET', path: '/api/billing/subscription', summary: 'Current subscription state', tag: 'billing', category: 'Billing', authRequired: true },
  // ── Analytics ──
  { method: 'GET', path: '/api/analytics/{siteId}', summary: 'Aggregated visit + funnel metrics', tag: 'analytics', category: 'Analytics', authRequired: true, addedAt: daysAgoIso(22) },
  // ── Audit ──
  { method: 'GET', path: '/api/audit-logs', summary: 'Org-scoped audit log feed (paginated)', tag: 'audit', category: 'Audit', authRequired: true },
  // ── Admin (this explorer) ──
  { method: 'GET', path: '/api/admin/docs/stats', summary: 'Aggregate counts for the Docs overview', tag: 'admin', category: 'Admin', authRequired: true, addedAt: daysAgoIso(2) },
];

/** Flatten the {@link SEEDS} into the OpenAPI `paths` map the worker emits. */
function buildPaths(seeds: readonly Seed[]): Record<string, Record<string, RawOp>> {
  const paths: Record<string, Record<string, RawOp>> = {};
  for (const s of seeds) {
    const op: RawOp = {
      summary: s.summary,
      tags: [s.tag],
      operationId: `${s.method.toLowerCase()}_${s.path.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
      responses: responses(s.authRequired, s.responseExample),
    };
    if (s.authRequired) op.security = [{ bearerAuth: [] }];
    // Path parameters — one `{param}` → one required path param (mirrors `pathParameters`).
    const params = Array.from(s.path.matchAll(/\{([^}]+)\}/g)).map((m) => ({
      name: m[1]!,
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }));
    if (params.length > 0) op.parameters = params;
    if (s.requestBody) {
      op.requestBody = { required: true, content: { 'application/json': { schema: s.requestBody } } };
    }
    if (s.category) op['x-category'] = s.category;
    if (s.rateLimit) op['x-rate-limit'] = s.rateLimit;
    if (s.addedAt) op['x-added-at'] = s.addedAt;
    if (!paths[s.path]) paths[s.path] = {};
    paths[s.path]![s.method.toLowerCase()] = op;
  }
  return paths;
}

/** Shared spec scaffold (info + servers + tags + components) — constant across the populated set. */
function buildSpec(seeds: readonly Seed[]): DocsOpenApiSpec {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Project Sites API',
      version: '1.0.0',
      description:
        'The complete public + authenticated API surface for projectsites.dev. ' +
        'Generated from the canonical CLAUDE.md table; live-tested via the in-product Docs explorer at /admin/docs.',
      contact: { name: 'Project Sites', url: 'https://projectsites.dev' },
    },
    servers: [
      { url: 'https://projectsites.dev', description: 'production' },
      { url: 'http://localhost:8787', description: 'local dev (wrangler)' },
    ],
    tags: [
      { name: 'auth', description: 'Sign-in, sessions, magic links' },
      { name: 'sites', description: 'Site CRUD + AI workflow' },
      { name: 'billing', description: 'Stripe checkout + subscriptions' },
      { name: 'analytics', description: 'Visit + funnel events' },
      { name: 'audit', description: 'Privileged-action audit log' },
      { name: 'health', description: 'Liveness + dependency checks' },
      { name: 'search', description: 'Public search proxies' },
      { name: 'admin', description: 'Admin-only endpoints (this explorer)' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'Opaque session token (32 bytes hex)',
          description: 'Auto-attached by the Docs explorer using your signed-in session.',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
                request_id: { type: 'string' },
              },
            },
          },
        },
      },
    },
    paths: buildPaths(seeds),
  };
}

/** The believable populated spec (16 endpoints across 8 categories). */
const POPULATED_SPEC: DocsOpenApiSpec = buildSpec(SEEDS);

/**
 * The honest brand-new / minimal spec — a VALID doc with a single public `/health` probe so the
 * explorer never renders a path-less (crash-prone) document, and the counters read a truthful "1".
 */
const EMPTY_SPEC: DocsOpenApiSpec = buildSpec([SEEDS[0]!]);

/**
 * OpenAPI-spec factory — the BARE spec object (NOT a `{data}` envelope), exactly as the worker's
 * `c.json(buildOpenApiSpec())` returns it. `empty` → a minimal one-endpoint spec (the honest
 * first-run surface); `populated`/`loading`/default → the rich 16-endpoint set. `error` is handled
 * by the interceptor (throws a 500 before this runs).
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 */
export const docsOpenApiFixture: FixtureFactory<DocsOpenApiSpec> = (
  state: MockState,
): DocsOpenApiSpec => (state === 'empty' ? structuredClone(EMPTY_SPEC) : structuredClone(POPULATED_SPEC));

// ───────────────────────── GET /admin/docs/stats ─────────────────────────

/** The `DocsStats` payload (mirrors `docs.ts:917`'s derived counters). */
export interface DocsStats {
  total: number;
  public: number;
  authed: number;
  rate_limited: number;
  recent: Array<{ method: string; path: string; addedAt: string; category?: string }>;
  category_counts: Record<string, number>;
  generated_at: string;
}

/** The `GET /api/admin/docs/stats` envelope — the worker wraps the stats in `{ data }`. */
export interface DocsStatsResponse {
  data: DocsStats;
}

/**
 * Derive the stats from a spec's `paths` the SAME way the worker derives them from `API_SURFACE`,
 * so the overview hero numbers are always internally consistent with the rail (total === op count,
 * public + authed === total, category_counts sums to total, recent ⊆ the `x-added-at` set).
 */
function deriveStats(spec: DocsOpenApiSpec): DocsStats {
  let total = 0;
  let publicCount = 0;
  let authedCount = 0;
  let rateLimited = 0;
  const recent: Array<{ method: string; path: string; addedAt: string; category?: string }> = [];
  const categoryCounts: Record<string, number> = {};
  const cutoff = ANCHOR - 30 * 86_400_000;

  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      total++;
      const authed = Array.isArray(op.security) && op.security.length > 0;
      if (authed) authedCount++;
      else publicCount++;
      if (op['x-rate-limit']) rateLimited++;
      const cat = op['x-category'] ?? op.tags[0] ?? 'other';
      categoryCounts[cat] = (categoryCounts[cat] ?? 0) + 1;
      const added = op['x-added-at'];
      if (added) {
        const t = Date.parse(added);
        if (!Number.isNaN(t) && t >= cutoff) {
          recent.push({ method: method.toUpperCase(), path, addedAt: added, category: cat });
        }
      }
    }
  }
  recent.sort((a, b) => b.addedAt.localeCompare(a.addedAt));

  return {
    total,
    public: publicCount,
    authed: authedCount,
    rate_limited: rateLimited,
    recent: recent.slice(0, 10),
    category_counts: categoryCounts,
    generated_at: new Date(ANCHOR).toISOString(),
  };
}

const POPULATED_STATS: DocsStats = deriveStats(POPULATED_SPEC);
const EMPTY_STATS: DocsStats = deriveStats(EMPTY_SPEC);

/**
 * Stats factory. `empty` → the minimal-spec-derived counters (a truthful "1 endpoint, no recent
 * additions" surface); `populated`/`loading`/default → the rich derived set. `error` is handled by
 * the interceptor. Note the worker's `loadStats()` is best-effort (a failure silently leaves the
 * overview on a spec-derived summary), so this fixture simply keeps the two signals consistent.
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 */
export const docsStatsFixture: FixtureFactory<DocsStatsResponse> = (
  state: MockState,
): DocsStatsResponse => ({ data: state === 'empty' ? { ...EMPTY_STATS } : { ...POPULATED_STATS } });

// ───────────────────────── GET /admin/docs/app-overview ─────────────────────────

/** The `GET /api/admin/docs/app-overview` envelope — the markdown walkthrough under `{ data }`. */
export interface DocsAppOverviewResponse {
  data: { markdown: string; generated_at: string };
}

/**
 * A believable markdown overview of the Angular SPA — headings, a fenced code block (so the
 * renderer's language chip + copy button render), a bullet route tree, and inline links. Shorter
 * than the worker's, but structurally identical so every markdown feature (`## h2`, fences, lists,
 * `[link](url)`) is exercised.
 */
const OVERVIEW_MARKDOWN = [
  '# Project Sites — Angular SPA Overview',
  '',
  'This document explains how the **Angular 21 standalone** front-end bootstraps, navigates, and',
  'authenticates. It renders live inside the in-product `/admin/docs` explorer.',
  '',
  '## Bootstrap',
  '',
  'The app uses standalone components (no `NgModule`) wired through `bootstrapApplication`:',
  '',
  '- `provideRouter(routes, withComponentInputBinding())` — the route tree below.',
  '- `provideHttpClient(withInterceptors([authInterceptor]))` — attaches the bearer token.',
  '- `provideZonelessChangeDetection()` — signals everywhere.',
  '',
  '## Route Guard',
  '',
  '`authGuard` is a `CanActivateFn` that reads `ps_session` from `localStorage` and redirects to',
  '`/signin?returnUrl=<current>` when it is missing.',
  '',
  '## Homepage SPA State Machine',
  '',
  '```',
  'search ──> signin ──> details ──> waiting',
  '```',
  '',
  '## Route Tree',
  '',
  '- `/` → `HomepageComponent` (4-screen SPA: search → signin → details → waiting)',
  '- `/admin` [guard: `authGuard`] → `AdminComponent` (sidebar shell)',
  '  - `/admin/docs` — this explorer',
  '  - `/admin/analytics` — Workers Analytics Engine',
  '  - `/admin/billing` — Stripe billing',
  '',
  '## Where to look next',
  '',
  '- API endpoints — switch to the **Endpoints** tab in this explorer.',
  '- Worker entry — [the source on GitHub](https://github.com/HeyMegabyte/template.projectsites.dev).',
].join('\n');

/** A terse but valid stub overview for the honest brand-new surface. */
const EMPTY_OVERVIEW_MARKDOWN = [
  '# Project Sites — Angular SPA Overview',
  '',
  'The SPA overview will render here. Switch to the **Endpoints** tab to explore the API.',
].join('\n');

/**
 * App-overview factory. `empty` → a terse valid stub (the overview pane never renders blank);
 * `populated`/`loading`/default → the rich markdown walkthrough. `generated_at` is pinned to the
 * demo anchor for deterministic snapshots. `error` is handled by the interceptor.
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 */
export const docsAppOverviewFixture: FixtureFactory<DocsAppOverviewResponse> = (
  state: MockState,
): DocsAppOverviewResponse => ({
  data: {
    markdown: state === 'empty' ? EMPTY_OVERVIEW_MARKDOWN : OVERVIEW_MARKDOWN,
    generated_at: new Date(ANCHOR).toISOString(),
  },
});
