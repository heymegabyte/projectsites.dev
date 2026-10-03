// @vitest-environment jsdom
/**
 * LockManager.spec.tsx
 *
 * Unit tests for the LockManager's visibility-aware lock-list poll (fire-55).
 *
 * Evidence (Deep UI Explorer): the panel previously ran `setInterval(load, 5000)`
 * UNCONDITIONALLY — reading the workbench store every 5s even while the tab was
 * hidden. The contract under test is the ResourceOverviewPanel pattern:
 *
 *  1. Load once on mount.
 *  2. Poll on a lock-appropriate 10s cadence while the tab is VISIBLE (and the
 *     old 5s cadence is gone).
 *  3. NO loads while `document.hidden`.
 *  4. IMMEDIATE refetch on visibilitychange back to visible.
 *  5. Cleanup on unmount (no timer or listener leaks).
 *  6. Silent errors — a throwing store read keeps the last-known view.
 *
 * Strategy: mock `~/lib/stores/workbench` so the heavy real store (WebContainer
 * chain) never loads; the spy on `workbenchStore.files.get` IS the "fetch"
 * counter. Fake timers drive the cadence; `document.hidden` is redefined per
 * test and `visibilitychange` events are dispatched manually.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import React from 'react';

// ─── Workbench store mock (the "fetch" boundary) ─────────────────────────────

const { filesGetSpy, unlockFileSpy, unlockFolderSpy } = vi.hoisted(() => ({
  filesGetSpy: vi.fn(
    (): Record<string, { type: 'file' | 'folder'; isLocked?: boolean } | undefined> => ({
      '/home/project/locked-file.ts': { type: 'file', isLocked: true },
      '/home/project/open-file.ts': { type: 'file', isLocked: false },
      '/home/project/locked-folder': { type: 'folder', isLocked: true },
    }),
  ),
  unlockFileSpy: vi.fn(),
  unlockFolderSpy: vi.fn(),
}));

vi.mock('~/lib/stores/workbench', () => ({
  workbenchStore: {
    files: { get: filesGetSpy },
    unlockFile: unlockFileSpy,
    unlockFolder: unlockFolderSpy,
  },
}));

/*
 * react-toastify only fires on user actions this spec never takes; stub it so
 * the module import stays inert under jsdom.
 */
vi.mock('~/components/ui/use-toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

// ─── Import the component under test AFTER mocks are wired ──────────────────
import { LockManager } from '../LockManager';

// ─── document.hidden control ────────────────────────────────────────────────

let hidden = false;

/** Flip `document.hidden` + fire the `visibilitychange` event, inside act. */
function setVisibility(nextHidden: boolean): void {
  hidden = nextHidden;
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

/** Advance fake timers inside act so React state updates flush. */
function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe('LockManager — visibility-aware poll', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hidden = false;
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => hidden,
    });
    filesGetSpy.mockClear();

    // Reset to the default healthy implementation (a test may have made it throw).
    filesGetSpy.mockImplementation(() => ({
      '/home/project/locked-file.ts': { type: 'file', isLocked: true },
      '/home/project/open-file.ts': { type: 'file', isLocked: false },
      '/home/project/locked-folder': { type: 'folder', isLocked: true },
    }));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('loads locked items once on mount and renders them', () => {
    render(<LockManager />);

    expect(filesGetSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByText('locked-file.ts')).toBeTruthy();
    expect(screen.getByText('locked-folder')).toBeTruthy();
    expect(screen.queryByText('open-file.ts')).toBeNull();
  });

  it('polls on a 10s cadence while visible — and the old 5s cadence is gone', () => {
    render(<LockManager />);
    expect(filesGetSpy).toHaveBeenCalledTimes(1);

    // 5s in: the legacy 5000ms interval would have fired here. It must NOT.
    advance(5_000);
    expect(filesGetSpy).toHaveBeenCalledTimes(1);

    // 10s in: one interval tick.
    advance(5_000);
    expect(filesGetSpy).toHaveBeenCalledTimes(2);

    // 20s in: another tick.
    advance(10_000);
    expect(filesGetSpy).toHaveBeenCalledTimes(3);
  });

  it('does not load while the tab is hidden', () => {
    render(<LockManager />);
    expect(filesGetSpy).toHaveBeenCalledTimes(1);

    setVisibility(true); // hide — the visibilitychange-to-hidden must not itself load

    advance(30_000); // three would-be ticks, all suppressed
    expect(filesGetSpy).toHaveBeenCalledTimes(1);
  });

  it('refetches immediately when the tab becomes visible again', () => {
    render(<LockManager />);
    setVisibility(true);
    advance(30_000);
    expect(filesGetSpy).toHaveBeenCalledTimes(1);

    setVisibility(false); // foreground → immediate refetch, no timer needed
    expect(filesGetSpy).toHaveBeenCalledTimes(2);

    // …and the interval keeps ticking while visible.
    advance(10_000);
    expect(filesGetSpy).toHaveBeenCalledTimes(3);
  });

  it('stops polling and listening after unmount', () => {
    const { unmount } = render(<LockManager />);
    expect(filesGetSpy).toHaveBeenCalledTimes(1);

    unmount();

    advance(60_000);
    expect(filesGetSpy).toHaveBeenCalledTimes(1);

    setVisibility(false); // visibilitychange after unmount must not refetch
    expect(filesGetSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps the last-known view when a poll read throws (silent error)', () => {
    render(<LockManager />);
    expect(screen.getByText('locked-file.ts')).toBeTruthy();

    filesGetSpy.mockImplementation(() => {
      throw new Error('store unavailable');
    });

    // The throwing tick must neither crash the timer flush nor clear the list.
    advance(10_000);
    expect(filesGetSpy).toHaveBeenCalledTimes(2);
    expect(screen.getByText('locked-file.ts')).toBeTruthy();
    expect(screen.getByText('locked-folder')).toBeTruthy();
  });
});
