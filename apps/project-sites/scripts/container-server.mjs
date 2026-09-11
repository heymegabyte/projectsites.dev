#!/usr/bin/env node
/**
 * container-server.mjs — HTTP server inside SiteBuilderContainer
 *
 * Runs as root (needed for `su cuser`). Exposes:
 *   POST /build   → start async Claude Code job, return { jobId }
 *   GET  /status  → heartbeat polling for a job
 *   GET  /result  → fetch files + status when complete
 *   GET  /health  → liveness probe
 *
 * Job state is persisted to /var/jobs/{jobId}.json so the workflow's
 * heartbeat polling survives container hibernation/restart. Jobs that
 * were running when the container restarted are marked errored on boot
 * (the spawned Claude Code child died with the container).
 */
import { execSync as x, spawn as sp, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import http from 'http';
import crypto from 'crypto';

const JOBS_DIR = '/var/jobs';
const SKILLS_DIR = '/home/cuser/.agentskills';
const TEMPLATE_DIR = '/home/cuser/template';
// AL-345 container-code revision marker — proves WHICH container-server.mjs the running
// image executes. Written into every build's dist/ps-build-diag.txt so a live curl reveals
// whether the deployed image actually runs the latest code (theme-sidecar deploy debug).
const CONTAINER_BUILD_REV = 'al345-sidecar-diag-1';

try { fs.mkdirSync(JOBS_DIR, { recursive: true }); } catch {}

let CP = '/usr/local/bin/claude';
try { CP = x('which claude', { encoding: 'utf-8' }).trim(); } catch {}
console.warn('[boot] Claude at:', CP);

function refreshRepo(prefix, label, dir) {
  try {
    // claude-skills uses master, template uses main — detect the remote HEAD
    // ref instead of hardcoding either one.
    x(
      `cd ${dir} && BR=$(git remote show origin 2>/dev/null | sed -n 's/.*HEAD branch: //p') && BR=\${BR:-main} && ` +
      `git fetch --depth=1 origin "$BR" 2>&1 && git reset --hard "origin/$BR" 2>&1`,
      { timeout: 30000, shell: true, encoding: 'utf-8' },
    );
    console.warn(`[${prefix}] ${label} updated`);
    return true;
  } catch (e) {
    console.warn(`[${prefix}] ${label} pull failed:`, e.message.slice(0, 100));
    return false;
  }
}

// Sync universal agents from megabytespace/claude-skills into ~/.claude/agents/
// without clobbering project-specific agents (which were COPY'd in the
// Dockerfile after the cp). Runs after every claude-skills git-pull so
// upstream agent edits land in the orchestrator within 10 minutes.
const AGENTS_DST = '/home/cuser/.claude/agents';
const AGENTS_SRC = `${SKILLS_DIR}/agents`;
const PROJECT_AGENTS = new Set(['domain-builder.md', 'validator-fixer.md']);

function syncAgents(prefix) {
  try {
    fs.mkdirSync(AGENTS_DST, { recursive: true });
    if (!fs.existsSync(AGENTS_SRC)) return;
    let copied = 0;
    for (const f of fs.readdirSync(AGENTS_SRC)) {
      if (!f.endsWith('.md')) continue;
      if (PROJECT_AGENTS.has(f)) continue; // never overwrite project overrides
      try {
        fs.copyFileSync(path.join(AGENTS_SRC, f), path.join(AGENTS_DST, f));
        copied++;
      } catch {}
    }
    console.warn(`[${prefix}] Synced ${copied} universal agents`);
  } catch (e) {
    console.warn(`[${prefix}] agent sync failed:`, e.message.slice(0, 100));
  }
}

refreshRepo('boot', 'Skills', SKILLS_DIR);
refreshRepo('boot', 'Template', TEMPLATE_DIR);
syncAgents('boot');

// Long-lived Durable Object containers don't reboot for days — refresh every 10min
// so megabytespace/claude-skills updates land without redeploying the worker.
let lastRefresh = Date.now();
function maybeRefreshSkills() {
  if (Date.now() - lastRefresh < 10 * 60 * 1000) return;
  lastRefresh = Date.now();
  refreshRepo('refresh', 'Skills', SKILLS_DIR);
  refreshRepo('refresh', 'Template', TEMPLATE_DIR);
  syncAgents('refresh');
}

const jobs = {};

function jobPath(jobId) { return path.join(JOBS_DIR, `${jobId}.json`); }

function saveJob(jobId) {
  if (!jobs[jobId]) return;
  try { fs.writeFileSync(jobPath(jobId), JSON.stringify(jobs[jobId])); } catch {}
}

function deleteJob(jobId) {
  delete jobs[jobId];
  try { fs.unlinkSync(jobPath(jobId)); } catch {}
}

function loadJobs() {
  try {
    for (const f of fs.readdirSync(JOBS_DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(JOBS_DIR, f), 'utf-8'));
        if (j && j.jobId) jobs[j.jobId] = j;
      } catch {}
    }
    console.warn(`[boot] Loaded ${Object.keys(jobs).length} jobs from disk`);
  } catch {}
}

loadJobs();

for (const id of Object.keys(jobs)) {
  if (jobs[id].status === 'running') {
    jobs[id].status = 'error';
    jobs[id].error = 'container restarted mid-build — process lost';
    jobs[id].step = 'done';
    saveJob(id);
    console.warn(`[boot] Marked orphaned job ${id} as error`);
  }
}

// Self-keepalive: while any job is running, hit /health every 60s. This keeps the Node
// event loop active and signals "activity" to CF Container infrastructure to prevent
// idle DO hibernation. Without this, the workflow's KV-based heartbeat froze at the
// 2-min mark when the DO went idle after the initial /build POST returned.
setInterval(() => {
  const hasRunning = Object.values(jobs).some(j => j && j.status === 'running');
  if (!hasRunning) return;
  fetch('http://localhost:8080/health').catch(() => {});
}, 60_000);

function liveFileCount(dir) {
  if (!dir) return 0;
  let n = 0;
  const walk = (d) => {
    try {
      for (const f of fs.readdirSync(d)) {
        if (f.startsWith('_') || f === 'node_modules' || f === '.git' || f === '.claude') continue;
        const fp = path.join(d, f);
        const st = fs.statSync(fp);
        if (st.isDirectory()) walk(fp);
        else if (st.isFile() && st.size > 0) n++;
      }
    } catch {}
  };
  walk(dir);
  return n;
}

function pushStatus(jobId) {
  const j = jobs[jobId];
  if (!j || !j.callbackUrl || !j.callbackSecret) return;
  const liveCount = j.status === 'running' && j.dir ? liveFileCount(j.dir) : 0;
  const finalCount = j.files ? j.files.length : 0;
  const payload = {
    jobId,
    status: j.status,
    step: j.step,
    elapsed: ((Date.now() - j.startTime) / 1000) | 0,
    fileCount: finalCount || liveCount,
    error: j.error ? String(j.error).slice(0, 500) : null,
    uploadResult: j.uploadResult || null,
    functionsBuild: j.functionsBuild ?? null,
  };
  const body = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', j.callbackSecret).update(body).digest('hex');
  fetch(j.callbackUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Build-Sig': sig },
    body,
  }).then(res => {
    if (!res.ok) console.warn(`[${jobId}] callback HTTP ${res.status}`);
  }).catch(e => console.warn(`[${jobId}] callback err: ${e.message}`));
}

function setStatus(jobId, patch) {
  if (!jobs[jobId]) return;
  Object.assign(jobs[jobId], patch);
  saveJob(jobId);
  pushStatus(jobId);
  maybeSelfTerminate(jobId);
}

// ── SELF-TERMINATE AFTER BUILD (warm-container image-skew fix, 2026-08-26) ──
// The singleton SITE_BUILDER runs max_instances=20; warm instances PERSIST on
// OLD image versions across deploys, so each build hits whichever is free → the
// pipeline was non-deterministically thin/misclassified (fires 12-15) because a
// deployed fix (self-heal, classifier) wasn't live on the instance that served
// the build. FIX: once a job reaches a TERMINAL state (step 'done') AND no other
// job is running, `process.exit(0)` after a short grace. A hard exit stops the
// container → the NEXT /build cold-starts a FRESH instance on the LATEST image →
// no version skew. Bounded downside: at worst an extra cold-start — NEVER a broken
// build, because this fires only AFTER a terminal setStatus (+ its HMAC callback)
// and only when idle. Self-converging: every instance drains + exits after its
// batch, so within a fire or two ALL instances run the latest image.
let selfTerminateTimer = null;
function maybeSelfTerminate(jobId) {
  const j = jobs[jobId];
  if (!j || j.step !== 'done') return; // only on terminal completion
  if (Object.values(jobs).some((x) => x && x.status === 'running')) return; // concurrent build in flight
  if (selfTerminateTimer) clearTimeout(selfTerminateTimer);
  // 8s grace: lets the terminal HMAC callback flush AND lets a rapidly-arriving
  // follow-up /build cancel the exit (re-checked below) so back-to-back jobs on
  // one instance don't thrash.
  selfTerminateTimer = setTimeout(() => {
    if (Object.values(jobs).some((x) => x && x.status === 'running')) return; // a new build arrived
    console.warn('[self-terminate] build drained, no jobs running → exit(0); next build cold-starts on the latest image');
    process.exit(0);
  }, 8000);
}

// Boot-time push: surface any orphan errors marked above to KV via callback NOW so
// the workflow's next heartbeat sees status=error instead of waiting 8 minutes for
// stale threshold to expire.
for (const id of Object.keys(jobs)) {
  if (jobs[id].status === 'error') {
    try { pushStatus(id); } catch {}
  }
}

function collectFiles(dir, base = '') {
  const files = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith('_') || f === 'node_modules' || f === '.git' || f === '.claude') continue;
      const fp = path.join(dir, f);
      const rel = base ? `${base}/${f}` : f;
      const st = fs.statSync(fp);
      if (st.isDirectory()) files.push(...collectFiles(fp, rel));
      else if (st.isFile() && st.size > 0 && st.size < 500000) {
        try { files.push({ name: rel, content: fs.readFileSync(fp, 'utf-8') }); } catch {}
      }
    }
  } catch {}
  return files;
}

// ═══════════════════════════════════════════════════════════════════════════
// DETERMINISTIC TEMPLATE-TOKEN SAFETY NET + POST-BUILD GATE
// ───────────────────────────────────────────────────────────────────────────
// Root cause (journey 2026-08-22, e.g. summit-peak-pt): the template ships every
// page as TypeScript with single-brace {TOKEN} placeholders — {BUSINESS_NAME},
// {HERO_SUBHEADLINE}, {ABOUT_HEADLINE}, {BLOG_1_TITLE}, {CS_1_CLIENT}, {FAQ_*},
// {STAT_*}, {TIER_*}, … (hundreds across src/**/*.tsx + index.html + public/**
// + _brand.json). The orchestrator is TOLD to fill them but nothing GUARANTEES
// it — a partial/failed generation ships raw {TOKEN}s to the live site.
//
// This is the guarantee: after the orchestrator finishes, deterministically fill
// EVERY remaining content token from the job's context (whatever _content.json /
// _brand.json / _research.json / params landed in the build dir), and for any
// token still unfilled substitute a SAFE fallback by semantics so ZERO {TOKEN}
// can survive. Then a post-build GATE greps dist/ and FAILS the job if any leak.
// Pure w.r.t. inputs (fillTemplateTokens/distUnfilledTokens are unit-checkable).
// ═══════════════════════════════════════════════════════════════════════════

// A content token = {ALL_CAPS_SNAKE} in a string/text position. A JS-expression
// token (`={IDENT}` JSX container or `${IDENT}` template-literal interpolation,
// e.g. sw.js `${CACHE_VERSION}`) is NOT content — replacing it corrupts source.
// Discriminate on the char immediately before `{`: `=`/`$` = JS-expr (skip).
const TEMPLATE_TOKEN_RE = /(^|[^=$])\{([A-Z][A-Z0-9_]+)\}/g;
const TEMPLATE_TEXT_EXT = new Set([
  '.tsx', '.ts', '.jsx', '.js', '.mjs', '.html', '.htm', '.css',
  '.json', '.xml', '.txt', '.svg', '.webmanifest', '.md',
]);

