// @vitest-environment jsdom
/**
 * data-grid-features.spec.tsx
 *
 * Feature coverage for the Notion/Airtable-grade Data › Tables grid — the engine WIRED into
 * `SiteTablesPanel`. Each block seeds a rich in-memory table over the mocked embed bridge, then
 * asserts one grid feature end-to-end through the real component:
 *
 *   - toolbar present (search · filter · columns · density · view · export · add-row)
 *   - search box filters the rendered rows
 *   - filter bar: add a condition (each operator selectable) narrows the rows
 *   - multi-column sort: header click cycles asc→desc→none; a 2nd header builds a priority sort
 *   - pagination + page-size selector (PAGE_SIZE_OPTIONS)
 *   - column show/hide + reorder menu
 *   - typed cell renderers: boolean checkbox, rating stars, select chips
 *   - add-row → parameterized INSERT; delete-row + bulk-select delete → DELETE by PK
 *   - whole-table CSV/TSV/JSON export (asserts the serialized output the engine produces)
 *   - empty-state launchpad exposes BOTH "Use AI to load sample data" AND "Create Table"
 *   - Grid ↔ Gallery view toggle
 *   - AI panels (filter / column / fill) open + dispatch through /api/llmcall
 *
 * The embed bridge is mocked at the module level. `useVirtualizer` is stubbed to emit one virtual
 * item per row (jsdom has no layout) so cells render without a real container height.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, act, waitFor, within } from '@testing-library/react';
import React from 'react';

// ─── Embed bridge mock ────────────────────────────────────────────────────────

const { postToParentSpy, onParentMessageSpy, parentHandlers } = vi.hoisted(() => {
  const parentHandlers = new Set<(msg: unknown) => void>();
  const postToParentSpy = vi.fn();
  const onParentMessageSpy = vi.fn((handler: (msg: unknown) => void) => {
    parentHandlers.add(handler);
    return () => parentHandlers.delete(handler);
  });

  return { postToParentSpy, onParentMessageSpy, parentHandlers };
});

const { requestDbLoadSampleSpy, requestDbAiSeedSpy, postToastToParentSpy } = vi.hoisted(() => ({
  requestDbLoadSampleSpy: vi.fn(async () => ({ type: 'PS_DB_LOAD_SAMPLE_RESULT', ok: true, tablesCreated: 1, tables: ['sample'] })),
  requestDbAiSeedSpy: vi.fn(async () => ({ type: 'PS_DB_AI_SEED_RESULT', ok: true, rowsInserted: 10, table: 'posts' })),
  postToastToParentSpy: vi.fn(),
}));

vi.mock('~/lib/embed/embedded-mode', () => ({
  isEmbedded: true,
  postToParent: postToParentSpy,
  postToastToParent: postToastToParentSpy,
  onParentMessage: onParentMessageSpy,
  requestDbLoadSample: requestDbLoadSampleSpy,
  requestDbAiSeed: requestDbAiSeedSpy,
  // The panel also imports these DDL/edit senders; stub them so the module's named imports resolve.
  requestDbCreateTable: vi.fn(async () => ({ type: 'PS_SITEDB_CREATE_TABLE_RESPONSE', ok: true })),
  requestDbDropTable: vi.fn(async () => ({ type: 'PS_SITEDB_DROP_TABLE_RESPONSE', ok: true })),
  requestDbAddColumn: vi.fn(async () => ({ type: 'PS_SITEDB_ADD_COLUMN_RESPONSE', ok: true })),
  requestDbRenameColumn: vi.fn(async () => ({ type: 'PS_SITEDB_RENAME_COLUMN_RESPONSE', ok: true })),
  requestDbDropColumn: vi.fn(async () => ({ type: 'PS_SITEDB_DROP_COLUMN_RESPONSE', ok: true })),
  requestDbSearch: vi.fn(async () => ({ type: 'PS_SITEDB_SEARCH_RESPONSE', ok: true, nameMatches: [], contentMatches: [] })),
  requestDbUpdateRow: vi.fn(async () => ({ type: 'PS_SITEDB_UPDATE_ROW_RESPONSE', ok: true, updated: 1 })),
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: vi.fn(({ count }: { count: number }) => ({
    getVirtualItems: () => Array.from({ length: count }, (_, i) => ({ key: i, index: i, start: i * 34, size: 34 })),
    getTotalSize: () => count * 34,
  })),
}));

import { SiteTablesPanel } from '../SiteTablesPanel';
import {
  toCsv,
  toTsv,
  toJsonRows,
  cycleSortMulti,
  sortRows,
  filterRows,
  visibleColumns,
  moveColumn,
  clampPageSize,
  PAGE_SIZE_OPTIONS,
  // Revision 1 — rowid inline edit (kill the "no-PK = read-only" limitation).
  ROWID_KEY,
  rowStableKey,
  isRowEditableColumn,
} from '../data-panel-logic';

// ─── Helpers ────────────────────────────────────────────────────────────────

function fireReply(msg: unknown): void {
  for (const handler of parentHandlers) {
    handler(msg);
  }
}

function lastCorrelationId(): string | undefined {
  const calls = postToParentSpy.mock.calls;
  const last = calls[calls.length - 1]?.[0];
  return (last as { correlationId?: string })?.correlationId;
}

/** Find the correlationId of the most-recent request of a given type. */
function lastReqIdOfType(type: string): string | undefined {
  const calls = [...postToParentSpy.mock.calls].reverse();
  const found = calls.map((c) => c[0]).find((m: unknown) => (m as { type?: string })?.type === type);
  return (found as { correlationId?: string })?.correlationId;
}

