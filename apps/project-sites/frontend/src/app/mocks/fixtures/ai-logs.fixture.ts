/**
 * @module mocks/fixtures/ai-logs
 *
 * @description
 * Mock fixtures for the admin **AI Traces** section
 * (`pages/admin/sections/ai-logs.component.ts`, route `/admin/ai-logs`) — the
 * observability cockpit that lists every AI invocation a site makes (chat
 * replies, form-router classifications, endpoint calls, tool dispatches) with a
 * TanStack trace table, a p50/p95/p99 latency-percentile chart, four KPI tiles,
 * and a lazy-loaded master/detail panel. The section fires TWO reads through
 * {@link import('../../services/api.service').ApiService}, both traced to the
 * worker's `site_activity` feature module (`libs/features/site_activity/handlers.ts`):
 *
 * | Registry key                        | Factory                   | Worker contract (traced)                                             |
 * | ----------------------------------- | ------------------------- | -------------------------------------------------------------------- |
 * | `GET /sites/:id/ai-logs`            | {@link aiLogsFixture}     | `{ data: TraceRow[]; meta: { limit; total; has_more } }`             |
 * | `GET /sites/:id/ai-logs/:logId`     | {@link aiLogDetailFixture} | `{ data: TraceDetail }` (a `SELECT *` row — full prompt/IO/tool)     |
 *
 * Both are typed to the EXACT worker wire shape, so wiring the real endpoint
 * later is a provider SWAP, not a rewrite. These SUPERSEDE the thin 3-row
 * `aiLogsFixture` stub that shipped in `per-site.fixture.ts` for the #34 shell
 * sweep (empty-but-well-formed, no detail route) — the orchestrator re-points
 * the `GET /sites/:id/ai-logs` registry line here and ADDS the detail line.
 *
 * **Flag-gating:** the worker routes are **NOT** feature-flagged — `siteActivity`
 * guards only `need(c)` (orgId + userId) + `siteOwned(...)` (404 on a
 * missing/foreign site). So the AI-Logs section is auth-only; it renders fully on
 * `?mock=1` with these factories and needs NO flag flip. (The per-site reads 404
 * in prod ONLY because the fixture site ids don't exist there — a bad site id,
 * not a dark flag; under `?mock=1` the interceptor resolves them here.) The
 * section's read is `{ silent: true }`, so even a prod 404 never toasts.
 *
 * **HttpClient, not native fetch:** the component uses `ApiService.get(...)`
 * (Angular `HttpClient`), so these fixtures are served by the HTTP INTERCEPTOR —
 * they do NOT need the native-fetch shim (`mocks/mock-fetch.ts`), which exists
 * only for the handful of surfaces that call `window.fetch` directly.
 *
 * @remarks
 * - Believable LLM telemetry, not lorem: **36 trace rows** spanning the real
 *   `trace_kind` vocabulary (`chat` · `form_router` · `endpoint` · `tool_call` ·
 *   `search`) across a mix of Workers-AI (`@cf/meta/llama-*`), OpenAI (`gpt-4o`),
 *   and Anthropic (`claude-*`) models, with realistic prompt/completion token
 *   counts, credits, latencies (sub-second chats → multi-second tool calls), and
 *   a realistic status spread (mostly `ok`, a couple `error` / `rate_limited` /
 *   `timeout`). 36 rows exceeds the table's 25-row page size so **client-side
 *   pagination** (TanStack, 25/50/100/250 options) is exercised; the latencies
 *   feed a non-trivial p50/p95/p99 chart; the error rows light the red "Errors"
 *   KPI. Rows are dated backwards from `Date.now()` so "relative time", the
 *   24h-window chart, and the newest-first `created_at DESC` ordering all read as
 *   live.
 * - Honors the worker's query contract EXACTLY: `limit` is clamped to `[1,1000]`
 *   (default 200) and slices the newest-first list; `kind` filters by
 *   `trace_kind`. `total` is ALWAYS the full-store count (respecting `kind`) and
 *   `has_more = list.length < total` — so when a tiny `?limit=` is sent the
 *   component's honest "showing latest N of M calls" note lights up, mirroring the
 *   worker's cap-not-offset pagination. The component itself sends no `limit`, so
 *   the default load returns the whole store in one page.
 * - The DETAIL factory ({@link aiLogDetailFixture}) returns the SAME trace
 *   enriched with the `SELECT *` columns the summary omits — `prompt_template`,
 *   `input_json`, `output_text` / `output_json`, `tool_args_json` /
 *   `tool_result_json`, plus `org_id` / `site_id` / `explanation` — so the
 *   expand panel's system-prompt highlighter, JSON input/output blocks, tool
 *   code blocks, and Copy-JSON action all render with real content. It keys off
 *   the `:logId` path segment and reconstructs a deterministic, internally
 *   consistent detail for ANY of the 36 ids (and a believable generic one for an
 *   unknown id, so a deep-link never 404s in the demo).
 * - `state` variants: `empty` → `{ data: [], meta: { total: 0 } }` (a brand-new
 *   site with no AI activity → the component's calm "No AI traces yet" empty
 *   state + hidden KPIs); `populated` / `loading` / default → the full 36-row
 *   store. `error` is handled by the interceptor (it throws a 500 before this
 *   runs). The detail factory is state-independent (a row you can expand always
 *   has a detail).
 */
