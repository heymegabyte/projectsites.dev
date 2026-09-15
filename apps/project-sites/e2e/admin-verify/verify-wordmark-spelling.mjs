/**
 * verify-wordmark-spelling.mjs — catch the AI-generated `logo-wordmark.png` MISSPELLING the
 * business name (Ideogram text-in-image error). The delivery-visible defect no other gate
 * catches: deliver-verify checks the wordmark LOADS + right aspect; wordmarkTooSquare checks
 * ASPECT; NOTHING reads the wordmark TEXT vs the site's authoritative name. So a well-formed
 * but misspelled banner ships green — twice now (Perennials "PERENNENIALS" AL-477, Heath
 * "Heaath" AL-552).
 *
 * The hard part (AL-553): OCR AUTO-CORRECTS. A vision model reads the WORD IT EXPECTS, so a
 * single transcription of a "Heaath" image often returns the correct "Heath" — a false PASS.
 * That auto-correction is exactly why this defect is so insidious (even OCR reads through it).
 * Countermeasure: MULTI-SAMPLE (K reads, raised temperature, a "transcribe even if misspelled"
 * prompt) and flag a misspelling only when the CLOSE-BUT-INEXACT reading DOMINATES the exact
 * one across samples — the Ideogram signature is a close variant (edit-distance 1-2:
 * "heaath"↔"heath", "perennenials"↔"perennials"), so a fuzzy compare misses it and a single
 * exact read can't clear it.
 *
 * OCR backends (in preference order):
 *   1. AL-607 — LITERAL classical OCR via the `tesseract` CLI (when installed). tesseract does
 *      NOT auto-correct — it reads the baked characters, so it sees "ANIVIL"/"Heaath"/"PERENNENIALS"
 *      where the vision-LM reads through the typo. Deterministic → 3 PSM modes; a close-variant that
 *      dominates with NO exact read is a confident FAIL. This is what finally ACTIVATES the gate
 *      (empirically: on the live Anvil wordmark tesseract reads "ANIVIL", dist-1 from "anvil").
 *   2. Workers AI vision `@cf/meta/llama-3.2-11b-vision-instruct` (CF-native) — K-sample fallback
 *      when tesseract is absent/inconclusive; it auto-corrects, hence the multi-sample dominance rule.
 *   3. OpenAI gpt-4o-mini — only if its balance isn't exhausted.
 * The site's declared NAME is the authoritative signal ([[authoritative-signal-immutable-against-unreliable-generator]]).
 *
 * FAIL only on a DOMINANT close-variant with no exact read (tesseract: ≥2/3 PSM modes; vision-LM:
 * closeCount ≥ 2 AND > exactCount across K). Fail-OPEN on everything else — exact-dominant, all-noise,
 * no backend, 404 wordmark (→ Header's always-correct styled TEXT wordmark) — per
 * validator-precision-discipline (prefer false-negatives).
 *
 * Run: SLUG=anvil-bar-houston \
 *   CLOUDFLARE_API_KEY=$(get-secret CLOUDFLARE_API_KEY) CLOUDFLARE_EMAIL=blzalewski@gmail.com \
 *   node e2e/admin-verify/verify-wordmark-spelling.mjs
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const HOST = 'projectsites.dev';
const SLUG = process.env.SLUG || 'harborline-coffee-roasters-boston';
const BASE = `https://${SLUG}.${HOST}`;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const CF_ACCT = process.env.CLOUDFLARE_ACCOUNT_ID || '84fa0d1b16ff8086dd958c468ce7fd59';
const CF_KEY = process.env.CLOUDFLARE_API_KEY;
const CF_EMAIL = process.env.CLOUDFLARE_EMAIL || 'blzalewski@gmail.com';
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const K = Number(process.env.WORDMARK_OCR_SAMPLES || 6);
const PROMPT =
  'Transcribe the EXACT characters shown in this logo image, letter for letter, even if it ' +
  'looks like a misspelling or nonstandard word. Output ONLY the raw characters, nothing else.';
const skip = (msg) => {
  console.log(`::notice:: verify-wordmark-spelling skipped — ${msg}`);
  process.exit(0);
};

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

/** Classify ONE sample vs the name: 'exact' (a name word verbatim), 'close' (a near variant), or 'other'. */
function classifySample(nameWords, sample) {
  const ocrWords = [...new Set(norm(sample).split(' '))].filter((w) => w.length >= 3);
  if (!ocrWords.length) return { kind: 'other' };
  for (const nw of nameWords) if (ocrWords.includes(nw)) return { kind: 'exact', word: nw };
  for (const nw of nameWords)
    for (const ow of ocrWords) {
      const dist = editDistance(nw, ow);
      if (dist >= 1 && dist <= 2 && Math.abs(ow.length - nw.length) <= 2)
        return { kind: 'close', nameWord: nw, ocrWord: ow, dist };
    }
  return { kind: 'other' };
}