const RICH_COLUMNS = [
  { name: 'id', type: 'INTEGER', notnull: 1, pk: 1 },
  { name: 'title', type: 'TEXT', notnull: 0, pk: 0 },
  { name: 'views', type: 'INTEGER', notnull: 0, pk: 0 },
  { name: 'published', type: 'BOOLEAN', notnull: 0, pk: 0 },
  { name: 'stars', type: 'RATING', notnull: 0, pk: 0 },
  { name: 'tags', type: 'TEXT', notnull: 0, pk: 0 },
];

const RICH_ROWS = [
  { id: 1, title: 'Alpha', views: 100, published: 1, stars: 5, tags: '["news","hot"]' },
  { id: 2, title: 'Bravo', views: 20, published: 0, stars: 2, tags: '["tips"]' },
  { id: 3, title: 'Charlie', views: 300, published: 1, stars: 4, tags: '["news"]' },
];

/** Drive the panel to a browsed rich table (id PK + text/number/boolean/rating/multiselect columns). */
async function openRichTable(rows = RICH_ROWS): Promise<void> {
  render(<SiteTablesPanel />);

  await waitFor(() => {
    expect(postToParentSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'PS_SITEDB_TABLES_REQUEST' }));
  });

  await act(async () => {
    fireReply({
      type: 'PS_SITEDB_TABLES_RESPONSE',
      correlationId: lastCorrelationId(),
      ok: true,
      databaseId: 'db-grid',
      provisioned: true,
      tables: [{ name: 'posts' }],
    });
  });

  // Click the inner open-button (the row wrapper div has no onClick).
  const openButtons = screen.getAllByTestId('sitedb-table-open');

  await act(async () => {
    openButtons[0].click();
  });

  await waitFor(() => {
    expect(postToParentSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'PS_SITEDB_ROWS_REQUEST', table: 'posts' }),
    );
  });

  const rowsReqId = lastReqIdOfType('PS_SITEDB_ROWS_REQUEST');

  await act(async () => {
    fireReply({
      type: 'PS_SITEDB_ROWS_RESPONSE',
      correlationId: rowsReqId,
      ok: true,
      table: 'posts',
      columns: RICH_COLUMNS,
      rows,
      limit: 500,
      offset: 0,
      total: rows.length,
    });
  });
}

/** Reply OK to the most-recent RES_MUTATE (write). */
async function replyMutateOk(rowsWritten = 1): Promise<void> {
  const id = lastReqIdOfType('PS_RES_MUTATE_REQUEST');
  await act(async () => {
    fireReply({
      type: 'PS_RES_MUTATE_RESPONSE',
      correlationId: id,
      ok: true,
      kind: 'd1',
      action: 'exec',
      result: { ok: true, data: { action: 'exec', rows: [], rowsWritten, rowsRead: 0, changedDb: true } },
    });
  });
}

/** The visible cell text of every rendered grid cell (post-filter/sort, current page). */
function gridCellTexts(): string[] {
  return screen.queryAllByTestId('sitedb-grid-cell').map((c) => c.textContent?.trim() ?? '');
}

/** The title-column value of each rendered row, in DOM order. */
function renderedTitles(): string[] {
  return screen
    .queryAllByTestId('sitedb-grid-row')
    .map((r) => {
      const cells = within(r).queryAllByTestId('sitedb-grid-cell');
      // title is the 2nd column (after id).
      return cells[1]?.textContent?.trim() ?? '';
    })
    .filter(Boolean);
}

beforeEach(() => {
  postToParentSpy.mockClear();
  onParentMessageSpy.mockClear();
  parentHandlers.clear();
  requestDbAiSeedSpy.mockClear();
  postToastToParentSpy.mockClear();
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  cleanup();
  parentHandlers.clear();
  vi.unstubAllGlobals();
});

// ─── Pure engine contract (the primitives the grid wires) ─────────────────────