import type { FixtureFactory, MockState } from './index';

// ───────────────────────── GET /sites/:id/ai-logs ─────────────────────────

/**
 * One AI trace SUMMARY row — mirrors the worker's list SELECT projection
 * (`libs/features/site_activity/handlers.ts`) AND the component's local
 * `TraceRow` interface. `output_preview` is the worker's `substr(output_text,
 * 1, 200)`. The list SELECT does NOT join the actor, so `actor_email` /
 * `user_id` are absent (the component's `fallbackActor` renders `—`) — kept
 * optional here to match the wire exactly.
 */
export interface AiLogRowFixture {
  id: string;
  submission_id: string | null;
  trace_kind: string;
  endpoint_slug: string | null;
  model: string | null;
  status: string;
  latency_ms: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  credits_debited: number | null;
  tool_name: string | null;
  tool_status: string | null;
  output_preview: string | null;
  error_message: string | null;
  created_at: string;
}

/**
 * The `GET /api/sites/:siteId/ai-logs` envelope — the worker returns
 * `{ data, meta }` where `meta.total` is the TRUE full-store count (respecting
 * the `kind` filter) and `has_more = data.length < total` (a cap, NOT offset
 * pagination — there is no `offset` param on this route).
 */
export interface AiLogsResponse {
  data: AiLogRowFixture[];
  meta: { limit: number; total: number; has_more: boolean };
}

/**
 * One FULL trace detail row — mirrors the detail route's `SELECT *` from
 * `ai_form_logs` (migrations 0013 + 0016 + 0026) AND the component's
 * `TraceDetail` interface. Extends the summary with the heavy text columns the
 * list omits (system prompt + input/output JSON + tool payloads) plus the
 * `org_id` / `site_id` / `explanation` bookkeeping columns a `SELECT *` carries.
 */
export interface AiLogDetailFixture extends AiLogRowFixture {
  org_id: string;
  site_id: string;
  prompt_template: string | null;
  input_json: string;
  output_text: string | null;
  output_json: string | null;
  tool_args_json: string | null;
  tool_result_json: string | null;
  /** The cached AI post-mortem (migration 0026) — null until first "Explain with AI". */
  explanation: string | null;
}

/** The `GET /api/sites/:siteId/ai-logs/:logId` envelope — the worker wraps the row in `{ data }`. */
export interface AiLogDetailResponse {
  data: AiLogDetailFixture;
}

/** Stable demo org/site ids used across the detail reconstruction. */
const DEMO_ORG_ID = 'org-mock-0001';
const DEMO_SITE_ID = 'site-001';

/** The default page cap the worker applies when no `?limit=` is sent. */
const DEFAULT_LIMIT = 200;

/** The full believable trace store, newest-first (worker orders `created_at DESC`). */
const ROWS: readonly AiLogRowFixture[] = buildRows();

