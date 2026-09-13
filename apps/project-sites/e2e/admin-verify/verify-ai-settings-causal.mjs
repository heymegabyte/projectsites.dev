#!/usr/bin/env node
/**
 * verify-ai-settings-causal.mjs — CAUSAL test for the /admin/settings → AI Chat tab mutations
 * (write→read-back). The AI Chat settings (`allow_web_research` toggle + `chat_system_prompt`)
 * PUT to `/api/sites/:id/ai-settings` and are read back by the same GET the settings form loads
 * from — but NO causal probe covered them. A dropped write here (a lying-success — the toggle
 * flips in the UI + toasts "Saved", but the server never persists it, like the dbInsert-missing-
 * updated_at class) is INVISIBLE to reconcile-surfaces (read-only) and every other probe. This
 * flips the toggle + writes a probe system-prompt, reads each back over the SAME GET the form
 * uses, asserts they persisted, then restores the originals (never leaves the seed mutated).
 *
 * Pure-API on the e2e-test-org seed site (E2E_API_KEY + Origin header — omitting Origin trips
 * Bot Fight). Skips (exit 0) when E2E_API_KEY is unset so forks + secret-less CI stay green.
 *
 * Usage: E2E_API_KEY=$(get-secret E2E_API_KEY) node e2e/admin-verify/verify-ai-settings-causal.mjs
 */
import { resolveE2ESite } from './_resolve-e2e-site.mjs';

const KEY = process.env.E2E_API_KEY;
if (!KEY) {
  console.log('::notice:: verify-ai-settings-causal skipped — E2E_API_KEY unset');
  process.exit(0);
}

const BASE = process.env.PROD_URL || 'https://projectsites.dev';
let SITE_ID = process.env.CAUSAL_SITE_ID || '';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'User-Agent': UA, Origin: BASE };
const api = (path, init = {}) => fetch(`${BASE}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
const unwrap = (d) => d?.data ?? d;

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '🔴'} ${name} — ${detail}`);
};
const getSettings = async () => unwrap(await (await api(`/api/sites/${SITE_ID}/ai-settings`)).json()) ?? {};

try {
  if (!SITE_ID) {
    SITE_ID = (await resolveE2ESite(BASE, KEY, UA)).id;
    if (!SITE_ID) {
      console.log('::notice:: verify-ai-settings-causal skipped — no site on the e2e-test-org to probe');
      process.exit(0);
    }
    console.log(`(auto-resolved CAUSAL_SITE_ID=${SITE_ID})`);
  }

  const orig = await getSettings();
  const origWeb = !!orig.allow_web_research;
  const origPrompt = typeof orig.chat_system_prompt === 'string' ? orig.chat_system_prompt : '';

  // ── A. allow_web_research toggle persists + restores ──────────────────────
  {
    const putStatus = (await api(`/api/sites/${SITE_ID}/ai-settings`, { method: 'PUT', body: JSON.stringify({ allow_web_research: !origWeb }) })).status;
    const after = await getSettings();
    const flipped = !!after.allow_web_research === !origWeb;
    // restore
    await api(`/api/sites/${SITE_ID}/ai-settings`, { method: 'PUT', body: JSON.stringify({ allow_web_research: origWeb }) });
    const restored = !!(await getSettings()).allow_web_research === origWeb;
    record(
      'ai-settings allow_web_research toggle persists + restores',
      putStatus === 200 && flipped && restored,
      `put=${putStatus} flipped=${flipped} restored=${restored} (orig=${origWeb})`,
    );
  }

  // ── B. chat_system_prompt write persists + restores ───────────────────────
  {
    const probe = `PROBE chat prompt ${Date.now()} — you are a friendly assistant.`;
    const putStatus = (await api(`/api/sites/${SITE_ID}/ai-settings`, { method: 'PUT', body: JSON.stringify({ chat_system_prompt: probe }) })).status;
    const after = await getSettings();
    const persisted = after.chat_system_prompt === probe;
    // restore (a null/empty original clears back to the default — send '' to reset)
    await api(`/api/sites/${SITE_ID}/ai-settings`, { method: 'PUT', body: JSON.stringify({ chat_system_prompt: origPrompt }) });
    const back = await getSettings();
    const restored = (typeof back.chat_system_prompt === 'string' ? back.chat_system_prompt : '') === origPrompt;
    record(
      'ai-settings chat_system_prompt write persists + restores',
      putStatus === 200 && persisted && restored,
      `put=${putStatus} persisted=${persisted} restored=${restored}`,
    );
  }
} catch (e) {
  record('probe ran', false, String(e).slice(0, 120));
}

const fails = results.filter((r) => !r.ok).length;
console.log(
  fails === 0
    ? `\nVERDICT: ✅ PASS — ${results.length}/${results.length} ai-settings mutations persisted (toggle + chat prompt write→read-back real, no lying-success).`
    : `\nVERDICT: 🔴 ${fails} FAILED — an ai-settings write did NOT persist (lying-success / dropped write on the AI Chat tab).`,
);
process.exit(fails === 0 ? 0 : 1);
