#!/usr/bin/env node
/**
 * validate-feature-manifests.mjs
 *
 * Loads every libs/features/<slug>/feature.manifest.ts (or .js/.mjs compiled
 * equivalent), validates the shape against FeatureManifestSchema, and
 * cross-checks that manifest.flagKey exists in FLAG_REGISTRY.
 *
 * Exit 0  → all manifests valid and flag keys present
 * Exit 1  → one or more validation failures OR flag key missing from registry
 *
 * Node 22 native ESM — no build step required.
 */

import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ─── Schema (pure JS — no Zod at runtime in this script) ─────────────────────

/**
 * Validates a manifest object. Returns [] on success or an array of error
 * strings on failure.
 *
 * Mirrors FeatureManifest from tools/templates/feature-module/feature.manifest.ts
 */
function validateManifest(m, file) {
  const errors = [];

  if (typeof m !== 'object' || m === null) {
    return [`${file}: export 'manifest' is not an object`];
  }

  // Required string fields
  for (const field of ['slug', 'name', 'description', 'flagKey', 'owner']) {
    if (typeof m[field] !== 'string' || m[field].trim() === '') {
      errors.push(`${file}: '${field}' must be a non-empty string (got ${JSON.stringify(m[field])})`);
    }
  }

  // slug must be snake_case OR kebab-case ≤64 chars (matching the schema regex)
  if (typeof m.slug === 'string') {
    if (!/^[a-z][a-z0-9_-]*$/.test(m.slug)) {
      errors.push(`${file}: 'slug' must be snake_case or kebab-case (got "${m.slug}")`);
    }
    if (m.slug.length > 64) {
      errors.push(`${file}: 'slug' must be ≤64 chars`);
    }
  }

  // flagKey must be snake_case ≤32 chars
  if (typeof m.flagKey === 'string') {
    if (!/^[a-z][a-z0-9_]*$/.test(m.flagKey)) {
      errors.push(`${file}: 'flagKey' must be snake_case (got "${m.flagKey}")`);
    }
    if (m.flagKey.length > 32) {
      errors.push(`${file}: 'flagKey' must be ≤32 chars`);
    }
  }

  // description length
  if (typeof m.description === 'string') {
    if (m.description.length < 30) {
      errors.push(`${file}: 'description' must be ≥30 chars (got ${m.description.length})`);
    }
    if (m.description.length > 200) {
      errors.push(`${file}: 'description' must be ≤200 chars (got ${m.description.length})`);
    }
    // Detect un-filled template placeholder
    if (m.description.includes('TODO:') || m.description.includes('{{')) {
      errors.push(`${file}: 'description' still contains a template placeholder`);
    }
  }

  // owner must be email or GitHub handle
  if (typeof m.owner === 'string') {
    if (!/^[@a-zA-Z0-9._+-]+$/.test(m.owner)) {
      errors.push(`${file}: 'owner' must be an email or @github-handle`);
    }
  }

  // Array fields
  for (const field of ['apiPaths', 'uiPaths', 'migrations']) {
    if (!Array.isArray(m[field])) {
      errors.push(`${file}: '${field}' must be an array (got ${JSON.stringify(m[field])})`);
    }
  }

  // Optional arrays: e2eTests, unitTests
  for (const field of ['e2eTests', 'unitTests']) {
    if (m[field] !== undefined && !Array.isArray(m[field])) {
      errors.push(`${file}: '${field}' must be an array when present`);
    }
  }

  // e2eTests / unitTests paths must exist on disk when declared.
  // Paths are resolved relative to the `base` directory (e2e/ or src/).
  // Entries that already include the base prefix are accepted as-is.
  for (const [field, base] of [['e2eTests', 'e2e'], ['unitTests', 'src']]) {
    const list = m[field];
    if (!Array.isArray(list)) continue;
    for (const rel of list) {
      // Skip empties / comment strings that the text-parser picked up.
      if (!rel || rel.startsWith('//') || rel.startsWith('/*')) continue;
      const normalized = rel.startsWith(`${base}/`) ? rel : `${base}/${rel}`;
      const abs = path.resolve(ROOT, normalized);
      if (!existsSync(abs)) {
        errors.push(`${file}: '${field}' entry "${rel}" does not exist on disk (looked at ${normalized})`);
        continue;
      }
      // A unitTests entry that EXISTS but doesn't match the worker jest testMatch
      // (`**/*.test.ts`) is NEVER RUN — a `.spec.ts` worker unit test silently passes
      // the existence check above while jest reports "0 matches" (fire-114: site_crawl
      // shipped schemas.spec.ts → 0 tests ran + tsc errored on missing jest globals).
      // `.spec.ts` is the frontend/Playwright convention; worker units MUST be `.test.ts`.
      if (field === 'unitTests' && !/\.test\.(ts|tsx|js|jsx)$/.test(rel)) {
        errors.push(
          `${file}: '${field}' entry "${rel}" is not a '*.test.ts' file — the worker jest testMatch is '**/*.test.ts', so this unit test would NEVER run (rename '.spec.ts' → '.test.ts').`,
        );
      }
    }
  }

  // slug must match containing directory name
  const expectedSlug = path.basename(path.dirname(file));
  if (typeof m.slug === 'string' && m.slug !== expectedSlug) {
    errors.push(`${file}: 'slug' ("${m.slug}") does not match containing directory ("${expectedSlug}")`);
  }

  return errors;
}

