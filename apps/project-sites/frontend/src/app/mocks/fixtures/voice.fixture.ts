/**
 * @module mocks/fixtures/voice
 *
 * @description
 * Mock fixtures for the admin **Voice** section (`pages/admin/sections/voice/*`) — the
 * phone/SMS/browser-agent surface. The section is a 7-tab shell (Numbers · Conversations ·
 * Insights · Test Console · Agent · MCPs · Share); every tab self-fetches through
 * {@link import('../../services/api.service').ApiService}, so serving these fixtures lights
 * up the whole section on `?mock=1` with ZERO backend. Each factory is typed to the EXACT
 * worker wire shape, so wiring the real endpoint later is a provider SWAP, not a rewrite.
 *
 * **Flag-gating:** the section is NOT render-gated by a feature flag. Only the money-spending
 * `POST /api/voice/numbers/purchase` is gated on the `voice_numbers` killswitch (`voice.ts`);
 * every GET below (`requireSiteMembership` only) renders without any flag. So the demo needs
 * NO flag flip — the Voice tab renders fully on `?mock=1` as soon as a site is selected.
 *
 * | Registry key                    | Factory                              | Worker contract (traced)                                    |
 * | ------------------------------- | ------------------------------------ | ----------------------------------------------------------- |
 * | `GET /voice/insights`           | {@link voiceInsightsFixture}         | `{ data: VoiceInsights }` (`voice_insights.ts`)             |
 * | `GET /voice/numbers`            | {@link voiceNumbersFixture}          | `{ numbers: PurchasedNumber[] }` (`voice.ts:372` — NOT `{data}`) |
 * | `GET /voice/numbers/search`     | {@link voiceNumberSearchFixture}     | `{ numbers: NumberCandidate[]; total }` (`voice.ts:147`)    |
 * | `GET /voice/vanity-suggestions` | {@link voiceVanitySuggestionsFixture}| `{ data: VanitySuggestion[] }` (`suggestVanityWords`)       |
 * | `GET /voice/conversations`      | {@link voiceConversationsFixture}    | `{ items: RawRow[] }` (`voice.ts:494` — raw merged, NOT `{data}`) |
 * | `GET /voice/conversations/:id`  | {@link voiceConversationDetailFixture}| `{ data: Conversation }` (`voice.ts:568`)                  |
 * | `GET /voice/agent-settings`     | {@link voiceAgentSettingsFixture}    | `{ settings: D1 row \| null }` (`voice.ts:918`)             |
 * | `GET /voice/meta-prompt`        | {@link voiceMetaPromptFixture}       | `{ data: { text } }` (`voice.ts:46`)                        |
 * | `GET /voice/mcp-attachments`    | {@link voiceMcpAttachmentsFixture}   | `{ data: { voice[], sms[] } }` (`voice.ts:839`)             |
 * | `GET /mcp/connections`          | {@link voiceMcpConnectionsFixture}   | `{ data: McpConnection[] }` (`mcp_oauth.ts:543`)            |
 *
 * NOTE `GET /mcp/connections` is the ORG-WIDE connection list (`mcp_oauth.ts`), a DIFFERENT
 * route from the already-fixtured per-site `GET /sites/:id/mcp/connections` (`per-site.fixture.ts`,
 * `{ data: { providers, connections } }`) — not a duplicate.
 *
 * @remarks
 * - Believable data, not lorem: real-looking NJ phone numbers (NANP-valid `555-01xx`), a
 *   vanity hero number, call/SMS logs with ISO timestamps + durations + sentiment + outcomes,
 *   a transcript, and recognizable MCP providers. Enough variety that every column, badge,
 *   sentiment bar, and empty/populated branch renders with real texture.
 * - `state` variants: `empty` → the honest brand-new-site surface (no numbers, no calls, no
 *   agent configured, no attachments) that drives every tab's first-run empty state;
 *   `error` is handled by the interceptor (it throws a 500 before these run);
 *   `populated`/`loading`/default → the rich believable set.
 * - Per-site reads here are keyed by QUERY (`?siteId=`), which the interceptor strips before
 *   lookup — so these are static keys, not `:param` patterns. Only `GET /voice/conversations/:id`
 *   is a `:param` pattern (one body serves every demo conversation id).
 */