/** Recursively list text files under `root` (skips node_modules/.git/dist/.claude). */
function walkTemplateTextFiles(root, acc = []) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist' || e.name === '.claude') continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) walkTemplateTextFiles(full, acc);
    else if (TEMPLATE_TEXT_EXT.has(path.extname(e.name).toLowerCase())) acc.push(full);
  }
  return acc;
}

// The surfaces the build reads + ships: source pages/components, the SPA shell,
// public/** (Vite copies verbatim into dist/), AND root _brand.json — brand.ts
// imports it (bundled into assets/index-*.js) and build-feeds.mjs postbuild reads
// it raw, so its {BUSINESS_*} $value leaves re-emit into dist/ if left tokenized.
function templateFillSurfaces(dir) {
  const out = [];
  for (const sub of ['src', 'public']) {
    const p = path.join(dir, sub);
    if (fs.existsSync(p)) out.push(...walkTemplateTextFiles(p));
  }
  for (const rootFile of ['index.html', '_brand.json']) {
    const p = path.join(dir, rootFile);
    if (fs.existsSync(p)) out.push(p);
  }
  return out;
}

// Strip JS comments so a token documented in JSDoc/comments (e.g. `{TOKEN}` in a
// doc block, `{FEATURE_N_TITLE}` in a note) is never treated as fillable content.
// NEVER strip .html/.svg/.txt/.md/.json/.xml — `//` and `<...>` are content there.
function stripJsComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Best-effort content map from whatever context files landed in the build dir.
 * Priority: _content.json (explicit token→value) > _brand.json business $value
 * leaves > _research.json profile. Returns a flat { TOKEN: string } map.
 */
function loadContentMap(dir) {
  const map = {};
  const readJson = (name) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8')); } catch { return null; }
  };
  // 1. _content.json — the ideal explicit token→value map (may or may not exist).
  const content = readJson('_content.json');
  if (content && typeof content === 'object') {
    for (const [k, v] of Object.entries(content)) {
      if (typeof v === 'string' || typeof v === 'number') map[k] = String(v);
    }
  }
  // 2. _brand.json business leaves → the BUSINESS_* tokens (don't overwrite _content.json).
  const brand = readJson('_brand.json');
  const biz = (brand && brand.business) || {};
  const leaf = (l) => (l && typeof l === 'object' && typeof l.$value === 'string' ? l.$value : (typeof l === 'string' ? l : ''));
  const put = (k, v) => { if (v && !map[k]) map[k] = v; };
  put('BUSINESS_NAME', leaf(biz.name));
  put('BUSINESS_SHORT_NAME', leaf(biz.shortName));
  put('BUSINESS_TAGLINE', leaf(biz.tagline));
  put('BUSINESS_DESCRIPTION', leaf(biz.description));
  put('BUSINESS_URL', leaf(biz.url));
  put('BUSINESS_EMAIL', leaf(biz.email) || leaf(biz.contactEmail));
  put('BUSINESS_PHONE', leaf(biz.phone));
  put('BUSINESS_ADDRESS', leaf(biz.address));
  put('BUSINESS_HOURS', leaf(biz.hours));
  put('BUSINESS_CLASS', leaf(biz.businessClass));
  // SEO: {BUSINESS_DESCRIPTION} drives <meta name="description"> in index.html. `put`
  // skips an empty brand description, which then ships as an EMPTY meta (confirmed on
  // live sites) — a real SERP defect. Guarantee a non-empty description: content-pack
  // SEO_DESCRIPTION (a real 120-156 char line, already loaded from _content.json above)
  // → else a sentence composed from the identity tokens. Anything real beats empty.
  if (!map['BUSINESS_DESCRIPTION']) {
    const bn = map['BUSINESS_NAME'] || '';
    const tl = map['BUSINESS_TAGLINE'] || '';
    const cls = (map['BUSINESS_CLASS'] || '').replace(/[-_]/g, ' ').trim();
    const city =
      (map['BUSINESS_ADDRESS'] || '').split(',').map((s) => s.trim()).filter(Boolean).slice(-2, -1)[0] || '';
    const composed = bn
      ? `${bn}${tl ? ` — ${tl}` : ''}.${cls ? ` ${cls.charAt(0).toUpperCase()}${cls.slice(1)}` : ''}${city ? ` in ${city}` : ''}.`.trim()
      : '';
    const fallback = map['SEO_DESCRIPTION'] || composed;
    if (fallback) map['BUSINESS_DESCRIPTION'] = fallback;
  }
  // 3. _research.json profile as a last-resort source for the identity tokens.
  const research = readJson('_research.json');
  const prof = (research && research.profile) || {};
  put('BUSINESS_NAME', typeof prof.name === 'string' ? prof.name : '');
  put('BUSINESS_PHONE', typeof prof.phone === 'string' ? prof.phone : '');
  put('BUSINESS_EMAIL', typeof prof.email === 'string' ? prof.email : '');
  // Drop any value that is itself a placeholder (a token pointing at a token).
  for (const k of Object.keys(map)) {
    if (typeof map[k] !== 'string' || map[k].trim() === '' || /^\{[A-Z0-9_]+\}$/.test(map[k].trim())) delete map[k];
  }
  return map;
}

/**
 * Deterministic vertical → brand-preset selector. The orchestrator is TOLD to
 * `cp examples/_brand.<vertical>.json _brand.json`, but it crashes/truncates
 * often enough that theme selection cannot depend on it (journey 2026-08-24:
 * a dentist build shipped the DARK default because the orchestrator died before
 * the cp). Classify the vertical from the deterministic signals already in the
 * build dir (slug + prompt + research/content/brand JSON) so the container can
 * force the right preset regardless of orchestrator health.
 * @returns the preset filename under examples/, or '' when no confident match.
 */
function pickVerticalPreset(dir, promptText = '') {
  const read = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf-8'); } catch { return ''; } };
  const leaf = (l) => (l && typeof l === 'object' && typeof l.$value === 'string' ? l.$value : (typeof l === 'string' ? l : ''));
  let brand = {};
  try { brand = JSON.parse(read('_brand.json')); } catch { /* absent */ }
  const biz = (brand && brand.business) || {};
  // PRIMARY = the business's OWN authoritative identity (slug + name/type/desc),
  // weighted 10× below so incidental research text (e.g. a Google Places match on
  // the address surfacing a NEARBY restaurant) can't hijack the vertical — the
  // 2026-08-25 bug where "Flowdesk Analytics" (software) got the restaurant vertical.
  const primary = [
    path.basename(dir), leaf(biz.name), leaf(biz.shortName),
    leaf(biz.tagline), leaf(biz.description), leaf(biz.businessClass),
    // The EXPLICIT business TYPE / CATEGORY the user gave is the single most
    // authoritative vertical signal — weight it as identity (10×) so a declared
    // "farm-to-table restaurant" wins RESTAURANT over nonprofit-flavored research
    // noise (harvest-vine-burlington 2026-08-26: a restaurant shipped as a
    // nonprofit — "Together We Do More Good" — because type wasn't in primary).
    leaf(biz.businessType), leaf(biz.business_type), leaf(biz.category),
    leaf(biz.type), leaf(biz.vertical),
  ].join(' ').toLowerCase();
  // SECONDARY = broad, noisier context (prompt + research + content).
  let secondary = String(promptText || '').toLowerCase();
  for (const f of ['_content.json', '_research.json']) secondary += ' ' + read(f).toLowerCase();
  // Leading \b + STEM match (no trailing \b) so inflections resolve: dentist→
  // "dentistry", plumb→"plumbing", landscap→"landscaping", photograph→
  // "photography", charit→"charitable". Short/ambiguous tokens carry an explicit
  // trailing \b (spa\b not "space", law\b not "lawn", app\b not "apparel").
  const rules = [
    // Dental = its OWN vertical (light, dentistry copy). Placed BEFORE medical so a
    // tie favors it; dental terms were REMOVED from the medical regex below so a
    // general family-medicine practice no longer renders dentistry copy — the medical
    // pack WAS 100% dental ("Cleanings & Exams/Invisalign", fire-29). Pairs with the
    // template's examples/_brand.dental.json + _content.dental.json. Both stay LIGHT.
    ['_brand.dental.json', /\b(dentist|dental|orthodont|endodont|periodont|prosthodont|oral surgeon|oral surgery|dds\b|dmd\b|teeth|tooth|hygienist|smile makeover)/],
    ['_brand.medical.json', /\b(doctor|physician|clinic|medical|health|hospital|chiropract|dermatolog|pediatric|veterinar|optometr|ophthalmolog|physical therapy|physiotherap|physio|urgent care|family medicine|primary care|internal medicine|surgeon|cardiolog|pharmac)/],
    // Fitness = its OWN vertical (dark, strength-gym copy), NOT wellness. Placed
    // before wellness so a tie favors it; gym/fitness/strength terms were REMOVED
    // from the wellness regex below so a strength gym no longer scores wellness
    // (it rendered yoga copy + LIGHT theme — fire-20). Kept out of
    // LIGHT_VERTICAL_PRESETS so fitness stays DARK. Pairs with the template's
    // examples/_brand.fitness.json + _content.fitness.json pack.
    ['_brand.fitness.json', /\b(gym\b|crossfit|cross-fit|fitness|strength training|strength and conditioning|barbell|powerlifting|power lifting|weightlifting|weight lifting|olympic lifting|personal trainer|personal training|bootcamp|boot camp|kettlebell|calisthenics|athletic club|hiit\b|martial arts|karate|taekwondo|jiu-jitsu|jiu jitsu|judo|muay thai|kickboxing|\bdojo\b)/],
    ['_brand.wellness.json', /\b(yoga|pilates|spa\b|massage|wellness|meditation|salon|beaut|nail|barber|acupunctur|reiki|nutrition|wellbeing|well-being)/],
    // Legal = the professional-services vertical (light, trust/credential copy). Per the
    // orchestrator CLAUDE.md it covers lawyer/attorney AND accountant/CPA/tax/bookkeeping/
    // financial-advisor/insurance — all professional-services that render the same LIGHT
    // credential-forward pack (fire-85: those 6 were falling through / hitting agency).
    ['_brand.legal.json', /\b(law\b|lawyer|attorney|legal|counsel|litigation|paralegal|notary|estate planning|llp\b|accountant|accounting|\bcpa\b|\btax\b|tax prep|bookkeep|financial advis|financial plan|wealth management|insurance)/],
    // "kitchen" is a strong restaurant signal (Hell's Kitchen, The Kitchen) BUT "soup
    // kitchen" is a NONPROFIT — the negative lookbehind lets restaurant keep "kitchen"
    // while letting "soup kitchen" fall through to the nonprofit rule below (fire-85: a
    // declared "soup kitchen" category was shipping as a restaurant since restaurant is
    // checked before nonprofit and grabbed the bareword "kitchen").
    ['_brand.restaurant.json', /\b(restaurant|restaurateur|farm-to-table|farm to table|cafe|café|coffee|bakery|bar\b|bistro|dining|gastropub|osteria|trattoria|ramen|sushi|diner|eatery|catering|pizzeria|brewery|food truck|(?<!soup )kitchen|chophouse|smokehouse|noodle|burger|barbecue|bbq\b|tavern|pub\b|creamery|gelato|ice cream|grill|steakhouse|winery|vineyard|taqueria|deli\b)/],
    ['_brand.local-service.json', /\b(local service|local-service|home services?|plumb|hvac|electric|roofing|roofer|landscap|lawn|cleaning|janitor|contractor|handyman|pest control|locksmith|moving|movers|garage door|paint|construction|remodel|flooring|fencing|paving|towing|auto repair|mechanic|tree service|arborist|appliance repair|pool service|pressure washing|gutter|septic|chimney sweep)/],
    ['_brand.nonprofit.json', /\b(nonprofit|non-profit|charit|foundation|ministry|church|synagogue|mosque|temple|community center|volunteer|shelter|soup kitchen|food bank|pantry|relief center|mutual aid|501c3|outreach|humanitarian|advocacy|ngo\b|animal rescue|humane society|rescue mission)/],
    ['_brand.retail.json', /\b(shop|store|retail|boutique|apparel|clothing|jewelr|goods|merchandise|marketplace|e-commerce|ecommerce|outfitter|bookstore|bookshop|book store)/],
    ['_brand.saas.json', /\b(saas|software|platform|api\b|startup|analytics|dashboard|developer tool|automation|machine learning|fintech|cybersecurity|app\b|web app)/],
    // Real-estate BEFORE agency (fire-50): the authoritative short-circuit is
    // first-match-by-ORDER over the declared category, and "real estate agency"
    // matches BOTH — checked first, real-estate wins so a realtor no longer ships as
    // a magenta AGENCY site (Ridgeline Realty Group → agency copy/theme, fire-50). Own
    // vertical (dark, listings/buyers/sellers copy); OUT of LIGHT_VERTICAL_PRESETS →
    // DARK. Pairs with examples/_brand.real-estate.json + _content.real-estate.json.
    ['_brand.real-estate.json', /\b(real estate|real-estate|realtor|realty|home buyer|homebuyer|home seller|house hunting|open house|home valuation|buyer's agent|buyers agent|seller's agent|sellers agent|property listing|homes for sale|for sale by owner|mls\b|property management|property manager|mortgage|home loan|refinanc)/],
    ['_brand.agency.json', /\b(agency|marketing|advertis|branding|design studio|creative studio|consult|pr firm|media agency|growth marketing|seo agency)/],
    ['_brand.portfolio.json', /\b(portfolio|photograph|artist|freelance|illustrat|filmmaker|musician|architect|videograph)/],
  ];
  // AUTHORITATIVE SHORT-CIRCUIT (fire-55): the user-declared category (Google Places
  // type / explicit business_type) is threaded to the container as _category.txt — a
  // file the orchestrator NEVER writes, so (unlike _brand.json, which it rewrites) it
  // survives an orchestrator hallucination. If it maps to a vertical, it WINS outright.
  // Root cause it fixes (fire-54): a RESET restaurant ("Blackbird Kitchen") shipped as
  // a full DARK saas site — the reset path carried no category AND the orchestrator
  // clobbered _brand.json's category with saas copy, so the fuzzy scorer followed the
  // hallucination. First-match respects rule ORDER (dental>medical, fitness>wellness).
  const declared = read('_category.txt').trim().toLowerCase();
  if (declared) {
    for (const [file, re] of rules) {
      if (new RegExp(re.source, 'i').test(declared)) return file;
    }
  }
  // SCORED, not first-match-by-order: count keyword hits per vertical; identity
  // (primary) hits weigh 10× the noisy research (secondary) hits. Highest score
  // wins — a stray restaurant term in research no longer beats a real saas identity.
  let best = '';
  let bestScore = 0;
  for (const [file, re] of rules) {
    const g = new RegExp(re.source, 'gi');
    const pHits = (primary.match(g) || []).length;
    const sHits = (secondary.match(g) || []).length;
    const score = pHits * 10 + sHits;
    if (score > bestScore) { bestScore = score; best = file; }
  }
  return bestScore > 0 ? best : '';
}

