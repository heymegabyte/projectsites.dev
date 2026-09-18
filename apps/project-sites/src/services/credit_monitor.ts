/**
 * @module services/credit_monitor
 * @description Super-admin credit/quota monitor — a normalized read of every credit-based
 * third-party API in the stack, so a human can see at a glance which providers are funded,
 * low, or DEPLETED (the recurring build-LLM blocker: DeepSeek at a negative balance silently
 * fails every site build).
 *
 * Design:
 * - One adapter per provider. Each returns a normalized {@link ProviderCredit}, independently
 *   and FAIL-SOFT: a provider that errors/times out/lacks a key never breaks the report — it
 *   reports `status: 'unknown'|'unconfigured'` with a detail line. `Promise.allSettled` fans
 *   them out in parallel.
 * - Three data shapes, honestly labelled per provider's REAL capability:
 *     `balance`      — provider exposes a $/credit balance API (DeepSeek, Stability, Deepgram).
 *     `quota`        — provider exposes a used/limit quota (ElevenLabs characters).
 *     `availability` — no balance API, but a cheap authed GET proves the key works (Replicate).
 *     `console`      — no programmatic balance at all (Anthropic, OpenAI, Ideogram, Google) —
 *                      link to the billing console; never fabricate a number.
 * - The endpoint caches the report in KV (short TTL) so the widget doesn't hammer provider APIs.
 *
 * Workers-compatible: native `fetch` + `AbortController`, no node deps. Zod at the boundary.
 */
import { z } from 'zod';
import type { Env } from '../types/env.js';

export const ProviderCreditSchema = z.object({
  id: z.string(),
  label: z.string(),
  category: z.enum(['llm', 'image', 'voice', 'browser', 'maps', 'media']),
  kind: z.enum(['balance', 'quota', 'availability', 'console']),
  configured: z.boolean(),
  status: z.enum(['healthy', 'low', 'depleted', 'unknown', 'unconfigured']),
  balanceUsd: z.number().nullable().default(null),
  currency: z.string().nullable().default(null),
  quota: z
    .object({ used: z.number(), limit: z.number(), unit: z.string() })
    .nullable()
    .default(null),
  detail: z.string(),
  topUpUrl: z.string(),
});
export type ProviderCredit = z.infer<typeof ProviderCreditSchema>;

export const CreditReportSchema = z.object({
  providers: z.array(ProviderCreditSchema),
  checkedAt: z.number(),
  summary: z.object({
    healthy: z.number(),
    low: z.number(),
    depleted: z.number(),
    unknown: z.number(),
    unconfigured: z.number(),
  }),
});
export type CreditReport = z.infer<typeof CreditReportSchema>;

