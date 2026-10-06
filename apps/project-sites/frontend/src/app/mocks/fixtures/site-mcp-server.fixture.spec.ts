import {
  mcpTokensFixture,
  mcpToolsFixture,
  mcpToolUsageFixture,
  SITE_MCP_TOOL_NAMES,
  type McpTokensResponse,
  type McpToolsResponse,
  type McpToolUsageResponse,
} from './site-mcp-server.fixture';
import { toRegistryKey } from './index';

/**
 * site-mcp-server.fixture — mock bodies for the per-site MCP SERVER admin section
 * (`/admin/sites/:id/mcp-server`, `SiteMcpServerComponent`). It fires three GET
 * reads the moment it mounts, all `{ silent: true }`, each of which 404'd in the
 * `?mock=1` demo (the fixture site ids don't exist in prod), rendering the section's
 * "Couldn't load tokens / tools" error-cards:
 *
 *   GET /sites/:id/mcp/tokens     → { tokens: McpToken[] }
 *   GET /sites/:id/mcp/tools      → { tools: ToolDef[] }  (the SITE_MCP_TOOLS registry)
 *   GET /sites/:id/mcp/tool-usage → { usage: ToolUsage[] }
 *
 * Each matches the worker wire contract (`libs/features/site_mcp_server/handlers.ts`)
 * EXACTLY so the real endpoint is a drop-in swap. NOTE: `GET /sites/:id/mcp/connections`
 * is a SEPARATE route (billing's refreshSlackConnected) already fixtured in
 * per-site.fixture — NOT re-declared here.
 */
function q(search = ''): URLSearchParams {
  return new URLSearchParams(search);
}

describe('mcpTokensFixture (GET /sites/:id/mcp/tokens → { tokens: McpToken[] })', () => {
  it('returns the worker envelope shape { tokens: [...] } (array)', () => {
    const res: McpTokensResponse = mcpTokensFixture('populated', q());
    expect(Array.isArray(res.tokens)).toBe(true);
  });

  it('populated → a believable token roster; every row matches the worker projection', () => {
    const { tokens } = mcpTokensFixture('populated', q());
    expect(tokens.length).toBeGreaterThan(0);
    for (const t of tokens) {
      // Exactly the SELECT projection the handler returns — id/label/last_used/created_at.
      expect(typeof t.id).toBe('string');
      expect(typeof t.label).toBe('string');
      expect(t.label.length).toBeGreaterThan(0);
      expect(typeof t.created_at).toBe('string');
      expect(Number.isNaN(Date.parse(t.created_at))).toBe(false);
      // last_used is nullable (a freshly-minted, never-used token is null).
      expect(t.last_used === null || typeof t.last_used === 'string').toBe(true);
      // The raw token / hash are NEVER returned by the list endpoint.
      const row = t as unknown as Record<string, unknown>;
      expect(row['token']).toBeUndefined();
      expect(row['token_hash']).toBeUndefined();
    }
  });

  it('exposes BOTH a used and a never-used token so the "Never"/date branches both render', () => {
    const { tokens } = mcpTokensFixture('populated', q());
    expect(tokens.some((t) => t.last_used === null)).toBe(true);
    expect(tokens.some((t) => typeof t.last_used === 'string')).toBe(true);
  });

  it('empty → an honest empty roster (the first-run "mint your first token" launchpad)', () => {
    expect(mcpTokensFixture('empty', q()).tokens).toEqual([]);
  });

  it('loading/default → the full roster (interceptor owns latency + the error short-circuit)', () => {
    expect(mcpTokensFixture('loading', q()).tokens.length).toBeGreaterThan(0);
    expect(mcpTokensFixture('populated', q()).tokens.length).toBeGreaterThan(0);
  });

  it('newest-first (created_at DESC), mirroring the worker ORDER BY', () => {
    const times = mcpTokensFixture('populated', q()).tokens.map((t) => Date.parse(t.created_at));
    const sorted = [...times].sort((a, b) => b - a);
    expect(times).toEqual(sorted);
  });
});

