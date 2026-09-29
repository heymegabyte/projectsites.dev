/**
 * Lane 7 regression — the synthetic KNOWN-GOOD build fixture passes all 30 build validators.
 *
 * This is the "safe to flip strict" proof: a clean, complete build (the shape the
 * false-positive audit harness — `scripts/audit-validator-false-positives.mjs` — audits)
 * must produce ZERO blocking (error-severity) violations, so `validateBuild(goodBuild).ok`
 * is `true`. If a future validator change starts rejecting a legitimately-complete build,
 * this test goes RED before any org is flipped to `validator_strict`.
 *
 * The fixture lives on disk at `scripts/__fixtures__/known-good-build/` so BOTH this test
 * AND the offline `--fixture` mode of the harness exercise the exact same files.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { validateBuild, type BuildFile } from '../services/build_validators';

// Mirror build_validators.ts isText() — decode the same text set the R2 loader decodes;
// binaries carry only their byte size.
const TEXT_EXTENSIONS = [
  '.html',
  '.htm',
  '.css',
  '.js',
  '.mjs',
  '.json',
  '.xml',
  '.txt',
  '.svg',
  '.webmanifest',
];
const isTextPath = (p: string): boolean => TEXT_EXTENSIONS.some((e) => p.toLowerCase().endsWith(e));

const FIXTURE_DIR = join(__dirname, '..', '..', 'scripts', '__fixtures__', 'known-good-build');

/** Recursively load a fixture dir into BuildFile[] (path dist-relative + /-normalized). */
function loadFixture(dir: string): BuildFile[] {
  const files: BuildFile[] = [];
  const walk = (cur: string): void => {
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      const abs = join(cur, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(dir, abs).split(sep).join('/');
      const size = statSync(abs).size;
      const text = isTextPath(rel) ? readFileSync(abs, 'utf8') : undefined;
      files.push({ path: rel, text, size });
    }
  };
  walk(dir);
  return files;
}

describe('known-good build fixture (Lane 7: strict-flip false-positive regression)', () => {
  const goodBuild = loadFixture(FIXTURE_DIR);

  it('loads a complete multi-page build from disk', () => {
    expect(goodBuild.length).toBeGreaterThanOrEqual(20);
    // The four routes the sitemap declares must all be present as HTML files.
    for (const route of ['index.html', 'about.html', 'services.html', 'contact.html']) {
      expect(goodBuild.some((f) => f.path === route)).toBe(true);
    }
  });

  it('validateBuild(goodBuild).ok === true — zero blocking errors across all 30 validators', () => {
    const report = validateBuild(goodBuild, { expectedBusinessName: "Vito's Mens Salon" });
    // Surface the offending codes if this ever regresses (readable failure, not a bare `false`).
    expect(report.errors.map((e) => `${e.code}: ${e.message}`)).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('the known-good build also raises ZERO advisory warnings (a truly clean build)', () => {
    const report = validateBuild(goodBuild, { expectedBusinessName: "Vito's Mens Salon" });
    expect(report.warnings.map((w) => `${w.code}: ${w.message}`)).toEqual([]);
  });
});
