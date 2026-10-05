/**
 * @file claude-code-resolve — the typed CLIENT contract + parser for the Resolution Engine's
 * synthesis route (`POST /api/resolve`), consumed by {@link ClaudeCodePanel}'s Resolution mode
 * (WLK-39 §75 flagship, slice S6-b-ii).
 *
 * @remarks
 * ## Why a separate pure module
 * The panel's Single mode streams `/api/llmcall` line-by-line; Resolution mode instead POSTs
 * `/api/resolve` ONCE and renders a structured object (two research legs + a synthesis). That
 * parse/normalize is its own concern, so it lives here as a PURE, total function — no React, no
 * fetch — trivially unit-testable and reused by the panel at the fetch boundary.
 *
 * ## The server contract (S6-b-i — `libs/features/resolution_engine/handlers.ts`)
 * `POST /api/resolve {prompt}` returns, on `200`:
 * ```jsonc
 * // success — synthesis produced a combined answer:
 * { "research": [ {provider,ok:true,model,content}, … ],
 *   "synthesis": { "provider":"anthropic", "model":"claude-fable-5", "content":"…" } }
 * // synthesis-only failure — research is still valuable, synthesis step failed (NOT an error):
 * { "research": [ … ], "synthesis": { "ok":false, "reason":"…" } }
 * ```
 * A research leg is EITHER `{provider, ok:true, model, content}` OR a DOWN leg
 * `{provider, ok:false, reason}` (one provider errored/unconfigured; the survivor still returns).
 *
 * ## Flag-off (DARK) handling
 * When the `resolution_engine` flag is off the route returns **404** (never 403). The panel treats
 * a 404 as "Resolution mode unavailable" and disables the toggle with a tooltip — NEVER an error
 * toast. This module exposes nothing for that path; the panel branches on `res.status === 404`.
 *
 * The parser is DEFENSIVE (the body crosses a network boundary): a malformed/partial payload yields
 * a safe, renderable shape (empty legs + a synthesis-unavailable marker) rather than throwing, so a
 * backend hiccup degrades calmly instead of crashing the panel.
 */

/** A research leg that succeeded — carries the provider's provenance + its briefing content. */
export interface ResolveResearchLegOk {
  provider: string;
  ok: true;
  model: string;
  content: string;
}

/** A research leg that was unavailable (provider errored/unconfigured) — carries a safe reason. */
export interface ResolveResearchLegDown {
  provider: string;
  ok: false;
  reason: string;
}

/** One research leg of the dual-research fan-out (ok or down). */
export type ResolveResearchLeg = ResolveResearchLegOk | ResolveResearchLegDown;

/** The synthesis result when the Claude synthesis step succeeded. */
export interface ResolveSynthesisOk {
  ok: true;
  provider: string;
  model: string;
  content: string;
}

/** The synthesis marker when ONLY the synthesis step failed (research legs are still returned). */
export interface ResolveSynthesisDown {
  ok: false;
  reason: string;
}

/** The synthesis section — a combined answer, or an honest "unavailable" marker. */
export type ResolveSynthesis = ResolveSynthesisOk | ResolveSynthesisDown;

/** The normalized `/api/resolve` 200 body the panel renders (two legs + a synthesis). */
export interface ResolveResult {
  research: ResolveResearchLeg[];
  synthesis: ResolveSynthesis;
}

/** Human provider labels for the leg headers (mirrors the server's synthesis prompt labels). */
const PROVIDER_LABELS: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  deepseek: 'DeepSeek',
};

/** Title-case an unknown provider id as a readable fallback (`foo_bar` → `Foo Bar`). */
export function providerLabel(provider: string): string {
  const key = typeof provider === 'string' ? provider.toLowerCase() : '';

  if (PROVIDER_LABELS[key]) {
    return PROVIDER_LABELS[key];
  }

  if (key === '') {
    return 'Provider';
  }

  return key.replace(/[-_]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Normalize one raw leg into the typed union; a non-ok/malformed leg becomes a DOWN leg. */
function parseLeg(raw: unknown): ResolveResearchLeg {
  const leg = (raw ?? {}) as Record<string, unknown>;
  const provider = asString(leg.provider) || 'unknown';

  // ok:true + content ⇒ an OK leg; anything else is a down leg with a safe reason.
  if (leg.ok === true && typeof leg.content === 'string') {
    return {
      provider,
      ok: true,
      model: asString(leg.model),
      content: leg.content,
    };
  }

  const reason = asString(leg.reason) || 'This provider was unavailable.';

  return { provider, ok: false, reason };
}

/** Normalize the raw synthesis section; missing/`ok:false`/malformed ⇒ an unavailable marker. */
function parseSynthesis(raw: unknown): ResolveSynthesis {
  const synth = (raw ?? {}) as Record<string, unknown>;

  // A success synthesis has content and is NOT explicitly ok:false.
  if (synth.ok !== false && typeof synth.content === 'string' && synth.content !== '') {
    return {
      ok: true,
      provider: asString(synth.provider) || 'unknown',
      model: asString(synth.model),
      content: synth.content,
    };
  }

  const reason = asString(synth.reason) || 'The combined synthesis could not be produced.';

  return { ok: false, reason };
}

/**
 * Parse a raw `/api/resolve` 200 body into the typed {@link ResolveResult}. PURE + total: never
 * throws — a malformed/partial payload yields empty legs + a synthesis-unavailable marker so the
 * panel degrades calmly (the research-leg list simply renders empty, the synthesis note shows).
 *
 * @param raw - the parsed JSON body (already `await res.json()`).
 * @returns the normalized result the panel renders.
 */
export function parseResolveResult(raw: unknown): ResolveResult {
  const body = (raw ?? {}) as Record<string, unknown>;
  const legsRaw = Array.isArray(body.research) ? body.research : [];

  return {
    research: legsRaw.map(parseLeg),
    synthesis: parseSynthesis(body.synthesis),
  };
}