import type { FixtureFactory, MockState } from './index';

// ───────────────────────── GET /voice/insights ─────────────────────────

/** Org-scoped KPI aggregates over `voice_calls` (mirrors `voice_insights.ts`). */
export interface VoiceInsights {
  total_calls: number;
  by_direction: { inbound: number; outbound: number };
  avg_duration_seconds: number;
  sentiment_breakdown: {
    positive: number;
    neutral: number;
    negative: number;
    escalated_safety: number;
    flagged_scam: number;
  };
  total_cost_cents: number;
}

/** The `GET /api/voice/insights` envelope. */
export interface VoiceInsightsResponse {
  data: VoiceInsights;
}

/** All-zero aggregates — the honest "No calls yet" first-run surface. */
const EMPTY_INSIGHTS: VoiceInsights = {
  total_calls: 0,
  by_direction: { inbound: 0, outbound: 0 },
  avg_duration_seconds: 0,
  sentiment_breakdown: { positive: 0, neutral: 0, negative: 0, escalated_safety: 0, flagged_scam: 0 },
  total_cost_cents: 0,
};

/**
 * A believable, internally-consistent populated aggregate: inbound+outbound === total_calls,
 * the five sentiment buckets sum to total_calls (every call is scored), a realistic ~2:50
 * average, and a spend that reads as weeks of real traffic.
 */
const POPULATED_INSIGHTS: VoiceInsights = {
  total_calls: 128,
  by_direction: { inbound: 101, outbound: 27 },
  avg_duration_seconds: 170, // 2:50
  // 96 + 19 + 8 + 3 + 2 = 128
  sentiment_breakdown: { positive: 96, neutral: 19, negative: 8, escalated_safety: 3, flagged_scam: 2 },
  total_cost_cents: 2144, // $21.44 telephony + AI across all calls
};

/**
 * Insights factory. `empty` → all-zero aggregates (the "No calls yet" state);
 * `populated`/`loading`/default → the rich consistent set. `error` is handled by
 * the interceptor (throws a 500 before this runs).
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 */
export const voiceInsightsFixture: FixtureFactory<VoiceInsightsResponse> = (
  state: MockState,
): VoiceInsightsResponse => ({ data: state === 'empty' ? EMPTY_INSIGHTS : POPULATED_INSIGHTS });

// ───────────────────────── GET /voice/numbers ─────────────────────────

/** A purchased number — the `voice.ts` list projection (`{ numbers }`, cost in USD). */
export interface PurchasedNumberRow {
  id: string;
  phone_number: string;
  friendly_name?: string | null;
  vanity_display?: string | null;
  capabilities: { voice: boolean; sms: boolean; mms: boolean };
  monthly_cost_usd: number;
  purchased_at: string;
  status?: string;
}

/** The `GET /api/voice/numbers` envelope — the worker returns `{ numbers }`, NOT `{ data }`. */
export interface VoiceNumbersResponse {
  numbers: PurchasedNumberRow[];
}

/** A recent anchor so `purchased_at` reads as believable ISO timestamps. */
const ANCHOR = Date.parse('2026-10-06T13:00:00Z');
const iso = (hoursAgo: number): string => new Date(ANCHOR - hoursAgo * 3_600_000).toISOString();

/**
 * Two owned numbers (under the 3-cap, leaving a free slot to exercise the buy flow): a vanity
 * local number (the hero, voice+sms+mms) and a plain voice+sms line. Both NANP-valid 555-01xx.
 */
const PURCHASED_NUMBERS: readonly PurchasedNumberRow[] = [
  {
    id: 'vn-001',
    phone_number: '+19735550148',
    friendly_name: 'Main line',
    vanity_display: '(973) 555-01GB', // playful vanity rendering for the demo
    capabilities: { voice: true, sms: true, mms: true },
    monthly_cost_usd: 1.0,
    purchased_at: iso(720),
    status: 'active',
  },
  {
    id: 'vn-002',
    phone_number: '+12015550192',
    friendly_name: 'Text line',
    vanity_display: null,
    capabilities: { voice: true, sms: true, mms: false },
    monthly_cost_usd: 1.0,
    purchased_at: iso(300),
    status: 'active',
  },
];

