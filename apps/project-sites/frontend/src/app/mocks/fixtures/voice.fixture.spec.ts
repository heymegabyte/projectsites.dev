import {
  voiceInsightsFixture,
  voiceNumbersFixture,
  voiceNumberSearchFixture,
  voiceVanitySuggestionsFixture,
  voiceConversationsFixture,
  voiceConversationDetailFixture,
  voiceAgentSettingsFixture,
  voiceMetaPromptFixture,
  voiceMcpAttachmentsFixture,
  voiceMcpConnectionsFixture,
  type VoiceInsightsResponse,
  type VoiceNumbersResponse,
  type VoiceNumberSearchResponse,
  type VoiceVanitySuggestionsResponse,
  type VoiceConversationsResponse,
  type VoiceConversationDetailResponse,
  type VoiceAgentSettingsResponse,
  type VoiceMetaPromptResponse,
  type VoiceMcpAttachmentsResponse,
  type VoiceMcpConnectionsResponse,
} from './voice.fixture';
import { toRegistryKey, FIXTURES } from './index';

/**
 * voice.fixture — mock bodies for every GET the admin Voice section fires
 * (`pages/admin/sections/voice/*`). Each factory is typed to the EXACT worker
 * wire shape traced to `src/routes/voice.ts` + `src/routes/voice_insights.ts` +
 * `src/routes/mcp_oauth.ts` (`GET /api/mcp/connections`), so wiring the real
 * endpoint later is a provider SWAP, not a rewrite.
 *
 * This spec tests every factory DIRECTLY — envelope shape, believable data, and
 * each state variant (`empty` → honest first-run, `populated`/`loading` → rich).
 */
function q(search = ''): URLSearchParams {
  return new URLSearchParams(search);
}

describe('voiceInsightsFixture (GET /voice/insights → { data })', () => {
  it('returns the worker envelope { data: VoiceInsights }', () => {
    const res: VoiceInsightsResponse = voiceInsightsFixture('populated', q());
    expect(typeof res.data.total_calls).toBe('number');
    expect(typeof res.data.by_direction.inbound).toBe('number');
    expect(typeof res.data.by_direction.outbound).toBe('number');
    expect(typeof res.data.avg_duration_seconds).toBe('number');
    expect(typeof res.data.total_cost_cents).toBe('number');
    for (const k of ['positive', 'neutral', 'negative', 'escalated_safety', 'flagged_scam'] as const) {
      expect(typeof res.data.sentiment_breakdown[k]).toBe('number');
    }
  });

  it('populated is internally consistent: inbound+outbound === total_calls', () => {
    const { data } = voiceInsightsFixture('populated', q());
    expect(data.by_direction.inbound + data.by_direction.outbound).toBe(data.total_calls);
    expect(data.total_calls).toBeGreaterThan(0);
  });

  it('populated sentiment buckets sum to total_calls (every call is scored)', () => {
    const s = voiceInsightsFixture('populated', q()).data.sentiment_breakdown;
    const sum = s.positive + s.neutral + s.negative + s.escalated_safety + s.flagged_scam;
    expect(sum).toBe(voiceInsightsFixture('populated', q()).data.total_calls);
  });

  it('empty → all-zero aggregates (the honest "No calls yet" first-run surface)', () => {
    const { data } = voiceInsightsFixture('empty', q());
    expect(data.total_calls).toBe(0);
    expect(data.by_direction).toEqual({ inbound: 0, outbound: 0 });
    expect(data.total_cost_cents).toBe(0);
    expect(data.sentiment_breakdown).toEqual({
      positive: 0,
      neutral: 0,
      negative: 0,
      escalated_safety: 0,
      flagged_scam: 0,
    });
  });

  it('loading serves the populated body (interceptor owns the delay)', () => {
    expect(voiceInsightsFixture('loading', q()).data.total_calls).toBe(
      voiceInsightsFixture('populated', q()).data.total_calls,
    );
  });
});

