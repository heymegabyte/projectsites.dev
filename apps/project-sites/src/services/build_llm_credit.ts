// build_llm_credit.ts — PRE-FLIGHT build-LLM credit gate for the golden-journey delivery path.
//
// The build orchestrator (container Claude Code) speaks the Anthropic protocol against either
// DeepSeek's `/anthropic` endpoint (when DEEPSEEK_API_KEY is set + BUILD_LLM_PROVIDER != 'anthropic')
// or Anthropic directly. When the ACTIVE provider's balance is exhausted, the build does NOT fail —
// it FAST-PATHS: Claude Code emits an `API Error: 402 Insufficient Balance`, produces no real
// generation, and the pipeline can still flip the site to `published` with seed-token-only content
// AND email the owner "your site is ready" for a broken build (the exact `build-llm-402-dead-balance`
// incident class). `detectBuildLlmDegraded` (build_log.ts) catches this AFTER the build from stdout;
// this module is the PRE-FLIGHT — it refuses to spend a container boot (and a golden-journey
// Browserbase run) when no provider has credit, so the delivery fails fast + loud with the exact
// unblock instead of shipping a fake delivery.
//
// Fail-soft by design: only a DEFINITIVE dead-balance signal blocks. Any transient/network/parse
// error returns `ok:true, checked:false` so a blip never strands a legitimate build.
import { z } from 'zod';

/** Which build-LLM provider the workflow will actually use, mirroring site-generation.ts. */
export type BuildLlmProvider = 'deepseek' | 'anthropic';

/** Env slice this gate reads — a typed param, never `process.env` (Workers-compat). */
export interface BuildLlmCreditEnv {
  readonly DEEPSEEK_API_KEY?: string;
  readonly ANTHROPIC_API_KEY?: string;
  readonly BUILD_LLM_PROVIDER?: string;
  /**
   * Graceful-degradation opt-in (Brian's one-command delivery unblock during an LLM outage).
   * OFF by default → a dead balance BLOCKS (the safe AL-707 default: no fake bespoke delivery).
   * Set to `'1'`/`'true'` → a dead balance is DOWNGRADED to `{ok:true, degraded:true}` so the build
   * PROCEEDS on the deterministic seed-token fast-path (template + vertical content pack + brand
   * seed — proven high-quality: pike-place-fish-market was a post-LLM-death seed-only build, LCP
   * 712ms / density 1010w / beat-source +78%). Fail-soft-prod: a real template site beats a hard
   * build failure during an outage. The caller MUST log the degradation (seed-only, not bespoke).
   */
  readonly BUILD_LLM_ALLOW_SEED_ONLY?: string;
}

/** Injectable deps so the gate is unit-testable without real network I/O. */
export interface BuildLlmCreditDeps {
  readonly fetchImpl?: typeof fetch;
}

/** Result envelope — Zod-validated before return so callers get a guaranteed shape. */
export const BuildLlmCreditResultSchema = z.object({
  ok: z.boolean(),
  provider: z.enum(['deepseek', 'anthropic']),
  checked: z.boolean(),
  reason: z.string(),
  balance: z.string().optional(),
  /**
   * True ONLY when a dead balance was DOWNGRADED (not blocked) because BUILD_LLM_ALLOW_SEED_ONLY is
   * set — `ok:true` but the build will run seed-only (no LLM bespoke). The caller emits a
   * `build_llm_degraded` warn so the seed-only delivery is observable, never silent.
   */
  degraded: z.boolean().optional(),
});
export type BuildLlmCreditResult = z.infer<typeof BuildLlmCreditResultSchema>;

