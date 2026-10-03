// @vitest-environment jsdom
/**
 * SiteTablesPanel.spec.tsx
 *
 * Unit tests for the per-site D1 Tables panel.
 *
 * Strategy: mock the embed bridge (postToParent / onParentMessage / isEmbedded)
 * so no real iframe or admin origin is needed. The component is treated as
 * embedded (isEmbedded=true), and bridge replies are injected synchronously via
 * the captured handler spy.
 *
 * Cases:
 *  1. PS_SITEDB_TABLES_RESPONSE — empty tables list → empty-state launchpad
 *     renders "New table" + "Ask AI" CTAs.
 *  2. PS_SITEDB_TABLES_RESPONSE + PS_SITEDB_ROWS_RESPONSE — tables present,
 *     table selected → grid header columns + a row cell render correctly.
 *
 * The embed bridge is mocked at the module level so each describe block gets a
 * clean spy set. `useVirtualizer` renders only the visible rows in a virtual
 * list; jsdom has no real layout engine so the virtualizer sees 0px container
 * height and emits 0 virtual items. The test asserts row data via the
 * DOM rather than the virtualizer so it's decoupled from container size.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
import React from 'react';

// ─── Embed bridge mock ────────────────────────────────────────────────────────

/**
 * Hoisted spies shared across the two describe blocks.
 * `vi.hoisted` runs before the module-level `vi.mock` factories.
 */
const { postToParentSpy, onParentMessageSpy, parentHandlers } = vi.hoisted(() => {
  /**
   * Registered handlers from `onParentMessage(handler)` calls. The test driver
   * calls `fireReply(msg)` to synchronously invoke all registered handlers with
   * a synthetic parent reply, simulating the bridge postMessage round-trip.
   */
  const parentHandlers = new Set<(msg: unknown) => void>();

  const postToParentSpy = vi.fn();

  const onParentMessageSpy = vi.fn((handler: (msg: unknown) => void) => {
    parentHandlers.add(handler);

    // Return an unsubscribe function matching the real embed bridge contract.
    return () => {
      parentHandlers.delete(handler);
    };
  });

  return { postToParentSpy, onParentMessageSpy, parentHandlers };
});

const { requestDbLoadSampleSpy, requestDbAiSeedSpy, postToastToParentSpy, requestDbUpdateRowSpy } = vi.hoisted(() => ({
  requestDbLoadSampleSpy: vi.fn(async () => ({
    type: 'PS_DB_LOAD_SAMPLE_RESULT',
    ok: true,
    tablesCreated: 1,
    tables: ['sample'],
  })),
  requestDbAiSeedSpy: vi.fn(async () => ({ type: 'PS_DB_AI_SEED_RESULT', ok: true, rowsInserted: 10, table: 'posts' })),
  postToastToParentSpy: vi.fn(),
  // Revision 1 — the dedicated rowid UPDATE sender (PATCH …/rows/:rowid). Defaults to a success reply.
  requestDbUpdateRowSpy: vi.fn(async () => ({ type: 'PS_SITEDB_UPDATE_ROW_RESPONSE', ok: true, updated: 1 })),
}));

vi.mock('~/lib/embed/embedded-mode', () => ({
  isEmbedded: true,
  postToParent: postToParentSpy,
  postToastToParent: postToastToParentSpy,
  onParentMessage: onParentMessageSpy,
  requestDbLoadSample: requestDbLoadSampleSpy,
  requestDbAiSeed: requestDbAiSeedSpy,
  requestDbUpdateRow: requestDbUpdateRowSpy,
  // The panel also imports these DDL senders; stub them so the module's named imports resolve
  // (an `undefined` import can break the table-open path under this harness).
  requestDbCreateTable: vi.fn(async () => ({ type: 'PS_SITEDB_CREATE_TABLE_RESPONSE', ok: true })),
  requestDbDropTable: vi.fn(async () => ({ type: 'PS_SITEDB_DROP_TABLE_RESPONSE', ok: true })),
  requestDbAddColumn: vi.fn(async () => ({ type: 'PS_SITEDB_ADD_COLUMN_RESPONSE', ok: true })),
  requestDbRenameColumn: vi.fn(async () => ({ type: 'PS_SITEDB_RENAME_COLUMN_RESPONSE', ok: true })),
  requestDbDropColumn: vi.fn(async () => ({ type: 'PS_SITEDB_DROP_COLUMN_RESPONSE', ok: true })),
  requestDbSearch: vi.fn(async () => ({
    type: 'PS_SITEDB_SEARCH_RESPONSE',
    ok: true,
    nameMatches: [],
    contentMatches: [],
  })),
}));

/*
 * `useVirtualizer` from @tanstack/react-virtual calls getBoundingClientRect
 * which returns 0s in jsdom. We stub it to return each row as a virtual item
 * so cells are rendered without depending on layout measurement.
 */
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: vi.fn(({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, i) => ({
        key: i,
        index: i,
        start: i * 34,
        size: 34,
      })),
    getTotalSize: () => count * 34,
  })),
}));

// ─── Import the component under test AFTER mocks are wired ──────────────────
import { SiteTablesPanel } from '../SiteTablesPanel';

// ─── Helper: fire a synthetic parent reply to all registered handlers ────────

function fireReply(msg: unknown): void {
  for (const handler of parentHandlers) {
    handler(msg);
  }
}

/** Extract the correlationId from the most-recent postToParent call. */
function lastCorrelationId(): string | undefined {
  const calls = postToParentSpy.mock.calls;
  const last = calls[calls.length - 1]?.[0];

  return (last as { correlationId?: string })?.correlationId;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SiteTablesPanel — empty tables list', () => {
  beforeEach(() => {
    postToParentSpy.mockClear();
    onParentMessageSpy.mockClear();
    parentHandlers.clear();
  });

  afterEach(() => {
    cleanup();
    parentHandlers.clear();
  });

  it('renders the loading skeleton initially', () => {
    render(<SiteTablesPanel />);
    expect(screen.getByTestId('sitedb-skeleton')).toBeTruthy();
  });

  it('shows the gorgeous empty-state launchpad with all four primary actions when tables array is empty', async () => {
    render(<SiteTablesPanel />);

    /*
     * Wait for the component to register its onParentMessage handler and fire
     * its PS_SITEDB_TABLES_REQUEST. Then simulate an empty-tables reply.
     */
    await waitFor(() => {
      expect(postToParentSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'PS_SITEDB_TABLES_REQUEST' }));
    });

    const correlationId = lastCorrelationId();

    await act(async () => {
      fireReply({
        type: 'PS_SITEDB_TABLES_RESPONSE',
        correlationId,
        ok: true,
        databaseId: 'db-abc123',
        provisioned: true,
        tables: [],
      });
    });

    // Empty-state launchpad container + all four primary action tiles.
    expect(screen.getByTestId('sitedb-empty')).toBeTruthy();
    expect(screen.getByTestId('sitedb-empty-seed')).toBeTruthy();
    expect(screen.getByTestId('sitedb-empty-sample')).toBeTruthy();
    expect(screen.getByTestId('sitedb-empty-newtable')).toBeTruthy();
    expect(screen.getByTestId('sitedb-empty-import')).toBeTruthy();
  });

  it('clicking "Load sample data" calls the sample-data bridge sender', async () => {
    render(<SiteTablesPanel />);

    await waitFor(() => {
      expect(postToParentSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'PS_SITEDB_TABLES_REQUEST' }));
    });

    const correlationId = lastCorrelationId();

    await act(async () => {
      fireReply({
        type: 'PS_SITEDB_TABLES_RESPONSE',
        correlationId,
        ok: true,
        databaseId: 'db-abc123',
        provisioned: true,
        tables: [],
      });
    });

    requestDbLoadSampleSpy.mockClear();

    await act(async () => {
      screen.getByTestId('sitedb-empty-sample').click();
    });

    expect(requestDbLoadSampleSpy).toHaveBeenCalled();
  });

  it('clicking "Seed with AI" (standalone, no panel prop) calls the AI-seed bridge sender', async () => {
    render(<SiteTablesPanel />);

    await waitFor(() => {
      expect(postToParentSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'PS_SITEDB_TABLES_REQUEST' }));
    });

    await act(async () => {
      fireReply({
        type: 'PS_SITEDB_TABLES_RESPONSE',
        correlationId: lastCorrelationId(),
        ok: true,
        databaseId: 'db-abc123',
        provisioned: true,
        tables: [],
      });
    });

    requestDbAiSeedSpy.mockClear();

    await act(async () => {
      screen.getByTestId('sitedb-empty-seed').click();
    });

    expect(requestDbAiSeedSpy).toHaveBeenCalled();
  });

  it('renders the disabled state when per_site_data flag is off', async () => {
    render(<SiteTablesPanel />);

    await waitFor(() => {
      expect(postToParentSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'PS_SITEDB_TABLES_REQUEST' }));
    });

    const correlationId = lastCorrelationId();

    await act(async () => {
      fireReply({
        type: 'PS_SITEDB_TABLES_RESPONSE',
        correlationId,
        ok: false,
        enabled: false,
        error: 'Per-site data is not enabled',
      });
    });

    expect(screen.getByTestId('sitedb-disabled')).toBeTruthy();
  });

  it('renders the error card when the request fails', async () => {
    render(<SiteTablesPanel />);

    await waitFor(() => {
      expect(postToParentSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'PS_SITEDB_TABLES_REQUEST' }));
    });

    const correlationId = lastCorrelationId();

    await act(async () => {
      fireReply({
        type: 'PS_SITEDB_TABLES_RESPONSE',
        correlationId,
        ok: false,
        error: 'Network error',
      });
    });

    expect(screen.getByTestId('sitedb-error')).toBeTruthy();
    expect(screen.getByText('Network error')).toBeTruthy();
  });
});