describe('voiceNumbersFixture (GET /voice/numbers → { numbers })', () => {
  it('returns { numbers: [...] } — NOT { data } (matches voice.ts:372)', () => {
    const res: VoiceNumbersResponse = voiceNumbersFixture('populated', q());
    expect(Array.isArray(res.numbers)).toBe(true);
    expect((res as unknown as { data?: unknown }).data).toBeUndefined();
  });

  it('each row matches the PurchasedNumber contract (capabilities object + usd cost)', () => {
    for (const n of voiceNumbersFixture('populated', q()).numbers) {
      expect(typeof n.id).toBe('string');
      expect(typeof n.phone_number).toBe('string');
      expect(n.phone_number.startsWith('+1')).toBe(true);
      expect(typeof n.capabilities.voice).toBe('boolean');
      expect(typeof n.capabilities.sms).toBe('boolean');
      expect(typeof n.capabilities.mms).toBe('boolean');
      expect(typeof n.monthly_cost_usd).toBe('number');
      expect(typeof n.purchased_at).toBe('string');
    }
  });

  it('populated holds 1..3 numbers (respects the per-site cap of 3)', () => {
    const len = voiceNumbersFixture('populated', q()).numbers.length;
    expect(len).toBeGreaterThanOrEqual(1);
    expect(len).toBeLessThanOrEqual(3);
  });

  it('populated includes a vanity-display number (the hero number)', () => {
    expect(voiceNumbersFixture('populated', q()).numbers.some((n) => !!n.vanity_display)).toBe(true);
  });

  it('empty → [] (the "No numbers yet" first-run state + $0.00 spend)', () => {
    expect(voiceNumbersFixture('empty', q()).numbers).toEqual([]);
  });
});

describe('voiceNumberSearchFixture (GET /voice/numbers/search → { numbers, total })', () => {
  it('returns { numbers, total } with total === numbers.length', () => {
    const res: VoiceNumberSearchResponse = voiceNumberSearchFixture('populated', q('areaCode=973'));
    expect(Array.isArray(res.numbers)).toBe(true);
    expect(res.total).toBe(res.numbers.length);
    expect(res.numbers.length).toBeGreaterThan(0);
  });

  it('each candidate matches NumberCandidate (iso_country + capabilities + usd cost)', () => {
    for (const n of voiceNumberSearchFixture('populated', q()).numbers) {
      expect(n.phone_number.startsWith('+1')).toBe(true);
      expect(n.iso_country).toBe('US');
      expect(typeof n.capabilities.voice).toBe('boolean');
      expect(typeof n.monthly_cost_usd).toBe('number');
    }
  });

  it('honors areaCode — every candidate dials within the requested NPA', () => {
    const res = voiceNumberSearchFixture('populated', q('areaCode=201'));
    expect(res.numbers.length).toBeGreaterThan(0);
    for (const n of res.numbers) {
      expect(n.phone_number.startsWith('+1201')).toBe(true);
    }
  });

  it('annotates vanity_match when a contains word is a dial-word', () => {
    const res = voiceNumberSearchFixture('populated', q('contains=BLOOMS'));
    expect(res.numbers.some((n) => !!n.vanity_match)).toBe(true);
  });

  it('empty → no candidates (the honest "no matches" surface)', () => {
    const res = voiceNumberSearchFixture('empty', q('areaCode=973'));
    expect(res.numbers).toEqual([]);
    expect(res.total).toBe(0);
  });
});

describe('voiceVanitySuggestionsFixture (GET /voice/vanity-suggestions → { data })', () => {
  it('returns { data: VanitySuggestion[] } with believable word/digits/score', () => {
    const res: VoiceVanitySuggestionsResponse = voiceVanitySuggestionsFixture('populated', q());
    expect(Array.isArray(res.data)).toBe(true);
    expect(res.data.length).toBeGreaterThan(0);
    for (const s of res.data) {
      expect(typeof s.word).toBe('string');
      expect(/^\d+$/.test(s.digits)).toBe(true);
      expect(typeof s.rationale).toBe('string');
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(100);
    }
  });

  it('empty → [] (no suggestions yet)', () => {
    expect(voiceVanitySuggestionsFixture('empty', q()).data).toEqual([]);
  });
});