/** Is Brian's seed-only graceful-degradation opt-in set? (`'1'`/`'true'`, not `'0'`/`'false'`/empty.) */
function seedOnlyAllowed(env: BuildLlmCreditEnv): boolean {
  const v = (env.BUILD_LLM_ALLOW_SEED_ONLY ?? '').toString().trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Route a DEFINITIVE dead-balance signal through the escape hatch: block by default (`ok:false`),
 * or — when {@link seedOnlyAllowed} — downgrade to `{ok:true, degraded:true}` so the build proceeds
 * seed-only. The reason is stable for the caller's structured log.
 */
function deadBalanceResult(
  provider: BuildLlmProvider,
  reason: string,
  allowSeedOnly: boolean,
  balance?: string,
): BuildLlmCreditResult {
  return BuildLlmCreditResultSchema.parse({
    ok: allowSeedOnly,
    provider,
    checked: true,
    reason: allowSeedOnly ? `${reason}_seed_only_allowed` : reason,
    ...(allowSeedOnly && { degraded: true }),
    ...(balance !== undefined && { balance }),
  });
}

/** Deep-linked top-up URLs surfaced to the operator when a provider is out of credit. */
export const BUILD_LLM_TOPUP_URLS: Readonly<Record<BuildLlmProvider, string>> = Object.freeze({
  deepseek: 'https://platform.deepseek.com/top_up',
  anthropic: 'https://console.anthropic.com/settings/billing',
});

/**
 * Resolve which provider the build step will use — identical logic to the workflow's
 * `useDeepSeek` selection so the pre-flight checks the SAME provider the build will call.
 *
 * @param env - Build-LLM env slice.
 * @returns `'deepseek'` when its key is present and not force-overridden, else `'anthropic'`.
 * @example
 * resolveBuildLlmProvider({ DEEPSEEK_API_KEY: 'x' })                          // → 'deepseek'
 * resolveBuildLlmProvider({ DEEPSEEK_API_KEY: 'x', BUILD_LLM_PROVIDER: 'anthropic' }) // → 'anthropic'
 * resolveBuildLlmProvider({ ANTHROPIC_API_KEY: 'y' })                         // → 'anthropic'
 */
export function resolveBuildLlmProvider(env: BuildLlmCreditEnv): BuildLlmProvider {
  const useDeepSeek = !!env.DEEPSEEK_API_KEY && env.BUILD_LLM_PROVIDER !== 'anthropic';
  return useDeepSeek ? 'deepseek' : 'anthropic';
}

/** DeepSeek `/user/balance` response shape (only the fields we read). */
const DeepSeekBalanceSchema = z.object({
  is_available: z.boolean().optional(),
  balance_infos: z
    .array(z.object({ currency: z.string().optional(), total_balance: z.string().optional() }))
    .optional(),
});

/**
 * Ping the ACTIVE build-LLM provider's balance BEFORE a build is spent, so a dead balance is
 * caught pre-flight (no wasted container boot, no fake `published` + "ready" email).
 *
 * @remarks Impure — performs one network request to the provider's balance/echo endpoint.
 * @param env - Build-LLM env slice (keys + provider override).
 * @param deps - Optional injected `fetchImpl` for tests.
 * @returns A validated {@link BuildLlmCreditResult}. `ok:false` ONLY on a definitive dead-balance
 *   signal; every transient/parse failure is `ok:true, checked:false` (fail-soft).
 * @example
 * const c = await checkBuildLlmCredit(env);
 * if (!c.ok) throw new Error(`build-LLM ${c.provider} out of credit: ${c.reason}`);
 */
export async function checkBuildLlmCredit(
  env: BuildLlmCreditEnv,
  deps: BuildLlmCreditDeps = {},
): Promise<BuildLlmCreditResult> {
  const doFetch = deps.fetchImpl ?? fetch;
  const provider = resolveBuildLlmProvider(env);
  const key = provider === 'deepseek' ? env.DEEPSEEK_API_KEY : env.ANTHROPIC_API_KEY;

  // No key for the active provider → can't check; treat as unchecked-ok so the existing
  // (missing-key) failure path in the container remains the source of truth, not this gate.
  if (!key) {
    return BuildLlmCreditResultSchema.parse({
      ok: true,
      provider,
      checked: false,
      reason: 'no_api_key_for_active_provider',
    });
  }

  try {
    if (provider === 'deepseek') {
      const res = await doFetch('https://api.deepseek.com/user/balance', {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      });
      if (!res.ok) {
        return BuildLlmCreditResultSchema.parse({
          ok: true,
          provider,
          checked: false,
          reason: `balance_endpoint_http_${res.status}`,
        });
      }
      const parsed = DeepSeekBalanceSchema.safeParse(await res.json().catch(() => ({})));
      if (!parsed.success) {
        return BuildLlmCreditResultSchema.parse({
          ok: true,
          provider,
          checked: false,
          reason: 'balance_parse_failed',
        });
      }
      const bal = parsed.data.balance_infos?.[0]?.total_balance;
      // Definitive dead-balance: provider reports unavailable OR a non-positive total balance.
      const available = parsed.data.is_available === true;
      const positive = bal !== undefined ? Number(bal) > 0 : true;
      if (available && positive) {
        return BuildLlmCreditResultSchema.parse({
          ok: true,
          provider,
          checked: true,
          reason: 'deepseek_balance_ok',
          ...(bal !== undefined && { balance: bal }),
        });
      }
      return deadBalanceResult('deepseek', 'deepseek_dead_balance', seedOnlyAllowed(env), bal);
    }

    // Anthropic: a 1-token echo call is the cheapest liveness probe. A too-low-credit balance
    // returns an `invalid_request_error` whose message names the credit problem (HTTP 400).
    const res = await doFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'x' }],
      }),
    });
    if (res.ok) {
      return BuildLlmCreditResultSchema.parse({
        ok: true,
        provider,
        checked: true,
        reason: 'anthropic_credit_ok',
      });
    }
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    const msg = body.error?.message ?? '';
    const deadBalance = /credit balance is too low|insufficient|billing/i.test(msg);
    if (deadBalance) {
      return deadBalanceResult('anthropic', 'anthropic_dead_balance', seedOnlyAllowed(env));
    }
    // Any other non-2xx (rate-limit, transient 5xx, unrelated 400) → fail-soft, don't block.
    return BuildLlmCreditResultSchema.parse({
      ok: true,
      provider,
      checked: false,
      reason: `anthropic_non_credit_http_${res.status}`,
    });
  } catch (err) {
    return BuildLlmCreditResultSchema.parse({
      ok: true,
      provider,
      checked: false,
      reason: `check_failed_fail_soft:${err instanceof Error ? err.name : 'unknown'}`,
    });
  }
}