/**
 * AI-logs LIST factory. Reads the request's `limit` + `kind` and returns the
 * matching newest-first SLICE plus the full-store `total`, exactly like the
 * worker's handler (a cap, not offset pagination). `empty` → `{ data: [],
 * meta: { total: 0 } }`; `populated` / `loading` / default → the 36-row store.
 * `error` is handled by the interceptor (it throws a 500 before this runs).
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 * @param query - Parsed query params (honors `limit` 1..1000 + optional `kind`).
 */
export const aiLogsFixture: FixtureFactory<AiLogsResponse> = (
  state: MockState,
  query: URLSearchParams,
): AiLogsResponse => {
  const all = state === 'empty' ? [] : ROWS;
  // Apply the optional `kind` filter the worker's `trace_kind = ?` branch does.
  const kind = query.get('kind');
  const filtered = kind ? all.filter((r) => r.trace_kind === kind) : all;
  const total = filtered.length;
  // Clamp limit to [1,1000] like the worker; default 200. The component sends
  // no limit, so the default returns the whole store in one page.
  const limit = clampInt(query.get('limit'), DEFAULT_LIMIT, 1, 1000);
  const slice = filtered.slice(0, limit);
  return {
    data: slice.map((r) => ({ ...r })),
    // has_more mirrors the worker EXACTLY: list.length < total (cap pagination).
    meta: { limit, total, has_more: slice.length < total },
  };
};

/**
 * AI-logs DETAIL factory (`GET /api/sites/:siteId/ai-logs/:logId`). Returns the
 * FULL `SELECT *` detail for a trace — the summary row enriched with the system
 * prompt, input/output JSON, and tool payloads the list projection omits.
 *
 * The interceptor strips the path before lookup and passes a factory only
 * `(state, query)` — the `:logId` segment is NOT available here (same as the
 * voice conversation-detail fixture). So this serves ONE canonical, fully
 * enriched trace (a rich `tool_call` with a system prompt, structured input,
 * and a tool dispatch — the most instructive expand to demo) for ANY id. Every
 * detail block in the panel renders real matching content; a demo deep-link
 * never 404s. The precise per-id reconstruction lives in {@link detailForId}
 * (exported for the spec + a future interceptor that forwards the path id).
 *
 * @param _state - The mock state knob (unused — a row you can expand always has a detail).
 * @param _query - Parsed query (unused — the id lives in the PATH, which the interceptor strips).
 */
export const aiLogDetailFixture: FixtureFactory<AiLogDetailResponse> = (): AiLogDetailResponse => ({
  data: detailForId(CANONICAL_DETAIL_ID),
});

/** The id whose detail the live factory serves (a rich tool_call — the best expand to demo). */
const CANONICAL_DETAIL_ID = 'trace-035';

/**
 * Build the FULL detail for a given trace id — exported so the spec (and a
 * future interceptor that forwards the path `:logId`) can resolve an explicit
 * id. Falls back to the newest row for a null/unknown id so a demo deep-link
 * always renders.
 */
export function detailForId(logId: string | null): AiLogDetailFixture {
  const base = (logId && ROWS.find((r) => r.id === logId)) || ROWS[0]!;
  return enrichDetail(base);
}

/**
 * Enrich a summary row into its full `SELECT *` detail — reconstructs the heavy
 * text columns the list omits in a way that's internally consistent with the
 * row's `trace_kind` / `tool_name` / `status`, so the expand panel's
 * system-prompt highlighter, JSON blocks, and tool code blocks all render real
 * matching content.
 */
