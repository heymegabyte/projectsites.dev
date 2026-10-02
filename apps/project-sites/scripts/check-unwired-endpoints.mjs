#!/usr/bin/env node
/**
 * check-unwired-endpoints.mjs — "Save failed 404" regression detector.
 *
 * Caps the 2026-08-02 admin-verification arc: after finding + wiring two admin
 * features whose frontend called a worker route that DID NOT EXIST (P0.20
 * `PATCH /api/admin/profile` → 404 on every display-name save; P0.21
 * `GET/PUT /api/voice/mcp-attachments` → the voice MCPs tab's "Save failed"),
 * this gate prevents the class from recurring: every `/api/*` path the Angular
 * admin calls MUST resolve to a registered worker route.
 *
 * Heuristic (per validator-precision-discipline — prefers false-negatives):
 *   - Collect every worker route registration `.get|post|put|patch|delete|all|on('/…')`
 *     across `src/` + `libs/` (comment lines skipped), normalized to a SHAPE
 *     (`:param` / `${expr}` segments → `*`).
 *   - Collect every FE call `api.<m>('/x')` (ApiService prepends `/api`) and
 *     `http.<m>('/api/x')` (raw, full path) across `frontend/src/app`
 *     (comment lines skipped; fully-dynamic variable paths skipped).
 *   - FLAG any FE `/api/*` shape with no matching worker shape.
 *
 * Exit 0 (report-only / soft-info) by default; pass `--ci` to exit 1 on any
 * finding (surface is stable at zero as of the arc close). `--json` for machine.
 *
 * Usage: node scripts/check-unwired-endpoints.mjs [--ci] [--json]
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const FE_DIR = join(APP_DIR, 'frontend', 'src', 'app');
const WORKER_DIRS = [join(APP_DIR, 'src'), join(APP_DIR, 'libs')];

/**
 * BUILT-AHEAD FE calls — the frontend component ships before its worker route is
 * wired (the "wire-me backlog" class). These 6 were
 * surfaced 2026-08-02 when the regex was fixed to see generic-typed calls
 * (`api.get<T>(...)`). They are INTENTIONAL, TRACKED gaps — not accidental
 * regressions — so they're exempted here; the gate still blocks any NEW unwired
 * call. Remove an entry from this set the turn its worker route is wired.
 */
const EXEMPT_SHAPES = new Set([
  'POST /api/sites/*/ai-endpoints/*/invoke', // ai-logs "re-invoke" — worker invoke route not built (button has a captured-input fallback)
  'GET /api/admin/grafana/status', // grafana-dashboard — planned observability surface
  'GET /api/swarm/*/runs', // swarm.component — planned agent-swarm subsystem
  'POST /api/swarm/*/start', // swarm.component — planned agent-swarm subsystem
  'GET /api/voice/conversations/*', // voice conversation DETAIL — list exists (/voice/conversations), detail route not built
  // (voice number search FIXED 2026-08-02: runSearch() now calls the real
  //  GET /api/voice/numbers/search — no longer exempted.)
  // Surfaced 2026-08-02 when the regex learned to see fluent line-split calls (`this.api\n.get(...)`):
  'GET /api/v1-tokens', // api-tokens — "Public API v1 token management" UI, built ahead of the Public-Developer-API worker (monumental initiative)
  'POST /api/v1-tokens', // api-tokens — same (mint)
  'DELETE /api/v1-tokens/*', // api-tokens — same (revoke)
  // site-mcp-server.component — per-site MCP token CRUD + tools/usage read, built ahead
  // of its worker routes; the `site_mcp_server` flag is DARK (not in the registry → 404s
  // regardless), so these are INTENTIONAL built-ahead gaps. Wire on flag promotion
  // (convert-on-promotion). Remove these 4 the turn the site-mcp worker routes are built.
  'DELETE /api/sites/*/mcp/tokens/*',
  'GET /api/sites/*/mcp/tokens',
  'GET /api/sites/*/mcp/tools',
  'GET /api/sites/*/mcp/tool-usage',
  // (social AI-assist FIXED 2026-08-02: generate() now calls the real
  //  POST /api/social/:siteId/posts/generate — no longer exempted.)
  // kv/r2 inspectors ARE wired (index.ts `app.route('/', kvInspector|r2Inspector)` →
  //  /api/admin/{kv,r2}/*, flags kv_inspector|r2_inspector DARK); the detector can't
  //  resolve the mounted sub-router's 2-param shape, so these are false positives (fire-86).
  'GET /api/admin/kv/*/*',
  'GET /api/admin/r2/*/*',
  // bolt-embed.service.ts constructs cross-origin EDITOR URLs (editor.projectsites.dev),
  //  not projectsites-worker routes — resourceRegistryApi wires /resources[/reconcile]
  //  only, never /resources/*/* (fire-86).
  'POST /api/sites/*/resources/*/*',
]);
/** Matches `EXEMPT_SHAPES` entries `"<METHOD> <shape>"`. */
const exemptKey = (method, shape) => `${method} ${shape}`;

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__' || name.startsWith('.')) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.ts$/.test(name) && !/\.(spec|test|d)\.ts$/.test(name)) out.push(p);
  }
  return out;
}

/** True when the match at `index` sits on a comment line (JSDoc `*`, `//`, `/*`). */
function onCommentLine(src, index) {
  const lineStart = src.lastIndexOf('\n', index) + 1;
  const trimmed = src.slice(lineStart, index).trimStart();
  return trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*');
}

