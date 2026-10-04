// @vitest-environment jsdom
/**
 * @file Resources › Site files — honest build-files count (FILES-COUNT-1, fire-140).
 *
 * Context: the editor's Files tab shows `state.files.length` as the file count. The worker's
 * `/build-files` lists R2 with `.list({ limit: 1000 })` — a WINDOWED page, NOT an unbounded total.
 * A build with more objects than the cap would silently UNDER-report (a lying-undercount). The worker
 * now returns `truncated` + `cap`, the bridge forwards them, and the editor labels the count honestly.
 *
 * `buildFilesCountLabel` (pure) + `<FilesCountSummary>` (presentational) were extracted so the honesty
 * logic is falsifiable WITHOUT booting the WebContainer editor — the same pattern as `MediaPageStats`.
 *
 *   1. NOT truncated → the count is the COMPLETE set → bare "N files" (honest, locked).
 *   2. truncated + cap → "first cap+ files" (never presents the partial window as the total).
 *   3. truncated + no cap → "first N of many".
 *   4. singular/plural grammar is correct.
 */
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { buildFilesCountLabel, FilesCountSummary } from '../ResourcesPanel';

afterEach(cleanup);

// ─── Pure label logic ────────────────────────────────────────────────────────

describe('buildFilesCountLabel — honest count framing', () => {
  it('shows the complete count when NOT truncated', () => {
    expect(buildFilesCountLabel(42, false, undefined)).toBe('42 files');
    expect(buildFilesCountLabel(42, undefined, undefined)).toBe('42 files');
  });

  it('uses singular grammar for exactly one file', () => {
    expect(buildFilesCountLabel(1, false, undefined)).toBe('1 file');
  });

  it('never presents a WINDOWED count as the total — says "first cap+" when cap is known', () => {
    // 1000 shown but the build has more → must NOT read "1000 files" (that would under-report).
    expect(buildFilesCountLabel(1000, true, 1000)).toBe('first 1000+ files');
    expect(buildFilesCountLabel(1000, true, 1000)).not.toBe('1000 files');
  });

  it('falls back to "first N of many" when truncated with no cap', () => {
    expect(buildFilesCountLabel(500, true, undefined)).toBe('first 500 of many');
  });
});

// ─── DOM render ──────────────────────────────────────────────────────────────

describe('FilesCountSummary — render', () => {
  it('renders the honest complete count + size (not truncated)', () => {
    render(<FilesCountSummary shown={12} totalBytes={2048} truncated={false} cap={undefined} />);
    const el = screen.getByTestId('resources-files-count');
    expect(el).toBeTruthy();
    expect(el.textContent).toContain('12 files');
    // 2048 bytes → "2.0 KB"
    expect(el.textContent).toContain('KB');
  });

  it('renders a partial-window label when truncated (never the bare total)', () => {
    render(<FilesCountSummary shown={1000} totalBytes={1024 * 1024} truncated={true} cap={1000} />);
    const el = screen.getByTestId('resources-files-count');
    expect(el.textContent).toContain('first 1000+');
    // The honest title spells out that there are MORE than are shown.
    expect(el.getAttribute('title')).toContain('more');
  });
});
