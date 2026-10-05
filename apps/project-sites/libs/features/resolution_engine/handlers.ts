/**
 * @module libs/features/resolution_engine/handlers
 * @description The Resolution Engine's SYNTHESIS route — `POST /api/resolve`
 * (WLK-39 S6-b-i). The SECOND backend leg of S6: it runs the S6-a dual-research
 * primitive ({@link service.runDualResearch} — two INDEPENDENT provider legs via
 * the AI Gateway) and then SYNTHESIZES the two research legs into ONE better
 * combined answer with a Claude-class (premium-tier) model, again through the
 * EXISTING AI Gateway ({@link services/external_llm.callExternalLLM}).
 *
 * Directive §13 — "best(OpenAI) + best(Anthropic) + judgment = a better third":
 * the synthesis step feeds Claude BOTH legs' content, clearly labelled by the
 * provider that produced it, and instructs it to reconcile agreements / unique
 * ideas / disagreements into the best COMBINED answer — synthesize, NOT
 * concatenate. The panel that consumes this response is S6-b-ii (not here).
 *
 * | Method | Path          | Auth / gating                                          |
 * | ------ | ------------- | ------------------------------------------------------ |
 * | POST   | /api/resolve  | `orgId` (401) · optional `siteId` → `assertSiteOwned` (404) · flag `resolution_engine` → 404 when off |
 *
 * Status contract:
 *   - flag off → `runDualResearch` throws {@link ResolutionEngineDisabledError}
 *     → **404** (never 403; the gate decision lives in the service).
 *   - unauth (no `orgId`) → **401** BEFORE any research/provider call.
 *   - a supplied `siteId` the caller doesn't own → **404** (never 403).
 *   - BOTH research legs fail → `runDualResearch` throws {@link ResolutionEngineError}
 *     → **502** honest aggregate (secret-redacted reasons).
 *   - the SYNTHESIS call ITSELF failing → **200** with the research legs + a
 *     `synthesis:{ok:false,reason}` marker (NEVER a 500 — the research is still
 *     valuable, and the panel can retry synthesis).
 * No secrets ever reach a response or a log.
 *
 * @packageDocumentation
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, Variables } from '../../../src/types/env.js';
import { callExternalLLM } from '../../../src/services/external_llm.js';
import { log } from '../../../src/lib/log.js';
import { ResolveInputSchema } from './schemas.js';
import {
  runDualResearch,
  ResolutionEngineDisabledError,
  ResolutionEngineError,
  type ResearchLeg,
} from './service.js';

type AppContext = { Bindings: Env; Variables: Variables };

export const resolutionEngine = new Hono<AppContext>();

const reLog = log.child('resolution_engine_route');

/** Human label for a provider inside the synthesis prompt. */
const PROVIDER_LABEL: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  deepseek: 'DeepSeek',
};

/** The synthesis system instruction — reconcile, don't concatenate (directive §13). */
const SYNTHESIS_SYSTEM =
  'You are a senior research editor. You are given TWO independent research briefings on the ' +
  'same subject, each produced by a DIFFERENT AI provider working in isolation. Your job is to ' +
  'SYNTHESIZE them into a single, better answer — NOT to concatenate them. Explicitly: (1) state ' +
  'the points where the two briefings AGREE (highest confidence); (2) fold in the UNIQUE ideas ' +
  'each one contributes that the other missed; (3) where they DISAGREE, weigh the evidence and ' +
  'resolve it, noting the disagreement. Produce one coherent, dense, well-organized briefing that ' +
  'is better than either input alone. Do not fabricate; preserve any uncertainty either leg flagged.';

/**
 * Redact anything key-shaped from a synthesis failure reason before it reaches
 * the response/log. Mirrors the service's `safeReason` so a leaked upstream key
 * can never surface here either. Truncated to keep the marker tight.
 */
function safeReason(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/\b(sk|psk|pk|rk)[-_][A-Za-z0-9-_]{8,}/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9-_.]+/gi, 'Bearer [redacted]')
    .slice(0, 300);
}

/**
 * Build the Claude synthesis user prompt from the two research legs. Only OK
 * legs carry content; a down leg is noted so Claude knows the input is partial
 * (and synthesizes from the survivor without inventing the missing side).
 */
function buildSynthesisPrompt(prompt: string, legs: ResearchLeg[]): string {
  const sections = legs.map((leg, i) => {
    const label = PROVIDER_LABEL[leg.provider] ?? leg.provider;
    if (leg.ok) {
      return `### Research briefing ${i + 1} — from ${label} (model: ${leg.model})\n\n${leg.content}`;
    }
    return `### Research briefing ${i + 1} — from ${label}\n\n(unavailable: ${leg.reason})`;
  });
  return (
    `Subject that was researched:\n\n${prompt}\n\n` +
    `Here are the independent research briefings to synthesize:\n\n${sections.join('\n\n---\n\n')}\n\n` +
    `Now produce the single best COMBINED briefing per your instructions (agreements, unique ideas, resolved disagreements).`
  );
}

