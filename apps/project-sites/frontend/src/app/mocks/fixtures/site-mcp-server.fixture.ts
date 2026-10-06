/**
 * @module mocks/fixtures/site-mcp-server
 *
 * @description
 * Mock fixtures for the per-site **MCP SERVER** admin section (`/admin/sites/:id/mcp-server`,
 * `SiteMcpServerComponent`). The section fires THREE `{ silent: true }` GET reads the moment
 * it mounts — each 404'd in the `?mock=1` demo (the fixture site ids don't exist in prod),
 * rendering the section's "Couldn't load tokens" / "Couldn't load tools" error-cards and a
 * dead "— calls today" pill. These fixtures light the section up fully from mock data.
 *
 * Typed to the EXACT worker contract traced in `libs/features/site_mcp_server/handlers.ts`
 * (+ the static tool registry in `src/services/mcp_site_tools.ts`), so wiring the real
 * endpoint is a provider SWAP, not a rewrite:
 *
 * | Route                               | Factory                 | Worker envelope                                      |
 * | ----------------------------------- | ----------------------- | ---------------------------------------------------- |
 * | `GET /sites/:id/mcp/tokens`         | {@link mcpTokensFixture}    | `{ tokens: Array<{ id, label, last_used, created_at }> }` |
 * | `GET /sites/:id/mcp/tools`          | {@link mcpToolsFixture}     | `{ tools: McpToolDef[] }` (the static `SITE_MCP_TOOLS`)    |
 * | `GET /sites/:id/mcp/tool-usage`     | {@link mcpToolUsageFixture} | `{ usage: Array<{ tool_name, day, call_count, error_count }> }` |
 *
 * Registered under `:param` PATTERN keys so ONE fixture serves EVERY site id.
 *
 * @remarks
 * - **Flag-gating:** NONE. The `siteMcpServer` Hono sub-app (`src/index.ts` → `app.route('/',
 *   siteMcpServer)`) wires these three routes with only an `orgId`+`userId` + site-ownership
 *   guard (`siteOwned` → 404, never 403, on a foreign/missing site). There is no `requireFlag`
 *   on them — they ALWAYS serve for an owned site. (The `mcp_server` flag gates the SEPARATE
 *   platform-MCP + MCP-OAuth-provider features, not this per-site admin surface.)
 * - **Not re-declared here:** `GET /sites/:id/mcp/connections` is a DIFFERENT route (billing's
 *   `refreshSlackConnected`) already fixtured in `per-site.fixture.ts` (#32). The section's
 *   cosmetic `GET /sites/:id` slug read (for the endpoint URL line) is `{ silent: true }` +
 *   `catchError(() => of(null))` — it degrades invisibly when unfixtured, so it's left to the
 *   shell-reads slice (#34). The section renders fully without it.
 * - **State knob:** `empty` → no tokens + no usage (the honest brand-new site, so the
 *   "mint your first token" launchpad + the "—" stats render), but tools STAY non-empty (the
 *   registry is static code — a demo must never fake-empty it into a false "No tools"). `error`
 *   is handled by the interceptor (throws a 500 before this runs). `populated`/`loading`/default
 *   → the full believable surface. Usage is dated relative to `Date.now()` so "calls today" is
 *   always a live, non-zero subset.
 */
import type { FixtureFactory, MockState } from './index';

// ───────────────────────── GET /sites/:id/mcp/tokens ─────────────────────────

/**
 * One MCP token row — EXACTLY the worker's SELECT projection (`id, label, last_used,
 * created_at`). The raw token + its SHA-256 hash are NEVER returned by the list
 * endpoint (only the one-time mint response carries the raw secret).
 */
export interface McpTokenRow {
  id: string;
  label: string;
  last_used: string | null;
  created_at: string;
}

/** The `GET /api/sites/:id/mcp/tokens` envelope — `{ tokens: [...] }` (NOT a bare array). */
export interface McpTokensResponse {
  tokens: McpTokenRow[];
}