// ─── Load FLAG_REGISTRY keys ──────────────────────────────────────────────────

async function loadFlagRegistryKeys() {
  const registryPath = path.join(ROOT, 'src/modules/feature_flags/registry.ts');
  if (!existsSync(registryPath)) {
    console.warn(`[warn] FLAG_REGISTRY not found at ${registryPath} — skipping cross-check`);
    return new Set();
  }

  const src = await readFile(registryPath, 'utf8');
  // Extract keys from FLAG_REGISTRY object — match lines like `  my_flag: {`
  const keys = new Set();
  for (const match of src.matchAll(/^\s{2}([a-z][a-z0-9_]{0,31}):\s*\{/gm)) {
    keys.add(match[1]);
  }
  return keys;
}

// ─── Discover manifest files ──────────────────────────────────────────────────

async function discoverManifests() {
  const featuresRoot = path.join(ROOT, 'libs/features');
  if (!existsSync(featuresRoot)) {
    // No features directory yet — nothing to validate
    return [];
  }

  const entries = await readdir(featuresRoot, { withFileTypes: true });
  const manifests = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    const candidates = [
      path.join(featuresRoot, slug, 'feature.manifest.ts'),
      path.join(featuresRoot, slug, 'feature.manifest.js'),
      path.join(featuresRoot, slug, 'feature.manifest.mjs'),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        manifests.push({ slug, file: candidate });
        break;
      }
    }
  }

  return manifests;
}

// ─── Dynamic import with fallback for TypeScript files ───────────────────────

async function loadManifestExport(file) {
  // Prefer pre-compiled .js sibling if TypeScript source
  const jsFile = file.replace(/\.ts$/, '.js');
  const targetFile = existsSync(jsFile) && jsFile !== file ? jsFile : file;

  if (targetFile.endsWith('.ts')) {
    // Parse manually — extract the manifest object literal from TS source
    // rather than exec-ing tsc; this keeps the script zero-dep.
    const src = await readFile(file, 'utf8');
    return parseManifestFromSource(src, file);
  }

  try {
    const mod = await import(`file://${targetFile}`);
    return mod.manifest ?? mod.default?.manifest ?? null;
  } catch (err) {
    throw new Error(`Failed to import ${targetFile}: ${err.message}`);
  }
}

function parseManifestFromSource(src, file) {
  // Extract the manifest object literal from the defineFeatureManifest({...}) call.
  // This is a best-effort parser for the canonical template shape.
  const match = src.match(/defineFeatureManifest\(\s*\{([\s\S]+?)\}\s*\)/);
  if (!match) {
    // Try plain object export: export const manifest = { ... }
    const directMatch = src.match(/export\s+const\s+manifest\s*=\s*\{([\s\S]+?)\}\s*;/);
    if (!directMatch) {
      throw new Error(`${file}: could not parse manifest — expected defineFeatureManifest({...}) or export const manifest = {...}`);
    }
    return evalManifestBody(directMatch[1], file);
  }
  return evalManifestBody(match[1], file);
}

function evalManifestBody(body, file) {
  // Extract simple string / boolean / array fields.
  // We parse only primitive values to avoid executing arbitrary code.
  const obj = {};
  const stringField = (name) => {
    const m = body.match(new RegExp(`${name}\\s*:\\s*['"]([^'"]+)['"]`));
    return m ? m[1] : undefined;
  };
  const arrayField = (name) => {
    const m = body.match(new RegExp(`${name}\\s*:\\s*\\[([^\\]]*)]`));
    if (!m) return undefined;
    // Strip JS line + block comments so inline drift notes inside the array
    // literal don't end up as fake "entries".
    const cleaned = m[1]
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    return cleaned
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  };

  for (const f of ['slug', 'name', 'description', 'flagKey', 'owner']) {
    obj[f] = stringField(f);
  }
  for (const f of ['apiPaths', 'uiPaths', 'migrations', 'e2eTests', 'unitTests']) {
    const v = arrayField(f);
    if (v !== undefined) obj[f] = v;
  }

  // Default empty arrays for required array fields
  for (const f of ['apiPaths', 'uiPaths', 'migrations']) {
    if (obj[f] === undefined) obj[f] = [];
  }

  return obj;
}

