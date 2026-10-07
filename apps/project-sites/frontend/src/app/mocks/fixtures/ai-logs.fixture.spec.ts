import {
  aiLogsFixture,
  aiLogDetailFixture,
  detailForId,
  type AiLogsResponse,
  type AiLogDetailResponse,
} from './ai-logs.fixture';
import { toRegistryKey, FIXTURES } from './index';

/**
 * ai-logs.fixture — the mock bodies for the admin **AI Traces** section
 * (`/admin/ai-logs`). Two authenticated GET reads (NO feature flag — `siteActivity`
 * guards only org/user + site ownership), traced to
 * `libs/features/site_activity/handlers.ts`:
 *
 *   GET /sites/:id/ai-logs         → { data: TraceRow[]; meta: { limit; total; has_more } }
 *   GET /sites/:id/ai-logs/:logId  → { data: TraceDetail }  (a SELECT * row)
 *
 * These specs test the factories DIRECTLY (envelope shape · every state · the
 * worker's limit/kind query contract · `has_more = list.length < total` cap
 * semantics · detail enrichment) and assert BOTH registry keys resolve through the
 * interceptor's normalizer (query stripped, `:param` patterns matched). They are
 * RED until `index.ts` re-points `GET /sites/:id/ai-logs` here and ADDS the detail
 * line (the orchestrator's merge), then GREEN.
 */
function q(search = ''): URLSearchParams {
  return new URLSearchParams(search);
}

