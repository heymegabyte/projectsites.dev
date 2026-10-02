#!/usr/bin/env node
/**
 * detect-orphans.mjs
 *
 * Orphaned-code detector for ProjectSites — makes it impossible for a SUBSTANTIAL
 * code unit to sit disconnected from a user-facing surface unnoticed. This is the
 * anti-mishap the SQL/Table-editor near-miss exposed: a fully-built editor panel
 * (`app/components/workbench/DataPanel.tsx`) can exist, export cleanly, typecheck,
 * and never be rendered — invisible to every other gate (build passes, tests pass,
 * lint passes). Interconnectedness is the invariant this enforces.
 *
 * Detects four classes of orphan (a MAJOR code unit with 0 reachable references to
 * a user-facing surface):
 *
 *   1. EDITOR_PANEL   — a React panel/component under `app/components/**` that is
 *                       exported but never imported/rendered anywhere else. (The
 *                       DataPanel case — the canonical test that the detector works.)
 *   2. FEATURE_MODULE — a `libs/features/<slug>/` module with a manifest but whose
 *                       slug/flag/handler is never referenced by a route mount, the
 *                       flag registry, the Angular routes, or FEATURES.md.
 *   3. WORKER_ROUTE   — a Hono sub-app exported from `src/routes/**` but never
 *                       imported AND mounted (`app.route(...)`) on the root app.
 *   4. MCP_TOOL       — an MCP tool/adapter defined but never dispatched/registered
 *                       (a tool name in a registry with no dispatch reference, or an
 *                       MCP adapter module nothing imports).
 *
 * Approach: an import-graph / symbol-reference scan via ripgrep (fast, already on
 * the box) with a pure-Node fallback. knip-style "unused" is NOT always dead, so
 * every finding carries a confidence (high|medium) + a suggested wiring target, and
 * a baseline allowlist (`scripts/orphans-allowlist.json`) suppresses accepted ones.
 *
 * Exit 0  → no NEW orphans (allowlisted ones are reported but don't fail)
 * Exit 1  → one or more NEW orphans (not in the allowlist) — CI/lefthook merge-block
 *
 * Node 22 native ESM — no build step (per node-build-tooling-in-scripts rule).
 *
 * @packageDocumentation
 */

import { readFile, readdir } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/ lives at apps/project-sites/scripts → PROJECT is apps/project-sites
const PROJECT = path.resolve(__dirname, '..');
// The editor (bolt.diy) lives at the MONOREPO root `app/`, two levels above the project.
const MONOREPO = path.resolve(PROJECT, '..', '..');
const APP_DIR = path.join(MONOREPO, 'app');
const ALLOWLIST_PATH = path.join(PROJECT, 'scripts', 'orphans-allowlist.json');

const relFromRepo = (p) => path.relative(MONOREPO, p);

// ─── ripgrep availability + a resilient search helper ───────────────────────────
//
// The interactive shell aliases `rg` through the Claude binary, but a direct
// execFile of the real ripgrep is what we want here. Probe common locations, then
// fall back to a pure-Node recursive scan so the detector never hard-depends on rg.

function resolveRipgrep() {
  const candidates = [
    'rg',
    '/opt/homebrew/bin/rg',
    '/usr/local/bin/rg',
    '/usr/bin/rg',
    path.join(MONOREPO, 'node_modules', '.bin', 'rg'),
  ];
  for (const bin of candidates) {
    try {
      execFileSync(bin, ['--version'], { stdio: 'ignore' });
      return bin;
    } catch {
      /* try next */
    }
  }
  return null;
}

const RG = resolveRipgrep();

/**
 * Count files (excluding `excludeAbs`) that contain a literal `needle`, scanning the
 * given roots. Returns the list of matching relative paths. Used to answer "is this
 * symbol referenced anywhere but its own definition?".
 */