/**
 * POST /api/resolve
 *
 * Authed dual-research → Claude synthesis. See the module JSDoc for the full
 * status contract. Returns `{ research: ResearchLeg[], synthesis }` where
 * `synthesis` is `{ provider, model, content }` on success or
 * `{ ok:false, reason }` when only the synthesis step failed.
 *
 * @example
 * ```bash
 * curl -X POST https://projectsites.dev/api/resolve \
 *   -H "Authorization: Bearer <session>" -H "Content-Type: application/json" \
 *   -d '{"prompt":"research Acme Co"}'
 * # → { "research": [ {provider:"openai",…}, {provider:"anthropic",…} ],
 * #     "synthesis": { "provider":"anthropic", "model":"claude-fable-5", "content":"…" } }
 * ```
 */
resolutionEngine.post('/api/resolve', async (c: Context<AppContext>) => {
  // 1. Auth FIRST — a dual-research call fans out real provider spend, so an
  //    unauthenticated caller must be rejected before `runDualResearch` runs
  //    (401), independent of the flag. The flag 404 is the service's job.
  const orgId = c.get('orgId');
  if (!orgId) {
    return c.json(
      { error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } },
      401,
    );
  }

  // 2. Validate the body (empty/oversized prompt → 400; extra fields stripped).
  const raw = (await c.req.json().catch(() => ({}))) as unknown;
  const parsed = ResolveInputSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues[0]?.message ?? 'Invalid request body.',
        },
      },
      400,
    );
  }
  const input = parsed.data;

  // 3. Optional site scoping — 404 (never 403) when missing/deleted/foreign.
  if (input.siteId) {
    const { assertSiteOwned } = await import('../../../src/services/site_ownership.js');
    if (!(await assertSiteOwned(c.env, orgId, input.siteId))) return c.notFound();
  }

  // 4. Dual research (S6-a). The `resolution_engine` flag gate is enforced
  //    INSIDE runDualResearch (it calls `isFlagOn` before any provider call) —
  //    flag-off → ResolutionEngineDisabledError, which we catch → 404 (never 403),
  //    so no provider call ever fires when the feature is dark. Keeping the single
  //    gate in the service (not a duplicate isFlagOn here) is deliberate: one SSOT
  //    for the flag decision, tested in resolution_engine.test.ts.
  //    Both legs failed → ResolutionEngineError → 502 (honest, redacted).
  let research;
  try {
    research = await runDualResearch(c.env, {
      prompt: input.prompt,
      system: input.system,
      providers: input.providers,
      maxTokens: input.maxTokens,
    });
  } catch (err) {
    if (err instanceof ResolutionEngineDisabledError) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Resource not found.' } }, 404);
    }
    if (err instanceof ResolutionEngineError) {
      // Honest both-legs-down aggregate. Reasons are already secret-redacted by
      // the service's safeReason; surface them per-provider for the UI.
      return c.json(
        {
          error: {
            code: 'ALL_PROVIDERS_FAILED',
            message: 'All research providers failed. No answer could be produced.',
            reasons: err.legs.map((l) => ({ provider: l.provider, reason: l.reason })),
          },
        },
        502,
      );
    }
    throw err; // genuinely unexpected → global error handler (500)
  }

  // 5. Synthesize the two legs into a better third via a Claude-class (premium)
  //    model. A synthesis-only failure is NON-fatal: the research is still
  //    valuable, so return it with an {ok:false,reason} marker (never a 500).
  try {
    const synth = await callExternalLLM(c.env, {
      tier: 'premium', // Claude-class — external_llm's premium ladder resolves Claude/OpenAI.
      system: SYNTHESIS_SYSTEM,
      user: buildSynthesisPrompt(input.prompt, research.legs),
      maxTokens: input.maxTokens ?? 4096,
      temperature: 0.3,
      traceContext: {
        orgId,
        siteId: input.siteId,
        promptId: 'resolution_engine:synthesis',
      },
    });
    return c.json(
      {
        research: research.legs,
        synthesis: {
          provider: synth.provider,
          model: synth.model_used,
          content: synth.output,
        },
      },
      200,
    );
  } catch (err) {
    const reason = safeReason(err);
    reLog.warn('synthesis_failed', { orgId, reason });
    return c.json(
      {
        research: research.legs,
        synthesis: { ok: false, reason },
      },
      200,
    );
  }
});