/**
 * Numbers factory. `empty` → `[]` (the "No numbers yet" first-run + $0.00 spend);
 * `populated`/`loading`/default → the believable owned roster.
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 */
export const voiceNumbersFixture: FixtureFactory<VoiceNumbersResponse> = (
  state: MockState,
): VoiceNumbersResponse => ({ numbers: state === 'empty' ? [] : PURCHASED_NUMBERS.map((n) => ({ ...n })) });

// ───────────────────────── GET /voice/numbers/search ─────────────────────────

/** A search candidate — the annotated `searchAvailableNumbers` projection. */
export interface NumberCandidateRow {
  phone_number: string;
  locality?: string;
  region?: string;
  iso_country: string;
  capabilities: { voice: boolean; sms: boolean; mms: boolean };
  monthly_cost_usd: number;
  vanity_match?: string | null;
}

/** The `GET /api/voice/numbers/search` envelope — `{ numbers, total }`. */
export interface VoiceNumberSearchResponse {
  numbers: NumberCandidateRow[];
  total: number;
}

/** NJ localities keyed by area code so the fixture honors the `areaCode` query. */
const LOCALITY_BY_NPA: Readonly<Record<string, { locality: string; region: string }>> = {
  '973': { locality: 'Newark', region: 'NJ' },
  '201': { locality: 'Jersey City', region: 'NJ' },
  '908': { locality: 'Summit', region: 'NJ' },
  '732': { locality: 'Edison', region: 'NJ' },
};

/**
 * Build believable available candidates in the requested NPA (defaults to 973). Six lines per
 * search, NANP-valid `555-01xx`, each voice+sms (one mms). When a `contains` dial-word is a
 * known hero, one candidate is annotated with `vanity_match` so the vanity chip renders.
 */
function buildCandidates(areaCode: string, contains: string | null): NumberCandidateRow[] {
  const npa = /^\d{3}$/.test(areaCode) ? areaCode : '973';
  const loc = LOCALITY_BY_NPA[npa] ?? { locality: 'Newark', region: 'NJ' };
  const lines = ['0110', '0127', '0134', '0155', '0168', '0183'];
  return lines.map((suffix, i) => ({
    phone_number: `+1${npa}555${suffix}`,
    locality: loc.locality,
    region: loc.region,
    iso_country: 'US',
    capabilities: { voice: true, sms: true, mms: i === 0 },
    monthly_cost_usd: 1.0,
    // Annotate the first candidate when a vanity word was asked for (believable dial-word match).
    vanity_match: contains && /[A-Za-z]/.test(contains) && i === 0 ? `(${npa}) 555-0110` : null,
  }));
}

/**
 * Number-search factory. `empty` → no candidates (the honest "no matches" surface);
 * `populated`/`loading`/default → six believable candidates in the queried NPA.
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 * @param query - Parsed query params (honors `areaCode` + `contains`).
 */
export const voiceNumberSearchFixture: FixtureFactory<VoiceNumberSearchResponse> = (
  state: MockState,
  query: URLSearchParams,
): VoiceNumberSearchResponse => {
  if (state === 'empty') return { numbers: [], total: 0 };
  const numbers = buildCandidates(query.get('areaCode') ?? '973', query.get('contains'));
  return { numbers, total: numbers.length };
};

// ───────────────────────── GET /voice/vanity-suggestions ─────────────────────────

/** An AI-suggested vanity dial-word (mirrors `suggestVanityWords`). */
export interface VanitySuggestionRow {
  word: string;
  digits: string;
  rationale: string;
  score: number;
}

/** The `GET /api/voice/vanity-suggestions` envelope. */
export interface VoiceVanitySuggestionsResponse {
  data: VanitySuggestionRow[];
}