// Presets whose colorScheme is light — Brian directive: healthcare/wellness/legal/
// restaurant/local-service/nonprofit render LIGHT (white/cyan), never dark.
const LIGHT_VERTICAL_PRESETS = new Set([
  '_brand.medical.json', '_brand.dental.json', '_brand.wellness.json', '_brand.legal.json',
  '_brand.restaurant.json', '_brand.local-service.json', '_brand.nonprofit.json',
]);

/**
 * Force the vertical brand preset into _brand.json when the orchestrator left the
 * template DEFAULT (crash) OR mis-themed a light vertical dark. Design-merge only:
 * the preset supplies color/colorScheme/font/etc.; the real business identity
 * (business/social/logo, research-derived) is preserved so we never ship the
 * preset's placeholder name. No-op when the orchestrator already produced a
 * correctly-themed custom brand.
 * @returns a short status string for the log.
 */
function applyVerticalPreset(dir, preset, templateDir) {
  if (!preset) return 'no-match';
  let presetPath = path.join(dir, 'examples', preset);
  if (!fs.existsSync(presetPath) && templateDir) presetPath = path.join(templateDir, 'examples', preset);
  if (!fs.existsSync(presetPath)) return `preset-missing:${preset}`;
  const brandPath = path.join(dir, '_brand.json');
  let presetJson;
  let current = null;
  try { presetJson = JSON.parse(fs.readFileSync(presetPath, 'utf-8')); } catch { return 'preset-unreadable'; }
  try { current = JSON.parse(fs.readFileSync(brandPath, 'utf-8')); } catch { /* missing/default */ }
  const curScheme = current && (current.colorScheme?.$value || current.colorScheme);
  const curBg = String((current && current.color && current.color.background && current.color.background.$value) || '');
  // "default" = the template dark shell the crash path leaves behind.
  const isDefault = !current || !current.color || !curScheme || curBg.includes('0.08 0.02');
  // Force the preset when the current scheme doesn't match the vertical's EXPECTED
  // scheme (light for healthcare/wellness/legal/restaurant/local-service/nonprofit,
  // dark for retail/saas/agency/portfolio) — generalizes the old light-only force so
  // a dark vertical can't ship light (or vice-versa) when the orchestrator mis-themes.
  const expectLight = LIGHT_VERTICAL_PRESETS.has(preset);
  const schemeMismatch = expectLight ? curScheme !== 'light' : curScheme !== 'dark';

  // Ensure the vertical's SCHEMA CLASS is present regardless of the theme decision below.
  // The orchestrator's business identity (name/phone/address) rarely sets businessClass,
  // so without this the LocalBusiness JSON-LD degrades to a generic 'Organization' (no
  // Dentist/Restaurant/RealEstateAgent/… + no geo). The preset declares the right class;
  // carry it onto the live business when absent/generic (a real orchestrator value wins).
  const presetClass = presetJson.business && presetJson.business.businessClass;
  let classCarried = false;
  if (presetClass && current && current.business) {
    const cur = current.business.businessClass;
    const curVal = cur && (typeof cur === 'object' ? cur.$value : cur);
    if (!curVal || curVal === 'organization') {
      current.business.businessClass = presetClass;
      classCarried = true;
    }
  }

  if (!isDefault && !schemeMismatch) {
    // Theme is already correct — keep it, but still persist the businessClass carry.
    if (classCarried) fs.writeFileSync(brandPath, JSON.stringify(current, null, 2));
    return `kept-custom (scheme=${curScheme})${classCarried ? ' +businessClass' : ''}`;
  }
  const merged = { ...presetJson };
  for (const idKey of ['business', 'social', 'logo']) {
    if (current && current[idKey]) merged[idKey] = current[idKey];
  }
  // Preserve the worker's DETERMINISTIC themeStyle personality (theme_style.ts →
  // _brand.json.themeStyle) across a pack force-apply. The pack supplies CONTENT +
  // colorScheme, but the vertical's PERSONALITY (data-style) is the worker's call:
  // a jeweler is `luxe`, a bookstore `scholarly` — even though both borrow the retail
  // CONTENT pack. Without this the retail pack's `boutique` themeStyle clobbers them —
  // the exact AL-298 (luna-felix→boutique) / AL-322 (booksweet→boutique) live
  // mis-theme. Only preserves an EXISTING worker string; absent → the pack's own
  // themeStyle stays. Guarded live by e2e/site-quality/verify-theme-match.mjs.
  let themeStylePreserved = false;
  const curThemeStyle = current && current.themeStyle;
  if (typeof curThemeStyle === 'string' && curThemeStyle.trim()) {
    merged.themeStyle = curThemeStyle.trim();
    themeStylePreserved = true;
  }
  fs.writeFileSync(brandPath, JSON.stringify(merged, null, 2));
  return `applied ${preset} (default=${isDefault} schemeMismatch=${schemeMismatch})${classCarried ? ' +businessClass' : ''}${themeStylePreserved ? ` +themeStyle=${merged.themeStyle}` : ''}`;
}

/**
 * Force the worker's DETERMINISTIC theme PERSONALITY onto `_brand.json.themeStyle` from
 * the IMMUTABLE `_theme_style.txt` sidecar. This is the authoritative fix for the
 * vertical-mismatch class (St. Elmo steakhouse→warm-not-luxe, Waterloo record-store→
 * boutique-not-retro): the workflow seeds BOTH `_brand.json.themeStyle` AND this sidecar
 * (theme_style.ts → themeStyleFromInputs), but the orchestrator REWRITES `_brand.json`
 * (the same fire-54 clobber that motivated `_category.txt`), dropping the seeded
 * themeStyle — so `applyVerticalPreset`'s `_brand.json`-based preservation silently
 * no-ops and the vertical PACK's own themeStyle wins. The sidecar is a file the
 * orchestrator never touches, so it survives. Run this AFTER `applyVerticalPreset` so it
 * re-stamps the personality over the pack's default. Runs BEFORE `npm run build` (same
 * window as applyVerticalPreset), so brand.ts bundles the corrected value → `applyBrand`
 * stamps the right `data-style`. Idempotent; safe no-op when the sidecar is absent
 * (undefined category / legacy builds). Same immutable-signal pattern as
 * [[authoritative-signal-immutable-against-unreliable-generator]].
 *
 * @param {string} dir - the build directory containing `_brand.json` + `_theme_style.txt`.
 * @returns {string} a short status string for the build log.
 */
function applyThemeStyleSidecar(dir) {
  // ── AL-345 DIAGNOSTIC (temporary) — capture the FULL theme-chain state to a fetchable
  // dist/ file so ONE live build reveals exactly where the chain breaks: is the deployed
  // image running the latest code (rev), was `_theme_style.txt` materialized (sidecarExists),
  // its value, does the container read sidecars at all (_category.txt control), and the
  // pre-sidecar brand.themeStyle. Remove once root-caused. public/ → dist/ (Vite copies). ──
  let sidecarRaw = null;
  let sidecarErr = '';
  try {
    sidecarRaw = fs.readFileSync(path.join(dir, '_theme_style.txt'), 'utf-8');
  } catch (e) {
    sidecarErr = String((e && e.code) || e).slice(0, 40);
  }
  let catRaw = '(none)';
  try { catRaw = fs.readFileSync(path.join(dir, '_category.txt'), 'utf-8').trim() || '(empty)'; } catch {}
  let brandBefore = '(unreadable)';
  try { brandBefore = String(JSON.parse(fs.readFileSync(path.join(dir, '_brand.json'), 'utf-8')).themeStyle ?? '(none)'); } catch {}
  try {
    const pub = path.join(dir, 'public');
    fs.mkdirSync(pub, { recursive: true });
    fs.writeFileSync(
      path.join(pub, 'ps-build-diag.txt'),
      `rev=${CONTAINER_BUILD_REV}\nsidecarExists=${sidecarRaw !== null}\nsidecarValue=${(sidecarRaw || '').trim()}\nsidecarErr=${sidecarErr}\ncategoryTxt=${catRaw}\nbrandThemeStyleBefore=${brandBefore}\n`,
    );
  } catch {}
  // ── end diagnostic ──
  const want = (sidecarRaw || '').trim();
  if (!want) return 'no-sidecar';
  const brandPath = path.join(dir, '_brand.json');
  let brand;
  try { brand = JSON.parse(fs.readFileSync(brandPath, 'utf-8')); } catch { return 'brand-unreadable'; }
  const cur = typeof brand.themeStyle === 'string' ? brand.themeStyle.trim() : '';
  if (cur === want) return `already ${want}`;
  brand.themeStyle = want;
  try { fs.writeFileSync(brandPath, JSON.stringify(brand, null, 2)); } catch { return 'write-failed'; }
  return `applied ${want}${cur ? ` (was ${cur})` : ''}`;
}

