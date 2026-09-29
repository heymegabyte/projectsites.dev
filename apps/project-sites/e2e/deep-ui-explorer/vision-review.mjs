#!/usr/bin/env node
/**
 * vision-review.mjs — routes every Deep UI Explorer capture through a REAL
 * vision model via Cloudflare AI Gateway (`projectsites` gateway — the same
 * routing the Worker's `callExternalLLMWithVision` uses), and stores
 * schema-validated findings + per-image cost/latency. No screenshot is ever
 * "reviewed" by DOM text alone; no image is silently skipped.
 *
 * Model policy (cheap-first, escalate — never skip):
 *   pass 1: gpt-4o-mini (vision)      — every screenshot
 *   pass 2: gpt-4o                    — states with score ≤6, any p0/p1 finding,
 *                                       or key states (overlay/menu/terminal)
 *   fallback: anthropic claude-sonnet — when OPENAI_API_KEY is absent/failing
 *
 * Finding contract (validated before storing; invalid → retried once, then
 * recorded as reviewer-failure — an honest gap, not a fabricated finding):
 *   { dimension: aesthetics|structure|function|a11y_perf|business_value|architecture_hypothesis,
 *     severity: p0|p1|p2|p3, confidence: 0..1, observed, expected, proposal,
 *     persona, region, sourceOwnerHypothesis, acceptanceTest, effort: s|m|l }
 *
 * Redaction: explorer masks password inputs pre-capture; this script scrubs
 * token-shaped strings (psk_*, Bearer …, sk-…) from the TEXT context and never
 * uploads the coverage ledger or manifests — screenshots + compact context only.
 *
 * Usage:
 *   node e2e/deep-ui-explorer/vision-review.mjs                  # latest run
 *   node e2e/deep-ui-explorer/vision-review.mjs <runDir>
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolveSecret } from '../admin-verify/_browserbase-creds.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || '84fa0d1b16ff8086dd958c468ce7fd59';
const GATEWAY = `https://gateway.ai.cloudflare.com/v1/${CF_ACCOUNT_ID}/projectsites`;
const OPENAI_KEY = resolveSecret('OPENAI_API_KEY');
const ANTHROPIC_KEY = resolveSecret('ANTHROPIC_API_KEY');
// CF-native tier-3: Workers AI Llama 4 Scout (the same VISION_MODEL the product's
// /api/vision-qa route uses). Token needs "Workers AI" permission — the Browser-Run
// token minted for the explorer carries it.
const CF_AI_TOKEN = resolveSecret('CF_BROWSER_RUN_TOKEN') || resolveSecret('CLOUDFLARE_API_TOKEN');
const WORKERS_AI_VISION_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';

// $/1M tokens — mirrors src/services/external_llm.ts MODEL_COSTS (input, output).
const COSTS = {
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
};

const DIMENSIONS = [
  'aesthetics',
  'structure',
  'function',
  'a11y_perf',
  'business_value',
  'architecture_hypothesis',
];
const SEVERITIES = ['p0', 'p1', 'p2', 'p3'];

/** Locate the run dir: explicit arg or the newest run under screenshots/deep-ui-explorer. */
function findRunDir() {
  if (process.argv[2]) return resolve(process.argv[2]);
  const root = resolve(__dirname, '../screenshots/deep-ui-explorer');
  const runs = readdirSync(root)
    .filter((d) => d.startsWith('dux-'))
    .map((d) => join(root, d))
    .filter((d) => statSync(d).isDirectory())
    .sort();
  if (!runs.length) throw new Error('no explorer runs found — run explorer.mjs first');
  return runs[runs.length - 1];
}

/** Scrub token-shaped secrets out of text context before it leaves the machine. */
function scrub(text) {
  return String(text || '')
    .replace(/psk_[a-zA-Z0-9_]+/g, 'psk_…')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer …')
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, 'sk-…');
}

/** Validate one finding against the contract; returns null when malformed. */
function validFinding(f) {
  if (!f || typeof f !== 'object') return null;
  if (!DIMENSIONS.includes(f.dimension)) return null;
  if (!SEVERITIES.includes(f.severity)) return null;
  const conf = Number(f.confidence);
  if (!(conf >= 0 && conf <= 1)) return null;
  for (const k of ['observed', 'expected', 'proposal', 'acceptanceTest']) {
    if (typeof f[k] !== 'string' || !f[k].trim()) return null;
  }
  return {
    dimension: f.dimension,
    severity: f.severity,
    confidence: conf,
    observed: f.observed.slice(0, 600),
    expected: f.expected.slice(0, 400),
    proposal: f.proposal.slice(0, 500),
    acceptanceTest: f.acceptanceTest.slice(0, 400),
    persona: String(f.persona || 'business owner').slice(0, 120),
    region: String(f.region || '').slice(0, 160),
    sourceOwnerHypothesis: String(f.sourceOwnerHypothesis || '').slice(0, 240),
    effort: ['s', 'm', 'l'].includes(f.effort) ? f.effort : 'm',
  };
}