/** Believable vanity suggestions for a local-services business (keypad-correct digits). */
const VANITY_SUGGESTIONS: readonly VanitySuggestionRow[] = [
  { word: 'BARBER', digits: '227237', rationale: 'Says exactly what you do — instantly memorable for walk-ins.', score: 94 },
  { word: 'FADES', digits: '32337', rationale: 'Short, punchy, and on-brand for a modern cuts shop.', score: 88 },
  { word: 'GROOM', digits: '47666', rationale: 'Broad grooming appeal; easy to say on radio or a van wrap.', score: 82 },
  { word: 'SHARP', digits: '74277', rationale: 'Confident, premium feel that reads well on signage.', score: 79 },
  { word: 'STYLE', digits: '78953', rationale: 'Works for cuts, color, and shaves alike.', score: 74 },
];

/**
 * Vanity-suggestions factory. `empty` → `[]` (none yet); `populated`/`loading`/default →
 * five believable dial-word suggestions. `error` is handled by the interceptor.
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 */
export const voiceVanitySuggestionsFixture: FixtureFactory<VoiceVanitySuggestionsResponse> = (
  state: MockState,
): VoiceVanitySuggestionsResponse => ({ data: state === 'empty' ? [] : VANITY_SUGGESTIONS.map((s) => ({ ...s })) });

// ───────────────────────── GET /voice/conversations ─────────────────────────

/**
 * The `GET /api/voice/conversations` envelope — `{ items }` of RAW merged `voice_calls` +
 * `voice_messages` rows (aliased to a common `{ kind, event_at }` for merge-sort), NOT `{ data }`.
 * Typed loosely as the component maps `Record<string, unknown>` rows via `mapConversation`.
 */
export interface VoiceConversationsResponse {
  items: Array<Record<string, unknown>>;
}

/**
 * Build the believable merged feed — a mix of calls + SMS, newest-first, spanning both
 * sentiments, an escalated row, a flagged-scam row, recorded + unrecorded calls, and inbound +
 * outbound. Dated backwards from the anchor so the "This week" strip + day-grouping light up.
 */
function buildConversationItems(): Array<Record<string, unknown>> {
  const BUSINESS = '+19735550148'; // the owned main line
  // [kind, hoursAgo, direction, counterpart, status, sentiment, duration|null, bodyOrSummary]
  type Seed = [
    'call' | 'sms',
    number,
    'inbound' | 'outbound',
    string,
    string,
    string | null,
    number | null,
    string,
  ];
  const seeds: Seed[] = [
    ['call', 2, 'inbound', '+19735550231', 'completed', 'positive', 214, 'Booked a 3pm fade for Thursday; confirmed by text.'],
    ['sms', 5, 'inbound', '+12015550144', 'completed', 'positive', null, 'Do you take walk-ins on Saturdays?'],
    ['call', 9, 'inbound', '+19085550198', 'escalated', 'negative', 96, 'Caller upset about a wait time — escalated to the owner.'],
    ['call', 20, 'outbound', '+17325550176', 'completed', 'neutral', 132, 'Returned a missed call; left a voicemail with hours.'],
    ['sms', 27, 'inbound', '+19735550277', 'completed', 'neutral', null, 'What time do you close today?'],
    ['call', 31, 'inbound', '+12015550113', 'missed', null, null, 'Missed call — no voicemail left.'],
    ['call', 46, 'inbound', '+18005550000', 'completed', 'flagged_scam', 41, 'Likely robocall about an extended warranty — flagged.'],
    ['sms', 52, 'outbound', '+19085550162', 'completed', 'positive', null, 'Your appointment is confirmed for 10am — see you then!'],
    ['call', 70, 'inbound', '+17325550129', 'completed', 'positive', 188, 'New client asked about beard trims and pricing.'],
    ['sms', 96, 'inbound', '+19735550154', 'completed', 'negative', null, 'I need to cancel my 2pm, something came up.'],
    ['call', 140, 'inbound', '+12015550187', 'completed', 'neutral', 77, 'Asked for directions and parking info.'],
    ['sms', 190, 'inbound', '+19085550145', 'completed', 'positive', null, 'Thanks, the cut was great! See you next month.'],
  ];
  return seeds.map(([kind, hoursAgo, direction, counterpart, status, sentiment, duration, text], i) => {
    const inbound = direction === 'inbound';
    const base: Record<string, unknown> = {
      id: `conv-${String(i + 1).padStart(3, '0')}`,
      kind,
      voice_number_id: 'vn-001',
      direction,
      from_number: inbound ? counterpart : BUSINESS,
      to_number: inbound ? BUSINESS : counterpart,
      status,
      event_at: iso(hoursAgo),
    };
    if (kind === 'call') {
      return {
        ...base,
        ended_at: duration ? iso(hoursAgo - duration / 3600) : null,
        duration_seconds: duration,
        sentiment,
        summary: text,
        twilio_call_sid: `CA${(0x9a10 + i * 733).toString(16)}demo`,
      };
    }
    return {
      ...base,
      sentiment,
      body: text,
      ai_reply_id: direction === 'outbound' ? `air-${i}` : null,
      twilio_message_sid: `SM${(0x7b20 + i * 911).toString(16)}demo`,
    };
  });
}

