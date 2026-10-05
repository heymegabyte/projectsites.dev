/**
 * @module libs/features/resolution_engine/service
 * @description The Resolution Engine's dual-provider RESEARCH primitive
 * (WLK-39 S6-a) — the FIRST backend leg of S6. Given a prompt, it runs TWO
 * INDEPENDENT provider research calls IN PARALLEL through the EXISTING AI
 * Gateway ({@link services/external_llm.callExternalLLM}) and returns BOTH
 * results (each `{provider, model, content}`) for a later Claude synthesis
 * step (S6-b — NOT built here).
 *
 * Directive mapping:
 *   - §12-13 "dual heavy research" — two DISTINCT providers, OpenAI + Anthropic
 *     by default. Each is resolved as an explicit `callExternalLLM` provider, so
 *     each call rides the registry's real gateway mechanism
 *     (`gateway.ai.cloudflare.com/.../{provider}`), independently key-gated.
 *   - invariant #7 "independent" — the two calls NEVER share a conversation; each
 *     leg gets the SAME prompt but its OWN isolated `callExternalLLM` invocation,
 *     fanned out via `Promise.allSettled` so one leg can never observe the other.
 *   - §24 / §76-D "provider outage" — one leg errors/unconfigured ⇒ return the
 *     OTHER + mark the failed `{provider, ok:false, reason}` (NEVER throws); BOTH
 *     fail ⇒ an honest {@link ResolutionEngineError} carrying both reasons (a
 *     route added in S6-b maps it to a 502). No secrets ever reach a reason.
 *
 * Flag-gated DARK behind `resolution_engine` (default-off). Off ⇒
 * {@link ResolutionEngineDisabledError} (a route maps it to a 404 in S6-b).
 *
 * This slice is a PURE service primitive (no HTTP route): a route is S6-b's
 * concern, and a tested service fn is the correct seam for the synthesis step
 * to consume. See the feature manifest for the chosen shape.
 *
 * @packageDocumentation
 */
import type { Env } from '../../../src/types/env.js';
import { callExternalLLM } from '../../../src/services/external_llm.js';
import { isFlagOn } from '../../../src/modules/feature_flags/services.js';
import { log } from '../../../src/lib/log.js';
import { DualResearchInputSchema, type DualResearchInput, type ResearchProvider } from './schemas.js';

const reLog = log.child('resolution_engine');

/** The flag key that gates this feature (default-off → disabled). */
export const RESOLUTION_ENGINE_FLAG = 'resolution_engine';

/** The directive default: two DISTINCT independent heavy-research providers. */
const DEFAULT_PROVIDERS: readonly [ResearchProvider, ResearchProvider] = ['openai', 'anthropic'];

/** Env-var key each provider needs to be considered configured. */
const PROVIDER_ENV_KEY: Record<ResearchProvider, keyof Env> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
};

/** A leg that returned research content. */
export interface ResearchLegOk {
  provider: ResearchProvider;
  ok: true;
  /** The concrete model the gateway served (provenance). */
  model: string;
  /** The research text. */
  content: string;
  latencyMs: number;
}

/** A leg that errored or was unconfigured — carries a SECRET-FREE reason. */
export interface ResearchLegDown {
  provider: ResearchProvider;
  ok: false;
  /** Human-readable, secret-redacted failure reason (safe to surface/log). */
  reason: string;
}

export type ResearchLeg = ResearchLegOk | ResearchLegDown;

/** The dual-research result — BOTH legs, for the S6-b synthesis step. */
export interface DualResearchResult {
  /** True when AT LEAST ONE leg returned content (degraded-but-usable). */
  ok: true;
  /** Exactly two legs, in the requested provider order. */
  legs: ResearchLeg[];
}

/** Thrown when the `resolution_engine` flag is OFF (maps to 404 in S6-b). */
export class ResolutionEngineDisabledError extends Error {
  readonly code = 'RESOLUTION_ENGINE_DISABLED';
  constructor() {
    super('resolution_engine is not enabled');
    this.name = 'ResolutionEngineDisabledError';
  }
}

/** Thrown when EVERY leg failed — carries both secret-free reasons (→ 502 in S6-b). */
export class ResolutionEngineError extends Error {
  readonly code = 'RESOLUTION_ENGINE_ALL_PROVIDERS_FAILED';
  readonly legs: ResearchLegDown[];
  constructor(legs: ResearchLegDown[]) {
    super(`all research providers failed: ${legs.map((l) => `${l.provider} (${l.reason})`).join('; ')}`);
    this.name = 'ResolutionEngineError';
    this.legs = legs;
  }
}

/**
 * Redact anything that looks like a provider API key from a failure reason so a
 * leaked key in an upstream error message can never reach a response/log. Covers
 * the common `sk-…`, `psk_…`, and bearer-token shapes; truncates to keep reasons tight.
 */