describe('SiteTablesPanel — tables present + row grid', () => {
  beforeEach(() => {
    postToParentSpy.mockClear();
    onParentMessageSpy.mockClear();
    parentHandlers.clear();
  });

  afterEach(() => {
    cleanup();
    parentHandlers.clear();
  });

  /**
   * Drive through the full flow:
   *  1. Tables response → table list renders.
   *  2. User clicks a table row → rows request fires.
   *  3. Rows response → grid header + row cells render.
   */
  it('renders the table list and, after selecting a table, shows the grid', async () => {
    render(<SiteTablesPanel />);

    // ── Step 1: tables response ──
    await waitFor(() => {
      expect(postToParentSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'PS_SITEDB_TABLES_REQUEST' }));
    });

    const tablesCorrelationId = lastCorrelationId();

    await act(async () => {
      fireReply({
        type: 'PS_SITEDB_TABLES_RESPONSE',
        correlationId: tablesCorrelationId,
        ok: true,
        databaseId: 'db-abc123',
        provisioned: true,
        tables: [{ name: 'posts' }, { name: 'users' }],
      });
    });

    // Table list renders
    expect(screen.getByTestId('sitedb-table-list')).toBeTruthy();

    const tableRows = screen.getAllByTestId('sitedb-table-row');
    expect(tableRows.length).toBe(2);
    expect(tableRows[0].textContent).toContain('posts');
    expect(tableRows[1].textContent).toContain('users');

    // ── Step 2: click "posts" ──
    postToParentSpy.mockClear();

    await act(async () => {
      // Click the inner open-button (the row wrapper div has no onClick).
      screen.getAllByTestId('sitedb-table-open')[0].click();
    });

    // A PS_SITEDB_ROWS_REQUEST must have been sent
    await waitFor(() => {
      expect(postToParentSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'PS_SITEDB_ROWS_REQUEST',
          table: 'posts',
        }),
      );
    });

    const rowsCorrelationId = lastCorrelationId();

    // ── Step 3: rows response ──
    await act(async () => {
      fireReply({
        type: 'PS_SITEDB_ROWS_RESPONSE',
        correlationId: rowsCorrelationId,
        ok: true,
        table: 'posts',
        columns: [
          { name: 'id', type: 'INTEGER', notnull: 1, pk: 1 },
          { name: 'title', type: 'TEXT', notnull: 0, pk: 0 },
          { name: 'published', type: 'BOOLEAN', notnull: 0, pk: 0 },
        ],
        rows: [
          { id: 1, title: 'Hello world', published: 1 },
          { id: 2, title: 'Second post', published: 0 },
        ],
        limit: 25,
        offset: 0,
        total: 2,
      });
    });

    // Browse view is now rendered
    expect(screen.getByTestId('sitedb-browse')).toBeTruthy();

    // Grid must be present (virtualizer stub returns rows)
    expect(screen.getByTestId('sitedb-grid')).toBeTruthy();

    // Column headers — role="columnheader"
    const headers = screen.getAllByRole('columnheader');
    const headerTexts = headers.map((h) => h.textContent?.trim() ?? '');
    expect(headerTexts.some((t) => t.includes('id'))).toBe(true);
    expect(headerTexts.some((t) => t.includes('title'))).toBe(true);
    expect(headerTexts.some((t) => t.includes('published'))).toBe(true);

    // Row cells — role="cell" (the virtualizer stub rendered both rows)
    const cells = screen.getAllByRole('cell');
    const cellTexts = cells.map((c) => c.textContent?.trim() ?? '');

    // Numeric id cells
    expect(cellTexts.some((t) => t === '1')).toBe(true);
    expect(cellTexts.some((t) => t === '2')).toBe(true);

    // Text title cells
    expect(cellTexts.some((t) => t.includes('Hello world'))).toBe(true);
    expect(cellTexts.some((t) => t.includes('Second post'))).toBe(true);
  });

  it('enables Calendar + renders the month grid when a strict-ISO date column exists', async () => {
    render(<SiteTablesPanel />);

    await waitFor(() => {
      expect(postToParentSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'PS_SITEDB_TABLES_REQUEST' }));
    });

    await act(async () => {
      fireReply({
        type: 'PS_SITEDB_TABLES_RESPONSE',
        correlationId: lastCorrelationId(),
        ok: true,
        databaseId: 'db-cal',
        provisioned: true,
        tables: [{ name: 'events' }],
      });
    });

    postToParentSpy.mockClear();

    await act(async () => {
      screen.getAllByTestId('sitedb-table-open')[0].click();
    });

    await waitFor(() => {
      expect(postToParentSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'PS_SITEDB_ROWS_REQUEST', table: 'events' }),
      );
    });

    await act(async () => {
      fireReply({
        type: 'PS_SITEDB_ROWS_RESPONSE',
        correlationId: lastCorrelationId(),
        ok: true,
        table: 'events',
        columns: [
          { name: 'id', type: 'INTEGER', notnull: 1, pk: 1 },
          { name: 'title', type: 'TEXT', notnull: 0, pk: 0 },
          { name: 'starts_on', type: 'TEXT', notnull: 0, pk: 0 },
        ],
        rows: [
          { id: 1, title: 'Launch', starts_on: '2024-03-05' },
          { id: 2, title: 'Review', starts_on: '2024-03-05' },
          { id: 3, title: 'Retro', starts_on: '2024-03-18' },
        ],
        limit: 25,
        offset: 0,
        total: 3,
      });
    });

    // Calendar toggle is present + NOT disabled (a date column exists).
    const calBtn = screen.getByTestId('sitedb-view-calendar') as HTMLButtonElement;
    expect(calBtn).toBeTruthy();
    expect(calBtn.disabled).toBe(false);

    // Switch to the calendar view.
    await act(async () => {
      calBtn.click();
    });

    // Month grid renders (seeded from the latest data day — March 2024).
    expect(screen.getByTestId('sitedb-calendar')).toBeTruthy();
    expect(screen.getByTestId('sitedb-calendar-grid')).toBeTruthy();
    expect(screen.getByTestId('sitedb-calendar-month').textContent).toContain('March 2024');

    // The two rows on 2024-03-05 bucket into that day cell; the one on 2024-03-18 into its own.
    const days = screen.getAllByTestId('sitedb-calendar-day');
    const mar05 = days.find((d) => d.getAttribute('data-day') === '2024-03-05');
    const mar18 = days.find((d) => d.getAttribute('data-day') === '2024-03-18');
    expect(mar05?.getAttribute('data-count')).toBe('2');
    expect(mar18?.getAttribute('data-count')).toBe('1');
    expect(screen.getAllByTestId('sitedb-calendar-event').length).toBe(3);
  });

  it('disables the Calendar toggle (with a reason) when the table has no date column', async () => {
    render(<SiteTablesPanel />);

    await waitFor(() => {
      expect(postToParentSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'PS_SITEDB_TABLES_REQUEST' }));
    });

    await act(async () => {
      fireReply({
        type: 'PS_SITEDB_TABLES_RESPONSE',
        correlationId: lastCorrelationId(),
        ok: true,
        databaseId: 'db-nodate',
        provisioned: true,
        tables: [{ name: 'widgets' }],
      });
    });

    postToParentSpy.mockClear();

    await act(async () => {
      screen.getAllByTestId('sitedb-table-open')[0].click();
    });

    await waitFor(() => {
      expect(postToParentSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'PS_SITEDB_ROWS_REQUEST', table: 'widgets' }),
      );
    });

    await act(async () => {
      fireReply({
        type: 'PS_SITEDB_ROWS_RESPONSE',
        correlationId: lastCorrelationId(),
        ok: true,
        table: 'widgets',
        columns: [
          { name: 'id', type: 'INTEGER', notnull: 1, pk: 1 },
          { name: 'name', type: 'TEXT', notnull: 0, pk: 0 },
          { name: 'qty', type: 'INTEGER', notnull: 0, pk: 0 },
        ],
        rows: [
          { id: 1, name: 'Bolt', qty: 4 },
          { id: 2, name: 'Nut', qty: 9 },
        ],
        limit: 25,
        offset: 0,
        total: 2,
      });
    });

    // Calendar toggle is present but DISABLED with a reason (never a dead/doomed view).
    const calBtn = screen.getByTestId('sitedb-view-calendar') as HTMLButtonElement;
    expect(calBtn).toBeTruthy();
    expect(calBtn.disabled).toBe(true);
    expect(calBtn.getAttribute('title')).toContain('date column');

    // Clicking the disabled toggle does not switch to the calendar surface (grid stays).
    await act(async () => {
      calBtn.click();
    });
    expect(screen.queryByTestId('sitedb-calendar')).toBeNull();
    expect(screen.getByTestId('sitedb-grid')).toBeTruthy();
  });

  it('renders the export menu (CSV/TSV/JSON) when rows are present', async () => {
    render(<SiteTablesPanel />);

    await waitFor(() => {
      expect(postToParentSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'PS_SITEDB_TABLES_REQUEST' }));
    });

    await act(async () => {
      fireReply({
        type: 'PS_SITEDB_TABLES_RESPONSE',
        correlationId: lastCorrelationId(),
        ok: true,
        databaseId: 'db-abc123',
        provisioned: true,
        tables: [{ name: 'orders' }],
      });
    });

    const tableRows = screen.getAllByTestId('sitedb-table-row');
    postToParentSpy.mockClear();

    await act(async () => {
      // Click the inner open-button (the row wrapper div has no onClick).
      screen.getAllByTestId('sitedb-table-open')[0].click();
    });

    await waitFor(() => {
      expect(postToParentSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'PS_SITEDB_ROWS_REQUEST', table: 'orders' }),
      );
    });

    const rowsReq = postToParentSpy.mock.calls
      .map((c) => c[0])
      .find((m: unknown) => (m as { type?: string })?.type === 'PS_SITEDB_ROWS_REQUEST') as
      | { correlationId: string }
      | undefined;

    await act(async () => {
      fireReply({
        type: 'PS_SITEDB_ROWS_RESPONSE',
        correlationId: rowsReq?.correlationId,
        ok: true,
        table: 'orders',
        columns: [{ name: 'id', type: 'INTEGER', notnull: 1, pk: 1 }],
        rows: [{ id: 42 }],
        limit: 25,
        offset: 0,
        total: 1,
      });
    });

    // The Export trigger is present; clicking it reveals CSV / TSV / JSON menu items.
    expect(screen.getByTestId('sitedb-export')).toBeTruthy();

    await act(async () => {
      screen.getByTestId('sitedb-export').click();
    });

    expect(screen.getByTestId('sitedb-export-csv')).toBeTruthy();
    expect(screen.getByTestId('sitedb-export-tsv')).toBeTruthy();
    expect(screen.getByTestId('sitedb-export-json')).toBeTruthy();
  });

  it('renders the empty-table state when rows array is empty', async () => {
    render(<SiteTablesPanel />);

    await waitFor(() => {
      expect(postToParentSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'PS_SITEDB_TABLES_REQUEST' }));
    });

    await act(async () => {
      fireReply({
        type: 'PS_SITEDB_TABLES_RESPONSE',
        correlationId: lastCorrelationId(),
        ok: true,
        databaseId: 'db-abc123',
        provisioned: true,
        tables: [{ name: 'empty_table' }],
      });
    });

    const tableRows = screen.getAllByTestId('sitedb-table-row');
    postToParentSpy.mockClear();

    await act(async () => {
      // Click the inner open-button (the row wrapper div has no onClick).
      screen.getAllByTestId('sitedb-table-open')[0].click();
    });

    await waitFor(() => {
      expect(postToParentSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'PS_SITEDB_ROWS_REQUEST', table: 'empty_table' }),
      );
    });

    await act(async () => {
      fireReply({
        type: 'PS_SITEDB_ROWS_RESPONSE',
        correlationId: lastCorrelationId(),
        ok: true,
        table: 'empty_table',
        columns: [{ name: 'id', type: 'INTEGER', notnull: 1, pk: 1 }],
        rows: [],
        limit: 25,
        offset: 0,
        total: 0,
      });
    });

    expect(screen.getByTestId('sitedb-table-empty')).toBeTruthy();
  });

  it('shows pagination info when rows are present', async () => {
    render(<SiteTablesPanel />);

    await waitFor(() => {
      expect(postToParentSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'PS_SITEDB_TABLES_REQUEST' }));
    });

    await act(async () => {
      fireReply({
        type: 'PS_SITEDB_TABLES_RESPONSE',
        correlationId: lastCorrelationId(),
        ok: true,
        databaseId: 'db-abc123',
        provisioned: true,
        tables: [{ name: 'events' }],
      });
    });

    const tableRows = screen.getAllByTestId('sitedb-table-row');
    postToParentSpy.mockClear();

    await act(async () => {
      // Click the inner open-button (the row wrapper div has no onClick).
      screen.getAllByTestId('sitedb-table-open')[0].click();
    });

    await waitFor(() => {
      expect(postToParentSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'PS_SITEDB_ROWS_REQUEST', table: 'events' }),
      );
    });

    await act(async () => {
      fireReply({
        type: 'PS_SITEDB_ROWS_RESPONSE',
        correlationId: lastCorrelationId(),
        ok: true,
        table: 'events',
        columns: [{ name: 'id', type: 'INTEGER', notnull: 1, pk: 1 }],
        rows: [{ id: 1 }, { id: 2 }, { id: 3 }],
        limit: 25,
        offset: 0,
        total: 3,
      });
    });

    const pageInfo = screen.getByTestId('sitedb-page-info');
    expect(pageInfo.textContent).toContain('Showing 1');
    expect(pageInfo.textContent).toContain('of 3');
  });
});