const CONVERSATION_ITEMS: readonly Record<string, unknown>[] = buildConversationItems();

/**
 * Conversations-list factory. `empty` → `[]` (the honest "No conversations yet" feed);
 * `populated`/`loading`/default → the rich merged feed. `error` is handled by the interceptor.
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 */
export const voiceConversationsFixture: FixtureFactory<VoiceConversationsResponse> = (
  state: MockState,
): VoiceConversationsResponse => ({ items: state === 'empty' ? [] : CONVERSATION_ITEMS.map((r) => ({ ...r })) });

// ───────────────────────── GET /voice/conversations/:id ─────────────────────────

/** One transcript turn — the parsed `{ speaker, text, t_ms }` the detail pane renders. */
export interface TranscriptTurnRow {
  speaker: 'caller' | 'agent';
  text: string;
  t_ms: number;
}

/** A full conversation detail (the `voice.ts:568` `{ data }` projection for a call). */
export interface ConversationDetail {
  id: string;
  channel: 'call' | 'sms';
  from_number: string;
  to_number: string;
  started_at: string;
  duration_s?: number;
  status: string;
  sentiment?: string;
  summary?: string;
  transcript?: TranscriptTurnRow[];
  has_recording?: boolean;
  has_video?: boolean;
  message_preview?: string;
}

/** The `GET /api/voice/conversations/:id` envelope. */
export interface VoiceConversationDetailResponse {
  data: ConversationDetail;
}

/** A believable agent↔caller transcript for the populated detail pane. */
const DETAIL_TRANSCRIPT: readonly TranscriptTurnRow[] = [
  { speaker: 'agent', text: "Thanks for calling Beverwyck Barber Co. — this is the front desk, how can I help?", t_ms: 0 },
  { speaker: 'caller', text: "Hi, do you have anything open for a fade this Thursday afternoon?", t_ms: 4200 },
  { speaker: 'agent', text: "We do — I can offer 3:00pm or 4:15pm with Marcus. Which works better?", t_ms: 9800 },
  { speaker: 'caller', text: "3 o'clock is perfect.", t_ms: 15200 },
  { speaker: 'agent', text: "Booked you for Thursday at 3:00pm with Marcus. I'll text a confirmation now. Anything else?", t_ms: 18600 },
  { speaker: 'caller', text: "That's it, thank you!", t_ms: 24100 },
];

/**
 * Conversation-detail factory. Served under a `:param` pattern, so ONE body answers every
 * demo conversation id. `empty` → a minimal valid conversation with no transcript (never
 * crashes the pane); `populated`/`loading`/default → a rich recorded call with a transcript.
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 */
export const voiceConversationDetailFixture: FixtureFactory<VoiceConversationDetailResponse> = (
  state: MockState,
): VoiceConversationDetailResponse => {
  if (state === 'empty') {
    return {
      data: {
        id: 'conv-000',
        channel: 'call',
        from_number: '+19735550231',
        to_number: '+19735550148',
        started_at: iso(2),
        status: 'completed',
        transcript: [],
        has_recording: false,
        has_video: false,
      },
    };
  }
  return {
    data: {
      id: 'conv-001',
      channel: 'call',
      from_number: '+19735550231',
      to_number: '+19735550148',
      started_at: iso(2),
      duration_s: 214,
      status: 'completed',
      sentiment: 'positive',
      summary: 'Booked a 3pm fade for Thursday; confirmed by text.',
      transcript: DETAIL_TRANSCRIPT.map((t) => ({ ...t })),
      has_recording: true,
      has_video: false,
    },
  };
};