// ── Research-narrative uniqueness (loop FIRE-72) — first step of the content-
// uniqueness arc. The research LLM produces a business-SPECIFIC profile.description +
// mission_statement, but loadContentMap only ever wired research into 3 IDENTITY
// tokens (name/phone/email) — the VISIBLE About copy came from the generic per-vertical
// pack, so every <vertical> site shipped near-identical (name-agnostic) About prose.
// Let the business-specific research narrative OVERRIDE ABOUT_DESCRIPTION /
// ABOUT_MISSION_TEXT — but ONLY when it clears a strict publish-quality gate (length +
// ≥2 sentences + no {TOKENS} + no slop + Flesch floor). Research is a black box (not
// persisted/served post-build), so the VALIDATOR — not external inspection — is what
// makes this safe: bad/absent research fails the gate → the polished pack default stays.
// Priority ends up orchestrator > research > pack (we never clobber a non-blank existing
// value). Runs BEFORE applyVerticalContentPack so the pack's "non-blank existing wins".
const RN_SLOP = /\b(limitless|revolutioniz\w*|cutting[- ]edge|world[- ]class|leverag\w*|game[- ]chang\w*|unparalleled|seamless(?:ly)?|best[- ]in[- ]class|state[- ]of[- ]the[- ]art|synerg\w*|paradigm)\b/i;
function rnFlesch(text) {
  const sentences = (text.match(/[.!?]+/g) || []).length || 1;
  const words = text.match(/[A-Za-z]+/g) || [];
  const wc = words.length || 1;
  const syll = words.reduce((n, w) => {
    const m = w.toLowerCase().replace(/[^a-z]/g, '');
    if (m.length <= 3) return n + 1;
    const g = m.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').match(/[aeiouy]{1,2}/g);
    return n + Math.max(1, g ? g.length : 1);
  }, 0) || 1;
  return 206.835 - 1.015 * (wc / sentences) - 84.6 * (syll / wc);
}
/** Publish-quality gate: research prose must clear this to override polished pack copy. */
function rnPublishable(raw, min, max) {
  if (typeof raw !== 'string') return false;
  const s = raw.trim();
  if (s.length < min || s.length > max) return false;
  if (/\{[A-Z0-9_]{2,}\}/.test(s)) return false;              // unresolved template token
  if ((s.match(/[.!?]+/g) || []).length < 2) return false;    // ≥2 sentences
  if (RN_SLOP.test(s)) return false;                          // banned slop
  if (rnFlesch(s) < 52) return false;                        // readability floor
  return true;
}
/**
 * Wire the business-SPECIFIC research narrative into the VISIBLE About tokens. Only
 * fills a token that is BLANK (never clobbers an orchestrator value) AND whose research
 * source clears {@link rnPublishable} — else the pack default (applied next) stays.
 * Crash-proof. @returns a short status string for the log.
 */
function applyResearchNarrative(dir) {
  try {
    const research = JSON.parse(fs.readFileSync(path.join(dir, '_research.json'), 'utf-8'));
    const prof = (research && research.profile) || {};
    const contentPath = path.join(dir, '_content.json');
    let content = {};
    try { content = JSON.parse(fs.readFileSync(contentPath, 'utf-8')) || {}; } catch { /* none yet */ }
    const wrote = [];
    const blank = (k) => !String(content[k] || '').trim();
    if (blank('ABOUT_DESCRIPTION') && rnPublishable(prof.description, 150, 600)) { content.ABOUT_DESCRIPTION = prof.description.trim(); wrote.push('ABOUT_DESCRIPTION'); }
    if (blank('ABOUT_MISSION_TEXT') && rnPublishable(prof.mission_statement, 80, 400)) { content.ABOUT_MISSION_TEXT = prof.mission_statement.trim(); wrote.push('ABOUT_MISSION_TEXT'); }
    if (!wrote.length) return 'no publishable research narrative (pack default kept)';
    fs.writeFileSync(contentPath, JSON.stringify(content, null, 2));
    return `wrote ${wrote.join(', ')} from research`;
  } catch (e) {
    return `skipped: ${String((e && e.message) || e).slice(0, 80)}`;
  }
}

// ── Logo generation/recovery (loop FIRE-74, Brian directive: every site ships a
// beautiful, properly-integrated logo). Priority: (1) the OFFICIAL logo when it is
// recoverable online (research put a real image URL in _brand.json.logo.*), else
// (2) an IDEOGRAM-generated minimal/elegant logo ICON (built INTO the generation
// process as the fallback, per directive), else (3) the flat monogram from
// generate-favicons. Writes public/apple-touch-icon.png — the navbar logo + PWA icon;
// generate-favicons.mjs guards it (won't overwrite a real >4KB logo). Crash-proof +
// fail-soft: any error leaves the monogram fallback. Runs BEFORE `npm run build`.
/**
 * Vision gate for the AI-generated app-icon: does this image contain readable text /
 * letters / a business name? Uses the container's Anthropic key (Claude is multimodal).
 * Returns FALSE on any missing-key / error (fail-soft — never block a build on the gate).
 * Image models routinely bake the business NAME into a "logo" despite a "no text" prompt,
 * so this is the reliable enforcement the prompt alone can't give.
 */
async function imageHasText(anthropicKey, buf) {
  if (!anthropicKey || !buf || buf.length < 100) return false;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-latest',
        max_tokens: 5,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: buf.toString('base64') } },
          { type: 'text', text: 'Does this image contain ANY readable text, letters, words, or a business name? Answer ONLY "YES" or "NO".' },
        ] }],
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) return false;
    const j = await r.json().catch(() => ({}));
    const txt = ((j.content && j.content[0] && j.content[0].text) || '').trim().toUpperCase();
    return txt.startsWith('YES');
  } catch { return false; }
}

async function ensureLogo(dir, ideogramKey, anthropicKey) {
  const pub = path.join(dir, 'public');
  const dest = path.join(pub, 'apple-touch-icon.png');
  const downloadTo = async (url) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(45000) });
    if (!res.ok) return false;
    const ct = res.headers.get('content-type') || '';
    if (!/image\//.test(ct)) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 2000) return false; // reject an empty/broken image
    fs.mkdirSync(pub, { recursive: true });
    fs.writeFileSync(dest, buf);
    return true;
  };
  try {
    let brand = {};
    try { brand = JSON.parse(fs.readFileSync(path.join(dir, '_brand.json'), 'utf-8')); } catch { /* defaults */ }
    const leaf = (l) => (l && typeof l === 'object' && typeof l.$value === 'string' ? l.$value : typeof l === 'string' ? l : '');
    const biz = brand.business || {};
    const name = leaf(biz.name) || 'Business';
    const type = leaf(biz.businessClass) || leaf(biz.category) || 'local business';
    const logo = brand.logo || {};
    // (1) OFFICIAL logo recovered online — prefer the square icon, then the wordmark.
    for (const key of ['original_icon_url', 'original_url', 'url', 'icon']) {
      const u = leaf(logo[key]);
      if (u && /^https?:\/\//.test(u)) {
        try { if (await downloadTo(u)) return `official logo (${key})`; } catch { /* try next source */ }
      }
    }
    // (2) IDEOGRAM fallback — generate a minimal, elegant brand ICON (no text; the
    // navbar renders the business name as a wordmark beside it).
    if (ideogramKey) {
      const prompt =
        `Minimal, elegant, modern logo ICON for a ${type}. A simple flat ` +
        `geometric emblem or abstract symbol mark, clean vector style, memorable, professional, ` +
        `tasteful brand-appropriate color palette, centered on a soft solid background. ` +
        `Absolutely NO text, NO words, NO letters, NO business name — symbol only.`;
      const gen = await fetch('https://api.ideogram.ai/generate', {
        method: 'POST',
        headers: { 'Api-Key': ideogramKey, 'Content-Type': 'application/json' },
        // magic_prompt OFF: AUTO silently rewrites the prompt and re-injects the business
        // NAME as rendered text — that is why "no text" was ignored and the icon showed the
        // full name (e.g. "VANTA STRENGTH CLUB"). OFF respects the literal symbol-only prompt.
        body: JSON.stringify({ image_request: { prompt, aspect_ratio: 'ASPECT_1_1', model: 'V_2', magic_prompt_option: 'OFF' } }),
        signal: AbortSignal.timeout(90000),
      });
      if (!gen.ok) return `Ideogram HTTP ${gen.status} — monogram fallback`;
      const j = await gen.json().catch(() => ({}));
      const url = j && j.data && j.data[0] && j.data[0].url;
      if (url && (await downloadTo(url))) {
        // VISION GATE: if the model still baked text/the name into the icon, REJECT it
        // (delete → generate-favicons produces the clean deterministic monogram). An
        // app-icon must be a text-free mark; the navbar shows the name as a wordmark.
        // Only the AI-generated default is gated — an official/uploaded logo (step 1) is
        // used verbatim (honors user-supplied context: it may legitimately contain text).
        try {
          if (await imageHasText(anthropicKey, fs.readFileSync(dest))) {
            fs.unlinkSync(dest);
            return 'Ideogram logo contained text → rejected (vision gate) → monogram fallback';
          }
        } catch { /* vision unavailable → keep the image (fail-soft) */ }
        return 'Ideogram-generated logo (vision-verified text-free)';
      }
      return 'Ideogram returned no usable image — monogram fallback';
    }
    return 'no official logo + no Ideogram key — monogram fallback';
  } catch (e) {
    return `skipped: ${String((e && e.message) || e).slice(0, 80)}`;
  }
}

/**
 * Generate the STYLIZED TEXT wordmark (the business NAME) with Ideogram — the second
 * brand logo, shown to the RIGHT of the square icon mark. This one SHOULD contain text
 * (it IS the wordmark), so — unlike the square icon — it is NOT vision-gated. Transparent
 * background requested so it drops cleanly beside the icon; the navbar falls back to crisp
 * HTML text when the image is absent/broken. A user/official wordmark URL wins (honors
 * user-supplied context). Writes public/logo-wordmark.png. Runs BEFORE `npm run build`.
 */
async function ensureWordmark(dir, ideogramKey) {
  const pub = path.join(dir, 'public');
  const dest = path.join(pub, 'logo-wordmark.png');
  const save = async (url) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(45000) });
    if (!res.ok || !/image\//.test(res.headers.get('content-type') || '')) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 2000) return false;
    fs.mkdirSync(pub, { recursive: true });
    fs.writeFileSync(dest, buf);
    return true;
  };
  try {
    let brand = {};
    try { brand = JSON.parse(fs.readFileSync(path.join(dir, '_brand.json'), 'utf-8')); } catch { /* defaults */ }
    const leaf = (l) => (l && typeof l === 'object' && typeof l.$value === 'string' ? l.$value : typeof l === 'string' ? l : '');
    const name = leaf((brand.business || {}).name) || 'Business';
    const logo = brand.logo || {};
    // (1) user/official wordmark wins — used verbatim.
    for (const key of ['wordmark_url', 'original_url']) {
      const u = leaf(logo[key]);
      if (u && /^https?:\/\//.test(u)) { try { if (await save(u)) return `official wordmark (${key})`; } catch { /* next */ } }
    }
    // (2) Ideogram — a stylized wordmark of the NAME (text is intended here; no gate).
    if (!ideogramKey) return 'no ideogram key — HTML-text wordmark fallback';
    const prompt =
      `A clean, elegant, horizontal WORDMARK logo showing ONLY the text "${name}" in modern ` +
      `professional typography. Tasteful lettering, subtle brand-appropriate color, TRANSPARENT ` +
      `background, NO icon, NO symbol, NO tagline — just the stylized words "${name}".`;
    const gen = await fetch('https://api.ideogram.ai/generate', {
      method: 'POST',
      headers: { 'Api-Key': ideogramKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_request: { prompt, aspect_ratio: 'ASPECT_16_9', model: 'V_2', magic_prompt_option: 'OFF' } }),
      signal: AbortSignal.timeout(90000),
    });
    if (!gen.ok) return `Ideogram wordmark HTTP ${gen.status} — HTML-text fallback`;
    const j = await gen.json().catch(() => ({}));
    const url = j && j.data && j.data[0] && j.data[0].url;
    if (url && (await save(url))) return 'Ideogram-generated wordmark';
    return 'Ideogram returned no wordmark — HTML-text fallback';
  } catch (e) {
    return `wordmark skipped: ${String((e && e.message) || e).slice(0, 80)}`;
  }
}