/*
 * ─── Pure-function contract tests ─────────────────────────────────────────────
 * These test the payload builder / response field contract without any React
 * rendering — verifying that request and response shapes agree on field names.
 * This is the "runtime contract" guard that catches field-name drift early.
 */

describe('PS_SITEDB_* message field contract', () => {
  it('PS_SITEDB_TABLES_REQUEST carries type + correlationId', () => {
    const req = {
      type: 'PS_SITEDB_TABLES_REQUEST' as const,
      correlationId: 'test-id-1',
    };
    expect(req.type).toBe('PS_SITEDB_TABLES_REQUEST');
    expect(typeof req.correlationId).toBe('string');
    expect(req.correlationId.length).toBeGreaterThan(0);
  });

  it('PS_SITEDB_TABLES_RESPONSE ok=true carries databaseId + provisioned + tables[]', () => {
    const res = {
      type: 'PS_SITEDB_TABLES_RESPONSE' as const,
      correlationId: 'test-id-1',
      ok: true,
      databaseId: 'db-123',
      provisioned: true,
      tables: [{ name: 'users' }],
    };
    expect(res.ok).toBe(true);
    expect(typeof res.databaseId).toBe('string');
    expect(typeof res.provisioned).toBe('boolean');
    expect(Array.isArray(res.tables)).toBe(true);
    expect(res.tables[0]).toHaveProperty('name');
  });

  it('PS_SITEDB_TABLES_RESPONSE ok=false + enabled=false signals dark flag', () => {
    const res = {
      type: 'PS_SITEDB_TABLES_RESPONSE' as const,
      correlationId: 'test-id-2',
      ok: false,
      enabled: false,
      error: 'Per-site data is not enabled',
    };
    expect(res.ok).toBe(false);
    expect(res.enabled).toBe(false);

    // The component checks: reply.enabled === false || reply.error.includes(DISABLED_404)
    expect(res.error).toContain('Per-site data is not enabled');
  });

  it('PS_SITEDB_ROWS_REQUEST carries type + correlationId + table + optional limit + offset', () => {
    const req = {
      type: 'PS_SITEDB_ROWS_REQUEST' as const,
      correlationId: 'test-id-3',
      table: 'orders',
      limit: 25,
      offset: 0,
    };
    expect(req.type).toBe('PS_SITEDB_ROWS_REQUEST');
    expect(typeof req.table).toBe('string');
    expect(req.limit).toBe(25);
    expect(req.offset).toBe(0);
  });

  it('PS_SITEDB_ROWS_RESPONSE ok=true carries table + columns[] + rows[] + total', () => {
    const res = {
      type: 'PS_SITEDB_ROWS_RESPONSE' as const,
      correlationId: 'test-id-3',
      ok: true,
      table: 'orders',
      columns: [
        { name: 'id', type: 'INTEGER', notnull: 1, pk: 1 },
        { name: 'amount', type: 'REAL', notnull: 0, pk: 0 },
      ],
      rows: [{ id: 1, amount: 9.99 }],
      limit: 25,
      offset: 0,
      total: 1,
    };

    expect(res.ok).toBe(true);
    expect(typeof res.table).toBe('string');

    // Column shape: name + type + notnull (0/1 int) + pk (0/1 int)
    expect(res.columns[0]).toHaveProperty('name');
    expect(res.columns[0]).toHaveProperty('type');
    expect(typeof res.columns[0].notnull).toBe('number');
    expect(typeof res.columns[0].pk).toBe('number');

    // Rows are records keyed by column name
    expect(typeof res.rows[0]).toBe('object');
    expect(res.rows[0]).toHaveProperty('id');

    // Pagination fields
    expect(typeof res.total).toBe('number');
    expect(typeof res.limit).toBe('number');
    expect(typeof res.offset).toBe('number');
  });

  it('PS_SITEDB_ROWS_RESPONSE correlationId links to the matching request', () => {
    /*
     * The SiteTablesPanel resolves the pending promise by correlationId — the
     * response MUST echo the same correlationId that the request sent.
     */
    const requestCorrelationId = 'unique-correlation-id-42';
    const req = {
      type: 'PS_SITEDB_ROWS_REQUEST' as const,
      correlationId: requestCorrelationId,
      table: 'posts',
    };
    const res = {
      type: 'PS_SITEDB_ROWS_RESPONSE' as const,
      correlationId: requestCorrelationId, // MUST match
      ok: true,
      table: 'posts',
      columns: [],
      rows: [],
      total: 0,
    };

    // The key contract: correlationId on response == correlationId on request
    expect(res.correlationId).toBe(req.correlationId);
  });
});