function reviewPrompt(state, prevState) {
  return [
    'You are the Visual Intelligence reviewer for ProjectSites.dev (an admin where a busy,',
    'non-technical small-business owner builds + runs their website — the bar is',
    '"embarrassingly easy": succeed on the FIRST try, no manual, no thinking).',
    '',
    'Review ONE screenshot captured after a real UI action in an authenticated session.',
    'Grounded context:',
    `- action that produced this state: ${scrub(state.action)}`,
    `- route: ${state.coords?.route} · surface: ${state.coords?.surface || ''} · overlay: ${state.coords?.overlay || ''} · iframe: ${state.coords?.iframe || 'none'}`,
    `- breadcrumb (prior actions): ${scrub(prevState.map((s) => s.action).join(' → ') || 'run start')}`,
    `- console errors at this state: ${scrub(JSON.stringify(state.consoleErrors || []))}`,
    `- failed network requests: ${scrub(JSON.stringify(state.failedRequests || []))}`,
    `- visible text sample: ${scrub(state.visibleText || '').slice(0, 900)}`,
    '',
    'Report ONLY what the pixels + context genuinely support. Distinguish what the image',
    'PROVES from what needs code/data inspection — put the latter ONLY under the',
    '"architecture_hypothesis" dimension, clearly phrased as a hypothesis.',
    'Do NOT manufacture findings for an acceptable screen: an empty findings array with an',
    'honest score is a valid, welcome result.',
    '',
    'Respond with STRICT JSON (no markdown fence, no prose):',
    '{"score10": <1-10 overall quality for this state>, "summary": "<=200 chars>",',
    ' "findings": [{"dimension":"aesthetics|structure|function|a11y_perf|business_value|architecture_hypothesis",',
    '   "severity":"p0|p1|p2|p3","confidence":0.0-1.0,"observed":"…","expected":"…",',
    '   "proposal":"…","acceptanceTest":"executable check, e.g. a Playwright assertion",',
    '   "persona":"…","region":"where in the screenshot","sourceOwnerHypothesis":"likely file/module or empty",',
    '   "effort":"s|m|l"}]}',
  ].join('\n');
}

async function callOpenAI(model, prompt, imageB64) {
  const t0 = Date.now();
  const res = await fetch(`${GATEWAY}/openai/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: 1400,
      temperature: 0.1,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${imageB64}`, detail: 'high' } },
          ],
        },
      ],
    }),
  });
  const latencyMs = Date.now() - t0;
  if (!res.ok) throw new Error(`openai-gateway ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const usage = body.usage || {};
  const c = COSTS[model] || { input: 0, output: 0 };
  return {
    provider: 'openai-via-ai-gateway',
    model,
    latencyMs,
    text: body.choices?.[0]?.message?.content || '',
    tokens: { input: usage.prompt_tokens || 0, output: usage.completion_tokens || 0 },
    costUsd:
      ((usage.prompt_tokens || 0) * c.input + (usage.completion_tokens || 0) * c.output) / 1e6,
  };
}

async function callAnthropic(model, prompt, imageB64) {
  const t0 = Date.now();
  const res = await fetch(`${GATEWAY}/anthropic/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1400,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageB64 } },
            { type: 'text', text: prompt },
          ],
        },
      ],
    }),
  });
  const latencyMs = Date.now() - t0;
  if (!res.ok) throw new Error(`anthropic-gateway ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const usage = body.usage || {};
  const c = COSTS[model] || { input: 0, output: 0 };
  return {
    provider: 'anthropic-via-ai-gateway',
    model,
    latencyMs,
    text: (body.content || []).map((b) => b.text || '').join(''),
    tokens: { input: usage.input_tokens || 0, output: usage.output_tokens || 0 },
    costUsd: ((usage.input_tokens || 0) * c.input + (usage.output_tokens || 0) * c.output) / 1e6,
  };
}

async function callWorkersAi(prompt, imageB64) {
  const t0 = Date.now();
  // Workers AI OpenAI-compatible endpoint via the same AI Gateway app.
  const res = await fetch(`${GATEWAY}/workers-ai/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${CF_AI_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: WORKERS_AI_VISION_MODEL,
      max_tokens: 1400,
      temperature: 0.1,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${imageB64}` } },
          ],
        },
      ],
    }),
  });
  const latencyMs = Date.now() - t0;
  if (!res.ok) throw new Error(`workers-ai-gateway ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const usage = body.usage || {};
  return {
    provider: 'workers-ai-via-ai-gateway',
    model: WORKERS_AI_VISION_MODEL,
    latencyMs,
    text: body.choices?.[0]?.message?.content || '',
    tokens: { input: usage.prompt_tokens || 0, output: usage.completion_tokens || 0 },
    costUsd: 0, // included in CF account Workers AI allocation; metered there, not per-call here
  };
}

function parseVerdict(text) {
  const raw = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const parsed = JSON.parse(raw);
  const score10 = Number(parsed.score10);
  if (!(score10 >= 1 && score10 <= 10)) throw new Error('score10 out of range');
  const findings = Array.isArray(parsed.findings)
    ? parsed.findings.map(validFinding).filter(Boolean)
    : [];
  return { score10, summary: String(parsed.summary || '').slice(0, 300), findings };
}

async function reviewOne(model, prompt, imageB64) {
  // Provider ladder: OpenAI (when keyed) then Anthropic (when keyed) — a FAILING
  // OpenAI call (429 quota, 5xx) falls through to Anthropic instead of dying.
  const ladder = [];
  if (OPENAI_KEY) ladder.push(() => callOpenAI(model, prompt, imageB64));
  if (ANTHROPIC_KEY) ladder.push(() => callAnthropic('claude-sonnet-4-6', prompt, imageB64));
  if (CF_AI_TOKEN) ladder.push(() => callWorkersAi(prompt, imageB64));
  let lastErr;
  for (const call of ladder) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await call();
        const verdict = parseVerdict(r.text);
        return { ...verdict, meta: { provider: r.provider, model: r.model, latencyMs: r.latencyMs, tokens: r.tokens, costUsd: r.costUsd } };
      } catch (err) {
        lastErr = err;
        // Quota/credit exhaustion → jump to the next provider, don't hammer.
        if (/ 429:|credit balance/i.test(String(err?.message))) break;
      }
    }
  }
  return { failure: String(lastErr?.message || lastErr).slice(0, 300) };
}

