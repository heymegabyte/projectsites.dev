/**
 * @file Workbench fileHistory construction contract — no lying `as FileHistory` casts.
 *
 * fire-73 regression guard (commit cef2a2871): Workbench.client.tsx previously built its
 * inline-diff baseline as `{ originalContent } as FileHistory` — a TypeScript cast that
 * OMITTED the REQUIRED `versions[]`/`changes[]`/`lastModified` fields. Every consumer
 * reading `versions[versions.length - 1]` directly (FileTree's diff-count calc) threw
 * "Cannot read properties of undefined (reading 'length')" — 101x in prod on every
 * money-path editor-shell load, because EVERY AI turn populates this baseline.
 *
 * The fix has two load-bearing halves, each independently regressable:
 *  1. Workbench.client.tsx builds an HONEST FileHistory object (versions/changes/
 *     lastModified all present) instead of casting a partial shape — locked here as a
 *     static-contract read of the real source (no `as FileHistory` cast remains).
 *  2. computeFileDiffStat() guards `versions?.length` so even a partial/legacy entry
 *     can never throw — locked in the sibling `file-diff-stat.spec.ts`, and re-proven
 *     here end-to-end against the EXACT shape Workbench.client.tsx now constructs.
 *
 * This spec exercises the real Workbench.client.tsx source text (RED against the
 * pre-fix `as FileHistory` cast — it reappears, this fails) AND the real
 * computeFileDiffStat() module (RED against the pre-guard code — reverting the guard
 * makes the end-to-end assertion throw).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FileHistory } from '~/types/actions';
import { computeFileDiffStat } from '../file-diff-stat';

const WORKBENCH_SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'Workbench.client.tsx'), 'utf8');

describe('Workbench.client fileHistory construction contract (fire-73)', () => {
  it('never casts a partial object `as FileHistory` (the exact crash-causing pattern)', () => {
    // The bug WAS `{ originalContent } as FileHistory` — a cast papering over a missing
    // `versions`/`changes`/`lastModified`. Any reintroduction of an `as FileHistory` cast
    // AS LIVE CODE is the same lie resurfacing, regardless of which fields it happens to
    // omit this time. The fix's own explanatory comment quotes the old buggy snippet
    // inside backticks for documentation — exclude backtick-quoted lines so the comment
    // describing the bug doesn't trip the guard meant to catch the bug recurring.
    const liveCastLines = WORKBENCH_SRC.split('\n').filter(
      (line) => /as\s+FileHistory/.test(line) && !line.includes('`'),
    );
    expect(liveCastLines).toEqual([]);
  });

  it('constructs an honest FileHistory with versions/changes/lastModified all present', () => {
    // The replacement object literal must carry every REQUIRED FileHistory field so no
    // downstream consumer reading `.versions[...]` can ever dereference `undefined`.
    expect(WORKBENCH_SRC).toMatch(/originalContent/);
    expect(WORKBENCH_SRC).toMatch(/versions:\s*\[\]/);
    expect(WORKBENCH_SRC).toMatch(/changes:\s*\[\]/);
    expect(WORKBENCH_SRC).toMatch(/lastModified:\s*Date\.now\(\)/);
  });

  it('end-to-end: the EXACT fileHistory shape Workbench.client now builds never throws through computeFileDiffStat', () => {
    // Mirrors Workbench.client.tsx's fileHistory useMemo construction verbatim — this is
    // what every AI turn actually produces today. Pre-fix (versions-less `as FileHistory`
    // cast feeding a direct `versions[versions.length-1]` read) this input crashed the
    // Workbench 101x; post-fix it's a fully-typed FileHistory that resolves to "0/0 diff".
    const builtByWorkbench: FileHistory = {
      originalContent: 'export const x = 1;\n',
      versions: [],
      changes: [],
      lastModified: Date.now(),
    };

    expect(() => computeFileDiffStat(builtByWorkbench)).not.toThrow();
    expect(computeFileDiffStat(builtByWorkbench)).toEqual({ additions: 0, deletions: 0 });
  });
});