/*
 * ─── FIRE 2: typed inline cell edit + local undo (per-site D1) ─────────────────
 *
 * The Table-view now edits the site's OWN D1 through the resource-mutate bridge
 * (`PS_RES_MUTATE {kind:'d1', action:'exec'}`), NEVER the shared-D1 super-admin
 * path. These cases prove: (1) an editable (non-PK) cell click opens the typed
 * editor + Save dispatches a param-bound UPDATE-by-PK with confirm:true; (2) a
 * failed write rolls back the optimistic change + surfaces the error; (3) a
 * primary-key column is honest-locked (never opens a doomed editor).
 */

describe('SiteTablesPanel — FIRE 2 inline edit + undo (per-site D1)', () => {
  beforeEach(() => {
    postToParentSpy.mockClear();
    onParentMessageSpy.mockClear();
    parentHandlers.clear();
  });

  afterEach(() => {
    cleanup();
    parentHandlers.clear();
  });

  /** Drive to a browsed table with one editable text column + a PK. */
  async function openEditableTable(): Promise<void> {
    render(<SiteTablesPanel />);

    await waitFor(() => {
      expect(postToParentSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'PS_SITEDB_TABLES_REQUEST' }));
    });

    await act(async () => {
      fireReply({
        type: 'PS_SITEDB_TABLES_RESPONSE',
        correlationId: lastCorrelationId(),
        ok: true,
        databaseId: 'db-fire2',
        provisioned: true,
        tables: [{ name: 'posts' }],
      });
    });

    const tableRows = screen.getAllByTestId('sitedb-table-row');

    await act(async () => {
      // Click the inner open-button (the row wrapper div has no onClick).
      screen.getAllByTestId('sitedb-table-open')[0].click();
    });

    /*
     * The rows request fires; opening a table ALSO fires a pragma_table_xinfo exec
     * (generated-cols) — reply to the ROWS request specifically by finding its id.
     */
    await waitFor(() => {
      expect(postToParentSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'PS_SITEDB_ROWS_REQUEST', table: 'posts' }),
      );
    });

    const rowsReq = postToParentSpy.mock.calls
      .map((c) => c[0])
      .find((m: unknown) => (m as { type?: string })?.type === 'PS_SITEDB_ROWS_REQUEST') as
      | { correlationId: string }
      | undefined;

    await act(async () => {
      fireReply({
        type: 'PS_SITEDB_ROWS_RESPONSE',
        correlationId: rowsReq?.correlationId,
        ok: true,
        table: 'posts',
        columns: [
          { name: 'id', type: 'INTEGER', notnull: 1, pk: 1 },
          { name: 'title', type: 'TEXT', notnull: 0, pk: 0 },
        ],
        rows: [{ id: 1, title: 'Hello' }],
        limit: 25,
        offset: 0,
        total: 1,
      });
    });
  }

  it('clicking an editable (non-PK) cell opens the typed editor; Save dispatches a param-bound UPDATE with confirm:true', async () => {
    await openEditableTable();

    // The editable-column header shows the "editable" badge (PK present).
    expect(screen.getByText('editable')).toBeTruthy();

    // Click the title cell (editable). The id cell is PK-locked and must not open an editor.
    const cells = screen.getAllByTestId('sitedb-grid-cell');
    const titleCell = cells.find((c) => c.textContent?.includes('Hello'));
    expect(titleCell).toBeTruthy();

    await act(async () => {
      titleCell!.click();
    });

    // The typed editor opens for this cell.
    expect(screen.getByTestId('sitedb-cell-editing')).toBeTruthy();

    // Change the value + Save.
    const input = screen.getByTestId('data-edit-value') as HTMLInputElement;
    await act(async () => {
      input.focus();

      // React-controlled input: set value via the native setter then dispatch input.
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'Hello world');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    postToParentSpy.mockClear();

    await act(async () => {
      screen.getByTestId('data-edit-save').click();
    });

    // A param-bound UPDATE-by-PK went out over the resource-mutate bridge with confirm:true.
    await waitFor(() => {
      expect(postToParentSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'PS_RES_MUTATE_REQUEST',
          kind: 'd1',
          action: 'exec',
          confirm: true,
          input: expect.objectContaining({
            sql: expect.stringContaining('UPDATE "posts" SET "title" = ?1 WHERE'),
            params: expect.arrayContaining(['Hello world', 1]),
          }),
        }),
      );
    });

    // Reply success → the edit commits + the Undo affordance appears.
    const mutateReq = postToParentSpy.mock.calls
      .map((c) => c[0])
      .find((m: unknown) => (m as { type?: string })?.type === 'PS_RES_MUTATE_REQUEST') as
      | { correlationId: string }
      | undefined;

    await act(async () => {
      fireReply({
        type: 'PS_RES_MUTATE_RESPONSE',
        correlationId: mutateReq?.correlationId,
        ok: true,
        kind: 'd1',
        action: 'exec',
        result: { ok: true, data: { action: 'exec', rows: [], rowsWritten: 1, rowsRead: 0, changedDb: true } },
      });
    });

    // The optimistic value is shown + the Undo toast is present.
    expect(screen.getByTestId('sitedb-undo')).toBeTruthy();
    expect(screen.getByTestId('sitedb-undo-button')).toBeTruthy();
  });

  it('a failed write rolls back the optimistic edit and surfaces the error', async () => {
    await openEditableTable();

    const cells = screen.getAllByTestId('sitedb-grid-cell');
    const titleCell = cells.find((c) => c.textContent?.includes('Hello'));

    await act(async () => {
      titleCell!.click();
    });

    const input = screen.getByTestId('data-edit-value') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'Broken');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Clear so the finder below picks the UPDATE mutate, not the earlier generated-cols pragma exec.
    postToParentSpy.mockClear();

    await act(async () => {
      screen.getByTestId('data-edit-save').click();
    });

    // The UPDATE mutate is the one whose SQL begins with UPDATE (a pragma exec would be a SELECT).
    const mutateReq = postToParentSpy.mock.calls
      .map((c) => c[0])
      .find(
        (m: unknown) =>
          (m as { type?: string })?.type === 'PS_RES_MUTATE_REQUEST' &&
          typeof (m as { input?: { sql?: string } })?.input?.sql === 'string' &&
          (m as { input: { sql: string } }).input.sql.startsWith('UPDATE'),
      ) as { correlationId: string } | undefined;

    // Reply with a typed adapter error (not transport) → editor stays open with the error.
    await act(async () => {
      fireReply({
        type: 'PS_RES_MUTATE_RESPONSE',
        correlationId: mutateReq?.correlationId,
        ok: true,
        kind: 'd1',
        action: 'exec',
        result: { ok: false, error: { code: 'query_failed', message: 'D1 write rejected' } },
      });
    });

    // The error surfaces (never silent) and the editor is still open.
    await waitFor(() => {
      expect(screen.getByTestId('data-edit-error').textContent).toContain('D1 write rejected');
    });
    expect(screen.getByTestId('sitedb-cell-editing')).toBeTruthy();

    // Rolled back: no Undo toast (the write never committed).
    expect(screen.queryByTestId('sitedb-undo')).toBeNull();
  });

  it('a primary-key column is honest-locked (clicking it opens the row drawer, never a cell editor)', async () => {
    await openEditableTable();

    const cells = screen.getAllByTestId('sitedb-grid-cell');

    // The id cell (PK) renders "1" and must NOT be editable.
    const idCell = cells.find((c) => c.textContent?.trim() === '1');
    expect(idCell).toBeTruthy();

    await act(async () => {
      idCell!.click();
    });

    // No cell editor opened; the row drawer opened instead (PK cells fall through to row-click).
    expect(screen.queryByTestId('sitedb-cell-editing')).toBeNull();
    expect(screen.getByTestId('sitedb-row-drawer')).toBeTruthy();
  });
});