// ───────────────────────── GET /voice/agent-settings ─────────────────────────

/** The `GET /api/voice/agent-settings` envelope — a raw D1 row (or null for a fresh site). */
export interface VoiceAgentSettingsResponse {
  settings: Record<string, unknown> | null;
}

/**
 * A believable raw `voice_agent_settings` row — boolean columns as INTEGER 0/1 and
 * `business_hours_json` as a STRING (exactly what the component's `mapVoiceRowToSettings`
 * coerces + parses). Prompts read as real operator-tuned personas.
 */
const AGENT_SETTINGS_ROW: Record<string, unknown> = {
  id: 'vas-001',
  site_id: 'site-001',
  voice_system_prompt:
    "You are the friendly front-desk voice for Beverwyck Barber Co. Greet callers warmly, " +
    "answer questions about services, hours, and pricing, and offer to book an appointment. " +
    "If a caller is upset or asks for a refund, escalate to the owner. Keep replies short and natural.",
  sms_system_prompt:
    "You are the SMS assistant for Beverwyck Barber Co. Reply concisely, confirm appointments, " +
    "and share hours or directions when asked. Never share another customer's details.",
  voice_voice_id: 'aura-asteria-en',
  voice_model: 'claude-haiku-4-5',
  sms_model: 'claude-haiku-4-5',
  max_call_seconds: 600,
  recording_enabled: 1,
  video_browse_enabled: 0,
  escalation_phone: '+19735550100',
  business_hours_json: JSON.stringify({ start: '09:00', end: '19:00', tz: 'America/New_York' }),
  mcp_connection_ids: JSON.stringify(['mcp-cal-01', 'mcp-stripe-02']),
  mcp_sms_connection_ids: JSON.stringify(['mcp-cal-01']),
  knowledge_base_urls: null,
  created_at: iso(720),
  updated_at: iso(48),
};

/**
 * Agent-settings factory. `empty` → `{ settings: null }` (a fresh site → the "Configure your
 * voice agent" launchpad); `populated`/`loading`/default → a believable configured row.
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 */
export const voiceAgentSettingsFixture: FixtureFactory<VoiceAgentSettingsResponse> = (
  state: MockState,
): VoiceAgentSettingsResponse => ({ settings: state === 'empty' ? null : { ...AGENT_SETTINGS_ROW } });

// ───────────────────────── GET /voice/meta-prompt ─────────────────────────

/** The `GET /api/voice/meta-prompt` envelope — the immutable safety meta-prompt text. */
export interface VoiceMetaPromptResponse {
  data: { text: string };
}

/**
 * The read-only safety meta-prompt the agent-settings tab renders as "Immutable safety
 * meta-prompt". Constant across states (it's a worker constant, not per-site data).
 */
const META_PROMPT_TEXT = [
  'SAFETY META-PROMPT (non-negotiable — overrides every other instruction):',
  '1. Never provide medical, legal, or financial advice beyond this business’s services.',
  '2. Never collect or repeat full card numbers, SSNs, or passwords.',
  '3. If a caller is in danger or mentions self-harm, provide 911 and end gracefully.',
  '4. Escalate to a human when the caller is angry, asks for a manager, or requests a refund.',
  '5. Only discuss {{BUSINESS_NAME}} in {{BUSINESS_LOCATION}} — decline unrelated requests.',
  '6. Never promise pricing or availability you cannot confirm from the booking tools.',
  '7. Stay polite and concise; one question at a time.',
  '8. Do not impersonate a specific named employee unless configured to.',
  '9. Respect do-not-call and opt-out requests immediately.',
  '10. If unsure, offer to take a message rather than guess.',
].join('\n');

/**
 * Meta-prompt factory. Returns the constant safety meta-prompt regardless of state (there is
 * no per-site or empty variant — it's a fixed worker constant).
 */