function filesReferencing(needle, roots, excludeAbs = []) {
  const excludeSet = new Set(excludeAbs.map((p) => path.resolve(p)));
  const existingRoots = roots.filter((r) => existsSync(r));
  if (existingRoots.length === 0) return [];

  if (RG) {
    try {
      // -l list files, -F fixed-string, --type-add to include ts/tsx/mjs.
      const out = execFileSync(
        RG,
        [
          '-l',
          '-F',
          needle,
          '-g',
          '*.ts',
          '-g',
          '*.tsx',
          '-g',
          '*.mjs',
          '-g',
          '*.js',
          '--glob',
          '!**/node_modules/**',
          '--glob',
          '!**/.claude/**',
          '--glob',
          '!**/dist/**',
          '--glob',
          '!**/build/**',
          ...existingRoots,
        ],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      );
      return out
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .filter((abs) => !excludeSet.has(path.resolve(abs)));
    } catch (err) {
      // rg exits 1 when there are zero matches — that's a valid "no references".
      if (err.status === 1) return [];
      // Any other failure → fall through to the pure-Node scan.
    }
  }
  return nodeScan(needle, existingRoots, excludeSet);
}

/** Pure-Node recursive substring scan fallback (no rg). */
function nodeScan(needle, roots, excludeSet) {
  const hits = [];
  const SKIP_DIRS = new Set(['node_modules', '.claude', 'dist', 'build', '.git']);
  const EXT = new Set(['.ts', '.tsx', '.mjs', '.js']);
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(abs);
      } else if (EXT.has(path.extname(entry.name))) {
        if (excludeSet.has(path.resolve(abs))) continue;
        try {
          if (readFileSync(abs, 'utf8').includes(needle)) hits.push(abs);
        } catch {
          /* unreadable — skip */
        }
      }
    }
  };
  for (const r of roots) walk(r);
  return hits;
}

// ─── Allowlist ──────────────────────────────────────────────────────────────────

function loadAllowlist() {
  if (!existsSync(ALLOWLIST_PATH)) return { entries: [], byKey: new Set() };
  try {
    const raw = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
    const entries = Array.isArray(raw.allow) ? raw.allow : [];
    // Key each entry by "type::path" so a path allowlisted for one class doesn't
    // silently suppress a different class of finding on the same file.
    const byKey = new Set(entries.map((e) => `${e.type}::${e.path}`));
    return { entries, byKey };
  } catch (err) {
    console.error(`[warn] could not parse ${relFromRepo(ALLOWLIST_PATH)}: ${err.message}`);
    return { entries: [], byKey: new Set() };
  }
}

// ─── 1. EDITOR PANELS (app/components/**) ────────────────────────────────────────
//
// A "major" panel is a PascalCase .tsx that exports a component. It's an orphan when
// its component symbol is imported by nothing else. We only flag substantial files
// (>= MIN_PANEL_LINES) to avoid noise from tiny leaf presentational bits.

const MIN_PANEL_LINES = 120;

/**
 * Scope: the DataPanel mishap is about SUBSTANTIAL feature PANELS in the workbench
 * (the editor's tab surfaces), not the shared UI kit. We therefore scan
 * `app/components/workbench/**` (+ the top level of `app/components`) for panel-class
 * components and skip the `ui/` design-system + `@settings/` (barrel-exported
 * primitives whose wiring model is different). A component is a "panel" when it's a
 * substantial (>= MIN_PANEL_LINES) PascalCase `*Panel`/`*Tab`/`*Inspector`/`*Browser`
 * (or a big top-level workbench component). It's ORPHANED when its MODULE is imported
 * by no non-test file AND it's rendered as JSX nowhere.
 */