describe('voiceConversationsFixture (GET /voice/conversations → { items })', () => {
  it('returns { items: [...] } of RAW merged rows (NOT { data })', () => {
    const res: VoiceConversationsResponse = voiceConversationsFixture('populated', q());
    expect(Array.isArray(res.items)).toBe(true);
    expect((res as unknown as { data?: unknown }).data).toBeUndefined();
    expect(res.items.length).toBeGreaterThanOrEqual(8);
  });

  it('each row carries the merge-sort aliases the mapper reads (kind + event_at + id)', () => {
    for (const r of voiceConversationsFixture('populated', q()).items) {
      expect(r['kind'] === 'call' || r['kind'] === 'sms').toBe(true);
      expect(typeof r['event_at']).toBe('string');
      expect(typeof r['id']).toBe('string');
      expect(typeof r['from_number']).toBe('string');
    }
  });

  it('is ordered newest-first by event_at (mirrors the worker merge-sort)', () => {
    const items = voiceConversationsFixture('populated', q()).items;
    for (let i = 1; i < items.length; i++) {
      const prev = String(items[i - 1]!['event_at']);
      const cur = String(items[i]!['event_at']);
      expect(prev.localeCompare(cur)).toBeGreaterThanOrEqual(0);
    }
  });

  it('has a realistic mix: both channels, an escalated row, both sentiments, a recorded call', () => {
    const items = voiceConversationsFixture('populated', q());
    expect(items.items.some((r) => r['kind'] === 'call')).toBe(true);
    expect(items.items.some((r) => r['kind'] === 'sms')).toBe(true);
    expect(items.items.some((r) => r['status'] === 'escalated')).toBe(true);
    expect(items.items.some((r) => r['sentiment'] === 'positive')).toBe(true);
    expect(items.items.some((r) => r['sentiment'] === 'negative')).toBe(true);
    expect(items.items.some((r) => r['kind'] === 'call' && typeof r['duration_seconds'] === 'number')).toBe(true);
  });

  it('empty → [] (the honest "No conversations yet" first-run feed)', () => {
    expect(voiceConversationsFixture('empty', q()).items).toEqual([]);
  });
});

describe('voiceConversationDetailFixture (GET /voice/conversations/:id → { data })', () => {
  it('returns { data: Conversation } with a parsed transcript (caller|agent turns)', () => {
    const res: VoiceConversationDetailResponse = voiceConversationDetailFixture('populated', q());
    expect(res.data.channel).toBe('call');
    expect(Array.isArray(res.data.transcript)).toBe(true);
    expect(res.data.transcript!.length).toBeGreaterThan(0);
    for (const t of res.data.transcript!) {
      expect(t.speaker === 'caller' || t.speaker === 'agent').toBe(true);
      expect(typeof t.text).toBe('string');
      expect(typeof t.t_ms).toBe('number');
    }
  });

  it('the populated detail reports a recording so the audio player renders', () => {
    expect(voiceConversationDetailFixture('populated', q()).data.has_recording).toBe(true);
  });

  it('empty → a minimal valid conversation (no transcript) — never crashes the pane', () => {
    const { data } = voiceConversationDetailFixture('empty', q());
    expect(typeof data.id).toBe('string');
    expect(data.transcript ?? []).toEqual([]);
  });
});

describe('voiceAgentSettingsFixture (GET /voice/agent-settings → { settings })', () => {
  it('returns { settings: row } — a raw voice_agent_settings D1 row', () => {
    const res: VoiceAgentSettingsResponse = voiceAgentSettingsFixture('populated', q());
    expect(res.settings).not.toBeNull();
    const row = res.settings!;
    expect(typeof row['voice_system_prompt']).toBe('string');
    expect(typeof row['sms_system_prompt']).toBe('string');
    // boolean columns are INTEGER 0/1 (the mapper coerces 0/1 → boolean)
    expect(row['recording_enabled'] === 0 || row['recording_enabled'] === 1).toBe(true);
    expect(row['video_browse_enabled'] === 0 || row['video_browse_enabled'] === 1).toBe(true);
    // business_hours_json is a STRING column (parsed by the mapper) or null
    expect(row['business_hours_json'] === null || typeof row['business_hours_json'] === 'string').toBe(true);
  });

  it('empty → { settings: null } (a fresh site → the "Configure your voice agent" launchpad)', () => {
    expect(voiceAgentSettingsFixture('empty', q()).settings).toBeNull();
  });
});

describe('voiceMetaPromptFixture (GET /voice/meta-prompt → { data: { text } })', () => {
  it('returns the immutable safety meta-prompt text (constant across states)', () => {
    const res: VoiceMetaPromptResponse = voiceMetaPromptFixture('populated', q());
    expect(typeof res.data.text).toBe('string');
    expect(res.data.text.length).toBeGreaterThan(50);
    expect(voiceMetaPromptFixture('empty', q()).data.text).toBe(res.data.text);
  });
});

describe('voiceMcpAttachmentsFixture (GET /voice/mcp-attachments → { data: {voice,sms} })', () => {
  it('returns { data: { voice: string[]; sms: string[] } }', () => {
    const res: VoiceMcpAttachmentsResponse = voiceMcpAttachmentsFixture('populated', q());
    expect(Array.isArray(res.data.voice)).toBe(true);
    expect(Array.isArray(res.data.sms)).toBe(true);
  });

  it('populated attaches at least one connection to each channel', () => {
    const { data } = voiceMcpAttachmentsFixture('populated', q());
    expect(data.voice.length).toBeGreaterThan(0);
    expect(data.sms.length).toBeGreaterThan(0);
  });

  it('every attached id resolves to a connection id in the mcp-connections fixture', () => {
    const atts = voiceMcpAttachmentsFixture('populated', q()).data;
    const ids = new Set(voiceMcpConnectionsFixture('populated', q()).data.map((c) => c.id));
    for (const id of [...atts.voice, ...atts.sms]) expect(ids.has(id)).toBe(true);
  });

  it('empty → both channels empty (no attachments configured yet)', () => {
    expect(voiceMcpAttachmentsFixture('empty', q()).data).toEqual({ voice: [], sms: [] });
  });
});