describe('grid engine primitives (wired into the panel)', () => {
  it('cycleSortMulti builds asc→desc→removed and appends a 2nd column', () => {
    expect(cycleSortMulti([], 'views')).toEqual([{ col: 'views', dir: 'asc' }]);
    expect(cycleSortMulti([{ col: 'views', dir: 'asc' }], 'views')).toEqual([{ col: 'views', dir: 'desc' }]);
    expect(cycleSortMulti([{ col: 'views', dir: 'desc' }], 'views')).toEqual([]);
    expect(cycleSortMulti([{ col: 'a', dir: 'asc' }], 'b')).toEqual([
      { col: 'a', dir: 'asc' },
      { col: 'b', dir: 'asc' },
    ]);
  });

  it('sortRows sorts numeric columns numerically and text case-insensitively', () => {
    const rows = [{ n: '10' }, { n: '2' }, { n: '1' }];
    expect(sortRows(rows, { col: 'n', dir: 'asc' }).map((r) => r.n)).toEqual(['1', '2', '10']);
    expect(sortRows(rows, { col: 'n', dir: 'desc' }).map((r) => r.n)).toEqual(['10', '2', '1']);
  });

  it('filterRows matches a case-insensitive substring across columns', () => {
    const rows = [{ a: 'Hello' }, { a: 'World' }];
    expect(filterRows(rows, ['a'], 'wor')).toEqual([{ a: 'World' }]);
    expect(filterRows(rows, ['a'], '')).toHaveLength(2);
  });

  it('visibleColumns + moveColumn drive show/hide + reorder', () => {
    expect(visibleColumns(['a', 'b', 'c'], ['b'])).toEqual(['a', 'c']);
    expect(moveColumn(['a', 'b', 'c'], [], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(moveColumn(['a', 'b', 'c'], [], 'b', 1)).toEqual(['a', 'c', 'b']);
  });

  it('clampPageSize snaps to an allowed PAGE_SIZE_OPTIONS value', () => {
    expect(PAGE_SIZE_OPTIONS).toContain(clampPageSize(25));
    expect(PAGE_SIZE_OPTIONS).toContain(clampPageSize(999));
  });

  it('toCsv / toTsv / toJsonRows serialize the WHOLE set with the engine escaping', () => {
    const cols = ['id', 'title'];
    const rows = [{ id: 1, title: 'a,b' }, { id: 2, title: 'x' }];

    const csv = toCsv(cols, rows);
    expect(csv.split('\r\n')[0]).toBe('Id,Title'); // columnLabel humanizes the header
    expect(csv).toContain('"a,b"'); // comma is quoted

    const tsv = toTsv(cols, rows);
    expect(tsv.split('\r\n')[0]).toBe('Id\tTitle');
    expect(tsv).toContain('1\ta,b');

    const json = JSON.parse(toJsonRows(cols, rows));
    expect(json).toEqual([
      { id: 1, title: 'a,b' },
      { id: 2, title: 'x' },
    ]);
  });
});

// ─── Empty-state launchpad (Brian-explicit dual CTA) ──────────────────────────

describe('empty-state launchpad exposes AI-seed AND Create-Table', () => {
  it('renders "Use AI to load sample data" and "Create Table" tiles', async () => {
    render(<SiteTablesPanel />);

    await waitFor(() => {
      expect(postToParentSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'PS_SITEDB_TABLES_REQUEST' }));
    });

    await act(async () => {
      fireReply({
        type: 'PS_SITEDB_TABLES_RESPONSE',
        correlationId: lastCorrelationId(),
        ok: true,
        databaseId: 'db',
        provisioned: true,
        tables: [],
      });
    });

    const seed = screen.getByTestId('sitedb-empty-seed');
    const create = screen.getByTestId('sitedb-empty-newtable');
    expect(seed.textContent).toContain('Use AI to load sample data');
    expect(create.textContent).toContain('Create Table');
    expect(screen.getByTestId('sitedb-empty-sample')).toBeTruthy(); // existing "Load sample data" kept
  });

  // SKIPPED 2026-09-28: asserts `sitedb-list-seed-ai` (the table-list "Seed with AI" button), which was
  // intentionally removed in commit c5ed2b07a ("drop Seed button"). Pre-existing stale drift — not a
  // regression from the column-management work — kept skipped (not deleted) per the removed-feature convention.
  it.skip('the table-list toolbar also offers Use-AI + Create-Table so you can always seed', async () => {
    // The Create-Table button gates on a create handler being wired (the guided builder).
    render(<SiteTablesPanel onCreateTable={vi.fn()} />);

    await waitFor(() => {
      expect(postToParentSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'PS_SITEDB_TABLES_REQUEST' }));
    });

    await act(async () => {
      fireReply({
        type: 'PS_SITEDB_TABLES_RESPONSE',
        correlationId: lastCorrelationId(),
        ok: true,
        databaseId: 'db',
        provisioned: true,
        tables: [{ name: 'posts' }],
      });
    });

    expect(screen.getByTestId('sitedb-list-seed-ai')).toBeTruthy();
    expect(screen.getByTestId('sitedb-new-table-inline')).toBeTruthy();
  });
});

// ─── Toolbar presence ─────────────────────────────────────────────────────────

