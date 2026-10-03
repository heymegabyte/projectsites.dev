// @vitest-environment jsdom
/**
 * DataSearchPalette.spec.tsx
 *
 * Unit tests for the Database ⌘K global data-search palette (Rev 9/10 — Global data search).
 *
 * The palette REUSES the EXISTING cross-table content-search endpoint `POST /api/sites/:siteId/db/search`
 * via the `requestDbSearch({ q, limit })` bridge (message `PS_SITEDB_SEARCH_REQUEST` → `_RESPONSE`). It adds
 * NO new endpoint. A ⌘K / Ctrl+K opens + focuses the input; a typed query (debounced) dispatches the search;
 * matches render grouped by table (name matches + in-content matches with a snippet); ↑/↓ move selection,
 * Enter opens the matched table (fires `onOpenTable`), Esc closes. Empty query → a quiet hint; a zero-result
 * reply → "No matches" (never a dead overlay).
 *
 * Cases:
 *  1. ⌘K opens the overlay and focuses the search input; Esc closes it.
 *  2. A typed query (past debounce) dispatches requestDbSearch with the trimmed query.
 *  3. Results render grouped — a "Tables" name match + an "In content" match with its snippet.
 *  4. Enter on the highlighted result fires onOpenTable with { table, rowid } and closes the overlay.
 *  5. A zero-result reply shows the honest "No matches" state (not a dead/blank overlay).
 *  6. An empty/too-short query shows the quiet hint and never dispatches a search.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';

// ─── Embed bridge mock (mirror the real requestDbSearch contract) ─────────────

const { requestDbSearchSpy } = vi.hoisted(() => {
  return { requestDbSearchSpy: vi.fn() };
});

vi.mock('~/lib/embed/embedded-mode', () => ({
  isEmbedded: true,
  requestDbSearch: requestDbSearchSpy,
}));

import { DataSearchPalette } from '../DataSearchPalette';

/** Fire a real ⌘K on the document (the palette listens globally so it opens from any Database sub-view). */
function pressCmdK() {
  fireEvent.keyDown(document, { key: 'k', metaKey: true });
}

beforeEach(() => {
  vi.useFakeTimers();
  requestDbSearchSpy.mockReset();
  requestDbSearchSpy.mockResolvedValue({
    ok: true,
    enabled: true,
    nameMatches: ['customers'],
    contentMatches: [{ table: 'orders', column: 'note', rowid: 42, snippet: 'urgent ACME order' }],
    truncated: false,
  });
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  cleanup();
});

describe('DataSearchPalette (⌘K global data search)', () => {
  it('opens on ⌘K, focuses the input, and closes on Esc', () => {
    render(<DataSearchPalette onOpenTable={vi.fn()} />);

    // Closed initially — no overlay in the DOM.
    expect(screen.queryByTestId('data-search-overlay')).toBeNull();

    pressCmdK();

    const overlay = screen.getByTestId('data-search-overlay');
    expect(overlay).toBeTruthy();

    const input = screen.getByTestId('data-search-input') as HTMLInputElement;
    expect(document.activeElement).toBe(input);

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByTestId('data-search-overlay')).toBeNull();
  });

  it('dispatches the EXISTING cross-table search with the trimmed query (past debounce)', async () => {
    render(<DataSearchPalette onOpenTable={vi.fn()} />);
    pressCmdK();

    const input = screen.getByTestId('data-search-input');
    fireEvent.change(input, { target: { value: '  acme  ' } });

    // Debounced — nothing fires immediately.
    expect(requestDbSearchSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);

    expect(requestDbSearchSpy).toHaveBeenCalledTimes(1);
    expect(requestDbSearchSpy).toHaveBeenCalledWith(expect.objectContaining({ q: 'acme' }));
  });

  it('renders matches grouped by table with the in-content snippet', async () => {
    render(<DataSearchPalette onOpenTable={vi.fn()} />);
    pressCmdK();

    fireEvent.change(screen.getByTestId('data-search-input'), { target: { value: 'acme' } });

    // Advance past the debounce AND flush the awaited search promise + the React re-render.
    await vi.advanceTimersByTimeAsync(320);
    await vi.advanceTimersByTimeAsync(0);

    const resultsPanel = screen.getByTestId('data-search-results');

    // Name match (customers) + content match (orders.note) + its snippet all render.
    expect(screen.getByText('customers')).toBeTruthy();
    expect(screen.getByText('orders')).toBeTruthy();

    /*
     * The snippet renders with the matched term stylized in a <mark>; surrounding text stays around it.
     * (getByText can't span element boundaries, so assert on the panel's full text content.)
     */
    expect(resultsPanel.textContent).toMatch(/urgent\s*ACME\s*order/i);
    expect(resultsPanel.querySelector('mark')?.textContent?.toLowerCase()).toBe('acme');
  });

  it('opens the matched table on Enter (fires onOpenTable) and closes', async () => {
    const onOpenTable = vi.fn();
    render(<DataSearchPalette onOpenTable={onOpenTable} />);
    pressCmdK();

    const input = screen.getByTestId('data-search-input');
    fireEvent.change(input, { target: { value: 'acme' } });
    await vi.advanceTimersByTimeAsync(320);
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByTestId('data-search-results')).toBeTruthy();

    // First result is the "customers" name match (highlighted by default). Enter opens it.
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onOpenTable).toHaveBeenCalledTimes(1);
    expect(onOpenTable).toHaveBeenCalledWith(expect.objectContaining({ table: 'customers' }));
    expect(screen.queryByTestId('data-search-overlay')).toBeNull();
  });

  it('shows an honest "No matches" state on a zero-result reply', async () => {
    requestDbSearchSpy.mockResolvedValue({ ok: true, enabled: true, nameMatches: [], contentMatches: [] });

    render(<DataSearchPalette onOpenTable={vi.fn()} />);
    pressCmdK();

    fireEvent.change(screen.getByTestId('data-search-input'), { target: { value: 'zzzz' } });
    await vi.advanceTimersByTimeAsync(320);
    await vi.advanceTimersByTimeAsync(0);

    expect(screen.getByTestId('data-search-empty')).toBeTruthy();
    expect(screen.getByTestId('data-search-empty').textContent).toMatch(/no matches/i);
  });

  it('shows the quiet hint and never searches for a too-short query', async () => {
    render(<DataSearchPalette onOpenTable={vi.fn()} />);
    pressCmdK();

    fireEvent.change(screen.getByTestId('data-search-input'), { target: { value: 'a' } });
    await vi.advanceTimersByTimeAsync(300);

    expect(requestDbSearchSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId('data-search-hint')).toBeTruthy();
  });
});