async function findOrphanEditorPanels() {
  const findings = [];
  if (!existsSync(APP_DIR)) return findings;

  const workbenchDir = path.join(APP_DIR, 'components', 'workbench');
  const roots = [workbenchDir].filter(existsSync);
  if (roots.length === 0) return findings;

  const PANEL_SUFFIX = /(Panel|Tab|Inspector|Browser|Editor|View|Console|Terminal)$/;

  const tsxFiles = [];
  for (const r of roots) tsxFiles.push(...(await collectFiles(r, (name) => name.endsWith('.tsx'))));

  for (const abs of tsxFiles) {
    // Skip the design-system kit + settings primitives (different wiring model).
    if (/\/components\/(ui|@settings)\//.test(abs)) continue;

    const base = path.basename(abs, '.tsx');
    const compName = base.replace(/\.client$/, '');
    if (!/^[A-Z][A-Za-z0-9]+$/.test(compName)) continue;

    const src = await readFile(abs, 'utf8');
    const lineCount = src.split('\n').length;
    // A "major" panel: either the name looks panel-like, or it's a big top-level file.
    const looksLikePanel = PANEL_SUFFIX.test(compName) || lineCount >= 300;
    if (!looksLikePanel || lineCount < MIN_PANEL_LINES) continue;

    // Must actually export the component to be a wireable unit.
    const exportsComponent =
      new RegExp(`export\\s+(const|function|class)\\s+${compName}\\b`).test(src) ||
      new RegExp(`export\\s*\\{[^}]*\\b${compName}\\b`).test(src) ||
      /export\s+default/.test(src);
    if (!exportsComponent) continue;

    // WIRED if: another non-test file imports THIS MODULE (by path — barrel re-export
    // counts, `import type` from it counts as reachable), OR renders <CompName/> as JSX.
    // Bare comment/JSDoc mentions of the name do NOT count (the false-wiring trap).
    const moduleStem = base; // e.g. "DataPanel" or "Terminal.client"
    const candidateFiles = filesReferencing(compName, [APP_DIR], [abs]).concat(
      filesReferencing(`/${moduleStem}`, [APP_DIR], [abs]),
    );
    const uniqueCandidates = [...new Set(candidateFiles)];

    const wired = uniqueCandidates.some((f) => {
      if (/\.(test|spec|stories)\.[tj]sx?$/.test(f)) return false; // tests aren't a surface
      const content = safeRead(f);
      // (a) imports this module by path (named, default, namespace, type, or barrel re-export)
      const importsModule = new RegExp(
        `(import|export)\\b[^;\\n]*\\bfrom\\s*['"][^'"]*\\/${escapeRe(moduleStem)}(\\.js)?['"]`,
      ).test(content);
      const dynImportsModule = new RegExp(`import\\([^)]*['"][^'"]*\\/${escapeRe(moduleStem)}['"]`).test(content);
      // (b) renders it as a JSX element or wires it as a route component
      const rendersJsx = new RegExp(`<${compName}[\\s/>]`).test(content);
      const routeComponent = new RegExp(`component:\\s*${compName}\\b`).test(content);
      return importsModule || dynImportsModule || rendersJsx || routeComponent;
    });

    if (!wired) {
      findings.push({
        type: 'EDITOR_PANEL',
        path: relFromRepo(abs),
        unit: compName,
        confidence: 'high',
        why: `Panel "${compName}" (${lineCount} lines) is exported but its module is imported by no non-test file and it is rendered as JSX nowhere under app/ — only comment mentions, which don't wire it to a surface.`,
        suggest:
          'Wire it into a PanelLayer in app/components/workbench/Workbench.client.tsx (or the owning tab/route), or delete it if superseded.',
      });
    }
  }
  return findings;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── 2. FEATURE MODULES (libs/features/*) ────────────────────────────────────────
//
// A module is orphaned when its slug/flagKey/handler is referenced by nothing that
// wires it to a surface: not the root index.ts route mounts, not the flag registry,
// not the Angular app.routes.ts, not FEATURES.md.

async function findOrphanFeatureModules() {
  const findings = [];
  const featuresRoot = path.join(PROJECT, 'libs', 'features');
  if (!existsSync(featuresRoot)) return findings;

  const indexSrc = safeRead(path.join(PROJECT, 'src', 'index.ts'));
  const registrySrc = safeRead(path.join(PROJECT, 'src', 'modules', 'feature_flags', 'registry.ts'));
  const angularRoutesSrc = safeRead(
    path.join(PROJECT, 'frontend', 'src', 'app', 'app.routes.ts'),
  );
  const featuresMd = safeRead(path.join(PROJECT, 'FEATURES.md')) + safeRead(path.join(PROJECT, 'e2e', 'FEATURES.md'));

  const entries = await readdir(featuresRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    const dir = path.join(featuresRoot, slug);

    // Find a manifest — both conventions exist in-repo (manifest.ts + feature.manifest.ts).
    const manifestFile = ['manifest.ts', 'feature.manifest.ts', 'manifest.js', 'feature.manifest.js']
      .map((f) => path.join(dir, f))
      .find((p) => existsSync(p));
    if (!manifestFile) continue; // no manifest → not a "declared" feature module; skip.

    const manifestSrc = safeRead(manifestFile);
    const flagKey = matchField(manifestSrc, 'flagKey') || slug;

    // A feature is "wired" if ANY of these surfaces reference it.
    const wiredInRegistry =
      registrySrc.includes(`'${flagKey}'`) ||
      registrySrc.includes(`"${flagKey}"`) ||
      new RegExp(`\\b${flagKey}\\s*:`).test(registrySrc);
    const wiredInAngular =
      angularRoutesSrc.includes(`'${flagKey}'`) || angularRoutesSrc.includes(`'${slug}'`);
    const wiredInFeaturesMd = featuresMd.includes(slug) || featuresMd.includes(flagKey);

    // Does the root worker import from this module's handlers, or mount its slug path?
    const importsHandler =
      new RegExp(`libs/features/${slug}/`).test(indexSrc) ||
      new RegExp(`/api/${slug.replace(/_/g, '[-_]')}`).test(indexSrc);

    // Is the module referenced by ANY source file outside its own dir?
    const externalRefs = filesReferencing(`libs/features/${slug}`, [
      path.join(PROJECT, 'src'),
      path.join(PROJECT, 'frontend', 'src'),
      path.join(PROJECT, 'libs'),
    ]).filter((f) => !path.resolve(f).startsWith(path.resolve(dir)));

    const wired =
      wiredInRegistry || wiredInAngular || wiredInFeaturesMd || importsHandler || externalRefs.length > 0;

    if (!wired) {
      findings.push({
        type: 'FEATURE_MODULE',
        path: relFromRepo(dir),
        unit: slug,
        confidence: 'medium',
        why: `Feature module "${slug}" (flag "${flagKey}") has a manifest but is referenced by no route mount, the flag registry, app.routes.ts, FEATURES.md, or any other source file.`,
        suggest: `Mount its handlers in src/index.ts via app.route(...), register "${flagKey}" in src/modules/feature_flags/registry.ts, add an app.routes.ts entry, and add its FEATURES.md row — or remove the module.`,
      });
    }
  }
  return findings;
}

// ─── 3. WORKER ROUTES (src/routes/**) ────────────────────────────────────────────
//
// A route file exports one or more Hono sub-apps. It's an orphan when its exported
// symbol is neither imported by src/index.ts NOR mounted via app.route(). We derive
// the export names from `export { X }` / `export const X = new Hono` / `export function
// createXRoutes`, then check index.ts for both the import and an app.route(... X).

async function findOrphanWorkerRoutes() {
  const findings = [];
  const routesDir = path.join(PROJECT, 'src', 'routes');
  if (!existsSync(routesDir)) return findings;

  const indexSrc = safeRead(path.join(PROJECT, 'src', 'index.ts'));

  const routeFiles = (await readdir(routesDir)).filter(
    (f) => f.endsWith('.ts') && !f.includes('.test.') && !f.includes('.spec.'),
  );

  for (const file of routeFiles) {
    const abs = path.join(routesDir, file);
    const src = safeRead(abs);

    const exportNames = extractRouteExports(src);
    if (exportNames.length === 0) continue; // no Hono export → not a mountable route unit.

    // A route file is wired if index.ts imports from it AND at least one of its
    // exports is passed to app.route(...). Factory-style routes (createXRoutes) are
    // wired if index.ts imports+calls the factory.
    const importedFromFile =
      new RegExp(`from ['"][^'"]*routes/${file.replace(/\.ts$/, '')}(\\.js)?['"]`).test(indexSrc);

    const anyMounted = exportNames.some((name) => {
      // The export may be aliased on import (`import { scanProfiles as scanProfilesRoutes }`).
      const aliasMatch = indexSrc.match(
        new RegExp(`import\\s*\\{[^}]*\\b${name}\\b(?:\\s+as\\s+([A-Za-z0-9_]+))?[^}]*\\}\\s*from`),
      );
      const mountedName = aliasMatch && aliasMatch[1] ? aliasMatch[1] : name;
      const mounted = new RegExp(`app\\.route\\([^)]*\\b${mountedName}\\b`).test(indexSrc);
      // Factory routes: mounted through a returned value, e.g. app.route('/', createJobsRoutes(...)).
      const factoryMounted =
        /^create[A-Z]/.test(name) && new RegExp(`\\b${name}\\s*\\(`).test(indexSrc);
      return mounted || factoryMounted;
    });

    if (!importedFromFile && !anyMounted) {
      // Belt-and-suspenders: confirm the symbol truly isn't referenced elsewhere in src/.
      const refs = filesReferencing(exportNames[0], [path.join(PROJECT, 'src')], [abs]).filter(
        (f) => !/\.(test|spec)\.[tj]sx?$/.test(f),
      );
      if (refs.length === 0) {
        findings.push({
          type: 'WORKER_ROUTE',
          path: relFromRepo(abs),
          unit: exportNames.join(', '),
          confidence: 'high',
          why: `Route file exports Hono app(s) [${exportNames.join(', ')}] but src/index.ts neither imports the file nor mounts it via app.route().`,
          suggest: `Add \`import { ${exportNames[0]} } from './routes/${file.replace(/\.ts$/, '.js')}';\` + \`app.route('/', ${exportNames[0]});\` in src/index.ts — or delete the file if superseded.`,
        });
      }
    }
  }
  return findings;
}

/** Pull exported Hono/route symbol names from a route file's source. */
function extractRouteExports(src) {
  const names = new Set();
  // export const foo = new Hono...
  for (const m of src.matchAll(/export\s+const\s+([A-Za-z0-9_]+)\s*=\s*new\s+Hono/g)) names.add(m[1]);
  // export { foo, bar }  (only keep ones that look like a Hono app / route bundle)
  for (const m of src.matchAll(/export\s*\{\s*([^}]+)\}/g)) {
    for (const raw of m[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim();
      if (!name) continue;
      // Heuristic: the file's default export bundle — check it's declared as a Hono somewhere.
      if (new RegExp(`(const|let)\\s+${name}\\s*=\\s*new\\s+Hono`).test(src)) names.add(name);
    }
  }
  // export function createXRoutes(...) { ... } — factory pattern.
  for (const m of src.matchAll(/export\s+function\s+(create[A-Za-z0-9_]*Routes?)\s*\(/g)) names.add(m[1]);
  return [...names];
}

// ─── 4. MCP TOOLS / ADAPTERS ──────────────────────────────────────────────────────
//
// Two shapes: (a) a tool NAME declared in an MCP tool registry (e.g. SITE_MCP_TOOLS)
// that the dispatcher never handles; (b) an MCP adapter/service module nothing imports.

async function findOrphanMcpTools() {
  const findings = [];
  const servicesDir = path.join(PROJECT, 'src', 'services');
  const registryFile = path.join(servicesDir, 'mcp_site_tools.ts');

  if (existsSync(registryFile)) {
    const src = safeRead(registryFile);
    // Extract tool names from the SITE_MCP_TOOLS registry array (`name: 'list_pages'`).
    const registryBlock = sliceBetween(src, 'SITE_MCP_TOOLS', 'dispatchTool');
    const toolNames = [...registryBlock.matchAll(/name:\s*['"]([a-z0-9_]+)['"]/g)].map((m) => m[1]);
    // The dispatcher body — everything from dispatchTool onward.
    const dispatchBlock = src.slice(src.indexOf('dispatchTool'));

    for (const tool of toolNames) {
      const dispatched =
        new RegExp(`['"]${tool}['"]`).test(dispatchBlock) || new RegExp(`\\b${tool}\\b`).test(dispatchBlock);
      if (!dispatched) {
        findings.push({
          type: 'MCP_TOOL',
          path: relFromRepo(registryFile),
          unit: tool,
          confidence: 'high',
          why: `MCP tool "${tool}" is declared in SITE_MCP_TOOLS but the dispatchTool() switch never handles it — calling it returns "unknown tool".`,
          suggest: `Add a case for "${tool}" in dispatchTool() (src/services/mcp_site_tools.ts), or remove it from the SITE_MCP_TOOLS registry.`,
        });
      }
    }
  }

  // MCP adapter/service modules that nothing imports (adapter defined, never registered).
  if (existsSync(servicesDir)) {
    const mcpModules = (await readdir(servicesDir)).filter(
      (f) => /mcp/i.test(f) && f.endsWith('.ts') && !f.includes('.test.') && f !== 'mcp_site_tools.ts',
    );
    for (const file of mcpModules) {
      const abs = path.join(servicesDir, file);
      const base = file.replace(/\.ts$/, '');
      const refs = filesReferencing(`services/${base}`, [
        path.join(PROJECT, 'src'),
        path.join(PROJECT, 'libs'),
      ]).filter((f) => path.resolve(f) !== path.resolve(abs) && !/\.(test|spec)\.[tj]sx?$/.test(f));
      if (refs.length === 0) {
        findings.push({
          type: 'MCP_TOOL',
          path: relFromRepo(abs),
          unit: base,
          confidence: 'medium',
          why: `MCP adapter module "${base}" is imported by no non-test source file — defined but never dispatched/registered.`,
          suggest: `Import + wire it where MCP tools are dispatched (routes/mcp_oauth.ts or the MCP feature module), or delete it.`,
        });
      }
    }
  }

  return findings;
}

// ─── 5. SERVICE MODULES (src/services/**) ───────────────────────────────────────────
//
// Until fire-86 the ONLY thing scanning src/services/ was the MCP-tool class (class 4),
// and it looks exclusively at `mcp`-named files — so a generic service "thunk" (a thin
// orchestration/dispatch module with a real exported entrypoint but ZERO non-test callers)
// slipped past every class. That's exactly how site_event_dispatch.ts (D-85-a) sat
// built-but-unwired + undetected. This class closes that gap: a substantial service module
// whose PRIMARY exported function is imported by no NON-TEST source file is an orphan.
//
// Scoped conservatively to avoid noise: only files >= MIN_SERVICE_LINES, skip barrels
// (index.ts) + anything class 4 already owns (mcp*). Confidence is 'medium' (a service may
// be a deliberately-reserved contract — allowlist those with a reason), mirroring how knip
// "unused" is verified-not-blind-deleted.

const MIN_SERVICE_LINES = 40;

async function findOrphanServiceModules() {
  const findings = [];
  const servicesDir = path.join(PROJECT, 'src', 'services');
  if (!existsSync(servicesDir)) return findings;

  const serviceFiles = (await readdir(servicesDir)).filter(
    (f) =>
      f.endsWith('.ts') &&
      f !== 'index.ts' &&
      !f.includes('.test.') &&
      !f.includes('.spec.') &&
      !/mcp/i.test(f), // class 4 (MCP_TOOL) already owns mcp*-named service modules
  );

  for (const file of serviceFiles) {
    const abs = path.join(servicesDir, file);
    const base = file.replace(/\.ts$/, '');
    const src = safeRead(abs);
    if (src.split('\n').length < MIN_SERVICE_LINES) continue;

    const exportNames = extractFunctionExports(src);
    if (exportNames.length === 0) continue; // no exported function → not a wireable entrypoint

    // WIRED if any NON-TEST source file (a) imports this module by path, or (b) references
    // any of its exported function names. Both the module-path form and the symbol form are
    // checked so an aliased or barrel-re-exported import still counts as reachable.
    const byPath = filesReferencing(`services/${base}`, [
      path.join(PROJECT, 'src'),
      path.join(PROJECT, 'libs'),
    ]).filter((f) => path.resolve(f) !== path.resolve(abs) && !/\.(test|spec)\.[tj]sx?$/.test(f));

    const bySymbol = exportNames.flatMap((name) =>
      filesReferencing(name, [path.join(PROJECT, 'src'), path.join(PROJECT, 'libs')], [abs]).filter(
        (f) => !/\.(test|spec)\.[tj]sx?$/.test(f),
      ),
    );

    if (byPath.length === 0 && bySymbol.length === 0) {
      findings.push({
        type: 'SERVICE_MODULE',
        path: relFromRepo(abs),
        unit: exportNames.join(', '),
        confidence: 'medium',
        why: `Service module "${base}" exports [${exportNames.join(', ')}] but no NON-TEST source file imports the module or references its exports — built but unwired (tests alone are not a surface).`,
        suggest: `Call it from a route handler / workflow step / cron that reaches a surface, or allowlist it in scripts/orphans-allowlist.json with a reason if it is a deliberately-reserved contract — or delete it.`,
      });
    }
  }
  return findings;
}

/** Pull exported top-level function/const-arrow names from a service file's source. */
function extractFunctionExports(src) {
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s+const\s+([A-Za-z0-9_]+)\s*(?::[^=]+)?=\s*(?:async\s*)?\(/g))
    names.add(m[1]);
  return [...names];
}

// ─── small helpers ────────────────────────────────────────────────────────────────

function safeRead(p) {
  try {
    return existsSync(p) ? readFileSync(p, 'utf8') : '';
  } catch {
    return '';
  }
}

function matchField(src, field) {
  const m = src.match(new RegExp(`${field}\\s*:\\s*['"]([^'"]+)['"]`));
  return m ? m[1] : null;
}

function sliceBetween(src, startNeedle, endNeedle) {
  const start = src.indexOf(startNeedle);
  if (start === -1) return '';
  const end = src.indexOf(endNeedle, start);
  return src.slice(start, end === -1 ? undefined : end);
}

async function collectFiles(dir, filterFn) {
  const out = [];
  const walk = async (d) => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', 'dist', 'build', '.git'].includes(entry.name)) continue;
        await walk(abs);
      } else if (filterFn(entry.name)) {
        out.push(abs);
      }
    }
  };
  await walk(dir);
  return out;
}

// ─── reporting ──────────────────────────────────────────────────────────────────

const ICON = { EDITOR_PANEL: '🧩', FEATURE_MODULE: '📦', WORKER_ROUTE: '🛣️ ', MCP_TOOL: '🔧', SERVICE_MODULE: '⚙️ ' };

// Classes that REPORT but do NOT fail the build yet. A freshly-added detector class
// starts advisory (audit-arc maturity ladder step 2 "Surface"): it surfaces the backlog
// every run without blocking, gets migrated toward zero over time, and only PROMOTES to a
// blocking class once stable at zero. SERVICE_MODULE launched in fire-86 against a large
// pre-existing unwired-service surface (~134) — blind-baselining those into the allowlist
// would rubber-stamp real orphans, so it stays advisory until that surface is drained.
const ADVISORY_TYPES = new Set(['SERVICE_MODULE']);

function report(findings, allowlist) {
  const isAllowed = (f) => allowlist.byKey.has(`${f.type}::${f.path}`);
  const notAllowed = findings.filter((f) => !isAllowed(f));
  const suppressed = findings.filter(isAllowed);
  // Only NON-advisory, non-allowlisted findings fail the build.
  const newOrphans = notAllowed.filter((f) => !ADVISORY_TYPES.has(f.type));
  const advisory = notAllowed.filter((f) => ADVISORY_TYPES.has(f.type));

  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║   detect-orphans — unwired major code units (interconnectedness gate)  ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  console.log(`   ripgrep: ${RG ? RG : 'not found → pure-Node scan fallback'}`);
  console.log(
    `   scanned: editor panels (app/components) · feature modules (libs/features) · worker routes (src/routes) · MCP tools (src/services) · service modules (src/services)`,
  );
  console.log('');

  if (newOrphans.length === 0) {
    console.log(
      `✅ No NEW blocking orphaned code units.${advisory.length > 0 ? ` (${advisory.length} advisory finding(s) below — non-blocking.)` : ' Every major unit is wired to a surface.'}`,
    );
  } else {
    console.log(`❌ ${newOrphans.length} NEW orphaned code unit(s) — each is unwired to any user-facing surface:`);
    console.log('');
    for (const f of newOrphans) {
      console.log(`${ICON[f.type] ?? '•'} [${f.type} · confidence:${f.confidence}]  ${f.unit}`);
      console.log(`     path:    ${f.path}`);
      console.log(`     why:     ${f.why}`);
      console.log(`     wire-to: ${f.suggest}`);
      console.log('');
    }
  }

  if (advisory.length > 0) {
    console.log(
      `⚠️  ${advisory.length} ADVISORY finding(s) [${[...ADVISORY_TYPES].join(', ')}] — reported, NOT build-blocking (drain this backlog, then promote to a hard class):`,
    );
    for (const f of advisory) {
      console.log(`     · ${ICON[f.type] ?? '•'} ${f.type} ${f.unit} (${f.path})`);
    }
    console.log('');
  }

  if (suppressed.length > 0) {
    console.log(`ℹ️  ${suppressed.length} allowlisted (intentional, suppressed) orphan(s):`);
    for (const f of suppressed) {
      const note = allowlist.entries.find((e) => e.type === f.type && e.path === f.path)?.reason;
      console.log(`     · ${f.type} ${f.unit} (${f.path})${note ? ` — ${note}` : ''}`);
    }
    console.log('');
  }

  const byType = {};
  for (const f of findings) byType[f.type] = (byType[f.type] || 0) + 1;
  console.log(
    `Summary: ${findings.length} total finding(s) [${Object.entries(byType)
      .map(([t, n]) => `${t}:${n}`)
      .join(', ') || 'none'}] · ${newOrphans.length} new (blocking) · ${advisory.length} advisory · ${suppressed.length} allowlisted`,
  );

  return newOrphans.length;
}

// ─── main ─────────────────────────────────────────────────────────────────────────

async function main() {
  const allowlist = loadAllowlist();

  const [panels, features, routes, mcp, services] = await Promise.all([
    findOrphanEditorPanels(),
    findOrphanFeatureModules(),
    findOrphanWorkerRoutes(),
    findOrphanMcpTools(),
    findOrphanServiceModules(),
  ]);

  const findings = [...panels, ...features, ...routes, ...mcp, ...services].sort((a, b) =>
    a.type === b.type ? a.path.localeCompare(b.path) : a.type.localeCompare(b.type),
  );

  const newCount = report(findings, allowlist);
  process.exit(newCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`[fatal] ${err.stack || err.message}`);
  process.exit(1);
});