/**
 * Tokens factory. `empty` → an honest empty roster (the section's "mint your first
 * token" launchpad). `loading`/`populated`/default → a believable roster with one
 * actively-used token + one freshly-minted never-used one (so both the date and the
 * "Never" last-used branches render). Newest-first, mirroring the worker ORDER BY.
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 */
export const mcpTokensFixture: FixtureFactory<McpTokensResponse> = (
  state: MockState,
): McpTokensResponse => {
  if (state === 'empty') return { tokens: [] };
  return { tokens: buildTokens() };
};

/** Build the believable token roster (pure; deterministic; newest-first). */
function buildTokens(): McpTokenRow[] {
  const now = Date.now();
  const hoursAgo = (h: number) => new Date(now - h * 60 * 60 * 1000).toISOString();
  // [label, createdHoursAgo, lastUsedHoursAgo|null] — newest-created first.
  const seeds: [string, number, number | null][] = [
    ['Claude Desktop', 6, 2], // actively used (last_used date branch)
    ['Cursor', 30, 9], // actively used
    ['CI Pipeline', 72, null], // minted for CI, never fired → "Never" branch
  ];
  return seeds.map(([label, createdH, usedH], i) => ({
    id: `mcp-tok-${String(i + 1).padStart(3, '0')}`,
    label,
    last_used: usedH == null ? null : hoursAgo(usedH),
    created_at: hoursAgo(createdH),
  }));
}

// ───────────────────────── GET /sites/:id/mcp/tools ─────────────────────────

/**
 * One tool definition — mirrors the worker's `McpToolDef` (`services/mcp_site_tools.ts`)
 * AND the section's local `ToolDef` interface. `inputSchema` is a JSON-schema object.
 */
export interface McpToolDefFixture {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
}

/** The `GET /api/sites/:id/mcp/tools` envelope — `{ tools: [...] }`. */
export interface McpToolsResponse {
  tools: McpToolDefFixture[];
}

/**
 * The canonical per-site MCP tool registry — a 1:1 mirror of the worker's static
 * `SITE_MCP_TOOLS` (`src/services/mcp_site_tools.ts`), in declaration order. Kept here
 * (not imported from the worker) so the frontend bundle stays self-contained; the names,
 * descriptions, and schemas match prod exactly so the demo tool list is indistinguishable
 * from the real endpoint. Spans read + mutating tools (so the playground danger-confirm
 * branch is demoable).
 */
const SITE_MCP_TOOLS: readonly McpToolDefFixture[] = [
  {
    name: 'list_pages',
    description: 'List all pages for this site with their slugs and titles.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'read_page',
    description: 'Read the content of a specific page by slug.',
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string', description: 'Page slug e.g. "/about"' } },
      required: ['slug'],
    },
  },
  {
    name: 'update_page_section',
    description: 'Update a specific section within a page.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Page slug' },
        section_id: { type: 'string', description: 'Section identifier' },
        content: { type: 'string', description: 'New HTML or markdown content' },
      },
      required: ['slug', 'section_id', 'content'],
    },
  },
  {
    name: 'create_page',
    description: 'Create a new page on the site.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'URL slug, e.g. "/new-page"' },
        title: { type: 'string', description: 'Page title' },
        content: { type: 'string', description: 'Page content (HTML or markdown)' },
      },
      required: ['slug', 'title', 'content'],
    },
  },
  {
    name: 'list_form_submissions',
    description: 'List recent form submissions for this site.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max results (default 50)' } },
    },
  },
  {
    name: 'list_blog_posts',
    description: 'List blog posts for this site.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max results (default 20)' } },
    },
  },
  {
    name: 'create_blog_post',
    description: 'Create a new blog post.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Post title' },
        content: { type: 'string', description: 'Post content (HTML or markdown)' },
        slug: { type: 'string', description: 'URL slug (optional — auto-generated if omitted)' },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'get_analytics_summary',
    description: 'Get a 30-day analytics summary for this site.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_media_assets',
    description: 'List media assets (images, videos) for this site.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max results (default 30)' } },
    },
  },
] as const;