function extractName(html) {
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(m[1].trim());
      const nodes = Array.isArray(parsed) ? parsed : parsed['@graph'] ? parsed['@graph'] : [parsed];
      for (const n of nodes)
        if (/Organization|LocalBusiness/i.test(String(n?.['@type'] || '')) && typeof n.name === 'string' && n.name.trim())
          return n.name.trim();
    } catch {
      /* ignore */
    }
  }
  const og = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i);
  if (og?.[1]?.trim()) return og[1].trim();
  const title = html.match(/<title>([^<]+)<\/title>/i);
  if (title?.[1]) return title[1].split(/[—|]/)[0].trim();
  return '';
}

async function ocrOnce(bytes) {
  if (CF_KEY) {
    try {
      const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCT}/ai/run/@cf/meta/llama-3.2-11b-vision-instruct`, {
        method: 'POST',
        headers: { 'X-Auth-Email': CF_EMAIL, 'X-Auth-Key': CF_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: [...bytes], prompt: PROMPT, max_tokens: 40, temperature: 0.7 }),
      });
      const j = await r.json();
      if (r.ok && j.success && j.result?.response) return { text: j.result.response, engine: 'workers-ai' };
    } catch {
      /* fall through */
    }
  }
  if (OPENAI_KEY) {
    try {
      const dataUri = `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          temperature: 0,
          max_tokens: 40,
          messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }, { type: 'image_url', image_url: { url: dataUri } }] }],
        }),
      });
      const j = await r.json();
      if (r.ok && j.choices?.[0]?.message?.content) return { text: j.choices[0].message.content, engine: 'openai' };
    } catch {
      /* fall through */
    }
  }
  return null;
}

/**
 * LITERAL OCR via the `tesseract` CLI (AL-607) — deterministic + no auto-correct. Runs 3 PSM
 * modes; each read is augmented with a de-spaced join so a letter-tracked wordmark ("ANI V IL")
 * still fuzzy-matches the name word ("anvil"). Returns [] when the binary is absent (ENOENT) or
 * every mode errors → the caller falls back to the vision-LM (fail-open).
 */
function ocrTesseract(bytes) {
  const tmp = join(tmpdir(), `wordmark-${process.pid}.png`);
  const reads = [];
  try {
    writeFileSync(tmp, bytes);
    for (const psm of [7, 11, 6]) {
      try {
        const out = execFileSync('tesseract', [tmp, 'stdout', '--psm', String(psm)], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 15000,
        }).trim();
        // Append the fully de-spaced join so classifySample sees "anivil" (not "ani"/"v"/"il")
        // and the dist-1 close-variant compare against "anvil" fires despite letter-tracking.
        if (out) reads.push(`${out} ${norm(out).replace(/\s+/g, '')}`);
      } catch {
        /* this PSM mode (or the binary) failed — try the next; all-fail → [] → vision-LM */
      }
    }
  } catch {
    /* temp write failed → [] → caller falls back */
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
  return reads;
}