function enrichDetail(row: AiLogRowFixture): AiLogDetailFixture {
  const promptByKind: Record<string, string> = {
    chat:
      'ROLE\nYou are the friendly front-desk assistant for Beverwyck Barber Co.\n\nGOAL\nAnswer visitor questions about hours, services, and pricing, and offer to book an appointment when there is intent.\n\nSAFETY\nNever invent prices or availability — defer to the booking tool. Keep replies under 60 words.',
    form_router:
      'ROLE\nYou route inbound contact-form submissions to the correct workflow.\n\nOUTPUT\nReturn JSON: { "intent": one of [booking, quote, general, spam], "confidence": 0..1, "route": string }.\n\nSAFETY\nFlag anything that looks like spam or abuse with intent="spam".',
    endpoint:
      'ROLE\nYou are a code-defined Function endpoint handler.\n\nINPUT\nA validated JSON request body.\n\nOUTPUT\nA JSON response matching the endpoint contract. Fail closed on any schema mismatch.',
    tool_call:
      'ROLE\nYou dispatch booking actions to the connected Google Calendar MCP.\n\nOUTPUT\nCall create_event with { summary, start, end, attendees }. Confirm back to the visitor with the booked time.',
    search:
      'ROLE\nYou expand a visitor search query into synonyms before matching the on-site index.\n\nOUTPUT\nReturn a ranked list of matching page slugs.',
  };

  const inputByKind: Record<string, Record<string, unknown>> = {
    chat: { messages: [{ role: 'user', content: 'Are you open right now and can I get a fade today?' }] },
    form_router: { name: 'Dana R.', email: 'dana@example.com', message: 'Can I book a beard trim for Saturday morning?' },
    endpoint: { query: 'availability', date: '2026-10-08' },
    tool_call: { summary: 'Fade — Thursday 3:00pm', start: '2026-10-08T15:00:00-04:00', end: '2026-10-08T15:30:00-04:00' },
    search: { q: 'kids haircut' },
  };

  const input = inputByKind[row.trace_kind] ?? { note: 'trace input' };
  const hasError = row.status === 'error';

  // Tool payloads only when the row is a tool dispatch.
  const toolArgs =
    row.tool_name != null
      ? JSON.stringify({ summary: 'Fade — Thursday 3:00pm', start: '2026-10-08T15:00:00-04:00', end: '2026-10-08T15:30:00-04:00', attendees: ['visitor@example.com'] })
      : null;
  const toolResult =
    row.tool_name != null
      ? row.tool_status === 'error'
        ? JSON.stringify({ ok: false, error: 'calendar_conflict', detail: 'That slot was just booked.' })
        : JSON.stringify({ ok: true, event_id: 'evt_9x12ab', html_link: 'https://calendar.google.com/event?eid=evt_9x12ab' })
      : null;

  // output_text for prose traces; output_json for structured (router/search) traces.
  const structured = row.trace_kind === 'form_router' || row.trace_kind === 'search';
  const outputJson = structured
    ? row.trace_kind === 'form_router'
      ? JSON.stringify({ intent: 'booking', confidence: 0.94, route: 'shop_calendar' })
      : JSON.stringify({ matches: ['/services/kids', '/pricing'] })
    : null;

  return {
    ...row,
    org_id: DEMO_ORG_ID,
    site_id: DEMO_SITE_ID,
    prompt_template: promptByKind[row.trace_kind] ?? null,
    input_json: JSON.stringify(input),
    output_text: hasError ? null : structured ? null : (row.output_preview ?? null),
    output_json: hasError ? null : outputJson,
    tool_args_json: toolArgs,
    tool_result_json: toolResult,
    explanation: null,
  };
}

/** Parse a query-param int with a default + clamp; non-numeric → the default. */
function clampInt(raw: string | null, dflt: number, min: number, max: number): number {
  const n = raw == null ? dflt : Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(n, min), max);
}

/**
 * Build the 36-row believable trace store (pure; deterministic). Rows are dated
 * backwards from `Date.now()` so relative time, the 24h chart window, and the
 * newest-first ordering all read as live. Spans the real `trace_kind`
 * vocabulary, three model vendors, realistic token/credit/latency telemetry, and
 * a realistic status spread (mostly ok, a few error/rate_limited/timeout).
 */