/**
 * The tool names in registry order — exported so the spec (and the usage fixture) can
 * assert the tool list + keep usage counters pinned to real registered tools.
 */
export const SITE_MCP_TOOL_NAMES: readonly string[] = SITE_MCP_TOOLS.map((t) => t.name);

/**
 * Tools factory. Returns the full static registry on EVERY state — the worker serves
 * `SITE_MCP_TOOLS` for any owned site regardless of data, so the demo must never
 * fake-empty it (an empty tool list would lie "No MCP tools available yet" + fake-zero
 * the Tools stat). `state` is intentionally ignored.
 *
 * @param _state - The mock state knob (unused — the registry is static).
 */
export const mcpToolsFixture: FixtureFactory<McpToolsResponse> = (
  _state: MockState,
): McpToolsResponse => ({ tools: SITE_MCP_TOOLS.map((t) => ({ ...t })) });

// ───────────────────────── GET /sites/:id/mcp/tool-usage ─────────────────────────

/**
 * One per-tool/day usage counter — EXACTLY the worker's SELECT projection
 * (`tool_name, day, call_count, error_count`). `day` is an ISO date (YYYY-MM-DD).
 */
export interface McpToolUsageRow {
  tool_name: string;
  day: string;
  call_count: number;
  error_count: number;
}

/** The `GET /api/sites/:id/mcp/tool-usage` envelope — `{ usage: [...] }`. */
export interface McpToolUsageResponse {
  usage: McpToolUsageRow[];
}

/**
 * Tool-usage factory. `empty` → no usage (an honest brand-new site with zero recorded
 * calls → the header pill reads "0 calls today", the per-tool counts read "0 calls
 * (30d)"). `loading`/`populated`/default → believable per-tool/day counters within the
 * worker's 30-day window, INCLUDING rows dated TODAY so the "calls today" pill is a live,
 * non-zero subset. Newest-first (day DESC), mirroring the worker ORDER BY. Every
 * `tool_name` is a real registered tool (no orphan counters).
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 */
export const mcpToolUsageFixture: FixtureFactory<McpToolUsageResponse> = (
  state: MockState,
): McpToolUsageResponse => {
  if (state === 'empty') return { usage: [] };
  return { usage: buildUsage() };
};

/**
 * Build believable 30-day usage (pure; deterministic; newest-first). Spreads calls
 * across the busiest read + write tools over the window, with a couple of rows dated
 * TODAY (so "calls today" is non-zero) and a sprinkle of errors (never exceeding calls).
 */
function buildUsage(): McpToolUsageRow[] {
  const dayISO = (daysAgo: number) =>
    new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  // [tool_name, daysAgo, call_count, error_count] — the vocabulary a real site exercises.
  const seeds: [string, number, number, number][] = [
    // Today — drives the "calls today" header pill.
    ['list_pages', 0, 14, 0],
    ['read_page', 0, 9, 1],
    ['get_analytics_summary', 0, 4, 0],
    // Yesterday.
    ['list_pages', 1, 11, 0],
    ['update_page_section', 1, 5, 1],
    ['list_form_submissions', 1, 3, 0],
    // Earlier in the window.
    ['read_page', 3, 8, 0],
    ['create_blog_post', 5, 2, 0],
    ['list_blog_posts', 7, 6, 0],
    ['create_page', 12, 3, 1],
    ['list_media_assets', 18, 4, 0],
    ['get_analytics_summary', 27, 2, 0],
  ];
  return seeds
    .map(([tool_name, daysAgo, call_count, error_count]) => ({
      tool_name,
      day: dayISO(daysAgo),
      call_count,
      error_count,
    }))
    .sort((a, b) => Date.parse(b.day) - Date.parse(a.day));
}
