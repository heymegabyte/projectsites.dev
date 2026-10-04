// @vitest-environment jsdom
/**
 * @file Resources › Media — DOM-render test for the "N of total" count badge
 *       and "Load more" button (MEDIA-UI-VERIFY-LIVE, fire-137).
 *
 * Context: fire-135 shipped `[data-testid=resources-media-count]` and fire-136
 * shipped `[data-testid=resources-media-load-more]`. Both were live-browser
 * verified twice but the WebContainer environment blocked a stable probe. This
 * DOM-render test is the reliable, deterministic render proof:
 *
 *   1. With 50 assets shown and filteredTotal=109, the count badge SHOWS "50"
 *      and "109", and the load-more button IS present.
 *   2. With assets.length === total (or no total), the count badge is ABSENT
 *      and the load-more button is ABSENT.
 *   3. With total derived from usage.totalCount (no filteredTotal), the fallback
 *      path also renders correctly.
 *
 * The pure presentational subcomponent `MediaPageStats` was extracted from
 * `MediaLibrary` so this logic is falsifiable without mounting the whole panel.
 */
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MediaPageStats } from '../ResourcesPanel';

afterEach(cleanup);

// ─── 50 of 109 — partial page ────────────────────────────────────────────────

describe('MediaPageStats — partial page (shown < total)', () => {
  it('renders the honest "N of total" count badge', () => {
    render(<MediaPageStats shown={50} filteredTotal={109} usage={undefined} hasMore={true} loadingMore={false} onLoadMore={() => {}} />);

    const badge = screen.getByTestId('resources-media-count');
    expect(badge).toBeTruthy();
    expect(badge.textContent).toContain('50');
    expect(badge.textContent).toContain('109');
  });

  it('renders the load-more button', () => {
    render(<MediaPageStats shown={50} filteredTotal={109} usage={undefined} hasMore={true} loadingMore={false} onLoadMore={() => {}} />);

    const btn = screen.getByTestId('resources-media-load-more');
    expect(btn).toBeTruthy();
    // Button should say "Load more" when not actively loading
    expect(btn.textContent).toContain('Load more');
  });
});

// ─── 10 of 10 — full page (no more to load) ──────────────────────────────────

describe('MediaPageStats — full page (shown === total)', () => {
  it('hides the count badge when shown equals total', () => {
    render(<MediaPageStats shown={10} filteredTotal={10} usage={undefined} hasMore={false} loadingMore={false} onLoadMore={() => {}} />);

    const badge = screen.queryByTestId('resources-media-count');
    expect(badge).toBeNull();
  });

  it('hides the load-more button when shown equals total', () => {
    render(<MediaPageStats shown={10} filteredTotal={10} usage={undefined} hasMore={false} loadingMore={false} onLoadMore={() => {}} />);

    const btn = screen.queryByTestId('resources-media-load-more');
    expect(btn).toBeNull();
  });
});

// ─── No filteredTotal — fallback to usage.totalCount ─────────────────────────

describe('MediaPageStats — usage fallback (no filteredTotal)', () => {
  it('shows the count badge using usage.totalCount when filteredTotal is absent', () => {
    render(
      <MediaPageStats
        shown={20}
        filteredTotal={undefined}
        usage={{ totalCount: 80, totalBytes: 0, byKind: {} }}
        hasMore={true}
        loadingMore={false}
        onLoadMore={() => {}}
      />,
    );

    const badge = screen.getByTestId('resources-media-count');
    expect(badge).toBeTruthy();
    expect(badge.textContent).toContain('20');
    expect(badge.textContent).toContain('80');
  });
});

// ─── No total at all — both controls absent ───────────────────────────────────

describe('MediaPageStats — no total known', () => {
  it('hides the count badge when total is undefined', () => {
    render(<MediaPageStats shown={5} filteredTotal={undefined} usage={undefined} hasMore={false} loadingMore={false} onLoadMore={() => {}} />);

    expect(screen.queryByTestId('resources-media-count')).toBeNull();
  });

  it('hides the load-more button when total is undefined', () => {
    render(<MediaPageStats shown={5} filteredTotal={undefined} usage={undefined} hasMore={false} loadingMore={false} onLoadMore={() => {}} />);

    expect(screen.queryByTestId('resources-media-load-more')).toBeNull();
  });
});