describe('grid toolbar', () => {
  it('renders search, filter, columns, density, view toggle, export, add-row', async () => {
    await openRichTable();

    expect(screen.getByTestId('sitedb-search')).toBeTruthy();
    expect(screen.getByTestId('sitedb-filter-toggle')).toBeTruthy();
    expect(screen.getByTestId('sitedb-columns-toggle')).toBeTruthy();
    expect(screen.getByTestId('sitedb-density-compact')).toBeTruthy();
    expect(screen.getByTestId('sitedb-density-comfortable')).toBeTruthy();
    expect(screen.getByTestId('sitedb-view-grid')).toBeTruthy();
    expect(screen.getByTestId('sitedb-view-gallery')).toBeTruthy();
    expect(screen.getByTestId('sitedb-export')).toBeTruthy();
    // PK present → row mutation controls available.
    expect(screen.getByTestId('sitedb-add-row')).toBeTruthy();
    expect(screen.getByTestId('sitedb-add-column')).toBeTruthy();
  });
});

// ─── Search ───────────────────────────────────────────────────────────────────

describe('search box filters the rendered rows', () => {
  it('typing narrows to matching rows', async () => {
    await openRichTable();

    expect(renderedTitles().sort()).toEqual(['Alpha', 'Bravo', 'Charlie']);

    const searchInput = screen.getByTestId('sitedb-search') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(searchInput, 'brav');
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(renderedTitles()).toEqual(['Bravo']);
    expect(screen.getByTestId('sitedb-page-info').textContent).toContain('of 1');
  });
});

// ─── Filter bar (each operator selectable + applied) ──────────────────────────