// ─── Duplicate detection ──────────────────────────────────────────────────────

function detectDuplicates(manifests) {
  const seenSlugs = new Map();
  const seenFlagKeys = new Map();
  const errors = [];
  // Intentional flag groups (keep in sync with scripts/validate-feature-drift.mjs +
  // scripts/group-flags.mjs). An anchor flag deliberately gates several modules, so a
  // shared flagKey across their manifests is intentional grouping, not drift.
  const GROUPED_FLAG_KEYS = new Set([
    'site_analytics',
    'site_doctor',
    'onboarding_copilot',
    'mcp_server',
    'activity_feed',
    'batch_operations',
    'social_publishing_native',
  ]);

  for (const { slug, manifest } of manifests) {
    if (!manifest) continue;

    if (seenSlugs.has(slug)) {
      errors.push(`DUPLICATE SLUG: "${slug}" found in both ${seenSlugs.get(slug)} and current entry`);
    } else {
      seenSlugs.set(slug, slug);
    }

    if (manifest.flagKey && !GROUPED_FLAG_KEYS.has(manifest.flagKey)) {
      if (seenFlagKeys.has(manifest.flagKey)) {
        errors.push(`DUPLICATE FLAG KEY: "${manifest.flagKey}" declared in both "${seenFlagKeys.get(manifest.flagKey)}" and "${slug}"`);
      } else {
        seenFlagKeys.set(manifest.flagKey, slug);
      }
    }
  }

  return errors;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  validate-feature-manifests — feature shape + flag check ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const [manifestEntries, flagKeys] = await Promise.all([
    discoverManifests(),
    loadFlagRegistryKeys(),
  ]);

  if (manifestEntries.length === 0) {
    console.log('ℹ  No feature manifests found under libs/features/*/feature.manifest.ts');
    console.log('   Nothing to validate. (Create manifests with: npm run gen:feature)\n');
    console.log('✅ validate-feature-manifests: PASS (0 manifests, 0 violations)\n');
    process.exit(0);
  }

  console.log(`Found ${manifestEntries.length} manifest(s) to validate.\n`);

  const loaded = [];
  const allErrors = [];

  // Load each manifest
  for (const { slug, file } of manifestEntries) {
    const relFile = path.relative(ROOT, file);
    try {
      const manifest = await loadManifestExport(file);
      if (!manifest) {
        allErrors.push(`${relFile}: no 'manifest' export found`);
        loaded.push({ slug, file: relFile, manifest: null });
        continue;
      }
      const errs = validateManifest(manifest, relFile);
      allErrors.push(...errs);
      loaded.push({ slug, file: relFile, manifest });
    } catch (err) {
      allErrors.push(err.message);
      loaded.push({ slug, file: relFile, manifest: null });
    }
  }

  // Cross-check flag keys against FLAG_REGISTRY
  const missingFlagKeys = [];
  if (flagKeys.size > 0) {
    for (const { slug, file: relFile, manifest } of loaded) {
      if (!manifest?.flagKey) continue;
      if (!flagKeys.has(manifest.flagKey)) {
        missingFlagKeys.push(
          `${relFile}: flagKey "${manifest.flagKey}" not found in FLAG_REGISTRY (src/modules/feature_flags/registry.ts)`,
        );
      }
    }
  }

  // Duplicate detection
  const dupeErrors = detectDuplicates(loaded);

  const allViolations = [...allErrors, ...missingFlagKeys, ...dupeErrors];

  // ─── Report ───────────────────────────────────────────────────────────────
  if (allViolations.length === 0) {
    console.log(`┌─ Results ───────────────────────────────────────────────┐`);
    console.log(`│  Manifests checked : ${String(loaded.length).padEnd(36)}│`);
    console.log(`│  FLAG_REGISTRY keys: ${String(flagKeys.size).padEnd(36)}│`);
    console.log(`│  Violations        : 0${' '.repeat(36)}│`);
    console.log(`└─────────────────────────────────────────────────────────┘`);
    console.log('\n✅ validate-feature-manifests: PASS\n');
    process.exit(0);
  }

  console.log(`┌─ Violations (${allViolations.length}) ──────────────────────────────────────`);
  for (const err of allViolations) {
    console.log(`│  ✖  ${err}`);
  }
  console.log(`└─────────────────────────────────────────────────────────────\n`);
  console.log(`❌ validate-feature-manifests: FAIL — ${allViolations.length} violation(s)\n`);
  process.exit(1);
}

main().catch((err) => {
  console.error(`[fatal] ${err.message}`);
  process.exit(1);
});