export const voiceMetaPromptFixture: FixtureFactory<VoiceMetaPromptResponse> = (): VoiceMetaPromptResponse => ({
  data: { text: META_PROMPT_TEXT },
});

// ───────────────────────── GET /voice/mcp-attachments ─────────────────────────

/** The `GET /api/voice/mcp-attachments` envelope — per-channel attached connection ids. */
export interface VoiceMcpAttachmentsResponse {
  data: { voice: string[]; sms: string[] };
}

/**
 * MCP-attachments factory. `empty` → both channels empty (nothing attached yet);
 * `populated`/`loading`/default → ids that resolve into {@link voiceMcpConnectionsFixture}
 * (voice can call booking + payments; sms can call booking only).
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 */
export const voiceMcpAttachmentsFixture: FixtureFactory<VoiceMcpAttachmentsResponse> = (
  state: MockState,
): VoiceMcpAttachmentsResponse =>
  state === 'empty'
    ? { data: { voice: [], sms: [] } }
    : { data: { voice: ['mcp-cal-01', 'mcp-stripe-02'], sms: ['mcp-cal-01'] } };

// ───────────────────────── GET /mcp/connections ─────────────────────────

/** One MCP connection — the org-wide `mcp_oauth.ts` safe-column projection. */
export interface McpConnectionRow {
  id: string;
  site_id: string | null;
  provider: string;
  display_name: string;
  status: string;
  scopes: string[];
  token_expires_at: string | null;
  connected_at: string;
  updated_at: string;
}

/** The `GET /api/mcp/connections` envelope — the org's connections under `{ data }`. */
export interface VoiceMcpConnectionsResponse {
  data: McpConnectionRow[];
}

/**
 * Believable connected integrations for the demo org, newest-first (mirrors `connected_at DESC`).
 * Spans recognizable providers the MCP attach grid colors (Google Calendar · Stripe · Mailchimp ·
 * Slack), so the voice/sms attach toggles render a real-looking tool shelf.
 */
const MCP_CONNECTIONS: readonly McpConnectionRow[] = [
  {
    id: 'mcp-cal-01',
    site_id: 'site-001',
    provider: 'gcal',
    display_name: 'Beverwyck Bookings (Google Calendar)',
    status: 'connected',
    scopes: ['calendar.events'],
    token_expires_at: iso(-168), // valid ~1 week out
    connected_at: iso(240),
    updated_at: iso(48),
  },
  {
    id: 'mcp-stripe-02',
    site_id: 'site-001',
    provider: 'stripe',
    display_name: 'Beverwyck Payments (Stripe)',
    status: 'connected',
    scopes: ['read_write'],
    token_expires_at: null,
    connected_at: iso(360),
    updated_at: iso(72),
  },
  {
    id: 'mcp-mc-03',
    site_id: 'site-001',
    provider: 'mailchimp',
    display_name: 'Client Nurture List (Mailchimp)',
    status: 'connected',
    scopes: ['audiences.write'],
    token_expires_at: null,
    connected_at: iso(500),
    updated_at: iso(120),
  },
  {
    id: 'mcp-slack-04',
    site_id: 'site-001',
    provider: 'slack',
    display_name: 'Shop Floor Alerts (Slack)',
    status: 'connected',
    scopes: ['chat:write'],
    token_expires_at: null,
    connected_at: iso(600),
    updated_at: iso(200),
  },
];

/**
 * Org MCP-connections factory. `empty` → `[]` (no connections → the "Add new MCP" empty state);
 * `populated`/`loading`/default → the believable connected roster. `error` is handled by the
 * interceptor. NOTE this is the ORG-WIDE list route (`mcp_oauth.ts`), distinct from the per-site
 * `GET /sites/:id/mcp/connections` fixtured in `per-site.fixture.ts`.
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 */
export const voiceMcpConnectionsFixture: FixtureFactory<VoiceMcpConnectionsResponse> = (
  state: MockState,
): VoiceMcpConnectionsResponse => ({ data: state === 'empty' ? [] : MCP_CONNECTIONS.map((c) => ({ ...c })) });
