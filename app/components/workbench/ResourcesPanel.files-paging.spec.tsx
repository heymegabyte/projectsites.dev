// @vitest-environment jsdom
/**
 * ResourcesPanel.files-paging.spec.tsx — TDD spec for FILES-PAGING (fire-143): paging the editor
 * Resources › Files tab PAST the windowed first 1000 R2 objects. Mirrors the Media "Load more"
 * pattern (cursor-paged, since R2 is cursor-based — not offset/total). We assert the PURE, exported
 * surface so the render is falsifiable WITHOUT booting the WebContainer editor:
 *   1. `mergeBuildFiles` APPENDS the next page + dedupes by `key` (prev wins, order stable);
 *   2. `hasMoreFiles` is true ONLY when truncated AND a cursor is present (so the control can't offer
 *      a doomed fetch once the last page arrives);
 *   3. `FilesPageStats` renders the "Load more" control while `hasMore`, HIDES it when not, and
 *      disables it while `loadingMore`;
 *   4. `BuildFiles` shows the "Load more" footer for a windowed page WITH a cursor, and HIDES it once
 *      the final page (no cursor) is reached — the count then reads the honest complete "N files".
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';

// The panel imports the cross-origin bridge at module-eval; stub it so nothing real fires here.
vi.mock('~/lib/embed/embedded-mode', () => ({
  isEmbedded: true,
  onParentMessage: () => () => {},
  postToastToParent: vi.fn(),
  requestResMedia: vi.fn(),
  requestMediaUpload: vi.fn(),
  requestResSiteFiles: vi.fn(),
  requestAutomations: vi.fn(),
  requestAutomationRetry: vi.fn(),
}));

import { mergeBuildFiles, hasMoreFiles, FilesPageStats, BuildFiles } from './ResourcesPanel';
import type { SiteBuildFileEntry } from '~/lib/embed/embedded-mode';

const file = (key: string, size = 10): SiteBuildFileEntry => ({ key, name: key.split('/').pop() ?? key, size });

afterEach(() => cleanup());

describe('mergeBuildFiles (append + dedupe by key)', () => {
  it('appends the next page onto the previous, preserving order', () => {
    const prev = [file('a.html'), file('b.css')];
    const next = [file('c.js'), file('d.png')];
    expect(mergeBuildFiles(prev, next).map((f) => f.key)).toEqual(['a.html', 'b.css', 'c.js', 'd.png']);
  });

  it('dedupes by key — a repeated key from the next page is dropped (prev wins)', () => {
    const prev = [file('a.html'), file('b.css')];
    const next = [file('b.css'), file('c.js')];
    expect(mergeBuildFiles(prev, next).map((f) => f.key)).toEqual(['a.html', 'b.css', 'c.js']);
  });

  it('returns prev unchanged for an empty next page', () => {
    const prev = [file('a.html')];
    expect(mergeBuildFiles(prev, [])).toBe(prev);
  });
});

describe('hasMoreFiles (cursor-gated)', () => {
  it('true only when truncated AND a non-empty cursor is present', () => {
    expect(hasMoreFiles(true, 'CUR')).toBe(true);
  });

  it('false when truncated but no cursor (last page / cursor exhausted)', () => {
    expect(hasMoreFiles(true, undefined)).toBe(false);
    expect(hasMoreFiles(true, '')).toBe(false);
  });

  it('false when not truncated even if a stale cursor lingers', () => {
    expect(hasMoreFiles(false, 'CUR')).toBe(false);
    expect(hasMoreFiles(undefined, undefined)).toBe(false);
  });
});

describe('<FilesPageStats> (the Load-more control)', () => {
  it('renders the Load more button when hasMore', () => {
    render(<FilesPageStats shown={1000} hasMore loadingMore={false} onLoadMore={() => {}} />);
    expect(screen.getByTestId('resources-files-load-more')).toBeTruthy();
  });

  it('renders NOTHING when there is no next page', () => {
    const { container } = render(
      <FilesPageStats shown={42} hasMore={false} loadingMore={false} onLoadMore={() => {}} />,
    );
    expect(screen.queryByTestId('resources-files-load-more')).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it('fires onLoadMore on click, and disables while loadingMore', () => {
    const onLoadMore = vi.fn();
    const { rerender } = render(
      <FilesPageStats shown={1000} hasMore loadingMore={false} onLoadMore={onLoadMore} />,
    );
    fireEvent.click(screen.getByTestId('resources-files-load-more'));
    expect(onLoadMore).toHaveBeenCalledTimes(1);

    rerender(<FilesPageStats shown={1000} hasMore loadingMore onLoadMore={onLoadMore} />);
    expect((screen.getByTestId('resources-files-load-more') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('<BuildFiles> footer (windowed → Load more; last page → hidden + honest count)', () => {
  const ready = (over: Partial<Extract<Parameters<typeof BuildFiles>[0]['state'], { status: 'ready' }>>) =>
    ({
      status: 'ready' as const,
      files: [file('a.html'), file('b.css')],
      prefix: 'sites/acme/v1/',
      ...over,
    });

  it('shows the Load more footer when the listing is windowed WITH a cursor', () => {
    render(
      <BuildFiles
        state={ready({ truncated: true, cap: 1000, cursor: 'CUR' })}
        onRetry={() => {}}
        loadingMore={false}
        onLoadMore={() => {}}
      />,
    );
    expect(screen.getByTestId('resources-files-load-more')).toBeTruthy();
    // Windowed → the count is the honest partial "first N", never a lying total.
    expect(screen.getByTestId('resources-files-count').textContent).toContain('first 1000+');
  });

  it('HIDES the footer once the final page (no cursor) arrives, and the count reads the complete total', () => {
    render(
      <BuildFiles
        state={ready({ truncated: false, cursor: undefined })}
        onRetry={() => {}}
        loadingMore={false}
        onLoadMore={() => {}}
      />,
    );
    expect(screen.queryByTestId('resources-files-load-more')).toBeNull();
    // Not truncated → the shown count IS complete: "2 files".
    expect(screen.getByTestId('resources-files-count').textContent).toContain('2 files');
  });
});