/**
 * Merge the per-vertical DEFAULT content pack (examples/_content.<vertical>.json)
 * into _content.json so section tokens (HERO, FEATURE, SERVICE, STAT, PROCESS,
 * FAQ, CTA, ABOUT groups) fill with strong generic per-vertical copy even when the
 * orchestrator crashes/under-fills — turning a self-hiding stub into a full,
 * on-vertical site. Existing _content.json values (real orchestrator/research
 * content) WIN token-by-token; the pack only fills gaps + blanks. No-op when the
 * vertical has no pack. Pairs with applyVerticalPreset (theme) — same crash-proof
 * "determinism lives in the container, not the orchestrator" pattern.
 * @returns a short status string for the log.
 */
function applyVerticalContentPack(dir, preset, templateDir) {
  if (!preset) return 'no-vertical';
  const packName = preset.replace('_brand.', '_content.');
  let packPath = path.join(dir, 'examples', packName);
  if (!fs.existsSync(packPath) && templateDir) packPath = path.join(templateDir, 'examples', packName);
  if (!fs.existsSync(packPath)) return `no-pack:${packName}`;
  let pack;
  try { pack = JSON.parse(fs.readFileSync(packPath, 'utf-8')); } catch { return 'pack-unreadable'; }
  if (!pack || typeof pack !== 'object') return 'pack-not-object';
  const contentPath = path.join(dir, '_content.json');
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(contentPath, 'utf-8')) || {}; } catch { /* none yet */ }
  // Pack defaults are the BASE; a non-blank existing value (orchestrator/research)
  // overrides its token. A blank existing token falls back to the rich default.
  const merged = {};
  for (const [k, v] of Object.entries(pack)) {
    if (typeof v === 'string' || typeof v === 'number') merged[k] = String(v);
  }
  for (const [k, v] of Object.entries(existing)) {
    if ((typeof v === 'string' || typeof v === 'number') && String(v).trim() !== '') merged[k] = String(v);
  }
  fs.writeFileSync(contentPath, JSON.stringify(merged, null, 2));
  return `merged ${packName} (${Object.keys(pack).length} defaults, ${Object.keys(existing).length} existing)`;
}

// Canonical homepage section components. A full template Home.tsx references ~10
// of these; an orchestrator-stubbed Home (contact-only) references ~0.
const STUB_SECTION_COMPONENTS = [
  'HeroSplit', 'HeroCenter', 'BentoGrid', 'Stats', 'FeatureSplit',
  'ProcessSteps', 'Pricing', 'FAQ', 'LogoCloud', 'CTASection', 'GalleryGrid',
];

/**
 * Stub guard (journey 2026-08-25, cascade-metrics-sf). The container orchestrator
 * sometimes REWRITES src/pages/Home.tsx into a 1-section contact-only stub, deleting
 * the hero/bento/stats/about/… section JSX and their {TOKEN}s. The deterministic
 * content pack still fills _content.json, but a stubbed Home references none of those
 * tokens → the rich pack content renders NOWHERE → a published 1-section stub. (Theme
 * survives because it's _brand.json data read at render; content does NOT because the
 * orchestrator rewrote the structure.)
 *
 * Fix: when Home.tsx references fewer than 3 of the canonical section components, the
 * orchestrator stubbed it — restore the template's whole src/pages/ render layer from
 * TEMPLATE_DIR. fillTemplateTokens (called right after) then fills the restored,
 * token-bearing pages from the pack-merged _content.json → a full, on-vertical site.
 * The orchestrator's reliable output (content in _content.json, theme in _brand.json,
 * generated assets in public/) is untouched; only its unreliable .tsx structure edits
 * are discarded. No-op when Home already carries the full section set. Fail-safe: any
 * error is caught + logged, never breaks the build.
 * @returns a short status string for the log.
 */
function guardAgainstStubPages(dir, templateDir, force = false) {
  try {
    const homePath = path.join(dir, 'src', 'pages', 'Home.tsx');
    let refCount = 0;
    let stubReason = 'refs<3';
    if (fs.existsSync(homePath)) {
      const home = fs.readFileSync(homePath, 'utf-8');
      refCount = STUB_SECTION_COMPONENTS.filter((c) => new RegExp(`\\b${c}\\b`).test(home)).length;
      // `force` (used by the content self-heal) restores pages even when Home
      // LOOKS ok structurally — because a partial-fill (meridian-creative-denver
      // 2026-08-26: Home had ≥3 sections but an EMPTY <h1>/hero) still needs the
      // clean template pages so the freshly re-applied content pack fills every
      // token (HERO_HEADLINE included), not just the sections the orchestrator kept.
      // Even with ≥3 sections, a Home that renders NO <h1> is a broken build (fire-54:
      // an orchestrator-rewritten saas Home had ~4 sections but 0 <h1> — the custom
      // hero used neither HeroSplit/HeroCenter nor a literal <h1>, shipping a page with
      // no H1, a hard SEO defect). Detect from source: no hero component AND no literal
      // <h1> tag ⇒ 0 rendered H1 ⇒ restore the template pages (which always emit one).
      const willRenderH1 = /\b(HeroSplit|HeroCenter)\b/.test(home) || /<h1[\s>]/.test(home);
      if (!force && refCount >= 3 && willRenderH1)
        return `pages-ok (Home references ${refCount} sections, H1 present)`;
      if (!force && refCount >= 3 && !willRenderH1) stubReason = 'no <h1> (0 rendered H1)';
    }
    // STUB (or Home missing / no-H1) → restore the template's page render layer.
    if (!templateDir) return `stub-detected (refs=${refCount}) but no TEMPLATE_DIR to restore from`;
    const srcPages = path.join(templateDir, 'src', 'pages');
    if (!fs.existsSync(srcPages)) return `stub-detected (refs=${refCount}) but template src/pages missing`;
    const dstPages = path.join(dir, 'src', 'pages');
    x(`rm -rf ${dstPages} && cp -r ${srcPages} ${dstPages}`, { shell: true, stdio: 'pipe' });
    return `STUB DETECTED (Home referenced ${refCount} sections, ${stubReason}) → restored src/pages/ from template`;
  } catch (e) {
    return `stub-guard error: ${String(e && e.message).slice(0, 140)}`;
  }
}

/**
 * Deterministic safety net. Replace EVERY content {TOKEN} across the shipped
 * surfaces with a real value from `contentMap`, else a SAFE fallback by token
 * semantics, so ZERO {TOKEN} can survive to dist/. Writes files in place.
 *
 * Safe fallbacks: BUSINESS_NAME → real name (never blank); *_IMAGE_URL / *_COVER
 * / *_PHOTO / *_LOGO / *_LINKEDIN → '' (template placeholders.ts then hides the
 * <img>/link); all other text → '' (the section self-hides via its {value && …}
 * guard). Returns { filled, fromMap, fromFallback, filesTouched }.
 *
 * @param {string} dir             build directory
 * @param {Record<string,string>} contentMap  token → value
 * @param {{businessName?:string, businessUrl?:string}} params  identity fallbacks
 */
function fillTemplateTokens(dir, contentMap, params = {}) {
  const realName = String(contentMap.BUSINESS_NAME || params.businessName || '').trim();
  const realUrl = String(contentMap.BUSINESS_URL || params.businessUrl || '').trim();
  const fallback = (token) => {
    if (token === 'BUSINESS_NAME') return realName || 'Our Business';
    if (token === 'BUSINESS_SHORT_NAME') return (realName || 'Our Business').slice(0, 12);
    if (token === 'BUSINESS_URL' || token === 'DOMAIN') return realUrl;
    // image/media/link tokens → '' so the template hides the element (no 404).
    if (/(_IMAGE_URL|_COVER|_PHOTO|_LOGO|_ICON|_LINKEDIN)$/.test(token) || /IMAGE_URL$/.test(token)) return '';
    // all other text → '' so the owning section self-hides.
    return '';
  };
  let fromMap = 0, fromFallback = 0, filesTouched = 0;
  for (const f of templateFillSurfaces(dir)) {
    let before;
    try { before = fs.readFileSync(f, 'utf-8'); } catch { continue; }
    const after = before.replace(TEMPLATE_TOKEN_RE, (_m, pre, key, offset) => {
      // Tokens live inside quoted string literals ('…'/"…"/`…`) or JSX attributes
      // (attr="…"). Escape the value for its enclosing context so real content
      // (apostrophes, quotes, &, <, >, newlines) can NEVER break TS/JSX compilation.
      // isJsxAttr: pre is a double-quote immediately preceded by '=' → attr="…".
      const isJsxAttr = pre === '"' && before[offset - 1] === '=';
      const enc = (raw) => {
        const s = String(raw).replace(/\r?\n/g, ' ').trim();
        if (isJsxAttr) {
          return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }
        // JS string literal (', ", or backtick): backslash-escape.
        let e = s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
        e = pre === '"' ? e.replace(/"/g, '\\"') : e.replace(/'/g, "\\'");
        return e;
      };
      const v = Object.prototype.hasOwnProperty.call(contentMap, key) ? contentMap[key] : undefined;
      if (typeof v === 'string' && v.trim() !== '') { fromMap++; return pre + enc(v); }
      fromFallback++;
      return pre + enc(fallback(key));
    });
    if (after !== before) { try { fs.writeFileSync(f, after); filesTouched++; } catch {} }
  }
  return { filled: fromMap + fromFallback, fromMap, fromFallback, filesTouched };
}

/**
 * Post-build gate. Return the distinct content tokens still present anywhere in
 * `distDir` (excludes `${…}` JS interpolation via TEMPLATE_TOKEN_RE). A non-empty
 * result means a token leaked into the shippable output → the job must FAIL.
 */
function distUnfilledTokens(distDir) {
  if (!fs.existsSync(distDir)) return [];
  const set = new Set();
  for (const f of walkTemplateTextFiles(distDir)) {
    let raw;
    try { raw = fs.readFileSync(f, 'utf-8'); } catch { continue; }
    for (const m of raw.matchAll(TEMPLATE_TOKEN_RE)) set.add(m[2]);
  }
  return [...set].sort();
}