describe('aiLogsFixture (envelope { data, meta }, worker-contract-shaped)', () => {
  it('returns the worker envelope shape { data: TraceRow[]; meta: { limit; total; has_more } }', () => {
    const res: AiLogsResponse = aiLogsFixture('populated', q());
    expect(Array.isArray(res.data)).toBe(true);
    expect(typeof res.meta.limit).toBe('number');
    expect(typeof res.meta.total).toBe('number');
    expect(typeof res.meta.has_more).toBe('boolean');
  });

  it('ships 30+ believable rows so client pagination (25/50 page sizes) is exercised', () => {
    const res = aiLogsFixture('populated', q());
    expect(res.data.length).toBeGreaterThanOrEqual(30);
  });

  it('every row matches the summary projection (no actor join — actor_email/user_id absent)', () => {
    const res = aiLogsFixture('populated', q());
    for (const r of res.data) {
      expect(typeof r.id).toBe('string');
      expect(typeof r.trace_kind).toBe('string');
      expect(typeof r.status).toBe('string');
      expect(typeof r.created_at).toBe('string');
      expect('output_preview' in r).toBe(true);
      // The list SELECT does NOT join the actor, so these keys are absent on the wire.
      expect('actor_email' in r).toBe(false);
      expect('user_id' in r).toBe(false);
    }
  });

  it('spans the real trace_kind vocabulary + multiple model vendors (rich chart/filter texture)', () => {
    const res = aiLogsFixture('populated', q());
    const kinds = new Set(res.data.map((r) => r.trace_kind));
    for (const k of ['chat', 'form_router', 'endpoint', 'tool_call', 'search']) {
      expect(kinds.has(k)).toBe(true);
    }
    const models = new Set(res.data.map((r) => r.model));
    // At least a Workers-AI llama slug, an OpenAI gpt, and an Anthropic claude.
    expect([...models].some((m) => (m ?? '').includes('llama'))).toBe(true);
    expect([...models].some((m) => (m ?? '').startsWith('gpt-'))).toBe(true);
    expect([...models].some((m) => (m ?? '').startsWith('claude-'))).toBe(true);
  });

  it('includes a realistic status spread (some error/rate_limited/timeout drive the KPIs + chart gaps)', () => {
    const res = aiLogsFixture('populated', q());
    const statuses = new Set(res.data.map((r) => r.status));
    expect(statuses.has('ok')).toBe(true);
    expect(res.data.some((r) => r.status !== 'ok')).toBe(true);
    // An error row carries an error_message + null latency (the worker's shape).
    const errored = res.data.find((r) => r.status === 'error');
    expect(errored).toBeDefined();
    expect(typeof errored!.error_message).toBe('string');
  });

  it('is newest-first (created_at DESC — the worker ordering the component relies on)', () => {
    // The fixture store is built ONCE at module load, dating each row `Date.now() - minutesAgo`
    // with Date.now() called PER ROW inside its .map(). Rows with an IDENTICAL minutesAgo seed
    // (there are ties: 9/9, 52/52, 96/96, 188/188, 276/276) can straddle a 1ms clock tick at
    // build time and invert by a single millisecond — a non-deterministic flake against a strict
    // `>=`. Compare at WHOLE-SECOND granularity: a sub-second build jitter vanishes (ties collapse
    // to an equal second → `>=` holds), while every genuinely-distinct row differs by ≥60s, so the
    // DESC ordering guarantee the component relies on is still proven. (The worker's own
    // `ORDER BY created_at DESC` likewise tie-breaks arbitrarily on equal timestamps — sub-second
    // precision is never a user-visible ordering signal.)
    const res = aiLogsFixture('populated', q());
    const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);
    for (let i = 1; i < res.data.length; i++) {
      expect(sec(res.data[i - 1]!.created_at)).toBeGreaterThanOrEqual(sec(res.data[i]!.created_at));
    }
  });

  it('a tool_call row carries tool_name + tool_status; non-tool rows leave them null', () => {
    const res = aiLogsFixture('populated', q());
    const tool = res.data.find((r) => r.trace_kind === 'tool_call');
    expect(tool).toBeDefined();
    expect(typeof tool!.tool_name).toBe('string');
    expect(typeof tool!.tool_status).toBe('string');
    const chat = res.data.find((r) => r.trace_kind === 'chat');
    expect(chat!.tool_name).toBeNull();
  });

  it('default load (no limit) returns the whole store in one page with has_more=false', () => {
    const res = aiLogsFixture('populated', q());
    expect(res.meta.total).toBe(res.data.length);
    expect(res.meta.has_more).toBe(false);
    expect(res.meta.limit).toBe(200); // the worker default
  });

  it('honors ?limit= like the worker: slices to the cap, total stays full, has_more flips true', () => {
    const full = aiLogsFixture('populated', q());
    const capped = aiLogsFixture('populated', q('limit=10'));
    expect(capped.data.length).toBe(10);
    expect(capped.meta.limit).toBe(10);
    expect(capped.meta.total).toBe(full.data.length); // TRUE full count, not the page
    expect(capped.meta.has_more).toBe(true); // list.length < total → the "showing latest N of M" note
  });

  it('clamps ?limit= to [1,1000] and ignores a non-numeric limit (→ default 200)', () => {
    expect(aiLogsFixture('populated', q('limit=0')).data.length).toBe(1); // clamped up to 1
    expect(aiLogsFixture('populated', q('limit=99999')).meta.limit).toBe(1000); // clamped down
    expect(aiLogsFixture('populated', q('limit=abc')).meta.limit).toBe(200); // non-numeric → default
  });

  it('honors ?kind= like the worker: filters trace_kind and reflects the filtered total', () => {
    const chatOnly = aiLogsFixture('populated', q('kind=chat'));
    expect(chatOnly.data.length).toBeGreaterThan(0);
    expect(chatOnly.data.every((r) => r.trace_kind === 'chat')).toBe(true);
    expect(chatOnly.meta.total).toBe(chatOnly.data.length);
    // The filtered total is strictly smaller than the unfiltered store.
    expect(chatOnly.meta.total).toBeLessThan(aiLogsFixture('populated', q()).meta.total);
  });

  it('empty → { data: [], meta: { total: 0, has_more: false } } (brand-new site, no AI activity)', () => {
    const res = aiLogsFixture('empty', q());
    expect(res.data.length).toBe(0);
    expect(res.meta.total).toBe(0);
    expect(res.meta.has_more).toBe(false);
  });

  it('loading / default states serve the full store (same as populated)', () => {
    expect(aiLogsFixture('loading', q()).data.length).toBe(aiLogsFixture('populated', q()).data.length);
  });

  it('returns a fresh clone each call (mutating one row never corrupts the next)', () => {
    const a = aiLogsFixture('populated', q());
    a.data[0]!.status = 'MUTATED';
    const b = aiLogsFixture('populated', q());
    expect(b.data[0]!.status).not.toBe('MUTATED');
  });
});