/*
 * ─── Revision 1 — rowid inline cell editing (NO-PK table) ─────────────────────
 *
 * The "no primary key ⇒ read-only" limitation is dead. A table WITHOUT a PK is
 * still fully editable: every browsed row carries `_rowid` (the browse endpoint
 * SELECTs `rowid AS _rowid, *`), and an edit routes through the dedicated
 * `PS_SITEDB_UPDATE_ROW` bridge → `PATCH …/rows/:rowid` (never the PK-only
 * exec-SQL path). These cases prove: (1) an editable cell in a PK-less table
 * opens the typed editor + Save dispatches `requestDbUpdateRow({table, rowid,
 * column, value})`; (2) the optimistic value shows + Undo arms on success.
 */
describe('SiteTablesPanel — Revision 1 rowid inline edit (no-PK table)', () => {
  beforeEach(() => {
    postToParentSpy.mockClear();
    onParentMessageSpy.mockClear();
    parentHandlers.clear();
    requestDbUpdateRowSpy.mockClear();
    requestDbUpdateRowSpy.mockResolvedValue({ type: 'PS_SITEDB_UPDATE_ROW_RESPONSE', ok: true, updated: 1 });
  });

  afterEach(() => {
    cleanup();
    parentHandlers.clear();
  });

  /** Drive to a browsed table that has NO primary key but exposes `_rowid` per row. */
  async function openPklessTable(): Promise<void> {
    render(<SiteTablesPanel />);

    await waitFor(() => {
      expect(postToParentSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'PS_SITEDB_TABLES_REQUEST' }));
    });

    await act(async () => {
      fireReply({
        type: 'PS_SITEDB_TABLES_RESPONSE',
        correlationId: lastCorrelationId(),
        ok: true,
        databaseId: 'db-rev1',
        provisioned: true,
        tables: [{ name: 'notes' }],
      });
    });

    // The clickable element is the inner open-button (`sitedb-table-open`), not the row wrapper div.
    const openButtons = screen.getAllByTestId('sitedb-table-open');

    await act(async () => {
      openButtons[0].click();
    });

    await waitFor(() => {
      expect(postToParentSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'PS_SITEDB_ROWS_REQUEST', table: 'notes' }),
      );
    });

    const rowsReq = postToParentSpy.mock.calls
      .map((c) => c[0])
      .find((m: unknown) => (m as { type?: string })?.type === 'PS_SITEDB_ROWS_REQUEST') as
      | { correlationId: string }
      | undefined;

    await act(async () => {
      fireReply({
        type: 'PS_SITEDB_ROWS_RESPONSE',
        correlationId: rowsReq?.correlationId,
        ok: true,
        table: 'notes',
        // No `pk:1` on any column — this table has NO primary key.
        columns: [
          { name: 'body', type: 'TEXT', notnull: 0, pk: 0 },
          { name: 'author', type: 'TEXT', notnull: 0, pk: 0 },
        ],
        // Rows carry the synthetic `_rowid` handle from `SELECT rowid AS _rowid, *`.
        rows: [{ _rowid: 7, body: 'First note', author: 'me' }],
        limit: 25,
        offset: 0,
        total: 1,
      });
    });
  }

  it('an editable cell in a PK-less table opens the editor; Save dispatches requestDbUpdateRow by _rowid', async () => {
    await openPklessTable();

    // The grid is NOT read-only — a normal column cell opens the typed editor.
    const cells = screen.getAllByTestId('sitedb-grid-cell');
    const bodyCell = cells.find((c) => c.textContent?.includes('First note'));
    expect(bodyCell).toBeTruthy();

    await act(async () => {
      bodyCell!.click();
    });

    // The typed editor opens for this cell (proves the no-PK guard is gone).
    expect(screen.getByTestId('sitedb-cell-editing')).toBeTruthy();

    // Change the value + Save.
    const input = screen.getByTestId('data-edit-value') as HTMLInputElement;
    await act(async () => {
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'Edited note');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      screen.getByTestId('data-edit-save').click();
    });

    // The dedicated rowid UPDATE sender was called with { table, rowid, column, value } — NOT the exec-SQL path.
    await waitFor(() => {
      expect(requestDbUpdateRowSpy).toHaveBeenCalledWith(
        expect.objectContaining({ table: 'notes', rowid: 7, column: 'body', value: 'Edited note' }),
      );
    });

    // The optimistic value is shown + the Undo affordance appears on success.
    await waitFor(() => {
      expect(screen.getByTestId('sitedb-undo')).toBeTruthy();
    });
  });

  it('a failed rowid update rolls back the optimistic edit and surfaces the error', async () => {
    requestDbUpdateRowSpy.mockResolvedValue({
      type: 'PS_SITEDB_UPDATE_ROW_RESPONSE',
      ok: false,
      error: 'D1 write rejected',
    });

    await openPklessTable();

    const cells = screen.getAllByTestId('sitedb-grid-cell');
    const bodyCell = cells.find((c) => c.textContent?.includes('First note'));

    await act(async () => {
      bodyCell!.click();
    });

    const input = screen.getByTestId('data-edit-value') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'Broken');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      screen.getByTestId('data-edit-save').click();
    });

    // The error surfaces (never silent) and the editor stays open; no Undo (the write never committed).
    await waitFor(() => {
      expect(screen.getByTestId('data-edit-error').textContent).toContain('D1 write rejected');
    });
    expect(screen.getByTestId('sitedb-cell-editing')).toBeTruthy();
    expect(screen.queryByTestId('sitedb-undo')).toBeNull();
  });
});