/** Fetch with a hard timeout so a hung provider can never stall the whole report. */
async function timedFetch(url: string, init: RequestInit, ms = 8000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

interface Adapter {
  id: string;
  label: string;
  category: ProviderCredit['category'];
  kind: ProviderCredit['kind'];
  topUpUrl: string;
  /** Whether the provider's key is present in env. */
  configured: (env: Env) => boolean;
  /** Only called when configured; returns the live status fields. May throw (caught → unknown). */
  probe?: (env: Env) => Promise<Partial<ProviderCredit>>;
  /** Static detail for `console`-kind providers (no probe). */
  consoleDetail?: string;
}

/** Classify a $ balance into a traffic-light status. */
function balanceStatus(usd: number, lowThreshold = 5): ProviderCredit['status'] {
  if (usd <= 0) return 'depleted';
  if (usd < lowThreshold) return 'low';
  return 'healthy';
}

/** Classify a used/limit quota by remaining fraction. */
function quotaStatus(used: number, limit: number): ProviderCredit['status'] {
  if (limit <= 0) return 'unknown';
  const remaining = (limit - used) / limit;
  if (remaining <= 0) return 'depleted';
  if (remaining < 0.1) return 'low';
  return 'healthy';
}

const ADAPTERS: Adapter[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    category: 'llm',
    kind: 'balance',
    topUpUrl: 'https://platform.deepseek.com/top_up',
    configured: (env) => Boolean(env.DEEPSEEK_API_KEY),
    async probe(env) {
      const res = await timedFetch('https://api.deepseek.com/user/balance', {
        headers: { Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`, Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as {
        is_available?: boolean;
        balance_infos?: Array<{ currency?: string; total_balance?: string }>;
      };
      const info = body.balance_infos?.[0];
      const usd = Number(info?.total_balance ?? 'NaN');
      const status = Number.isFinite(usd) ? balanceStatus(usd) : body.is_available ? 'healthy' : 'depleted';
      return {
        balanceUsd: Number.isFinite(usd) ? usd : null,
        currency: info?.currency ?? 'USD',
        status,
        detail: Number.isFinite(usd)
          ? `${usd < 0 ? '-' : ''}$${Math.abs(usd).toFixed(2)} ${info?.currency ?? 'USD'} · ${body.is_available ? 'available' : 'UNAVAILABLE (builds blocked)'}`
          : body.is_available
            ? 'Available'
            : 'Unavailable — top up to unblock builds',
      };
    },
  },
  {
    id: 'stability',
    label: 'Stability AI',
    category: 'image',
    kind: 'balance',
    topUpUrl: 'https://platform.stability.ai/account/credits',
    configured: (env) => Boolean(env.STABILITY_API_KEY),
    async probe(env) {
      const res = await timedFetch('https://api.stability.ai/v1/user/balance', {
        headers: { Authorization: `Bearer ${env.STABILITY_API_KEY}`, Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { credits?: number };
      const credits = Number(body.credits ?? 'NaN');
      return {
        balanceUsd: null,
        status: Number.isFinite(credits) ? balanceStatus(credits, 50) : 'unknown',
        detail: Number.isFinite(credits) ? `${credits.toFixed(0)} credits` : 'No balance returned',
      };
    },
  },
  {
    id: 'deepgram',
    label: 'Deepgram',
    category: 'voice',
    kind: 'balance',
    topUpUrl: 'https://console.deepgram.com/',
    configured: (env) => Boolean(env.DEEPGRAM_API_KEY),
    async probe(env) {
      const projRes = await timedFetch('https://api.deepgram.com/v1/projects', {
        headers: { Authorization: `Token ${env.DEEPGRAM_API_KEY}`, Accept: 'application/json' },
      });
      if (!projRes.ok) throw new Error(`HTTP ${projRes.status}`);
      const projects = (await projRes.json()) as { projects?: Array<{ project_id?: string }> };
      const projId = projects.projects?.[0]?.project_id;
      if (!projId) return { status: 'unknown', detail: 'No project found' };
      const balRes = await timedFetch(`https://api.deepgram.com/v1/projects/${projId}/balances`, {
        headers: { Authorization: `Token ${env.DEEPGRAM_API_KEY}`, Accept: 'application/json' },
      });
      if (!balRes.ok) throw new Error(`HTTP ${balRes.status}`);
      const bal = (await balRes.json()) as { balances?: Array<{ amount?: number; units?: string }> };
      const amount = Number(bal.balances?.[0]?.amount ?? 'NaN');
      const units = bal.balances?.[0]?.units ?? 'usd';
      return {
        balanceUsd: units.toLowerCase().includes('usd') && Number.isFinite(amount) ? amount : null,
        currency: 'USD',
        status: Number.isFinite(amount) ? balanceStatus(amount) : 'unknown',
        detail: Number.isFinite(amount) ? `$${amount.toFixed(2)} ${units}` : 'No balance returned',
      };
    },
  },
  {
    id: 'elevenlabs',
    label: 'ElevenLabs',
    category: 'voice',
    kind: 'quota',
    topUpUrl: 'https://elevenlabs.io/app/subscription',
    configured: (env) => Boolean(env.ELEVENLABS_API_KEY),
    async probe(env) {
      const res = await timedFetch('https://api.elevenlabs.io/v1/user/subscription', {
        headers: { 'xi-api-key': env.ELEVENLABS_API_KEY as string, Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { tier?: string; character_count?: number; character_limit?: number };
      const used = Number(body.character_count ?? 0);
      const limit = Number(body.character_limit ?? 0);
      return {
        quota: { used, limit, unit: 'characters' },
        status: quotaStatus(used, limit),
        detail: `${used.toLocaleString()} / ${limit.toLocaleString()} chars · ${body.tier ?? 'unknown'} tier`,
      };
    },
  },
  {
    id: 'replicate',
    label: 'Replicate',
    category: 'image',
    kind: 'availability',
    topUpUrl: 'https://replicate.com/account/billing',
    configured: (env) => Boolean(env.REPLICATE_API_TOKEN),
    async probe(env) {
      const res = await timedFetch('https://api.replicate.com/v1/account', {
        headers: { Authorization: `Bearer ${env.REPLICATE_API_TOKEN}`, Accept: 'application/json' },
      });
      if (res.status === 401 || res.status === 403) return { status: 'depleted', detail: `Key rejected (HTTP ${res.status})` };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { username?: string };
      return { status: 'healthy', detail: `Key valid${body.username ? ` · @${body.username}` : ''} · usage-billed (no balance API)` };
    },
  },
  {
    id: 'browserbase',
    label: 'Browserbase',
    category: 'browser',
    kind: 'availability',
    topUpUrl: 'https://www.browserbase.com/settings/billing',
    configured: (env) => Boolean(env.BROWSERBASE_API_KEY),
    consoleDetail: 'Key configured · usage-billed (session minutes) — see console',
  },
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    category: 'llm',
    kind: 'console',
    topUpUrl: 'https://console.anthropic.com/settings/billing',
    configured: (env) => Boolean(env.ANTHROPIC_API_KEY),
    consoleDetail: 'No public balance API — manage credits in the Console (build-LLM fallback)',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    category: 'llm',
    kind: 'console',
    topUpUrl: 'https://platform.openai.com/settings/organization/billing/overview',
    configured: (env) => Boolean(env.OPENAI_API_KEY),
    consoleDetail: 'Billing API deprecated for keys — manage in the Platform dashboard',
  },
  {
    id: 'ideogram',
    label: 'Ideogram',
    category: 'image',
    kind: 'console',
    topUpUrl: 'https://ideogram.ai/manage-api',
    configured: (env) => Boolean(env.IDEOGRAM_API_KEY),
    consoleDetail: 'No balance API — manage credits in the Ideogram dashboard',
  },
  {
    id: 'google_places',
    label: 'Google Maps / Places',
    category: 'maps',
    kind: 'console',
    topUpUrl: 'https://console.cloud.google.com/billing',
    configured: (env) => Boolean(env.GOOGLE_PLACES_API_KEY),
    consoleDetail: 'Usage-billed with monthly free tier — manage in Google Cloud Billing',
  },
  {
    id: 'stock_media',
    label: 'Stock media (Pexels · Pixabay · Unsplash)',
    category: 'media',
    kind: 'availability',
    topUpUrl: 'https://www.pexels.com/api/',
    configured: (env) => Boolean(env.PEXELS_API_KEY || env.PIXABAY_API_KEY || env.UNSPLASH_ACCESS_KEY),
    consoleDetail: 'Free tier (rate-limited, no $ balance) — monitor request quotas per provider',
  },
];

/** Build one provider's normalized credit row, fail-soft. */
async function runAdapter(env: Env, a: Adapter): Promise<ProviderCredit> {
  const base: ProviderCredit = {
    id: a.id,
    label: a.label,
    category: a.category,
    kind: a.kind,
    configured: a.configured(env),
    status: 'unknown',
    balanceUsd: null,
    currency: null,
    quota: null,
    detail: '',
    topUpUrl: a.topUpUrl,
  };
  if (!base.configured) {
    return { ...base, status: 'unconfigured', detail: 'API key not set in this environment' };
  }
  if (a.kind === 'console' || !a.probe) {
    return { ...base, status: 'unknown', detail: a.consoleDetail ?? 'Managed in provider console' };
  }
  try {
    const live = await a.probe(env);
    return ProviderCreditSchema.parse({ ...base, ...live });
  } catch (e) {
    return { ...base, status: 'unknown', detail: `Probe failed: ${String(e).slice(0, 80)}` };
  }
}

/**
 * Fetch the full credit report for every credit-based provider, in parallel + fail-soft.
 *
 * @param env - Worker bindings (reads each provider's API key).
 * @returns A Zod-validated {@link CreditReport}.
 * @example
 * const report = await getCreditReport(env);
 * report.providers.find((p) => p.id === 'deepseek')?.status; // 'depleted' when balance ≤ 0
 */
export async function getCreditReport(env: Env): Promise<CreditReport> {
  const settled = await Promise.allSettled(ADAPTERS.map((a) => runAdapter(env, a)));
  const providers = settled.map((s, i) =>
    s.status === 'fulfilled'
      ? s.value
      : ({
          id: ADAPTERS[i].id,
          label: ADAPTERS[i].label,
          category: ADAPTERS[i].category,
          kind: ADAPTERS[i].kind,
          configured: false,
          status: 'unknown' as const,
          balanceUsd: null,
          currency: null,
          quota: null,
          detail: 'Adapter crashed',
          topUpUrl: ADAPTERS[i].topUpUrl,
        } satisfies ProviderCredit),
  );
  const summary = {
    healthy: providers.filter((p) => p.status === 'healthy').length,
    low: providers.filter((p) => p.status === 'low').length,
    depleted: providers.filter((p) => p.status === 'depleted').length,
    unknown: providers.filter((p) => p.status === 'unknown').length,
    unconfigured: providers.filter((p) => p.status === 'unconfigured').length,
  };
  return CreditReportSchema.parse({ providers, checkedAt: Date.now(), summary });
}
