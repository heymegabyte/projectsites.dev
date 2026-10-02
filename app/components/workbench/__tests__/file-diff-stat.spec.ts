import { describe, expect, it } from 'vitest';
import type { FileHistory } from '~/types/actions';
import { computeFileDiffStat } from '../file-diff-stat';

describe('computeFileDiffStat', () => {
  it('does NOT throw on a versions-less entry (the fire-73 Workbench crash)', () => {
    // The inline-diff baseline publishes `{ originalContent } as FileHistory` with
    // NO `versions`. Reading versions[length-1] directly threw 101× in prod.
    const versionsLess = { originalContent: 'line one\nline two\n' } as FileHistory;
    expect(() => computeFileDiffStat(versionsLess)).not.toThrow();
    expect(computeFileDiffStat(versionsLess)).toEqual({ additions: 0, deletions: 0 });
  });

  it('returns 0/0 for undefined (untracked file)', () => {
    expect(computeFileDiffStat(undefined)).toEqual({ additions: 0, deletions: 0 });
  });

  it('returns 0/0 when versions is an empty array', () => {
    const entry = { originalContent: 'a\nb\n', versions: [] } as unknown as FileHistory;
    expect(computeFileDiffStat(entry)).toEqual({ additions: 0, deletions: 0 });
  });

  it('returns 0/0 when the latest version is identical to the original', () => {
    const entry = {
      originalContent: 'a\nb\nc\n',
      versions: [{ timestamp: 1, content: 'a\nb\nc\n' }],
    } as unknown as FileHistory;
    expect(computeFileDiffStat(entry)).toEqual({ additions: 0, deletions: 0 });
  });

  it('counts additions and deletions against the latest version', () => {
    const entry = {
      originalContent: 'a\nb\nc\n',
      versions: [{ timestamp: 2, content: 'a\nB\nc\nd\n' }],
    } as unknown as FileHistory;
    const stat = computeFileDiffStat(entry);
    expect(stat.additions).toBeGreaterThan(0);
    expect(stat.deletions).toBeGreaterThan(0);
  });

  it('normalizes CRLF so line-ending-only differences are not counted', () => {
    const entry = {
      originalContent: 'a\r\nb\r\n',
      versions: [{ timestamp: 3, content: 'a\nb\n' }],
    } as unknown as FileHistory;
    expect(computeFileDiffStat(entry)).toEqual({ additions: 0, deletions: 0 });
  });
});