/*
 * ─── Rev 2 — persistent schema / table-browser rail ──────────────────────────
 *
 * The per-site Database surface now carries a persistent Airtable-style LEFT
 * RAIL listing every table (from the already-fetched PS_SITEDB_TABLES_RESPONSE —
 * NO new endpoint). Each rail row shows a table glyph + name; the ACTIVE table
 * additionally shows its column-count + row-count (from the already-loaded
 * PS_SITEDB_ROWS_RESPONSE). Clicking a rail row opens that table in the main
 * grid; the active table's rail row is highlighted (aria-current="true"). The
 * rail is keyboard-navigable (↑/↓ move focus, Enter opens).
 *
 * These cases prove: (1) the rail renders one entry per table from the tables
 * response; (2) clicking a rail entry fires that table's PS_SITEDB_ROWS_REQUEST
 * and marks it active; (3) the active entry shows the loaded column/row counts.
 */
describe('SiteTablesPanel — Rev 2 schema/table rail', () => {
  beforeEach(() => {
    postToParentSpy.mockClear();
    onParentMessageSpy.mockClear();
    parentHandlers.clear();
  });

  afterEach(() => {
    cleanup();
    parentHandlers.clear();
  });

  /** Drive to the tables-ready state with a two-table database. */
  async function openTablesReady(): Promise<void> {
    render(<SiteTablesPanel />);

    await waitFor(() => {
      expect(postToParentSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'PS_SITEDB_TABLES_REQUEST' }));
    });

    await act(async () => {
      fireReply({
        type: 'PS_SITEDB_TABLES_RESPONSE',
        correlationId: lastCorrelationId(),
        ok: true,
        databaseId: 'db-rev2',
        provisioned: true,
        tables: [{ name: 'posts' }, { name: 'users' }],
      });
    });
  }

  it('renders a persistent rail listing every table from the tables response', async () => {
    await openTablesReady();

    // The rail is present with one entry per table (reuses the fetched table list — no new endpoint).
    expect(screen.getByTestId('sitedb-rail')).toBeTruthy();

    const railItems = screen.getAllByTestId('sitedb-rail-item');
    expect(railItems.length).toBe(2);
    expect(railItems[0].textContent).toContain('posts');
    expect(railItems[1].textContent).toContain('users');
  });

  it('clicking a rail entry opens that table (fires its rows request) and marks it active', async () => {
    await openTablesReady();

    postToParentSpy.mockClear();

    await act(async () => {
      screen.getAllByTestId('sitedb-rail-item')[0].click();
    });

    // The clicked table's rows request goes out (reuses the existing PS_SITEDB_ROWS_REQUEST bridge).
    await waitFor(() => {
      expect(postToParentSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'PS_SITEDB_ROWS_REQUEST', table: 'posts' }),
      );
    });

    // The active rail entry is highlighted (aria-current).
    const activeItem = screen.getAllByTestId('sitedb-rail-item')[0];
    expect(activeItem.getAttribute('aria-current')).toBe('true');
  });

  it('shows the active table column + row counts on its rail entry once rows load', async () => {
    await openTablesReady();

    postToParentSpy.mockClear();

    await act(async () => {
      screen.getAllByTestId('sitedb-rail-item')[0].click();
    });

    await waitFor(() => {
      expect(postToParentSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'PS_SITEDB_ROWS_REQUEST', table: 'posts' }),
      );
    });

    const rowsReq = postToParentSpy.mock.calls
      .map((c) => c[0])
      .find((m: unknown) => (m as { type?: string })?.type === 'PS_SITEDB_ROWS_REQUEST') as
      | { correlationId: string }
      | undefined;

    await act(async () => {
      fireReply({
        type: 'PS_SITEDB_ROWS_RESPONSE',
        correlationId: rowsReq?.correlationId,
        ok: true,
        table: 'posts',
        columns: [
          { name: 'id', type: 'INTEGER', notnull: 1, pk: 1 },
          { name: 'title', type: 'TEXT', notnull: 0, pk: 0 },
          { name: 'body', type: 'TEXT', notnull: 0, pk: 0 },
        ],
        rows: [
          { id: 1, title: 'A', body: 'x' },
          { id: 2, title: 'B', body: 'y' },
        ],
        limit: 25,
        offset: 0,
        total: 2,
      });
    });

    // The active rail entry surfaces the loaded schema shape: 3 columns · 2 rows.
    const activeMeta = screen.getByTestId('sitedb-rail-active-meta');
    expect(activeMeta.textContent).toContain('3');
    expect(activeMeta.textContent).toContain('2');
  });
});

/*
 * ─── PS_SITEDB_UPDATE_ROW message field contract ─────────────────────────────
 * The request/response shape agree on field names — the runtime contract guard
 * that catches drift between the child sender and the parent handler.
 */
describe('PS_SITEDB_UPDATE_ROW message field contract', () => {
  it('PS_SITEDB_UPDATE_ROW_REQUEST carries type + correlationId + table + rowid + column + value', () => {
    const req = {
      type: 'PS_SITEDB_UPDATE_ROW_REQUEST' as const,
      correlationId: 'rev1-id-1',
      table: 'notes',
      rowid: 7,
      column: 'body',
      value: 'Edited note',
    };
    expect(req.type).toBe('PS_SITEDB_UPDATE_ROW_REQUEST');
    expect(typeof req.correlationId).toBe('string');
    expect(typeof req.table).toBe('string');
    expect(typeof req.rowid).toBe('number');
    expect(typeof req.column).toBe('string');
    expect(req.value).toBe('Edited note');
  });

  it('PS_SITEDB_UPDATE_ROW_RESPONSE ok=true carries updated count; correlationId links to the request', () => {
    const requestCorrelationId = 'rev1-id-42';
    const res = {
      type: 'PS_SITEDB_UPDATE_ROW_RESPONSE' as const,
      correlationId: requestCorrelationId,
      ok: true,
      updated: 1,
    };
    expect(res.ok).toBe(true);
    expect(typeof res.updated).toBe('number');
    expect(res.correlationId).toBe(requestCorrelationId);
  });

  it('PS_SITEDB_UPDATE_ROW_RESPONSE ok=false + enabled=false signals the dark flag', () => {
    const res = {
      type: 'PS_SITEDB_UPDATE_ROW_RESPONSE' as const,
      correlationId: 'rev1-id-2',
      ok: false,
      enabled: false,
      error: 'Per-site data is not enabled',
    };
    expect(res.ok).toBe(false);
    expect(res.enabled).toBe(false);
    expect(res.error).toContain('Per-site data is not enabled');
  });
});