describe('aiLogDetailFixture (envelope { data: TraceDetail }, full SELECT * shape)', () => {
  it('returns the FULL detail under { data } with the heavy text columns the list omits', () => {
    const res: AiLogDetailResponse = aiLogDetailFixture('populated', q());
    const d = res.data;
    // Summary fields + the SELECT * extras.
    expect(typeof d.id).toBe('string');
    expect(typeof d.org_id).toBe('string');
    expect(typeof d.site_id).toBe('string');
    expect('prompt_template' in d).toBe(true);
    expect(typeof d.input_json).toBe('string');
    expect('output_text' in d).toBe(true);
    expect('output_json' in d).toBe(true);
    expect('tool_args_json' in d).toBe(true);
    expect('tool_result_json' in d).toBe(true);
    expect('explanation' in d).toBe(true);
  });

  it('input_json is valid parseable JSON (the panel pretty-prints + highlights it)', () => {
    const d = aiLogDetailFixture('populated', q()).data;
    expect(() => JSON.parse(d.input_json)).not.toThrow();
  });

  it('the canonical detail is a rich tool_call (system prompt + tool args + tool result all present)', () => {
    const d = aiLogDetailFixture('populated', q()).data;
    expect(d.trace_kind).toBe('tool_call');
    expect(typeof d.prompt_template).toBe('string');
    expect(d.prompt_template!.length).toBeGreaterThan(20);
    expect(typeof d.tool_name).toBe('string');
    expect(() => JSON.parse(d.tool_args_json!)).not.toThrow();
    expect(() => JSON.parse(d.tool_result_json!)).not.toThrow();
  });

  it('detailForId reconstructs a consistent detail for a specific summary id', () => {
    const list = aiLogsFixture('populated', q()).data;
    const chatRow = list.find((r) => r.trace_kind === 'chat')!;
    const d = detailForId(chatRow.id);
    expect(d.id).toBe(chatRow.id);
    expect(d.trace_kind).toBe('chat');
    // A chat trace has a system prompt + prose output_text, no tool payloads.
    expect(typeof d.prompt_template).toBe('string');
    expect(d.tool_args_json).toBeNull();
    expect(d.output_text).toBe(chatRow.output_preview);
  });

  it('an errored row detail has null output_text AND null output_json (nothing produced)', () => {
    const list = aiLogsFixture('populated', q()).data;
    const errRow = list.find((r) => r.status === 'error')!;
    const d = detailForId(errRow.id);
    expect(d.output_text).toBeNull();
    expect(d.output_json).toBeNull();
    expect(typeof d.error_message).toBe('string');
  });

  it('a form_router detail carries structured output_json (not prose output_text)', () => {
    const list = aiLogsFixture('populated', q()).data;
    const router = list.find((r) => r.trace_kind === 'form_router')!;
    const d = detailForId(router.id);
    expect(d.output_text).toBeNull();
    expect(typeof d.output_json).toBe('string');
    expect(() => JSON.parse(d.output_json!)).not.toThrow();
  });

  it('an unknown / null id falls back to a valid detail (a demo deep-link never 404s)', () => {
    expect(() => detailForId('does-not-exist')).not.toThrow();
    expect(() => detailForId(null)).not.toThrow();
    expect(typeof detailForId('does-not-exist').id).toBe('string');
  });
});

describe('ai-logs fixtures — registry wiring (the shipped FIXTURES map carries both :param patterns)', () => {
  // Assert against the STATIC registry map + its PATTERN keys directly — the merged lines
  // always carry these factories regardless of Jasmine's spec order, and reading the map (not
  // findFixture) never touches the mutable registerFixtures/EXTRA_FIXTURES seam a sibling spec
  // could leak under random order. The LIST + DETAIL are DISTINCT `:param` PATTERN keys.
  const reg = FIXTURES as Record<string, unknown>;
  const LIST_PATTERN = 'GET /sites/:id/ai-logs';
  const DETAIL_PATTERN = 'GET /sites/:id/ai-logs/:logId';

  it('both ai-logs URLs normalize to the LIST + DETAIL keys (query stripped, :id/:logId distinct)', () => {
    expect(toRegistryKey('GET', 'https://projectsites.dev/api/sites/site-001/ai-logs?limit=200').key).toBe(
      'GET /sites/site-001/ai-logs',
    );
    expect(toRegistryKey('GET', 'https://projectsites.dev/api/sites/site-001/ai-logs/trace-001').key).toBe(
      'GET /sites/site-001/ai-logs/trace-001',
    );
  });

  it('the LIST pattern GET /sites/:id/ai-logs is wired to aiLogsFixture in FIXTURES', () => {
    expect(typeof reg[LIST_PATTERN]).toBe('function');
    expect(reg[LIST_PATTERN]).toBe(aiLogsFixture as unknown);
  });

  it('the DETAIL pattern GET /sites/:id/ai-logs/:logId is wired to aiLogDetailFixture in FIXTURES', () => {
    expect(typeof reg[DETAIL_PATTERN]).toBe('function');
    expect(reg[DETAIL_PATTERN]).toBe(aiLogDetailFixture as unknown);
  });

  it('the LIST + DETAIL patterns are two DISTINCT registry keys (the list never shadows the detail)', () => {
    expect(LIST_PATTERN).not.toBe(DETAIL_PATTERN);
    expect(reg[LIST_PATTERN]).not.toBe(reg[DETAIL_PATTERN]);
  });
});