describe('filter bar', () => {
  it('adds a condition and narrows rows by an operator (gt)', async () => {
    await openRichTable();

    await act(async () => {
      screen.getByTestId('sitedb-filter-toggle').click();
    });
    expect(screen.getByTestId('sitedb-filter-bar')).toBeTruthy();

    await act(async () => {
      screen.getByTestId('sitedb-filter-add').click();
    });

    // Pick column = views, op = gt, value = 50 → only Alpha(100) + Charlie(300).
    const col = screen.getByTestId('sitedb-filter-col') as HTMLSelectElement;
    const op = screen.getByTestId('sitedb-filter-op') as HTMLSelectElement;

    await act(async () => {
      const s = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
      s?.call(col, 'views');
      col.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      const s = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
      s?.call(op, 'gt');
      op.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const val = screen.getByTestId('sitedb-filter-val') as HTMLInputElement;
    await act(async () => {
      const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      s?.call(val, '50');
      val.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(renderedTitles().sort()).toEqual(['Alpha', 'Charlie']);
  });

  it('a value-free operator (is not null) hides the value input', async () => {
    await openRichTable();

    await act(async () => {
      screen.getByTestId('sitedb-filter-toggle').click();
    });
    await act(async () => {
      screen.getByTestId('sitedb-filter-add').click();
    });

    const op = screen.getByTestId('sitedb-filter-op') as HTMLSelectElement;
    await act(async () => {
      const s = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
      s?.call(op, 'notnull');
      op.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(screen.queryByTestId('sitedb-filter-val')).toBeNull();
  });

  it('all engine operators are offered in the operator dropdown', async () => {
    await openRichTable();
    await act(async () => {
      screen.getByTestId('sitedb-filter-toggle').click();
    });
    await act(async () => {
      screen.getByTestId('sitedb-filter-add').click();
    });

    const op = screen.getByTestId('sitedb-filter-op') as HTMLSelectElement;
    const values = Array.from(op.options).map((o) => o.value);
    ['eq', 'ne', 'contains', 'startswith', 'endswith', 'gt', 'lt', 'gte', 'lte', 'null', 'notnull'].forEach((o) =>
      expect(values).toContain(o),
    );
  });
});

// ─── Multi-column sort ────────────────────────────────────────────────────────

describe('multi-column sort via header click', () => {
  it('clicking a header sorts asc, then desc, then clears', async () => {
    await openRichTable();

    const headers = screen.getAllByRole('columnheader');
    const viewsHeader = headers.find((h) => h.textContent?.includes('views'))!;

    // asc → Bravo(20), Alpha(100), Charlie(300)
    await act(async () => {
      viewsHeader.click();
    });
    expect(renderedTitles()).toEqual(['Bravo', 'Alpha', 'Charlie']);

    // desc → Charlie(300), Alpha(100), Bravo(20)
    await act(async () => {
      viewsHeader.click();
    });
    expect(renderedTitles()).toEqual(['Charlie', 'Alpha', 'Bravo']);

    // cleared → original order
    await act(async () => {
      viewsHeader.click();
    });
    expect(renderedTitles()).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('a second header builds a priority multi-sort (shows priority badges)', async () => {
    await openRichTable();

    const headers = screen.getAllByRole('columnheader');
    const publishedHeader = headers.find((h) => h.textContent?.includes('published'))!;
    const viewsHeader = headers.find((h) => h.textContent?.includes('views'))!;

    await act(async () => {
      publishedHeader.click();
    });
    await act(async () => {
      viewsHeader.click();
    });

    // Two active sorts → both headers show a sort indicator.
    expect(screen.getByTestId('sitedb-sort-published')).toBeTruthy();
    expect(screen.getByTestId('sitedb-sort-views')).toBeTruthy();
  });
});

// ─── Pagination + page-size ───────────────────────────────────────────────────

describe('pagination + page-size', () => {
  it('page-size selector offers PAGE_SIZE_OPTIONS and paginates', async () => {
    // 30 rows so a page-size of 25 yields 2 pages.
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: i + 1,
      title: `Row ${i + 1}`,
      views: i,
      published: i % 2,
      stars: (i % 5) + 1,
      tags: '[]',
    }));
    await openRichTable(many);

    const sizeSel = screen.getByTestId('sitedb-page-size') as HTMLSelectElement;
    const values = Array.from(sizeSel.options).map((o) => Number(o.value));
    PAGE_SIZE_OPTIONS.forEach((n) => expect(values).toContain(n));

    // Set page size to 25.
    await act(async () => {
      const s = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
      s?.call(sizeSel, '25');
      sizeSel.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(screen.getByTestId('sitedb-page-count').textContent).toContain('of 2');
    expect(screen.getByTestId('sitedb-page-info').textContent).toContain('of 30');

    // Next page.
    await act(async () => {
      screen.getByTestId('sitedb-next-page').click();
    });
    expect(screen.getByTestId('sitedb-page-info').textContent).toContain('Showing 26');
  });
});

// ─── Column show/hide + reorder ───────────────────────────────────────────────

describe('column show/hide + reorder menu', () => {
  it('hiding a column removes its header; the menu lists every column', async () => {
    await openRichTable();

    await act(async () => {
      screen.getByTestId('sitedb-columns-toggle').click();
    });
    expect(screen.getByTestId('sitedb-columns-menu')).toBeTruthy();

    // Hide "views".
    await act(async () => {
      screen.getByTestId('sitedb-col-toggle-views').click();
    });

    const headers = screen.getAllByRole('columnheader');
    expect(headers.some((h) => h.textContent?.includes('views'))).toBe(false);
    expect(headers.some((h) => h.textContent?.includes('title'))).toBe(true);
  });

  it('reorder buttons are present per column', async () => {
    await openRichTable();
    await act(async () => {
      screen.getByTestId('sitedb-columns-toggle').click();
    });
    expect(screen.getByTestId('sitedb-col-left-views')).toBeTruthy();
    expect(screen.getByTestId('sitedb-col-right-views')).toBeTruthy();
  });
});

// ─── Typed cell renderers ─────────────────────────────────────────────────────

describe('typed cell renderers', () => {
  it('boolean → checkbox, rating → stars, multiSelect → chips', async () => {
    await openRichTable();

    // Boolean column renders a checkbox cell.
    expect(screen.getAllByTestId('sitedb-cell-checkbox').length).toBeGreaterThan(0);

    // Rating renders stars (★) somewhere in the grid.
    const cellText = gridCellTexts().join(' ');
    expect(cellText).toContain('★');

    // multiSelect (tags) renders chips.
    const rows = screen.getAllByTestId('sitedb-grid-row');
    const firstRowText = rows[0].textContent ?? '';
    expect(firstRowText).toContain('news');
    expect(firstRowText).toContain('hot');
  });

  it('toggling a boolean checkbox dispatches a param-bound UPDATE', async () => {
    await openRichTable();

    const boxes = screen.getAllByTestId('sitedb-cell-checkbox');
    postToParentSpy.mockClear();

    await act(async () => {
      boxes[0].click();
    });

    await waitFor(() => {
      expect(postToParentSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'PS_RES_MUTATE_REQUEST',
          kind: 'd1',
          action: 'exec',
          confirm: true,
          input: expect.objectContaining({
            sql: expect.stringContaining('UPDATE "posts" SET "published"'),
          }),
        }),
      );
    });
  });
});

// ─── Add row ─────────────────────────────────────────────────────────────────

describe('add row', () => {
  it('clicking "New row" dispatches a parameterized INSERT (autoincrement PK omitted)', async () => {
    await openRichTable();
    postToParentSpy.mockClear();

    await act(async () => {
      screen.getByTestId('sitedb-add-row').click();
    });

    await waitFor(() => {
      expect(postToParentSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'PS_RES_MUTATE_REQUEST',
          confirm: true,
          input: expect.objectContaining({
            sql: expect.stringMatching(/^INSERT INTO "posts"/),
          }),
        }),
      );
    });

    // The INSERT must NOT include the INTEGER PK "id" (it autoincrements).
    const insert = postToParentSpy.mock.calls
      .map((c) => c[0])
      .find(
        (m: unknown) =>
          (m as { input?: { sql?: string } })?.input?.sql?.startsWith('INSERT INTO "posts"'),
      ) as { input: { sql: string } };
    expect(insert.input.sql).not.toContain('"id"');
  });
});

// ─── Delete row + bulk delete ─────────────────────────────────────────────────

describe('delete row + bulk delete', () => {
  it('the row action deletes one row via DELETE ... WHERE pk', async () => {
    await openRichTable();

    const deletes = screen.getAllByTestId('sitedb-row-delete');
    postToParentSpy.mockClear();

    await act(async () => {
      deletes[0].click();
    });

    await waitFor(() => {
      expect(postToParentSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'PS_RES_MUTATE_REQUEST',
          confirm: true,
          input: expect.objectContaining({
            sql: expect.stringMatching(/^DELETE FROM "posts" WHERE "id" = \?1/),
            params: [1],
          }),
        }),
      );
    });
  });

  it('selecting rows shows a bulk bar; bulk delete issues one DELETE per row', async () => {
    await openRichTable();

    const selects = screen.getAllByTestId('sitedb-row-select');

    await act(async () => {
      selects[0].click();
    });
    await act(async () => {
      selects[1].click();
    });

    expect(screen.getByTestId('sitedb-bulk-bar').textContent).toContain('2 selected');

    postToParentSpy.mockClear();

    // Bulk delete awaits each DELETE sequentially → reply OK to each pending mutate so the loop advances.
    const seen = new Set<string>();

    await act(async () => {
      screen.getByTestId('sitedb-bulk-delete').click();
    });

    // Drive the sequential loop: reply to each new DELETE mutate as it appears (2 total).
    for (let step = 0; step < 4; step++) {
      const id = lastReqIdOfType('PS_RES_MUTATE_REQUEST');

      if (id && !seen.has(id)) {
        seen.add(id);
        await replyMutateOk(1);
      }

      // Let the next await resolve + dispatch the next DELETE.
      await act(async () => {
        await Promise.resolve();
      });
    }

    const deletes = postToParentSpy.mock.calls
      .map((c) => c[0])
      .filter((m: unknown) => (m as { input?: { sql?: string } })?.input?.sql?.startsWith('DELETE FROM "posts"'));
    expect(deletes.length).toBe(2);
  });
});

// ─── Add column ────────────────────────────────────────────────────────────────

describe('add column', () => {
  it('opens the add-column form and dispatches an ALTER TABLE ADD COLUMN', async () => {
    await openRichTable();

    await act(async () => {
      screen.getByTestId('sitedb-add-column').click();
    });
    expect(screen.getByTestId('sitedb-add-column-form')).toBeTruthy();

    const nameInput = screen.getByTestId('sitedb-add-column-name') as HTMLInputElement;
    await act(async () => {
      const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      s?.call(nameInput, 'author');
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    postToParentSpy.mockClear();

    await act(async () => {
      screen.getByTestId('sitedb-add-column-submit').click();
    });

    await waitFor(() => {
      expect(postToParentSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'PS_RES_MUTATE_REQUEST',
          confirm: true,
          input: expect.objectContaining({
            sql: expect.stringMatching(/ALTER TABLE "posts" ADD COLUMN "author"/),
          }),
        }),
      );
    });
  });
});

// ─── View toggle ───────────────────────────────────────────────────────────────

describe('Grid ↔ Gallery view toggle', () => {
  it('switching to gallery renders cards instead of the grid', async () => {
    await openRichTable();

    expect(screen.getByTestId('sitedb-grid')).toBeTruthy();

    await act(async () => {
      screen.getByTestId('sitedb-view-gallery').click();
    });

    expect(screen.getByTestId('sitedb-gallery')).toBeTruthy();
    expect(screen.getAllByTestId('sitedb-gallery-card').length).toBe(RICH_ROWS.length);
    expect(screen.queryByTestId('sitedb-grid')).toBeNull();
  });
});

// ─── AI-native panels ────────────────────────────────────────────────────────

describe('AI-native features', () => {
  it('AI filter panel opens and applies a model-returned filter plan', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ text: '{"conditions":[{"col":"views","op":"gt","val":"50"}],"combinator":"AND","sorts":[]}' }),
    });

    await openRichTable();

    await act(async () => {
      screen.getByTestId('sitedb-ai-filter').click();
    });
    expect(screen.getByTestId('sitedb-ai-panel')).toBeTruthy();

    const input = screen.getByTestId('sitedb-ai-input') as HTMLInputElement;
    await act(async () => {
      const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      s?.call(input, 'views over 50');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      screen.getByTestId('sitedb-ai-submit').click();
    });

    // The model plan applied → only Alpha(100) + Charlie(300) remain.
    await waitFor(() => {
      expect(renderedTitles().sort()).toEqual(['Alpha', 'Charlie']);
    });
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/llmcall', expect.objectContaining({ method: 'POST' }));
  });

  it('AI generate-column panel opens and calls /api/llmcall then ALTERs', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ text: '{"name":"score","type":"INTEGER","expr":"views * 2"}' }),
    });

    await openRichTable();

    await act(async () => {
      screen.getByTestId('sitedb-ai-column').click();
    });
    const input = screen.getByTestId('sitedb-ai-input') as HTMLInputElement;
    await act(async () => {
      const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      s?.call(input, 'double the views');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    postToParentSpy.mockClear();

    await act(async () => {
      screen.getByTestId('sitedb-ai-submit').click();
    });

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/llmcall', expect.anything());
    });
    // ADD COLUMN dispatched from the AI plan.
    await waitFor(() => {
      expect(postToParentSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({ sql: expect.stringMatching(/ADD COLUMN "score"/) }),
        }),
      );
    });
  });

  it('AI fill appears only when rows are selected', async () => {
    await openRichTable();

    // No selection → no AI-fill button.
    expect(screen.queryByTestId('sitedb-ai-fill')).toBeNull();

    const selects = screen.getAllByTestId('sitedb-row-select');
    await act(async () => {
      selects[0].click();
    });

    expect(screen.getByTestId('sitedb-ai-fill')).toBeTruthy();
  });
});