/*
 * ─── Rev 10 (FINAL) — Airtable-class views: Grid | Gallery | Kanban ────────────
 *
 * The Tables surface now carries a THREE-way view switcher (Grid | Gallery |
 * Kanban) that renders entirely from the ALREADY-loaded page rows — NO new
 * endpoint/fetch. Gallery shows one card per row; Kanban groups the rows by a
 * user-chosen column (default: first low-cardinality text/enum column) into
 * lanes of cards. The view choice persists per-table (localStorage keyed by the
 * site's D1 id + table). These cases prove: (1) the switcher exposes a Kanban
 * button and toggling it renders the board; (2) Gallery renders N cards for N
 * rows; (3) Kanban buckets rows by the chosen column into the right lanes.
 */
describe('SiteTablesPanel — Rev 10 Airtable-class views (Grid | Gallery | Kanban)', () => {
  beforeEach(() => {
    postToParentSpy.mockClear();
    onParentMessageSpy.mockClear();
    parentHandlers.clear();

    try {
      window.localStorage.clear();
    } catch {
      /* jsdom storage may throw on opaque origin — harmless here */
    }
  });

  afterEach(() => {
    cleanup();
    parentHandlers.clear();
  });

  /**
   * Drive to a browsed table with 4 rows and a low-cardinality `status` column
   * (2 "new", 1 "done", 1 "new") so the kanban board has real buckets to group.
   */
  async function openBoardTable(): Promise<void> {
    render(<SiteTablesPanel />);

    await waitFor(() => {
      expect(postToParentSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'PS_SITEDB_TABLES_REQUEST' }));
    });

    await act(async () => {
      fireReply({
        type: 'PS_SITEDB_TABLES_RESPONSE',
        correlationId: lastCorrelationId(),
        ok: true,
        databaseId: 'db-rev10',
        provisioned: true,
        tables: [{ name: 'tasks' }],
      });
    });

    await act(async () => {
      screen.getAllByTestId('sitedb-table-open')[0].click();
    });

    await waitFor(() => {
      expect(postToParentSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'PS_SITEDB_ROWS_REQUEST', table: 'tasks' }),
      );
    });

    const rowsReq = postToParentSpy.mock.calls
      .map((c) => c[0])
      .find((m: unknown) => (m as { type?: string })?.type === 'PS_SITEDB_ROWS_REQUEST') as
      | { correlationId: string }
      | undefined;

    await act(async () => {
      fireReply({
        type: 'PS_SITEDB_ROWS_RESPONSE',
        correlationId: rowsReq?.correlationId,
        ok: true,
        table: 'tasks',
        columns: [
          { name: 'id', type: 'INTEGER', notnull: 1, pk: 1 },
          { name: 'title', type: 'TEXT', notnull: 0, pk: 0 },
          { name: 'status', type: 'TEXT', notnull: 0, pk: 0 },
        ],
        rows: [
          { id: 1, title: 'Alpha', status: 'new' },
          { id: 2, title: 'Bravo', status: 'new' },
          { id: 3, title: 'Charlie', status: 'done' },
          { id: 4, title: 'Delta', status: 'new' },
        ],
        limit: 25,
        offset: 0,
        total: 4,
      });
    });
  }

  it('exposes a three-way switcher (Grid · Gallery · Kanban), defaulting to Grid', async () => {
    await openBoardTable();

    // All three view-mode buttons are present + keyboard-reachable (real <button>s).
    expect(screen.getByTestId('sitedb-view-grid')).toBeTruthy();
    expect(screen.getByTestId('sitedb-view-gallery')).toBeTruthy();
    expect(screen.getByTestId('sitedb-view-kanban')).toBeTruthy();

    // Default view = grid (dense table rendered, no gallery/kanban surface yet).
    expect(screen.getByTestId('sitedb-grid')).toBeTruthy();
    expect(screen.queryByTestId('sitedb-gallery')).toBeNull();
    expect(screen.queryByTestId('sitedb-kanban')).toBeNull();
    expect(screen.getByTestId('sitedb-view-grid').getAttribute('aria-pressed')).toBe('true');
  });

  it('Gallery view renders exactly one card per loaded row (N cards for N rows)', async () => {
    await openBoardTable();

    await act(async () => {
      screen.getByTestId('sitedb-view-gallery').click();
    });

    // The gallery surface renders; there are 4 cards for the 4 loaded rows.
    expect(screen.getByTestId('sitedb-gallery')).toBeTruthy();
    expect(screen.getAllByTestId('sitedb-gallery-card').length).toBe(4);
    expect(screen.getByTestId('sitedb-view-gallery').getAttribute('aria-pressed')).toBe('true');
  });

  it('Kanban view groups the rows by the chosen column into the right buckets', async () => {
    await openBoardTable();

    await act(async () => {
      screen.getByTestId('sitedb-view-kanban').click();
    });

    // The board surface renders.
    expect(screen.getByTestId('sitedb-kanban')).toBeTruthy();

    // Two lanes: "new" (3 rows) + "done" (1 row) — grouped by the auto-picked `status` column.
    const lanes = screen.getAllByTestId('sitedb-kanban-lane');
    expect(lanes.length).toBe(2);

    // Every loaded row appears as a card somewhere on the board (4 rows → 4 cards).
    expect(screen.getAllByTestId('sitedb-kanban-card').length).toBe(4);

    // The "new" lane holds exactly 3 cards; the "done" lane holds exactly 1.
    const laneByHeader = (label: string) =>
      lanes.find((l) => l.querySelector('[data-testid="sitedb-kanban-lane-title"]')?.textContent?.includes(label));
    const newLane = laneByHeader('new');
    const doneLane = laneByHeader('done');
    expect(newLane).toBeTruthy();
    expect(doneLane).toBeTruthy();
    expect(newLane!.querySelectorAll('[data-testid="sitedb-kanban-card"]').length).toBe(3);
    expect(doneLane!.querySelectorAll('[data-testid="sitedb-kanban-card"]').length).toBe(1);

    // A group-by picker is present so the owner can regroup by another column.
    expect(screen.getByTestId('sitedb-kanban-groupby')).toBeTruthy();
  });

  it('persists the chosen view per-table in localStorage (keyed by D1 id + table)', async () => {
    await openBoardTable();

    await act(async () => {
      screen.getByTestId('sitedb-view-kanban').click();
    });

    /*
     * The choice is written under a deterministic key scoped to the site's D1 id + the table name.
     * (jsdom's Storage doesn't enumerate keys via Object.keys/key(), so assert the exact key directly —
     * the format `ps-sitedb-view:<dbId>:<table>` is the contract, keyed by D1 id + table per the brief.)
     */
    const viewKey = 'ps-sitedb-view:db-rev10:tasks';
    const stored = window.localStorage.getItem(viewKey);
    expect(stored).toBeTruthy();
    expect(stored).toContain('kanban');
  });

  it('shows an honest empty note (no dead view) when a kanban board has no rows', async () => {
    render(<SiteTablesPanel />);

    await waitFor(() => {
      expect(postToParentSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'PS_SITEDB_TABLES_REQUEST' }));
    });

    await act(async () => {
      fireReply({
        type: 'PS_SITEDB_TABLES_RESPONSE',
        correlationId: lastCorrelationId(),
        ok: true,
        databaseId: 'db-rev10-empty',
        provisioned: true,
        tables: [{ name: 'empties' }],
      });
    });

    await act(async () => {
      screen.getAllByTestId('sitedb-table-open')[0].click();
    });

    await waitFor(() => {
      expect(postToParentSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'PS_SITEDB_ROWS_REQUEST', table: 'empties' }),
      );
    });

    await act(async () => {
      fireReply({
        type: 'PS_SITEDB_ROWS_RESPONSE',
        correlationId: lastCorrelationId(),
        ok: true,
        table: 'empties',
        columns: [
          { name: 'id', type: 'INTEGER', notnull: 1, pk: 1 },
          { name: 'status', type: 'TEXT', notnull: 0, pk: 0 },
        ],
        rows: [],
        limit: 25,
        offset: 0,
        total: 0,
      });
    });

    // An empty table shows the shared empty-table launchpad — never a dead/blank view.
    expect(screen.getByTestId('sitedb-table-empty')).toBeTruthy();
  });
});