// ---------------------------------------------------------------------------
const runDir = findRunDir();
const manifest = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8'));
if (!OPENAI_KEY && !ANTHROPIC_KEY) {
  console.error('BLOCKED: neither OPENAI_API_KEY nor ANTHROPIC_API_KEY available (get-secret).');
  process.exit(2);
}

const results = [];
let totalCost = 0;
console.warn(`▶ vision review of ${manifest.states.length} states in ${runDir}`);
for (const state of manifest.states) {
  const img = join(runDir, state.screenshot);
  if (!existsSync(img)) {
    results.push({ stateId: state.id, key: state.key, failure: 'screenshot missing on disk' });
    continue;
  }
  const b64 = readFileSync(img).toString('base64');
  const prev = manifest.states.filter((s) => s.id < state.id).slice(-6);
  const prompt = reviewPrompt(state, prev);

  let verdict = await reviewOne('gpt-4o-mini', prompt, b64);
  let escalated = false;
  const isKeyState = /overlay|menu|terminal|blocked/i.test(
    `${state.coords?.overlay || ''} ${state.action}`,
  );
  const needsEscalation =
    !verdict.failure &&
    OPENAI_KEY &&
    (verdict.score10 <= 6 || isKeyState || verdict.findings.some((f) => f.severity === 'p0' || f.severity === 'p1'));
  if (needsEscalation) {
    const strong = await reviewOne('gpt-4o', prompt, b64);
    if (!strong.failure) {
      verdict = strong;
      escalated = true;
    }
  }
  if (verdict.meta) totalCost += verdict.meta.costUsd;
  results.push({
    stateId: state.id,
    key: state.key,
    action: state.action,
    screenshot: state.screenshot,
    escalated,
    ...verdict,
  });
  const label = verdict.failure
    ? `REVIEWER-FAILED (${verdict.failure.slice(0, 60)})`
    : `${verdict.score10}/10 · ${verdict.findings.length} finding(s)${escalated ? ' · escalated' : ''}`;
  console.warn(`  [${String(state.id).padStart(2, '0')}] ${label}`);
}

const out = {
  runId: manifest.runId,
  reviewedAt: new Date().toISOString(),
  gateway: GATEWAY.replace(CF_ACCOUNT_ID, '<acct>'),
  statesReviewed: results.filter((r) => !r.failure).length,
  reviewerFailures: results.filter((r) => r.failure).length,
  totalCostUsd: Number(totalCost.toFixed(5)),
  results,
};
writeFileSync(join(runDir, 'vision-findings.json'), JSON.stringify(out, null, 2));
const p01 = results.flatMap((r) => (r.findings || []).filter((f) => f.severity === 'p0' || f.severity === 'p1'));
console.warn(
  `∎ reviewed=${out.statesReviewed}/${manifest.states.length} failures=${out.reviewerFailures} cost=$${out.totalCostUsd} p0/p1=${p01.length}\n  findings: ${join(runDir, 'vision-findings.json')}`,
);