// ─── Revision 3 — bulk edit + fill-down (Airtable-style multi-cell) ───────────

/** The grid cells of the Nth rendered row (0-based), in column order. */
function rowCells(rowIndex: number): HTMLElement[] {
  const rows = screen.queryAllByTestId('sitedb-grid-row');
  return within(rows[rowIndex]).queryAllByTestId('sitedb-grid-cell');
}

/** Every `PS_RES_MUTATE_REQUEST` whose SQL is an UPDATE of the given column, in dispatch order. */
function updateCallsForColumn(column: string): { input: { sql: string; params: unknown[] } }[] {
  return postToParentSpy.mock.calls
    .map((c) => c[0])
    .filter(
      (m: unknown) =>
        (m as { type?: string })?.type === 'PS_RES_MUTATE_REQUEST' &&
        typeof (m as { input?: { sql?: string } })?.input?.sql === 'string' &&
        (m as { input: { sql: string } }).input.sql.includes(`UPDATE "posts" SET "${column}"`),
    ) as { input: { sql: string; params: unknown[] } }[];
}

describe('Revision 3 — fill-down applies the top value to N-1 rows via the writeCell bridge', () => {
  it('shift-click a column range + Cmd/Ctrl+D issues one UPDATE per lower selected row (N-1)', async () => {
    await openRichTable();

    // Column index 1 = "title". Plain-click sets the range anchor without opening the editor
    // (a bare click on a text cell would open the editor; the range gesture is shift-click).
    // Select the title cells of rows 0,1,2: anchor via click on row 0 title while holding a modifier,
    // then shift-click row 2 to extend the range down the column.
    const r0title = rowCells(0)[1];
    const r2title = rowCells(2)[1];

    // Anchor: modifier-click (adds the single cell to a fresh column selection, no editor).
    await act(async () => {
      r0title.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }));
    });
    // Extend: shift-click the 3rd row's title cell → selects rows 0,1,2 in the title column.
    await act(async () => {
      r2title.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    });

    // The fill-down affordance appears for a multi-cell selection.
    const fillBtn = screen.getByTestId('sitedb-fill-down');
    expect(fillBtn.textContent).toMatch(/fill down/i);

    postToParentSpy.mockClear();

    // Fill-down: click the affordance (Cmd/Ctrl+D is the keyboard equivalent).
    await act(async () => {
      fillBtn.click();
    });

    // Drive the sequential per-row writes: reply OK to each UPDATE mutate as it appears.
    const seen = new Set<string>();

    for (let step = 0; step < 6; step++) {
      const id = lastReqIdOfType('PS_RES_MUTATE_REQUEST');

      if (id && !seen.has(id)) {
        seen.add(id);
        await replyMutateOk(1);
      }

      await act(async () => {
        await Promise.resolve();
      });
    }

    // 3 selected rows (Alpha/Bravo/Charlie) → source Alpha, targets Bravo + Charlie = 2 UPDATEs.
    const updates = updateCallsForColumn('title');
    expect(updates).toHaveLength(2);
    // Every write carries Alpha's title value bound as the first param.
    expect(updates.every((u) => u.input.params[0] === 'Alpha')).toBe(true);
  });

  it('Cmd+D on the grid triggers the same fill-down for the active column selection', async () => {
    await openRichTable();

    const r0title = rowCells(0)[1];
    const r1title = rowCells(1)[1];

    await act(async () => {
      r0title.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }));
    });
    await act(async () => {
      r1title.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    });

    postToParentSpy.mockClear();

    // Keyboard shortcut: Cmd/Ctrl+D on the grid.
    await act(async () => {
      const grid = screen.getByTestId('sitedb-grid');
      grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', metaKey: true, bubbles: true }));
    });

    const seen = new Set<string>();

    for (let step = 0; step < 4; step++) {
      const id = lastReqIdOfType('PS_RES_MUTATE_REQUEST');

      if (id && !seen.has(id)) {
        seen.add(id);
        await replyMutateOk(1);
      }

      await act(async () => {
        await Promise.resolve();
      });
    }

    // 2 selected rows → 1 UPDATE (source Alpha → target Bravo).
    const updates = updateCallsForColumn('title');
    expect(updates).toHaveLength(1);
    expect(updates[0].input.params[0]).toBe('Alpha');
  });
});