function safeReason(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/\b(sk|psk|pk|rk)[-_][A-Za-z0-9-_]{8,}/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9-_.]+/gi, 'Bearer [redacted]')
    .slice(0, 300);
}

/** The system instruction each leg gets when the caller doesn't supply one. */
const DEFAULT_SYSTEM =
  'You are a rigorous business/domain research analyst. Research the subject thoroughly ' +
  'and return a dense, well-organized, factual briefing. Do not fabricate; mark uncertainty.';

/**
 * Run ONE research leg against a single provider. Never throws — resolves to a
 * {@link ResearchLeg} (ok or down). Skips the call entirely (marks down) when the
 * provider's key is absent, so an unconfigured provider is never even attempted.
 */
async function runLeg(
  env: Env,
  provider: ResearchProvider,
  input: { system: string; user: string; maxTokens: number },
): Promise<ResearchLeg> {
  if (!env[PROVIDER_ENV_KEY[provider]]) {
    return { provider, ok: false, reason: `${provider} is not configured (no API key)` };
  }
  try {
    const result = await callExternalLLM(env, {
      // Explicit provider → callExternalLLM routes THIS vendor through the AI
      // Gateway (never a tier ladder that could collapse both legs onto one
      // vendor and defeat independence). Each leg is its own isolated call.
      provider,
      system: input.system,
      user: input.user,
      maxTokens: input.maxTokens,
      // Deterministic research → let the gateway cache (temperature < 0.5).
      temperature: 0.2,
      traceContext: { promptId: `${RESOLUTION_ENGINE_FLAG}:${provider}` },
    });
    return {
      provider,
      ok: true,
      model: result.model_used,
      content: result.output,
      latencyMs: result.latency_ms,
    };
  } catch (err) {
    return { provider, ok: false, reason: safeReason(err) };
  }
}

/**
 * Run two INDEPENDENT provider research calls in PARALLEL and return BOTH
 * results for the S6-b synthesis step.
 *
 * @param env - Worker env (provider keys + flag plumbing).
 * @param rawInput - {@link DualResearchInput} — `{ prompt, system?, providers?, maxTokens? }`.
 * @returns A {@link DualResearchResult} with exactly two legs (each ok or down).
 * @throws {@link ResolutionEngineDisabledError} when the flag is off.
 * @throws {@link ResolutionEngineError} when BOTH legs fail (honest aggregate).
 *
 * @example
 * ```ts
 * const res = await runDualResearch(env, { prompt: 'research Acme Co' });
 * // res.legs → [{provider:'openai',ok:true,model,content}, {provider:'anthropic',...}]
 * ```
 */
export async function runDualResearch(
  env: Env,
  rawInput: DualResearchInput,
): Promise<DualResearchResult> {
  // Flag gate FIRST — dark means no provider call ever fires.
  if (!(await isFlagOn(env, RESOLUTION_ENGINE_FLAG, {}))) {
    throw new ResolutionEngineDisabledError();
  }

  const input = DualResearchInputSchema.parse(rawInput);
  const [p1, p2] = input.providers ?? DEFAULT_PROVIDERS;
  const system = input.system ?? DEFAULT_SYSTEM;
  const maxTokens = input.maxTokens ?? 4096;
  const user = `Research subject:\n\n${input.prompt}`;

  // Fan out — Promise.allSettled so a rejection in one leg can NEVER reject the
  // other (runLeg already swallows per-leg errors, but allSettled is the belt).
  // The two calls share NO state → independent (invariant #7).
  const settled = await Promise.allSettled([
    runLeg(env, p1, { system, user, maxTokens }),
    runLeg(env, p2, { system, user, maxTokens }),
  ]);

  const legs: ResearchLeg[] = settled.map((s, i) => {
    const provider = (i === 0 ? p1 : p2) as ResearchProvider;
    if (s.status === 'fulfilled') return s.value;
    // runLeg never throws, but belt-and-suspenders: a settled rejection is a down leg.
    return { provider, ok: false, reason: safeReason(s.reason) };
  });

  const okLegs = legs.filter((l): l is ResearchLegOk => l.ok);
  const downLegs = legs.filter((l): l is ResearchLegDown => !l.ok);

  if (okLegs.length === 0) {
    // BOTH down → honest aggregate error (502 at the route layer in S6-b).
    reLog.warn('all_providers_failed', {
      providers: legs.map((l) => l.provider),
      reasons: downLegs.map((l) => l.reason),
    });
    throw new ResolutionEngineError(downLegs);
  }

  if (downLegs.length > 0) {
    // Degraded — one leg survived. Surface the fallback for observability.
    reLog.warn('provider_leg_down_fallback', {
      down: downLegs.map((l) => ({ provider: l.provider, reason: l.reason })),
      survived: okLegs.map((l) => l.provider),
    });
  } else {
    reLog.info('dual_research_ok', { providers: okLegs.map((l) => l.provider) });
  }

  return { ok: true, legs };
}