/** Normalize a path to a shape: drop query/hash, dynamic segments → '*'. */
function shape(path) {
  const p = path.split('?')[0].split('#')[0];
  if (!p.startsWith('/')) return null;
  return p
    .split('/')
    .map((seg) => (seg.includes('${') || seg.startsWith(':') ? '*' : seg))
    .join('/');
}

// ── Worker routes ──
const workerShapes = new Set();
let workerCount = 0;
const routeRe = /\.(get|post|put|patch|delete|all|on)\(\s*[`'"]([^`'"]+)[`'"]/g;
for (const dir of WORKER_DIRS) {
  for (const f of walk(dir)) {
    const src = readFileSync(f, 'utf8');
    let m;
    while ((m = routeRe.exec(src))) {
      if (onCommentLine(src, m.index)) continue;
      const raw = m[2];
      if (!raw.startsWith('/')) continue;
      const s = shape(raw);
      if (s) {
        workerShapes.add(s);
        workerCount++;
      }
    }
  }
}

// ── Prefix-mounted sub-routers ──
// `app.route('/api/x', subRouter)` mounts a router whose OWN registrations use RELATIVE
// paths (`subRouter.post('/dismiss')` → collected above as the shape `/dismiss`, NOT
// `/api/x/dismiss`). Collect these mount prefixes so a FE call to the FULL path can be
// resolved by stripping the prefix + matching the relative shape. Without this, every
// prefix-mounted route (onboarding_copilot, audit_trail_export, …) is a false positive.
const mountPrefixes = [];
const mountRe = /\.route\(\s*[`'"](\/api\/[^`'"]+)[`'"]/g;
for (const dir of WORKER_DIRS) {
  for (const f of walk(dir)) {
    const src = readFileSync(f, 'utf8');
    let m;
    while ((m = mountRe.exec(src))) {
      if (onCommentLine(src, m.index)) continue;
      const pfx = shape(m[1]);
      if (pfx) mountPrefixes.push(pfx);
    }
  }
}

// ── FE calls ──
// Match an optional TS generic between the method and `(` — e.g.
// `api.get<{ data: ApiToken[] }>('/x')` — so generic-typed calls aren't missed
// (that false-negative hid the /api/v1-tokens 404, found by visual sweep 2026-08-02).
const feCallRe = /\b(api|http)\s*\.\s*(get|post|put|patch|delete)\s*(?:<[^(;]*>)?\s*\(\s*([`'"])([^`'"]*)\3/g;
const flagged = [];
const seen = new Set();
for (const f of walk(FE_DIR)) {
  const src = readFileSync(f, 'utf8');
  let m;
  while ((m = feCallRe.exec(src))) {
    if (onCommentLine(src, m.index)) continue;
    const kind = m[1];
    const method = m[2].toUpperCase();
    let path = m[4];
    if (!path) continue; // fully-dynamic variable path — unresolvable statically
    if (kind === 'api') path = '/api' + path;
    if (!path.startsWith('/api')) continue;
    const s = shape(path);
    // `/*` = the whole path is one dynamic segment — i.e. the ApiService GENERIC verb
    // helpers (`get<T>(path) => http.get(\`/api${path}\`)`) + any fully-dynamic call.
    // These are unresolvable + not concrete endpoints (the docstring promises to skip
    // "fully-dynamic variable paths") — never a real unwired route. Skip to kill the
    // GET|POST|PUT|PATCH|DELETE `/*` false positives on api.service.ts.
    // `/*` and any `/*/…` (fully-dynamic FIRST segment) = an unresolvable variable-base
    // URL (e.g. bolt-embed's cross-origin `${base}/${x}` editor calls) — a real worker
    // route never has a dynamic first segment, so these are never a concrete unwired route
    // (the docstring promises to skip "fully-dynamic variable paths"). (fire-86)
    if (!s || s === '/*' || s.startsWith('/*/') || EXEMPT_SHAPES.has(exemptKey(method, s))) continue;
    if (!workerShapes.has(s)) {
      // Resolve prefix-mounted sub-routers: strip a known `/api/x` mount prefix and
      // match the remainder against the relative shapes (`/api/onboarding/dismiss` →
      // strip `/api/onboarding` → `/dismiss`, which IS registered by onboardingCopilot).
      const wiredViaMount = mountPrefixes.some(
        (pfx) => s.startsWith(pfx + '/') && workerShapes.has(s.slice(pfx.length)),
      );
      if (wiredViaMount) continue;
      const key = method + ' ' + s;
      if (!seen.has(key)) {
        seen.add(key);
        flagged.push({ method, shape: s, file: f.replace(FE_DIR + '/', '') });
      }
    }
  }
}

const ci = process.argv.includes('--ci');
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ worker_routes: workerCount, worker_shapes: workerShapes.size, unwired: flagged }, null, 2));
  process.exit(ci && flagged.length ? 1 : 0);
}

if (flagged.length === 0) {
  console.log(`✅ check-unwired-endpoints: clean — every FE /api call resolves (${workerShapes.size} worker route shapes).`);
  process.exit(0);
}
console.log(`⚠️  check-unwired-endpoints: ${flagged.length} FE call(s) to a route with NO worker handler:`);
for (const f of flagged) {
  console.log(`   FAIL ${f.method.padEnd(6)} ${f.shape.padEnd(46)} ${f.file} — wire the worker route or fix the FE path`);
}
process.exit(ci ? 1 : 0);