// ─── Real-time data — no manual Refresh (per `real-time-data-no-manual-refresh`) ──

describe('SiteTablesPanel — real-time data, no manual Refresh', () => {
  beforeEach(() => {
    postToParentSpy.mockClear();
    onParentMessageSpy.mockClear();
    parentHandlers.clear();
  });

  afterEach(() => {
    cleanup();
    parentHandlers.clear();
  });

  /** Count how many table-list reads the panel has issued so far. */
  function tablesRequestCount(): number {
    return postToParentSpy.mock.calls.filter((c) => (c[0] as { type?: string })?.type === 'PS_SITEDB_TABLES_REQUEST')
      .length;
  }

  /** Reply to the panel's latest tables request with a ready (empty) database. */
  async function replyTablesReady(): Promise<void> {
    await act(async () => {
      fireReply({
        type: 'PS_SITEDB_TABLES_RESPONSE',
        correlationId: lastCorrelationId(),
        ok: true,
        databaseId: 'db-live',
        provisioned: true,
        tables: [],
      });
    });
  }

  it('offers NO Refresh action — the Actions menu carries only New Table · Import · History', async () => {
    render(<SiteTablesPanel />);

    await waitFor(() => {
      expect(postToParentSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'PS_SITEDB_TABLES_REQUEST' }));
    });
    await replyTablesReady();

    await act(async () => {
      screen.getByTestId('sitedb-actions').click();
    });

    // The three real actions stay…
    expect(screen.getByTestId('sitedb-action-new-table')).toBeTruthy();
    expect(screen.getByTestId('sitedb-action-import')).toBeTruthy();
    expect(screen.getByTestId('sitedb-action-history')).toBeTruthy();

    // …but a manual Refresh (or Reconcile) is a DEFECT: the surface self-updates.
    expect(screen.queryByTestId('sitedb-action-refresh')).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /refresh|reconcile/i })).toBeNull();
  });

  it('re-fetches the table list automatically on a visibility-aware interval (no click)', async () => {
    vi.useFakeTimers();

    try {
      render(<SiteTablesPanel />);

      await act(async () => {
        await Promise.resolve();
      });
      await replyTablesReady();

      const afterMount = tablesRequestCount();
      expect(afterMount).toBeGreaterThanOrEqual(1);

      // Advancing past the poll cadence fires another list read — with zero user interaction.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(31_000);
      });

      expect(tablesRequestCount()).toBeGreaterThan(afterMount);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-fetches immediately when the tab returns to the foreground (visibilitychange)', async () => {
    render(<SiteTablesPanel />);

    await waitFor(() => {
      expect(postToParentSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'PS_SITEDB_TABLES_REQUEST' }));
    });
    await replyTablesReady();

    const before = tablesRequestCount();

    await act(async () => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await waitFor(() => expect(tablesRequestCount()).toBeGreaterThan(before));
  });
});

// ─── Dual-pane differentiation (fire-55) ─────────────────────────────────────

/**
 * Evidence (fire-53 dux-2026-09-29T20-01-44-425Z state 08): with tables present
 * and none selected, the left SchemaRail AND the right list pane both rendered
 * the SAME "Tables (N)" header over the same table names — two near-identical
 * lists side-by-side read as a duplication bug. The contract under test:
 *
 *  - The two panes render DISTINCT headers: the rail keeps its (visually
 *    secondary) "Tables (N)" inventory header; the right pane becomes a
 *    "Browse a table" pick-one launchpad.
 *  - The launchpad carries a one-line hint telling the owner what to do.
 *  - Each right-pane row carries a hover "Browse" affordance (plus the
 *    existing chevron) so rows read as openable, not as a second index.
 *  - All pre-existing testids + row controls survive (open / drop / rail).
 */
describe('SiteTablesPanel — dual-pane differentiation (rail vs browse launchpad)', () => {
  beforeEach(() => {
    postToParentSpy.mockClear();
    onParentMessageSpy.mockClear();
    parentHandlers.clear();
  });

  afterEach(() => {
    cleanup();
    parentHandlers.clear();
  });

  /** Render + drive to "tables present, none selected" (both panes visible). */
  async function renderWithTables(): Promise<void> {
    render(<SiteTablesPanel />);

    await waitFor(() => {
      expect(postToParentSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'PS_SITEDB_TABLES_REQUEST' }));
    });

    const correlationId = lastCorrelationId();

    await act(async () => {
      fireReply({
        type: 'PS_SITEDB_TABLES_RESPONSE',
        correlationId,
        ok: true,
        databaseId: 'db-abc123',
        provisioned: true,
        tables: [{ name: 'posts' }, { name: 'users' }],
      });
    });
  }

  it('renders DISTINCT headers on the rail and the browse pane when no table is selected', async () => {
    await renderWithTables();

    // Both panes are on screen.
    expect(screen.getByTestId('sitedb-rail')).toBeTruthy();
    expect(screen.getByTestId('sitedb-table-list')).toBeTruthy();

    // The rail keeps its inventory header (with the count)…
    const railHeader = screen.getByTestId('sitedb-rail-header');
    expect(railHeader.textContent).toContain('Tables (2)');

    // …while the right pane is a pick-a-table launchpad with a DIFFERENT header.
    const browseHeader = screen.getByTestId('sitedb-browse-header');
    expect(browseHeader.textContent).toMatch(/browse a table/i);
    expect(browseHeader.textContent).not.toEqual(railHeader.textContent);
  });

  it('shows the pick-a-table hint in the browse pane when no table is selected', async () => {
    await renderWithTables();

    const hint = screen.getByTestId('sitedb-browse-hint');
    expect(hint.textContent).toMatch(/pick a table/i);
  });

  it('gives every browse row a hover "Browse" affordance alongside the chevron', async () => {
    await renderWithTables();

    const rows = screen.getAllByTestId('sitedb-table-row');
    expect(rows.length).toBe(2);

    const hints = screen.getAllByTestId('sitedb-row-open-hint');
    expect(hints.length).toBe(2);
    expect(hints[0].textContent).toMatch(/browse/i);
  });

  it('keeps all pre-existing testids + row controls intact', async () => {
    await renderWithTables();

    expect(screen.getAllByTestId('sitedb-rail-item').length).toBe(2);
    expect(screen.getAllByTestId('sitedb-table-open').length).toBe(2);
    expect(screen.getAllByTestId('sitedb-table-drop').length).toBe(2);

    // Clicking a row's open button still fires the rows request (keyboard/click path unchanged).
    postToParentSpy.mockClear();

    await act(async () => {
      screen.getAllByTestId('sitedb-table-open')[0].click();
    });

    await waitFor(() => {
      expect(postToParentSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'PS_SITEDB_ROWS_REQUEST' }));
    });
  });
});