function runJob(jobId, dir, prompt, envVars, timeoutMin, callbackUrl, callbackSecret, skipBuild) {
  jobs[jobId] = {
    jobId,
    status: 'running',
    dir,
    startTime: Date.now(),
    step: 'claude-code',
    error: null,
    files: null,
    uploadResult: null,
    callbackUrl: callbackUrl || null,
    callbackSecret: callbackSecret || null,
    skipBuild: Boolean(skipBuild),
  };
  saveJob(jobId);
  pushStatus(jobId);

  const pf = path.join(dir, '_prompt.txt');
  fs.writeFileSync(pf, prompt);

  const envLines = ['#!/bin/sh'];
  for (const k in envVars) if (envVars[k]) envLines.push(`export ${k}=${JSON.stringify(envVars[k])}`);
  envLines.push('export HOME=/home/cuser');
  envLines.push(`export SKILLS_DIR=${SKILLS_DIR}`);
  envLines.push(`export TEMPLATE_DIR=${TEMPLATE_DIR}`);
  envLines.push(`cd ${dir}`);
  envLines.push(`${CP} --dangerously-skip-permissions -p < ${pf}`);
  const sf = `/tmp/run_${jobId}.sh`;
  fs.writeFileSync(sf, envLines.join('\n'));
  try { x(`chmod +x ${sf}`, { stdio: 'pipe' }); } catch {}

  const to = (timeoutMin || 14) * 60000;
  console.warn(`[${jobId}] Starting Claude Code (${Math.round(prompt.length / 1024)}KB prompt, ${timeoutMin}min timeout)`);

  // Heartbeat every 30s for the ENTIRE job (claude -p + npm install + npm build + R2 upload).
  // Workflow staleness threshold is 8min — npm install alone can be 5min, so heartbeat must
  // outlive child process. Cleared only when status terminal (complete/error).
  const hb = setInterval(() => {
    const j = jobs[jobId];
    if (!j) { clearInterval(hb); return; }
    if (j.status === 'complete' || j.status === 'error') { clearInterval(hb); return; }
    pushStatus(jobId);
  }, 30_000);

  // shell:false is critical — with shell:true Node wraps the args in `/bin/sh -c "su cuser -s /bin/sh -c sh /tmp/...sh"`,
  // and the outer shell tokenizes that so su's -c receives only "sh" (no script path), leaving an idle inner shell
  // that never invokes claude. Pass argv directly so su gets `-c "sh ${sf}"` as one argument.
  const child = sp('su', ['cuser', '-s', '/bin/sh', '-c', `sh ${sf}`], {
    timeout: to, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 100 * 1024 * 1024,
  });

  // HARD WALL-CLOCK GUARD (Brian 2026-08-20): CF Containers cap wall-clock at
  // ~15 min — anything longer gets evicted mid-run and the workflow can only
  // recover ONCE. Beyond the spawn timeout's SIGTERM, kill the whole process
  // GROUP 45s earlier than the budget so Claude's subagent children (which the
  // su-wrapper SIGTERM may orphan) are reaped BEFORE the container eviction
  // boundary, and the terminal status lands in KV while the container is
  // still alive to report it.
  const killAt = to - 45_000;
  const killTimer = setTimeout(() => {
    console.warn(`[${jobId}] Hard time-box reached (${(killAt / 60000).toFixed(1)}min) — killing the process group`);
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
    }
  }, killAt);
  child.on('close', () => clearTimeout(killTimer));
  child.on('error', () => clearTimeout(killTimer));
  let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d.toString(); });
  child.stderr.on('data', d => { stderr += d.toString(); });

  // Run a shell command async via spawn so the Node event loop stays free for setInterval heartbeats.
  // Returns { code, stdout } or throws on timeout/spawn error.
  // Build-job env vars (CF creds, R2 bucket, etc.) are merged in so npm + the R2 upload script see them.
  const runEnv = { ...process.env, ...envVars, HOME: '/home/cuser' };
  function runAsync(cmd, timeoutMs, maxOutBytes) {
    return new Promise((resolve, reject) => {
      const c = sp('sh', ['-c', cmd], { timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: maxOutBytes || 50 * 1024 * 1024, env: runEnv });
      let out = '', err = '';
      c.stdout.on('data', d => { out += d.toString(); });
      c.stderr.on('data', d => { err += d.toString(); });
      c.on('close', code => resolve({ code, stdout: out, stderr: err }));
      c.on('error', e => reject(e));
    });
  }

  child.on('close', async code => {
    console.warn(`[${jobId}] Claude Code exited code=${code} stdout=${stdout.length}b stderr=${stderr.length}b elapsed=${((Date.now() - jobs[jobId].startTime) / 1000) | 0}s`);

    setStatus(jobId, { step: 'npm-build' });

    let buildOk = false;
    // WHY-tracker — the workflow only surfaces the generic error; recording
    // the container-side reason makes the next failure self-diagnosing
    // (journey 2026-08-19: repeated 'npm build failed' with zero root-cause
    // visibility).
    let buildFailReason = '';
    if (jobs[jobId] && jobs[jobId].skipBuild) {
      // Smoke-test path: skip npm install/build, treat any non-underscore files as the upload set.
      buildOk = liveFileCount(dir) > 0;
      console.warn(`[${jobId}] skipBuild=true, file count=${liveFileCount(dir)}, buildOk=${buildOk}`);
      if (!buildOk) buildFailReason = 'skipBuild=true and no live files';
    } else if (fs.existsSync(path.join(dir, 'package.json'))) {
      try {
        // ── SAFETY NET: deterministically fill EVERY remaining template {TOKEN}
        // before build so a partial/failed orchestrator run can never ship raw
        // {BUSINESS_NAME}/{HERO_SUBHEADLINE}/… to the live site. Idempotent —
        // tokens the orchestrator already filled are simply absent here. ──
        try {
          // ── DETERMINISTIC VERTICAL THEME (journey 2026-08-24): the orchestrator's
          // `cp examples/_brand.<vertical>.json` step is unreliable — a crash ships the
          // DARK default for a light vertical (dentist). Force the right preset here so
          // the theme survives an orchestrator crash; design-merge preserves identity. ──
          let preset = '';
          try {
            preset = pickVerticalPreset(dir, prompt);
            console.warn(`[${jobId}] Vertical theme: ${applyVerticalPreset(dir, preset, TEMPLATE_DIR)}`);
            // Re-stamp the worker's authoritative personality from the orchestrator-proof
            // _theme_style.txt sidecar AFTER the pack merge, so it wins over the pack's
            // default themeStyle (fixes steakhouse→warm-not-luxe, record-store→boutique-not-retro).
            console.warn(`[${jobId}] Theme personality (sidecar): ${applyThemeStyleSidecar(dir)}`);
            // Logo: recover the OFFICIAL mark, else generate an elegant one via Ideogram
            // (BEFORE npm build, so generate-favicons keeps it as apple-touch-icon.png).
            console.warn(`[${jobId}] Logo: ${await ensureLogo(dir, envVars.IDEOGRAM_API_KEY, envVars.ANTHROPIC_API_KEY)}`);
            console.warn(`[${jobId}] Wordmark: ${await ensureWordmark(dir, envVars.IDEOGRAM_API_KEY)}`);
            console.warn(`[${jobId}] Research narrative: ${applyResearchNarrative(dir)}`);
            console.warn(`[${jobId}] Vertical content: ${applyVerticalContentPack(dir, preset, TEMPLATE_DIR)}`);
            console.warn(`[${jobId}] Stub guard: ${guardAgainstStubPages(dir, TEMPLATE_DIR)}`);
          } catch (te) {
            console.warn(`[${jobId}] Vertical theme/content skipped: ${te.message.slice(0, 200)}`);
          }
          let contentMap = loadContentMap(dir);
          // ── CONTENT-COMPLETENESS SELF-HEAL (loopwork class, 2026-08-26): if the
          // vertical content pack did NOT populate _content.json (pickVerticalPreset
          // returned '' on a real business, applyVerticalContentPack was skipped by a
          // stale warm-container image, or the orchestrator emptied it), the core
          // content tokens are blank → the site publishes near-empty (Home ~130w,
          // /services ~12w) with the default dark shell + no tagline, and NOTHING
          // catches it (the token-leak gate only fires on raw {TOKEN}s, not on empty
          // fills). Force-apply the picked pack — or a sensible default vertical, since
          // every pack fills all 167 tokens — and re-load before filling. ──
          const CORE_CONTENT = ['HERO_HEADLINE', 'SERVICE_1_LONG_DESCRIPTION', 'ABOUT_PARAGRAPH_1', 'SERVICES_INTRO'];
          if (CORE_CONTENT.filter((k) => !String(contentMap[k] || '').trim()).length >= 2) {
            // Prefer the deterministically-picked vertical; else the theme already
            // applied to _brand.json (so content matches the shell); else saas.
            let themeVal = '';
            try { const b = JSON.parse(fs.readFileSync(path.join(dir, '_brand.json'), 'utf-8')); themeVal = (b.colorScheme?.$value || b.colorScheme || ''); } catch { /* none */ }
            const fallbackPreset = preset || '_brand.saas.json';
            console.warn(`[${jobId}] Content self-heal: core content empty → force-applying ${fallbackPreset} + FORCE-restoring pages (theme=${themeVal})`);
            try {
              applyVerticalContentPack(dir, fallbackPreset, TEMPLATE_DIR);
              // FORCE restore (true): a partial-fill Home (≥3 sections but empty
              // hero) would otherwise be kept, shipping an empty <h1>. Restoring the
              // clean template pages guarantees every token — HERO_HEADLINE included —
              // fills from the freshly-applied pack → a FULL site, never partial.
              guardAgainstStubPages(dir, TEMPLATE_DIR, true);
              contentMap = loadContentMap(dir);
            } catch (he) {
              console.warn(`[${jobId}] Content self-heal error: ${he.message.slice(0, 160)}`);
            }
          }
          // Identity fallbacks come from the context map itself (BUSINESS_NAME/URL
          // sourced from _content.json/_brand.json/_research.json in loadContentMap)
          // and the slug parsed from the build dir name (/tmp/build-<slug>-<ts>) —
          // no dependence on a build-param that may be absent.
          const slugFromDir = (path.basename(dir).match(/^build-(.+)-\d+$/) || [])[1] || '';
          const fill = fillTemplateTokens(dir, contentMap, {
            businessName: contentMap.BUSINESS_NAME,
            businessUrl: contentMap.BUSINESS_URL || (slugFromDir ? `https://${slugFromDir}.projectsites.dev` : ''),
          });
          console.warn(`[${jobId}] Token safety-net: filled ${fill.filled} (${fill.fromMap} from context, ${fill.fromFallback} safe-fallback) across ${fill.filesTouched} files`);
        } catch (fe) {
          console.warn(`[${jobId}] Token safety-net skipped: ${fe.message.slice(0, 200)}`);
        }
        // --omit=dev: the template's build tools (vite/tsc/tailwind/postcss/plugin-react)
        // live in `dependencies`; the 8 devDependencies are ALL test-only (@playwright/test
        // — which downloads browsers, MINUTES — vitest, jsdom, testing-library, coverage) and
        // are NOT needed by `tsc -b && vite build`. Skipping them cuts install from ~minutes
        // to seconds, keeping the whole job under the CF 15min wall-clock eviction cap (the #1
        // build-reliability bottleneck, 2026-08-24). Verified safe: no src/**/*.test.ts to
        // typecheck, `npm run build --omit=dev` passes clean.
        // fire-79: npm install intermittently fails with code=null (network flake /
        // resource-kill in the container) on ~1/3 of builds — the #1 build-reliability
        // gap (bit TWICE in FIRE-78 alone, each needing a manual /reset). It is
        // CREDIT-FREE (no Claude Code call — the orchestrator already ran), so retry it
        // ONCE with a short backoff before flipping the whole job to error. Bounded
        // (2 attempts × ≤5min) keeps the job under the 15min CF wall-clock eviction cap.
        let inst = await runAsync(`cd ${dir} && npm install --legacy-peer-deps --omit=dev 2>&1`, 300000, 50 * 1024 * 1024);
        if (inst.code !== 0) {
          console.warn(`[${jobId}] npm install attempt 1 exit=${inst.code} — retrying once; tail=`, inst.stdout.slice(-300));
          await new Promise((r) => setTimeout(r, 4000));
          inst = await runAsync(`cd ${dir} && npm install --legacy-peer-deps --omit=dev 2>&1`, 300000, 50 * 1024 * 1024);
        }
        if (inst.code !== 0) {
          console.warn(`[${jobId}] npm install exit=${inst.code} (after retry) tail=`, inst.stdout.slice(-500));
          buildFailReason = `npm install failed after retry code=${inst.code}: ${inst.stdout.slice(-800)}`;
          throw new Error(`npm install failed code=${inst.code}`);
        }
        const bld = await runAsync(`cd ${dir} && npm run build 2>&1`, 300000, 50 * 1024 * 1024);
        if (bld.code !== 0) {
          console.warn(`[${jobId}] npm build exit=${bld.code} tail=`, bld.stdout.slice(-500));
          buildFailReason = `npm build failed code=${bld.code}: ${(bld.stdout.match(/[^\n]*error[^\n]*/gi) || []).slice(-6).join(' | ') || bld.stdout.slice(-1500)}`;
          throw new Error(`npm build failed code=${bld.code}`);
        }
        const distDir = path.join(dir, 'dist');
        if (fs.existsSync(distDir)) {
          const distFiles = collectFiles(distDir);
          if (distFiles.length > 0) {
            // ── QUALITY GATE: a build that still emits raw {TOKEN}s into dist/
            // is a token-leaking site (the summit-peak-pt class). FAIL it — never
            // publish. Excludes ${…} JS interpolation via TEMPLATE_TOKEN_RE. ──
            const leaked = distUnfilledTokens(distDir);
            if (leaked.length > 0) {
              console.warn(`[${jobId}] TOKEN GATE FAIL: ${leaked.length} unfilled tokens in dist/ — ${leaked.slice(0, 12).join(', ')}${leaked.length > 12 ? '…' : ''}`);
              buildFailReason = `dist/ still contains ${leaked.length} unfilled template tokens (${leaked.slice(0, 8).join(', ')}${leaked.length > 8 ? '…' : ''}) — site would render raw {TOKEN}s`;
            } else {
              // ── CONTENT-COMPLETENESS BACKSTOP (loopwork class, 2026-08-26): a build
              // whose core content tokens are still empty published a near-empty site
              // (Home ~130w, /services ~12w). If the self-heal above could not populate
              // them (e.g. a stale image lacking applyVerticalContentPack entirely),
              // FAIL LOUD → error email + retry (which may hit a healthy container) —
              // never publish a thin site. ──
              let cm = {};
              try { cm = JSON.parse(fs.readFileSync(path.join(dir, '_content.json'), 'utf-8')) || {}; } catch { /* none */ }
              const CORE = ['HERO_HEADLINE', 'SERVICE_1_LONG_DESCRIPTION', 'ABOUT_PARAGRAPH_1', 'SERVICES_INTRO'];
              const emptyCore = CORE.filter((k) => !String(cm[k] || '').trim());
              if (emptyCore.length >= 2) {
                buildFailReason = `content-completeness gate: ${emptyCore.length}/${CORE.length} core content tokens empty (${emptyCore.join(', ')}) — the vertical content pack did not apply; refusing to publish a thin site`;
                console.warn(`[${jobId}] CONTENT GATE FAIL: ${buildFailReason}`);
              } else {
                buildOk = true;
                console.warn(`[${jobId}] npm build ok: ${distFiles.length} dist files, 0 unfilled tokens, content complete`);
              }
            }
          } else {
            console.warn(`[${jobId}] dist/ empty after build`);
            buildFailReason = 'dist/ exists but is empty after npm run build';
          }
        } else {
          console.warn(`[${jobId}] dist/ missing after build`);
          buildFailReason = 'dist/ missing after npm run build';
        }
      } catch (be) {
        console.warn(`[${jobId}] Build error:`, be.message.slice(0, 500));
        buildFailReason = buildFailReason || be.message.slice(0, 500);
      }
    } else {
      console.warn(`[${jobId}] No package.json — skipping build`);
      buildFailReason = 'no package.json in build dir — Claude Code never produced a buildable project';
    }

    if (!buildOk) {
      setStatus(jobId, {
        status: 'error',
        error: `npm build failed or produced no dist/ files — ${buildFailReason || 'unknown'}`, 
        step: 'done',
        files: [],
      });
      return;
    }

    setStatus(jobId, { step: 'r2-upload' });
    let uploadOk = false;
    let uploadResult = null;
    try {
      const up = await runAsync(`cd ${dir} && node /home/cuser/upload-to-r2.mjs 2>&1`, 300000, 10 * 1024 * 1024);
      console.warn(`[${jobId}] R2 upload exit=${up.code} tail:`, up.stdout.slice(-500));
      try {
        uploadResult = JSON.parse(fs.readFileSync(path.join(dir, '_upload_result.json'), 'utf-8'));
        if (uploadResult && typeof uploadResult.uploaded === 'number' && uploadResult.uploaded > 0) {
          uploadOk = true;
        } else {
          console.warn(`[${jobId}] Upload result has uploaded=${uploadResult && uploadResult.uploaded}`);
        }
      } catch (pe) {
        console.warn(`[${jobId}] Could not parse _upload_result.json:`, pe.message.slice(0, 200));
      }
    } catch (ue) {
      console.warn(`[${jobId}] R2 upload error:`, ue.message.slice(0, 500));
    }

    if (!uploadOk) {
      setStatus(jobId, {
        status: 'error',
        error: `R2 upload failed or uploaded 0 files. claude_exit=${code} upload_result=${JSON.stringify(uploadResult)}`,
        step: 'done',
        files: collectFiles(dir),
        uploadResult,
      });
      return;
    }

    setStatus(jobId, { step: 'collecting' });
    const files = collectFiles(dir);
    console.warn(`[${jobId}] Collected ${files.length} source files`);

    // Functions (Stage 2.2a): if the built site ships a functions/ folder, bundle it via
    // the container's functions-build CLI and carry the result in the terminal callback →
    // the worker's deploySiteFunctions deploys/removes the site's WfP worker (entitlement-
    // gated, non-throwing). Fail-soft: any spawn/parse fault leaves it null (no functions
    // deploy this build) and NEVER blocks the site from publishing. No functions/ folder →
    // signal `empty` so the worker removes any stale WfP worker (cheap no-op when none).
    let functionsBuild = null;
    try {
      if (fs.existsSync(path.join(dir, 'functions'))) {
        const cliPath = '/home/cuser/scripts/functions-build/cli.ts';
        const out = spawnSync('tsx', [cliPath, dir], {
          cwd: dir,
          encoding: 'utf-8',
          timeout: 120000,
          maxBuffer: 8 * 1024 * 1024,
          // ROOT-CAUSE FIX (2026-08-30): bundle.ts does a bare `import 'esbuild'`, which
          // Node resolves relative to the IMPORTING file (/home/cuser/scripts/functions-build/),
          // NOT `cwd` — so cwd:dir never helped. esbuild is installed GLOBALLY in the image
          // (`npm i -g … esbuild`), so point NODE_PATH there (+ the build dir's node_modules
          // as a fallback). Without this cli.ts silently produced no stdout → functionsBuild
          // stayed null → deploySiteFunctions never ran (the 2.2a positive-dispatch miss).
          env: { ...process.env, NODE_PATH: `/usr/local/lib/node_modules:${dir}/node_modules` },
        });
        const stdout = (out.stdout || '').trim();
        if (stdout) {
          functionsBuild = JSON.parse(stdout);
        } else {
          // Surface WHY (status/signal/stderr) in the callback — not null — so the build
          // record is self-diagnosing. {ok:false} → deploySiteFunctions keeps last-good.
          const why = `no stdout (status=${out.status} signal=${out.signal || ''}) ${(out.stderr || out.error?.message || '').slice(-240)}`;
          console.warn(`[${jobId}] functions-build ${why}`);
          functionsBuild = { ok: false, error: why };
        }
      } else {
        functionsBuild = { ok: true, empty: true };
      }
    } catch (fe) {
      const why = `threw: ${fe.message.slice(0, 240)}`;
      console.warn(`[${jobId}] functions-build ${why}`);
      functionsBuild = { ok: false, error: why };
    }

    setStatus(jobId, {
      files,
      uploadResult,
      functionsBuild,
      status: 'complete',
      step: 'done',
    });
  });

  child.on('error', e => {
    console.warn(`[${jobId}] Process error:`, e.message);
    const files = collectFiles(dir);
    setStatus(jobId, {
      files,
      status: files.length > 0 ? 'complete' : 'error',
      error: e.message,
      step: 'done',
    });
  });
}