describe('voiceMcpConnectionsFixture (GET /mcp/connections → { data: McpConnection[] })', () => {
  it('returns { data: McpConnection[] } with id/provider/display_name/status/connected_at', () => {
    const res: VoiceMcpConnectionsResponse = voiceMcpConnectionsFixture('populated', q());
    expect(Array.isArray(res.data)).toBe(true);
    expect(res.data.length).toBeGreaterThan(0);
    for (const c of res.data) {
      expect(typeof c.id).toBe('string');
      expect(typeof c.provider).toBe('string');
      expect(typeof c.display_name).toBe('string');
      expect(typeof c.status).toBe('string');
      expect(typeof c.connected_at).toBe('string');
    }
  });

  it('spans recognizable providers so the MCP attach grid renders real logos', () => {
    const providers = new Set(voiceMcpConnectionsFixture('populated', q()).data.map((c) => c.provider));
    expect(providers.size).toBeGreaterThanOrEqual(3);
  });

  it('empty → [] (no connections yet → the "Add new MCP" empty state)', () => {
    expect(voiceMcpConnectionsFixture('empty', q()).data).toEqual([]);
  });
});

describe('voice fixtures — registry-key normalization + reachability (shipped FIXTURES map)', () => {
  // We assert the KEY normalization here, then prove reachability by reading the shipped
  // FIXTURES map directly (deterministic + order-independent, unlike the mutable findFixture seam).
  it('each component URL normalizes to the expected registry key (query stripped)', () => {
    expect(toRegistryKey('GET', '/api/voice/insights').key).toBe('GET /voice/insights');
    expect(toRegistryKey('GET', '/api/voice/numbers?siteId=s1').key).toBe('GET /voice/numbers');
    expect(toRegistryKey('GET', '/api/voice/numbers/search?areaCode=973').key).toBe('GET /voice/numbers/search');
    expect(toRegistryKey('GET', '/api/voice/vanity-suggestions?siteId=s1').key).toBe('GET /voice/vanity-suggestions');
    expect(toRegistryKey('GET', '/api/voice/conversations?siteId=s1').key).toBe('GET /voice/conversations');
    expect(toRegistryKey('GET', '/api/voice/conversations/conv-1').key).toBe('GET /voice/conversations/conv-1');
    expect(toRegistryKey('GET', '/api/voice/agent-settings?siteId=s1').key).toBe('GET /voice/agent-settings');
    expect(toRegistryKey('GET', '/api/voice/meta-prompt').key).toBe('GET /voice/meta-prompt');
    expect(toRegistryKey('GET', '/api/voice/mcp-attachments?siteId=s1').key).toBe('GET /voice/mcp-attachments');
    expect(toRegistryKey('GET', '/api/mcp/connections?siteId=s1').key).toBe('GET /mcp/connections');
  });

  it('the conversations detail :param PATTERN key is wired in FIXTURES (one fixture, every id)', () => {
    // Assert against the STATIC registry map directly — the merged lines always carry these
    // factories regardless of Jasmine's spec order, and reading the map (not findFixture, which
    // iterates the module-level PARAM_PATTERNS a sibling spec's registerFixtures could
    // reorder/leak) is deterministic. A concrete URL still normalizes to the trailing-id key.
    expect(toRegistryKey('GET', '/api/voice/conversations/conv-xyz').key).toBe(
      'GET /voice/conversations/conv-xyz',
    );
    const reg = FIXTURES as Record<string, unknown>;
    expect(reg['GET /voice/conversations/:id']).toBe(voiceConversationDetailFixture as unknown);
  });

  it('the voice static keys are wired in FIXTURES', () => {
    const reg = FIXTURES as Record<string, unknown>;
    expect(reg[toRegistryKey('GET', '/api/voice/insights').key]).toBe(voiceInsightsFixture as unknown);
    expect(reg[toRegistryKey('GET', '/api/voice/numbers?siteId=s1').key]).toBe(voiceNumbersFixture as unknown);
    expect(reg[toRegistryKey('GET', '/api/mcp/connections').key]).toBe(voiceMcpConnectionsFixture as unknown);
  });
});