function buildRows(): AiLogRowFixture[] {
  // [kind, minutesAgo, model, status, latencyMs, tokIn, tokOut, credits, endpoint|null, tool|null, toolStatus|null, preview|null, error|null, submissionId|null]
  type Seed = [
    string,
    number,
    string,
    string,
    number | null,
    number | null,
    number | null,
    number | null,
    string | null,
    string | null,
    string | null,
    string | null,
    string | null,
    string | null,
  ];

  const LLAMA = '@cf/meta/llama-3.3-70b-instruct';
  const LLAMA_SMALL = '@cf/meta/llama-3.1-8b-instruct-fp8';
  const GPT4O = 'gpt-4o';
  const HAIKU = 'claude-haiku-4-5';
  const SONNET = 'claude-sonnet-4-6';

  const seeds: Seed[] = [
    // Newest first — a dense, varied observability timeline a real operator would recognize.
    ['chat', 3, HAIKU, 'ok', 742, 512, 118, 1, null, null, null, "We're open until 7pm today — I can book you a 3pm fade with Marcus if that works?", null, null],
    ['tool_call', 9, HAIKU, 'ok', 1203, 96, 22, 1, 'contact', 'google_calendar.create_event', 'ok', 'Created event "Fade — Thursday 3:00pm" on Beverwyck Bookings.', null, 'sub-014'],
    ['form_router', 9, LLAMA_SMALL, 'ok', 338, 310, 64, 1, 'contact', null, null, 'Classified: booking · routed to shop calendar · sender confirmation sent.', null, 'sub-014'],
    ['chat', 17, GPT4O, 'ok', 880, 640, 142, 1, null, null, null, 'A skin fade runs $35 and takes about 30 minutes. Want me to check this afternoon?', null, null],
    ['endpoint', 24, LLAMA, 'ok', 612, 420, 96, 1, 'availability', null, null, 'Returned 4 open slots for 2026-10-08.', null, null],
    ['chat', 31, HAIKU, 'rate_limited', null, 480, 0, 0, null, null, null, null, 'Workers AI rate limit hit — request queued and retried.', null],
    ['search', 38, LLAMA_SMALL, 'ok', 121, 48, 18, 1, null, null, null, 'Expanded "kids cut" → 6 synonyms; matched /services/kids.', null, null],
    ['tool_call', 52, SONNET, 'ok', 2140, 180, 44, 2, 'contact', 'resend.send_email', 'ok', 'Sent booking confirmation to dana@example.com.', null, 'sub-013'],
    ['form_router', 52, LLAMA_SMALL, 'ok', 294, 288, 58, 1, 'contact', null, null, 'Classified: quote · routed to owner inbox.', null, 'sub-013'],
    ['chat', 67, GPT4O, 'ok', 934, 712, 160, 1, null, null, null, "Yes — walk-ins are welcome after 4pm. Earlier slots need a booking, which I'm happy to set up.", null, null],
    ['endpoint', 74, LLAMA, 'error', 4210, 512, 0, 0, 'availability', null, null, null, 'Upstream calendar API returned 503 after 3 retries.', null],
    ['chat', 88, HAIKU, 'ok', 701, 496, 104, 1, null, null, null, 'We do straight-razor shaves on Fridays and Saturdays — $40, about 45 minutes.', null, null],
    ['tool_call', 96, HAIKU, 'error', 1890, 120, 30, 1, 'contact', 'google_calendar.create_event', 'error', null, 'Calendar conflict: the 3:00pm slot was booked moments earlier.', 'sub-012'],
    ['form_router', 96, LLAMA_SMALL, 'ok', 312, 301, 60, 1, 'contact', null, null, 'Classified: booking · confidence 0.91.', null, 'sub-012'],
    ['chat', 115, GPT4O, 'ok', 1020, 760, 172, 1, null, null, null, 'Marcus specializes in fades and beard sculpting; Dre is our senior stylist for classic cuts.', null, null],
    ['search', 128, LLAMA_SMALL, 'ok', 98, 40, 14, 1, null, null, null, 'Matched "gift card" → /shop/gift-cards.', null, null],
    ['chat', 141, HAIKU, 'timeout', null, 520, 0, 0, null, null, null, null, 'Generation exceeded the 20s ceiling and was aborted.', null],
    ['endpoint', 155, LLAMA, 'ok', 588, 400, 88, 1, 'pricing', null, null, 'Returned the current service price list (7 items).', null, null],
    ['chat', 171, SONNET, 'ok', 1760, 880, 210, 2, null, null, null, 'Absolutely — for a wedding party of 6 I can set up back-to-back slots. What date works?', null, null],
    ['tool_call', 188, HAIKU, 'ok', 1340, 104, 26, 1, 'contact', 'resend.send_email', 'ok', 'Sent catering-style group-booking quote to the owner.', null, 'sub-011'],
    ['form_router', 188, LLAMA_SMALL, 'ok', 276, 294, 55, 1, 'contact', null, null, 'Classified: general · routed to FAQ auto-reply.', null, 'sub-011'],
    ['chat', 204, GPT4O, 'ok', 812, 624, 138, 1, null, null, null, "We're closed Mondays. Tuesday–Saturday 9am–7pm, Sunday 10am–4pm.", null, null],
    ['search', 221, LLAMA_SMALL, 'ok', 110, 44, 16, 1, null, null, null, 'Matched "parking" → /visit#parking.', null, null],
    ['chat', 239, HAIKU, 'ok', 688, 472, 98, 1, null, null, null, 'Yes, we carry beard oil and pomade from our own line — $18 and $22.', null, null],
    ['endpoint', 258, LLAMA, 'ok', 640, 436, 92, 1, 'availability', null, null, 'Returned 2 open slots for 2026-10-09.', null, null],
    ['tool_call', 276, SONNET, 'ok', 2010, 168, 40, 2, 'contact', 'google_calendar.create_event', 'ok', 'Booked "Beard trim — Saturday 10:30am".', null, 'sub-010'],
    ['form_router', 276, LLAMA_SMALL, 'ok', 300, 286, 57, 1, 'contact', null, null, 'Classified: booking · routed to shop calendar.', null, 'sub-010'],
    ['chat', 295, GPT4O, 'rate_limited', null, 700, 0, 0, null, null, null, null, 'OpenAI rate limit (RPM) — backed off and retried after 2s.', null],
    ['chat', 314, HAIKU, 'ok', 754, 504, 112, 1, null, null, null, 'Gift cards start at $25 and can be bought online or in-shop.', null, null],
    ['search', 331, LLAMA_SMALL, 'ok', 102, 42, 15, 1, null, null, null, 'Matched "hours" → homepage hours block.', null, null],
    // A few rows older than 24h so the 24h chart window is a strict subset of the store.
    ['chat', 1600, GPT4O, 'ok', 905, 688, 150, 1, null, null, null, 'We can do a father-and-son cut together — two chairs side by side.', null, null],
    ['tool_call', 1740, HAIKU, 'ok', 1280, 100, 24, 1, 'contact', 'resend.send_email', 'ok', 'Sent a first-visit welcome email.', null, 'sub-009'],
    ['endpoint', 1900, LLAMA, 'error', 3980, 480, 0, 0, 'availability', null, null, null, 'Timeout reaching the booking provider (gateway 504).', null],
    ['form_router', 2050, LLAMA_SMALL, 'ok', 284, 290, 56, 1, 'contact', null, null, 'Classified: spam · dropped (promotional link detected).', null, 'sub-008'],
    ['chat', 2400, SONNET, 'ok', 1680, 840, 198, 2, null, null, null, 'For a bald fade I recommend booking with Marcus — he has the steadiest clipper work.', null, null],
    ['search', 2900, LLAMA_SMALL, 'ok', 95, 38, 13, 1, null, null, null, 'Matched "appointment" → /book.', null, null],
  ];

  return seeds.map((s, i) => {
    const [trace_kind, minutesAgo, model, status, latency_ms, tokens_input, tokens_output, credits_debited, endpoint_slug, tool_name, tool_status, output_preview, error_message, submission_id] = s;
    return {
      id: `trace-${String(seeds.length - i).padStart(3, '0')}`,
      submission_id,
      trace_kind,
      endpoint_slug,
      model,
      status,
      latency_ms,
      tokens_input,
      tokens_output,
      credits_debited,
      tool_name,
      tool_status,
      output_preview,
      error_message,
      created_at: new Date(Date.now() - minutesAgo * 60 * 1000).toISOString(),
    };
  });
}