http.createServer((q, r) => {
  r.setHeader('Content-Type', 'application/json');
  const url = new URL(q.url, 'http://localhost');

  if (q.method === 'GET' && url.pathname === '/health') {
    return r.end(JSON.stringify({ ok: true, jobs: Object.keys(jobs).length }));
  }

  if (q.method === 'GET' && url.pathname === '/status') {
    const jid = url.searchParams.get('jobId');
    if (!jid || !jobs[jid]) return r.end(JSON.stringify({ error: 'unknown job' }));
    const waitMs = Math.min(parseInt(url.searchParams.get('wait') || '0', 10) || 0, 60_000);
    const sinceStep = url.searchParams.get('sinceStep') || null;
    const sinceStatus = url.searchParams.get('sinceStatus') || null;

    const snapshot = () => {
      const j = jobs[jid];
      return {
        status: j.status,
        step: j.step,
        elapsed: ((Date.now() - j.startTime) / 1000) | 0,
        fileCount: j.files ? j.files.length : 0,
        error: j.error ? j.error.slice(0, 500) : null,
        uploadResult: j.uploadResult || null,
      };
    };

    const immediate = snapshot();
    const changed = (s) => s.status !== sinceStatus || s.step !== sinceStep;
    if (waitMs <= 0 || changed(immediate) || immediate.status !== 'running') {
      return r.end(JSON.stringify(immediate));
    }

    // Long-poll: hold the request open until status/step changes or wait expires.
    // This keeps inbound traffic flowing to the DO, preventing hibernation, AND
    // delivers state changes to the workflow with sub-second latency instead of 30s.
    const start = Date.now();
    const poll = setInterval(() => {
      if (!jobs[jid]) { clearInterval(poll); try { r.end(JSON.stringify({ error: 'job lost' })); } catch {} return; }
      const s = snapshot();
      if (changed(s) || s.status !== 'running' || Date.now() - start >= waitMs) {
        clearInterval(poll);
        try { r.end(JSON.stringify(s)); } catch {}
      }
    }, 1000);
    q.on('close', () => { clearInterval(poll); });
    return;
  }

  if (q.method === 'GET' && url.pathname === '/result') {
    const jid = url.searchParams.get('jobId');
    if (!jid || !jobs[jid]) return r.end(JSON.stringify({ error: 'unknown job' }));
    const j = jobs[jid];
    if (j.status === 'running') {
      return r.end(JSON.stringify({ error: 'still running', status: j.status, step: j.step }));
    }
    try { if (j.dir) fs.rmSync(j.dir, { recursive: true, force: true }); } catch {}
    const result = { status: j.status, files: j.files || [], error: j.error, uploadResult: j.uploadResult || null };
    deleteJob(jid);
    return r.end(JSON.stringify(result));
  }

  if (q.method === 'POST' && url.pathname === '/bundle-functions') {
    // Stage 2.2d — bundle a bolt-editor `functions/` subtree into one WfP worker.
    // The Worker sends ONLY the function SOURCES (a client-supplied bundle could
    // bypass the tenant-scoping shims), so we bundle them here with the TRUSTED
    // platform codegen via the SAME functions-build CLI the AI-build path uses.
    let b = '';
    q.on('data', c => { b += c; });
    q.on('end', () => {
      const dir = `/tmp/fnbundle-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      try {
        const { files } = JSON.parse(b || '{}');
        if (!Array.isArray(files) || files.length === 0) {
          return r.end(JSON.stringify({ ok: true, empty: true }));
        }
        // Write each source under the sandbox dir, PATH-SANITIZED — reject absolute
        // paths + `..` traversal so a hostile path can't escape the temp dir.
        for (const f of files) {
          if (!f || typeof f.path !== 'string' || typeof f.content !== 'string') continue;
          const rel = f.path.replace(/^\.?\//, '');
          if (rel.startsWith('/') || rel.split('/').includes('..')) continue;
          const abs = path.join(dir, rel);
          if (!abs.startsWith(dir + path.sep)) continue; // final containment check
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, f.content);
        }
        // Reuse the EXACT Stage 2.2a invocation (esbuild resolvable via NODE_PATH to
        // the global install; bundle.ts existsSync-probes the runtime at a FIXED
        // container path, independent of this temp dir). cli.ts bundles
        // <dir>/functions/ → one ESM worker + prints a FunctionsBuildResult JSON.
        const cliPath = '/home/cuser/scripts/functions-build/cli.ts';
        const out = spawnSync('tsx', [cliPath, dir], {
          cwd: dir,
          encoding: 'utf-8',
          timeout: 120000,
          maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env, NODE_PATH: `/usr/local/lib/node_modules:${dir}/node_modules` },
        });
        const stdout = (out.stdout || '').trim();
        if (stdout) return r.end(stdout); // already a FunctionsBuildResult JSON
        const why = `no stdout (status=${out.status} signal=${out.signal || ''}) ${(out.stderr || out.error?.message || '').slice(-240)}`;
        return r.end(JSON.stringify({ ok: false, error: why }));
      } catch (e) {
        return r.end(JSON.stringify({ ok: false, error: `bundle-functions threw: ${(e.message || String(e)).slice(0, 240)}` }));
      } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      }
    });
    return;
  }

  if (q.method === 'POST' && url.pathname === '/build-minimal') {
    let b = '';
    q.on('data', c => { b += c; });
    q.on('end', () => {
      const t0 = Date.now();
      try {
        const P = JSON.parse(b || '{}');
        const slug = P.slug || 'minimal-test';
        const dir = `/tmp/build-${slug}-${Date.now()}`;
        fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
        const html = `<!doctype html><html><head><meta charset=utf-8><title>${slug}</title></head><body><h1>Hello from container — ${slug}</h1><p>2+2=${2 + 2}</p><p>Built: ${new Date().toISOString()}</p></body></html>`;
        fs.writeFileSync(path.join(dir, 'dist', 'index.html'), html);

        const envVars = {};
        if (P.envVars && typeof P.envVars === 'object') {
          for (const ek in P.envVars) envVars[ek] = P.envVars[ek];
        }
        const envLines = ['#!/bin/sh'];
        for (const k in envVars) if (envVars[k]) envLines.push(`export ${k}=${JSON.stringify(envVars[k])}`);
        envLines.push('export HOME=/home/cuser');
        envLines.push(`cd ${dir}`);
        envLines.push(`node /home/cuser/upload-to-r2.mjs 2>&1`);
        const sf = `/tmp/run_min_${Date.now()}.sh`;
        fs.writeFileSync(sf, envLines.join('\n'));
        try { x(`chmod +x ${sf}`, { stdio: 'pipe' }); } catch {}
        try { x(`chown -R cuser:cuser ${dir}`, { stdio: 'pipe', shell: true }); } catch {}

        let uploadOk = false, uploadResult = null, stdoutTail = '';
        try {
          stdoutTail = x(`sh ${sf}`, { timeout: 60000, maxBuffer: 5 * 1024 * 1024, shell: true, encoding: 'utf-8' }).slice(-400);
          uploadResult = JSON.parse(fs.readFileSync(path.join(dir, '_upload_result.json'), 'utf-8'));
          uploadOk = uploadResult && uploadResult.uploaded > 0;
        } catch (e) { stdoutTail = (e.message || String(e)).slice(0, 400); }

        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}

        r.writeHead(200);
        r.end(JSON.stringify({
          ok: uploadOk,
          elapsedMs: Date.now() - t0,
          uploadResult,
          stdoutTail,
        }));
      } catch (e) {
        r.writeHead(200);
        r.end(JSON.stringify({ ok: false, error: e.message, elapsedMs: Date.now() - t0 }));
      }
    });
    return;
  }

  if (q.method === 'POST' && url.pathname === '/build-stub') {
    let b = '';
    q.on('data', c => { b += c; });
    q.on('end', () => {
      try {
        const P = JSON.parse(b);
        const jobId = `stub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const callbackUrl = P.callbackUrl || null;
        const callbackSecret = P.callbackSecret || null;
        jobs[jobId] = {
          jobId,
          status: 'running',
          dir: null,
          startTime: Date.now(),
          step: 'stub-init',
          error: null,
          files: null,
          uploadResult: null,
          callbackUrl,
          callbackSecret,
        };
        saveJob(jobId);
        pushStatus(jobId);

        const steps = ['stub-foundation', 'stub-inspect', 'stub-enhance', 'stub-finalize'];
        let i = 0;
        const tick = setInterval(() => {
          if (!jobs[jobId]) { clearInterval(tick); return; }
          if (i < steps.length) {
            setStatus(jobId, { step: steps[i] });
            i++;
          } else {
            setStatus(jobId, {
              status: 'complete',
              step: 'done',
              uploadResult: { uploaded: 3, failed: 0, version: `stub-v-${Date.now()}` },
              files: [{ name: 'index.html', content: '<h1>stub ok</h1>' }],
            });
            clearInterval(tick);
          }
        }, 6000);

        r.writeHead(200);
        r.end(JSON.stringify({ jobId, status: 'started', mode: 'stub' }));
      } catch (e) {
        r.writeHead(200);
        r.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (q.method === 'POST' && url.pathname === '/build') {
    let b = '';
    q.on('data', c => { b += c; });
    q.on('end', () => {
      try {
        const P = JSON.parse(b);
        const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const dir = `/tmp/build-${P.slug || 'site'}-${Date.now()}`;
        fs.mkdirSync(dir, { recursive: true });

        // Lazy refresh — bring skills + template up to origin/main on burst job arrivals.
        maybeRefreshSkills();

        if (P.skipBuild !== true && fs.existsSync(`${TEMPLATE_DIR}/package.json`)) {
          try {
            x(`cp -r ${TEMPLATE_DIR}/* ${dir}/ 2>/dev/null; cp -r ${TEMPLATE_DIR}/.[!.]* ${dir}/ 2>/dev/null; true`, { shell: true, stdio: 'pipe' });
            console.warn(`[${jobId}] Template copied`);
          } catch {}
        }

        // ORDERING (journey defect 2026-08-19): contextFiles MUST be written AFTER
        // the template copy — the template's shipped _brand.json carries
        // {BUSINESS_NAME} placeholders and the cp -r OVERWROTE the workflow's
        // materialized seed on every build. The seed writes last and wins.
        if (P.contextFiles && typeof P.contextFiles === 'object') {
          for (const k in P.contextFiles) {
            fs.writeFileSync(
              path.join(dir, `_${k}`),
              typeof P.contextFiles[k] === 'string' ? P.contextFiles[k] : JSON.stringify(P.contextFiles[k], null, 2)
            );
          }
          console.warn(`[${jobId}] contextFiles written (post-template-copy): ${Object.keys(P.contextFiles).join(', ')}`);
        }

        // MECHANICAL TOKEN SUBSTITUTION — the template ships error pages
        // (offline.html, 500.html, something-went-wrong) with RAW
        // {BUSINESS_NAME}-style tokens the LLM never touches; the brand gate
        // correctly blocks those. Substitute them here, deterministically, in
        // EVERY text file of the build dir — no LLM compliance involved.
        // (Journey 2026-08-19: the gate's error list showed offline/500 pages
        // were the remaining token carriers.)
        try {
          const brandJson = P.contextFiles && P.contextFiles['brand.json'];
          if (brandJson) {
            const brand = JSON.parse(brandJson);
            const biz = brand.business || {};
            const val = (leaf) => (leaf && typeof leaf.$value === 'string' ? leaf.$value : '');
            const TOKENS = {
              '{BUSINESS_NAME}': val(biz.name),
              '{BUSINESS_SHORT_NAME}': val(biz.shortName) || val(biz.name).slice(0, 12),
              '{BUSINESS_TAGLINE}': val(biz.tagline),
              '{BUSINESS_DESCRIPTION}': val(biz.description),
              '{BUSINESS_URL}': val(biz.url),
              '{BUSINESS_EMAIL}': val(biz.email),
              '{BUSINESS_PHONE}': val(biz.phone),
              '{BUSINESS_ADDRESS}': val(biz.address),
              '{BUSINESS_HOURS}': val(biz.hours),
              '{BUSINESS_CLASS}': val(biz.businessClass) || 'organization',
            };
            const TEXT_EXT = new Set(['.html', '.htm', '.js', '.mjs', '.css', '.json', '.xml', '.txt', '.svg', '.webmanifest', '.md']);
            let replaced = 0;
            const walk = (d) => {
              for (const f of fs.readdirSync(d)) {
                if (f === 'node_modules' || f === '.git' || f === '.claude') continue;
                const fp = path.join(d, f);
                const st = fs.statSync(fp);
                if (st.isDirectory()) { walk(fp); continue; }
                if (!TEXT_EXT.has(path.extname(f).toLowerCase())) continue;
                let content = fs.readFileSync(fp, 'utf-8');
                let changed = false;
                for (const [tok, rep] of Object.entries(TOKENS)) {
                  if (content.includes(tok)) { content = content.split(tok).join(rep); changed = true; replaced++; }
                }
                // Empty-tagline repair — an empty {BUSINESS_TAGLINE} leaves a
                // dangling 'NAME — ' in <title>/og:title (the live 'Cedar Ridge
                // Bakeshop — ' title, journey 2026-08-19). Collapse any
                // substituted ' —  '/' — ' remnant that ends a text node.
                if (content.includes('\u2014')) {
                  content = content
                    .replace(/\u2014\s*(<\/title>|<\/meta>|"\s*\/?>|'\s*\/?>)/gi, '$1')
                    .replace(/\s\u2014\s*$/gm, '');
                  changed = true;
                }
                // Double-dot canonical repair — the LLM writes
                // https://<slug>..projectsites.dev (slug already dot-suffixed
                // in its mental model). Mechanical repair, no LLM compliance.
                if (content.includes('..projectsites.dev')) {
                  content = content.split('..projectsites.dev').join('.projectsites.dev');
                  changed = true; replaced++;
                }
                if (changed) fs.writeFileSync(fp, content);
              }
            };
            walk(dir);
            console.warn(`[${jobId}] Token substitution: ${replaced} replacements in build dir`);
          }
        } catch (subErr) {
          console.warn(`[${jobId}] Token substitution skipped: ${subErr.message}`);
        }

        if (P.claudeMd) fs.writeFileSync(path.join(dir, 'CLAUDE.md'), P.claudeMd);

        try { x(`chown -R cuser:cuser ${dir}`, { stdio: 'pipe', shell: true }); } catch {}

        const envVars = { ANTHROPIC_API_KEY: P._anthropicKey || '' };
        // Ideogram key powers the logo-generation fallback (ensureLogo) when the
        // official mark isn't recoverable online. Threaded top-level like the LLM keys.
        if (P._ideogramKey) envVars.IDEOGRAM_API_KEY = P._ideogramKey;
        if (P.envVars && typeof P.envVars === 'object') {
          for (const ek in P.envVars) envVars[ek] = P.envVars[ek];
        }
        // DeepSeek-primary path: override Claude Code's Anthropic endpoint with DeepSeek's
        // Anthropic-compatible API. ANTHROPIC_API_KEY stays as fallback if DeepSeek errors.
        if (P._deepseekKey && P._anthropicBaseUrl) {
          envVars.ANTHROPIC_BASE_URL = P._anthropicBaseUrl;
          envVars.ANTHROPIC_AUTH_TOKEN = P._deepseekKey;
          envVars.ANTHROPIC_MODEL = P._anthropicModel || 'deepseek-chat';
        }

        const callbackUrl = P.callbackUrl || envVars.CALLBACK_URL || null;
        const callbackSecret = P.callbackSecret || envVars.CALLBACK_SECRET || null;

        runJob(jobId, dir, P.prompt || '', envVars, P.timeoutMin || 14, callbackUrl, callbackSecret, P.skipBuild === true);
        r.writeHead(200);
        r.end(JSON.stringify({ jobId, status: 'started' }));
      } catch (e) {
        r.writeHead(200);
        r.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  r.writeHead(404);
  r.end(JSON.stringify({ error: 'not found' }));
}).listen(8080, () => console.warn('[container] Ready on :8080'));