const htmlRes = await fetch(BASE + '/', { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' } });
if (!htmlRes.ok) skip(`${BASE} → HTTP ${htmlRes.status}`);
const name = extractName(await htmlRes.text());
if (!name) skip('could not read authoritative name from site head');
const nameWords = [...new Set(norm(name).split(' '))].filter((w) => w.length >= 4);
if (!nameWords.length) skip(`no significant name words in "${name}"`);

const wmRes = await fetch(`${BASE}/logo-wordmark.png`, { headers: { 'User-Agent': UA } });
if (!wmRes.ok) {
  console.log(JSON.stringify({ slug: SLUG, name, wordmark: `HTTP ${wmRes.status}`, verdict: '✅ PASS (no image → styled text wordmark)' }));
  process.exit(0);
}
const bytes = new Uint8Array(await wmRes.arrayBuffer());

// ── PREFERRED: literal tesseract (deterministic, no auto-correct) — this ACTIVATES the gate.
// A close-variant that dominates the 3 PSM reads with NO exact read is a high-confidence typo
// (a real baked misspelling reads close CONSISTENTLY across modes; random garble does not).
const tessReads = ocrTesseract(bytes);
if (tessReads.length >= 2) {
  const tf = tessReads.map((s) => ({ sample: s.slice(0, 40), ...classifySample(nameWords, s) }));
  const tExact = tf.filter((f) => f.kind === 'exact').length;
  const tClose = tf.filter((f) => f.kind === 'close').length;
  const tCloseEx = tf.find((f) => f.kind === 'close');
  const tDetail = {
    slug: SLUG,
    authoritativeName: name,
    engine: 'tesseract',
    reads: tf.map((f) => `${f.kind}:${JSON.stringify(f.sample)}`),
    exactCount: tExact,
    closeCount: tClose,
  };
  if (tClose >= 2 && tExact === 0) {
    console.log(JSON.stringify({ ...tDetail, verdict: '❌ FAIL — wordmark misspells the business name (literal OCR)' }, null, 2));
    console.log(
      `❌ FAIL — logo-wordmark.png renders "${tCloseEx?.ocrWord}" where the name has "${tCloseEx?.nameWord}" ` +
        `(tesseract read it LITERALLY in ${tClose}/${tessReads.length} PSM modes — not a vision-LM auto-correct artifact). ` +
        `Root fix: build-time OCR-gate → discard the wordmark → styled TEXT fallback.`,
    );
    process.exit(1);
  }
  if (tExact >= 2 && tClose === 0) {
    console.log(JSON.stringify({ ...tDetail, verdict: '✅ PASS (literal OCR)' }, null, 2));
    console.log(`✅ PASS — wordmark spelling OK for "${name}" (tesseract exact=${tExact} close=${tClose} of ${tessReads.length})`);
    process.exit(0);
  }
  // tesseract mixed/garbled → inconclusive → fall through to the vision-LM below.
}

if (!CF_KEY && !OPENAI_KEY) skip('tesseract inconclusive/absent + no vision OCR backend (set CLOUDFLARE_API_KEY or OPENAI_API_KEY)');

const samples = [];
for (let i = 0; i < K; i++) {
  const o = await ocrOnce(bytes);
  if (o) samples.push(o.text.trim());
}
if (!samples.length) skip('OCR backend returned nothing (429 / error) — fail-open');

const findings = samples.map((s) => ({ sample: s.slice(0, 40), ...classifySample(nameWords, s) }));
const exactCount = findings.filter((f) => f.kind === 'exact').length;
const closeCount = findings.filter((f) => f.kind === 'close').length;
const closeEx = findings.find((f) => f.kind === 'close');

// TRI-STATE — never falsely PASS a defective site (a lying-green is worse than no probe):
//   FAIL  = close-variant reading DOMINATES (the image really renders the typo).
//   PASS  = exact reading DOMINATES (the name is confidently spelled right).
//   SKIP  = OCR too noisy to be confident either way (llama-3.2-vision returns partial/
//           auto-corrected reads on stylized wordmarks; OpenAI gpt-4o is credit-exhausted).
const misspelled = closeCount >= 2 && closeCount > exactCount;
const confidentCorrect = exactCount >= 2 && exactCount >= closeCount;
const detail = { slug: SLUG, authoritativeName: name, samples: findings.map((f) => `${f.kind}:${JSON.stringify(f.sample)}`), exactCount, closeCount };

if (misspelled) {
  console.log(JSON.stringify({ ...detail, verdict: '❌ FAIL — wordmark misspells the business name' }, null, 2));
  console.log(
    `❌ FAIL — logo-wordmark.png renders "${closeEx?.ocrWord}" where the name has "${closeEx?.nameWord}" ` +
      `(Ideogram baked a misspelling; ${closeCount}/${samples.length} reads close-but-wrong). ` +
      `Root fix: build-time OCR-gate → discard → styled text fallback.`,
  );
  process.exit(1);
}
if (confidentCorrect) {
  console.log(JSON.stringify({ ...detail, verdict: '✅ PASS' }, null, 2));
  console.log(`✅ PASS — wordmark spelling OK for "${name}" (exact=${exactCount} close=${closeCount} of ${samples.length})`);
  process.exit(0);
}
// Inconclusive — do NOT claim PASS (never lie about a site we couldn't read).
console.log(JSON.stringify({ ...detail, verdict: '⚠ SKIP (inconclusive OCR)' }, null, 2));
skip(`inconclusive OCR for "${name}" (exact=${exactCount} close=${closeCount} of ${samples.length}) — needs gpt-4o credits or a sharper OCR backend`);