describe('mcpToolsFixture (GET /sites/:id/mcp/tools → { tools: ToolDef[] })', () => {
  it('returns the worker envelope shape { tools: [...] } (array)', () => {
    const res: McpToolsResponse = mcpToolsFixture('populated', q());
    expect(Array.isArray(res.tools)).toBe(true);
  });

  it('mirrors the canonical SITE_MCP_TOOLS registry exactly (same names, same order)', () => {
    const names = mcpToolsFixture('populated', q()).tools.map((t) => t.name);
    expect(names).toEqual([...SITE_MCP_TOOL_NAMES]);
  });

  it('every tool carries a name + description + object inputSchema (the worker contract)', () => {
    for (const t of mcpToolsFixture('populated', q()).tools) {
      expect(typeof t.name).toBe('string');
      expect(t.name.length).toBeGreaterThan(0);
      expect(typeof t.description).toBe('string');
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.inputSchema).toBeDefined();
      expect(t.inputSchema.type).toBe('object');
      expect(typeof t.inputSchema.properties).toBe('object');
    }
  });

  it('includes both read and mutating tools so the playground danger-confirm branch is demoable', () => {
    const names = mcpToolsFixture('populated', q()).tools.map((t) => t.name);
    expect(names).toContain('list_pages'); // read
    expect(names).toContain('create_page'); // mutating → MUTATING_TOOL confirm
    expect(names).toContain('update_page_section'); // mutating
  });

  it('tools is NON-EMPTY on every state (the registry is static — never a false "no tools")', () => {
    // The worker returns the static SITE_MCP_TOOLS for any owned site regardless of
    // data; a demo must not fake-empty it (that would lie "No MCP tools available").
    expect(mcpToolsFixture('empty', q()).tools.length).toBeGreaterThan(0);
    expect(mcpToolsFixture('loading', q()).tools.length).toBeGreaterThan(0);
    expect(mcpToolsFixture('populated', q()).tools.length).toBeGreaterThan(0);
  });
});

describe('mcpToolUsageFixture (GET /sites/:id/mcp/tool-usage → { usage: ToolUsage[] })', () => {
  it('returns the worker envelope shape { usage: [...] } (array)', () => {
    const res: McpToolUsageResponse = mcpToolUsageFixture('populated', q());
    expect(Array.isArray(res.usage)).toBe(true);
  });

  it('populated → believable per-tool/day counters matching the worker projection', () => {
    const { usage } = mcpToolUsageFixture('populated', q());
    expect(usage.length).toBeGreaterThan(0);
    for (const u of usage) {
      expect(typeof u.tool_name).toBe('string');
      // day is an ISO date (YYYY-MM-DD), the worker's `day` column granularity.
      expect(u.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof u.call_count).toBe('number');
      expect(u.call_count).toBeGreaterThanOrEqual(0);
      expect(typeof u.error_count).toBe('number');
      expect(u.error_count).toBeGreaterThanOrEqual(0);
      // errors never exceed calls (a believable invariant).
      expect(u.error_count).toBeLessThanOrEqual(u.call_count);
    }
  });

  it('every usage tool_name is a real registered tool (no orphan counters)', () => {
    const toolNames = new Set<string>(SITE_MCP_TOOL_NAMES);
    for (const u of mcpToolUsageFixture('populated', q()).usage) {
      expect(toolNames.has(u.tool_name)).toBe(true);
    }
  });

  it('includes a row dated TODAY so the "calls today" header pill renders a non-zero count', () => {
    const today = new Date().toISOString().slice(0, 10);
    const usage = mcpToolUsageFixture('populated', q()).usage;
    const todays = usage.filter((u) => u.day === today);
    expect(todays.length).toBeGreaterThan(0);
    expect(todays.reduce((s, u) => s + u.call_count, 0)).toBeGreaterThan(0);
  });

  it('is within the worker 30-day window (every day >= 30 days ago)', () => {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    for (const u of mcpToolUsageFixture('populated', q()).usage) {
      expect(Date.parse(u.day)).toBeGreaterThanOrEqual(cutoff);
    }
  });

  it('newest-first (day DESC), mirroring the worker ORDER BY', () => {
    const days = mcpToolUsageFixture('populated', q()).usage.map((u) => Date.parse(u.day));
    const sorted = [...days].sort((a, b) => b - a);
    expect(days).toEqual(sorted);
  });

  it('empty → no usage (an honest brand-new site with zero recorded calls)', () => {
    expect(mcpToolUsageFixture('empty', q()).usage).toEqual([]);
  });
});

describe('registry key normalization (per-site :param routes)', () => {
  it('GET /sites/:id/mcp/tokens', () => {
    expect(toRegistryKey('GET', '/api/sites/site-001/mcp/tokens').key).toBe(
      'GET /sites/site-001/mcp/tokens',
    );
  });
  it('GET /sites/:id/mcp/tools', () => {
    expect(toRegistryKey('GET', '/api/sites/site-001/mcp/tools').key).toBe(
      'GET /sites/site-001/mcp/tools',
    );
  });
  it('GET /sites/:id/mcp/tool-usage', () => {
    expect(toRegistryKey('GET', '/api/sites/site-001/mcp/tool-usage').key).toBe(
      'GET /sites/site-001/mcp/tool-usage',
    );
  });
});
