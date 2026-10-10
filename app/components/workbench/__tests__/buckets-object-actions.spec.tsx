// @vitest-environment jsdom
/**
 * @file Resources › Buckets › Object management UX (B3) — context menu + keyboard/range multi-select.
 *
 * Context: the object browser already had checkbox multi-select, a bulk-delete-with-undo bar, and
 * per-row/tile hover buttons (Preview · Copy URL · Download · Delete). B3 adds the polished
 * file-manager layer ON TOP, WITHOUT regressing any of that:
 *
 *   1. A right-click / keyboard CONTEXT MENU on object rows + tiles ({@link ObjectActionMenu}) that
 *      fires the SAME four handlers. Radix gives roles (`menu`/`menuitem`), Escape-to-close + focus
 *      return; we assert the four items render with their stable testids and the menu's a11y label.
 *   2. KEYBOARD multi-select math — pure, mountless helpers: `Cmd/Ctrl+A` → every loaded key
 *      ({@link selectAllKeys}); `Shift+click` → the inclusive index range ({@link rangeKeys}) UNIONed
 *      into the current set ({@link extendSelection}, so Shift EXTENDS, never replaces).
 *
 * The context menu is exercised via a real `contextmenu` event (how Radix ContextMenu opens); the
 * selection helpers are asserted directly (the exact set math that wires to the existing
 * `setSelected` Set) so a regression in the range/union logic fails HERE, not just in a headless run.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ObjectActionMenu,
  extendSelection,
  rangeKeys,
  selectAllKeys,
} from '~/components/workbench/BucketsPanel';

afterEach(cleanup);

// ── 1. Pure keyboard / range multi-select math ────────────────────────────────

const shown = [
  { key: 'a.txt' },
  { key: 'b.png' },
  { key: 'c.pdf' },
  { key: 'd.mp4' },
  { key: 'e.json' },
];

describe('selectAllKeys — what Cmd/Ctrl+A selects', () => {
  it('returns every loaded object key as a Set', () => {
    const all = selectAllKeys(shown);
    expect(all.size).toBe(5);
    expect([...all]).toEqual(['a.txt', 'b.png', 'c.pdf', 'd.mp4', 'e.json']);
  });

  it('is empty for an empty list (nothing to select → no-op upstream)', () => {
    expect(selectAllKeys([]).size).toBe(0);
  });
});

describe('rangeKeys — what Shift+click selects (inclusive, order-independent)', () => {
  it('selects the inclusive range between anchor and target (forward)', () => {
    expect([...rangeKeys(shown, 1, 3)]).toEqual(['b.png', 'c.pdf', 'd.mp4']);
  });

  it('is order-independent (anchor after target)', () => {
    expect([...rangeKeys(shown, 3, 1)]).toEqual(['b.png', 'c.pdf', 'd.mp4']);
  });

  it('a zero-width range (anchor === target) selects just that one key', () => {
    expect([...rangeKeys(shown, 2, 2)]).toEqual(['c.pdf']);
  });

  it('with no valid anchor, falls back to just the target key (never a doomed no-op)', () => {
    expect([...rangeKeys(shown, -1, 4)]).toEqual(['e.json']);
  });

  it('returns empty when the target index itself is out of bounds', () => {
    expect(rangeKeys(shown, 0, 99).size).toBe(0);
    expect(rangeKeys(shown, 0, -1).size).toBe(0);
  });
});

describe('extendSelection — Shift+click EXTENDS, it never replaces', () => {
  it('unions the range into the existing selection', () => {
    const current = new Set(['x.svg']);
    const next = extendSelection(current, rangeKeys(shown, 0, 1));
    expect([...next].sort()).toEqual(['a.txt', 'b.png', 'x.svg']);
  });

  it('does not mutate the input set (returns a fresh Set)', () => {
    const current = new Set(['x.svg']);
    extendSelection(current, new Set(['a.txt']));
    expect([...current]).toEqual(['x.svg']);
  });
});

// ── 2. The right-click / keyboard context menu ─────────────────────────────────

describe('ObjectActionMenu — right-click context menu on an object', () => {
  function setup(overrides: Partial<Parameters<typeof ObjectActionMenu>[0]> = {}) {
    const onPreview = vi.fn();
    const onCopyUrl = vi.fn();
    const onDownload = vi.fn();
    const onDelete = vi.fn();

    render(
      <ObjectActionMenu
        objectKey="images/hero.png"
        name="hero.png"
        canPreview
        onPreview={onPreview}
        onCopyUrl={onCopyUrl}
        onDownload={onDownload}
        onDelete={onDelete}
        {...overrides}
      >
        <div data-testid="the-row">hero.png</div>
      </ObjectActionMenu>,
    );

    return { onPreview, onCopyUrl, onDownload, onDelete };
  }

  /** Open the menu the way a user does — a contextmenu (right-click) event on the trigger. */
  async function openMenu() {
    fireEvent.contextMenu(screen.getByTestId('the-row'));
    await waitFor(() => expect(screen.getByTestId('buckets-object-context-menu')).toBeTruthy());
  }

  it('opens on right-click and exposes Preview · Copy URL · Download · Delete', async () => {
    setup();
    await openMenu();

    expect(screen.getByTestId('buckets-object-context-preview')).toBeTruthy();
    expect(screen.getByTestId('buckets-object-context-copy')).toBeTruthy();
    expect(screen.getByTestId('buckets-object-context-download')).toBeTruthy();
    expect(screen.getByTestId('buckets-object-context-delete')).toBeTruthy();
  });

  it('exposes an accessible menu role + per-item menuitem roles (keyboard/SR usable)', async () => {
    setup();
    await openMenu();

    const menu = screen.getByTestId('buckets-object-context-menu');
    expect(menu.getAttribute('role')).toBe('menu');
    expect(menu.getAttribute('aria-label')).toContain('hero.png');
    expect(screen.getAllByRole('menuitem').length).toBe(4);
  });

  it('each item fires the matching handler with the object key', async () => {
    const { onPreview, onCopyUrl, onDownload, onDelete } = setup();

    await openMenu();
    fireEvent.click(screen.getByTestId('buckets-object-context-preview'));
    expect(onPreview).toHaveBeenCalledWith('images/hero.png');

    await openMenu();
    fireEvent.click(screen.getByTestId('buckets-object-context-copy'));
    expect(onCopyUrl).toHaveBeenCalledWith('images/hero.png');

    await openMenu();
    fireEvent.click(screen.getByTestId('buckets-object-context-download'));
    expect(onDownload).toHaveBeenCalledWith('images/hero.png');

    await openMenu();
    fireEvent.click(screen.getByTestId('buckets-object-context-delete'));
    expect(onDelete).toHaveBeenCalledWith('images/hero.png');
  });

  it('hides the Preview item for a non-previewable object (no doomed control)', async () => {
    setup({ canPreview: false });
    await openMenu();

    expect(screen.queryByTestId('buckets-object-context-preview')).toBeNull();
    // The other three remain.
    expect(screen.getByTestId('buckets-object-context-copy')).toBeTruthy();
    expect(screen.getByTestId('buckets-object-context-download')).toBeTruthy();
    expect(screen.getByTestId('buckets-object-context-delete')).toBeTruthy();
  });

  it('closes on Escape (Radix focus/Escape contract)', async () => {
    setup();
    await openMenu();

    fireEvent.keyDown(screen.getByTestId('buckets-object-context-menu'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('buckets-object-context-menu')).toBeNull());
  });
});