// ─── Undo (delete → re-insert) ─────────────────────────────────────────────────

describe('undo a delete', () => {
  it('after a successful row delete, an undo toast appears', async () => {
    await openRichTable();

    const deletes = screen.getAllByTestId('sitedb-row-delete');

    await act(async () => {
      deletes[0].click();
    });

    // Reply OK to the DELETE mutate; the panel then re-loads rows — reply to that too.
    await replyMutateOk(1);

    const reloadId = lastReqIdOfType('PS_SITEDB_ROWS_REQUEST');
    await act(async () => {
      fireReply({
        type: 'PS_SITEDB_ROWS_RESPONSE',
        correlationId: reloadId,
        ok: true,
        table: 'posts',
        columns: RICH_COLUMNS,
        rows: RICH_ROWS.slice(1),
        limit: 500,
        offset: 0,
        total: RICH_ROWS.length - 1,
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('sitedb-undo')).toBeTruthy();
    });
    expect(screen.getByTestId('sitedb-undo').textContent).toContain('Deleted');
  });
});

/*
 * ─── Revision 1 — rowid inline cell editing (pure edit-gate) ──────────────────
 *
 * Kills the "no primary key ⇒ read-only" limitation. Every browsed row exposes
 * the SQLite `rowid` under `_rowid` (the browse endpoint SELECTs `rowid AS
 * _rowid, *`). These pure functions are the STABLE-KEY + EDIT-GATE the panel
 * uses so a PK-less table is still fully editable — the row is targeted by its
 * `_rowid` via the dedicated `PATCH …/rows/:rowid` endpoint.
 */
describe('Revision 1 — rowStableKey + isRowEditableColumn (pure edit-gate)', () => {
  it('ROWID_KEY is the "_rowid" convention the browse endpoint emits', () => {
    expect(ROWID_KEY).toBe('_rowid');
  });

  it('rowStableKey prefers the PRIMARY KEY identity when a PK exists', () => {
    const row = { id: 42, _rowid: 7, title: 'Alpha' };
    // With a PK, the key is the PK identity (unchanged from rowPkKey), NOT the rowid.
    expect(rowStableKey(row, ['id'])).toBe(JSON.stringify([42]));
  });

  it('rowStableKey FALLS BACK to _rowid when there is NO primary key', () => {
    const row = { _rowid: 7, title: 'Alpha', body: 'x' };
    // No PK columns → the stable key is the rowid handle, so the row is still targetable.
    expect(rowStableKey(row, [])).toBe('_rowid:7');
  });

  it('rowStableKey is null only when there is NEITHER a PK NOR a _rowid', () => {
    expect(rowStableKey({ title: 'Alpha' }, [])).toBeNull();
    // A composite-PK row missing one key part is still unresolvable (matches rowPkKey).
    expect(rowStableKey({ a: 1 }, ['a', 'b'])).toBeNull();
  });

  it('isRowEditableColumn: a PK-LESS table is EDITABLE for a normal column when _rowid is present', () => {
    const gate = isRowEditableColumn('title', {
      pkCols: [],
      generatedCols: new Set<string>(),
      hasRowid: true,
    });
    expect(gate.editable).toBe(true);
  });

  it('isRowEditableColumn: PK-less AND no _rowid stays read-only (nothing safe to target)', () => {
    const gate = isRowEditableColumn('title', {
      pkCols: [],
      generatedCols: new Set<string>(),
      hasRowid: false,
    });
    expect(gate.editable).toBe(false);
    expect(gate.reason).toBeTruthy();
  });

  it('isRowEditableColumn: the synthetic _rowid handle itself is never editable', () => {
    const gate = isRowEditableColumn(ROWID_KEY, {
      pkCols: [],
      generatedCols: new Set<string>(),
      hasRowid: true,
    });
    expect(gate.editable).toBe(false);
  });

  it('isRowEditableColumn: a PK column stays locked; a generated column stays locked', () => {
    const pk = isRowEditableColumn('id', { pkCols: ['id'], generatedCols: new Set<string>(), hasRowid: true });
    expect(pk.editable).toBe(false);

    const gen = isRowEditableColumn('slug', {
      pkCols: ['id'],
      generatedCols: new Set(['slug']),
      hasRowid: true,
    });
    expect(gen.editable).toBe(false);
  });
});
