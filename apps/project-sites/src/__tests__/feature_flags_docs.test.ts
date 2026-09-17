/**
 * Guard test for the per-flag docs map (`FLAG_DOCS`) surfaced by
 * `GET /api/feature-flags/:key` and rendered in the /admin/feature-flags
 * detail panel.
 *
 * The point of this suite is to make two kinds of drift impossible:
 *   1. A registry flag that has no docs entry (the detail panel would fall
 *      back to the one-line registry description — a silent quality drop).
 *   2. An `e2e_tests` path that points at a spec file which does not exist
 *      (fabricated coverage). Every referenced path must resolve to a real
 *      Playwright spec under apps/project-sites/ AND contain a `describe`
 *      block — so the link genuinely points at executable coverage.
 */

import fs from 'node:fs';
import path from 'node:path';

import { FLAG_REGISTRY } from '../modules/feature_flags/registry.js';
import { FLAG_DOCS } from '../modules/feature_flags/docs.js';

// Test lives at src/__tests__/ → apps/project-sites/ is two levels up.
const APP_ROOT = path.resolve(__dirname, '..', '..');

describe('FLAG_DOCS — completeness', () => {
  const registryKeys = Object.keys(FLAG_REGISTRY);

  it('has a docs entry for every registry flag', () => {
    const missing = registryKeys.filter((k) => !FLAG_DOCS[k]);
    expect(missing).toEqual([]);
  });

  it('has no docs entry without a matching registry flag', () => {
    const orphans = Object.keys(FLAG_DOCS).filter((k) => !FLAG_REGISTRY[k]);
    expect(orphans).toEqual([]);
  });

  it.each(Object.entries(FLAG_DOCS))(
    '%s carries a 3-8 item checklist + smoke_test',
    (_key, doc) => {
      expect(Array.isArray(doc.checklist)).toBe(true);
      expect(doc.checklist.length).toBeGreaterThanOrEqual(3);
      // Cap raised 6→8 (AL-715): live_build_stream carries a legitimate 7-item operational
      // runbook (stream · HMAC · throttle · redact-twice · noise-filter-twice · render · flag-off-404)
      // — all distinct, genuine checkpoints; the old ≤6 was arbitrary + red-gated the worker deploy.
      expect(doc.checklist.length).toBeLessThanOrEqual(8);
      expect(doc.checklist.every((c) => typeof c === 'string' && c.trim().length > 0)).toBe(true);
      expect(typeof doc.explanation).toBe('string');
      expect(doc.explanation.trim().length).toBeGreaterThan(40);
      expect(Array.isArray(doc.smoke_test)).toBe(true);
      expect(doc.smoke_test.length).toBeGreaterThanOrEqual(1);
    },
  );
});

describe('FLAG_DOCS — e2e_tests reference real specs', () => {
  const referenced: Array<[string, string]> = [];
  for (const [key, doc] of Object.entries(FLAG_DOCS)) {
    for (const p of doc.e2e_tests ?? []) referenced.push([key, p]);
  }

  it('references at least one real spec across the docs map', () => {
    expect(referenced.length).toBeGreaterThan(0);
  });

  it.each(referenced)('%s → %s exists and contains a describe block', (_key, specPath) => {
    expect(specPath.startsWith('e2e/')).toBe(true);
    expect(specPath.endsWith('.spec.ts')).toBe(true);
    const abs = path.join(APP_ROOT, specPath);
    expect(fs.existsSync(abs)).toBe(true);
    const src = fs.readFileSync(abs, 'utf8');
    expect(/\bdescribe\s*\(/.test(src)).toBe(true);
  });
});
