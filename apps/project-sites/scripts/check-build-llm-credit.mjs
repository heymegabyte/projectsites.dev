// check-build-llm-credit.mjs — operator/loop PRE-FLIGHT diagnostic for the build-LLM balance.
//
// Mirrors the authoritative TS gate `src/services/build_llm_credit.ts` (checked in the workflow),
// as a standalone Node check the golden-journey loop runs BEFORE spending a Browserbase session +
// a ~$5-15 container build. On a dead balance it prints the exact top-up URL and exits 7 so the
// caller bails instead of fast-pathing a degraded, fake "delivered" site.
//
// Keys: env first (DEEPSEEK_API_KEY / ANTHROPIC_API_KEY / BUILD_LLM_PROVIDER), else `get-secret`.
// Exit: 0 = credit OK (or fail-soft transient), 7 = DEFINITIVE dead balance (do not build).
import { execFileSync } from 'node:child_process';

const TOPUP = {
  deepseek: 'https://platform.deepseek.com/top_up',
  anthropic: 'https://console.anthropic.com/settings/billing',
};

function secret(name) {
  if (process.env[name]) return process.env[name];
  try {
    return execFileSync('/Users/Apple/.local/bin/get-secret', [name], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

const DEEPSEEK_API_KEY = secret('DEEPSEEK_API_KEY');
const ANTHROPIC_API_KEY = secret('ANTHROPIC_API_KEY');
const BUILD_LLM_PROVIDER = process.env.BUILD_LLM_PROVIDER || '';

// Same selection as resolveBuildLlmProvider() in the TS gate.
const provider = DEEPSEEK_API_KEY && BUILD_LLM_PROVIDER !== 'anthropic' ? 'deepseek' : 'anthropic';
const key = provider === 'deepseek' ? DEEPSEEK_API_KEY : ANTHROPIC_API_KEY;

function verdict(ok, checked, reason, balance) {
  const tag = ok ? '✓ CREDIT OK' : '❌ NO CREDIT';
  console.log(`${tag} — provider=${provider} checked=${checked} reason=${reason}${balance ? ` balance=${balance}` : ''}`);
  if (!ok) {
    console.log(`::error:: build-LLM ${provider} is out of credit. Top up: ${TOPUP[provider]}`);
    console.log(`  (or set BUILD_LLM_PROVIDER to a provider that HAS credit, if one exists)`);
    process.exit(7);
  }
  process.exit(0);
}

if (!key) verdict(true, false, 'no_api_key_for_active_provider'); // defer to the container's own missing-key path

try {
  if (provider === 'deepseek') {
    const res = await fetch('https://api.deepseek.com/user/balance', {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    });
    if (!res.ok) verdict(true, false, `balance_endpoint_http_${res.status}`); // fail-soft
    const j = await res.json().catch(() => ({}));
    const bal = j?.balance_infos?.[0]?.total_balance;
    const positive = bal !== undefined ? Number(bal) > 0 : true;
    const ok = j?.is_available === true && positive;
    verdict(ok, true, ok ? 'deepseek_balance_ok' : 'deepseek_dead_balance', bal);
  } else {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 1, messages: [{ role: 'user', content: 'x' }] }),
    });
    if (res.ok) verdict(true, true, 'anthropic_credit_ok');
    const j = await res.json().catch(() => ({}));
    const msg = j?.error?.message ?? '';
    if (/credit balance is too low|insufficient|billing/i.test(msg)) verdict(false, true, 'anthropic_dead_balance');
    verdict(true, false, `anthropic_non_credit_http_${res.status}`); // fail-soft on non-credit non-2xx
  }
} catch (e) {
  verdict(true, false, `check_failed_fail_soft:${e?.name || 'unknown'}`); // network blip never blocks
}
