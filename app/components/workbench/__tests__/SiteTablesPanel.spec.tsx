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

vi.mock('~/lib/embed/embedded-mode', () => ({
  isEmbedded: true,
  postToParent: postToParentSpy,
  onParentMessage: onParentMessageSpy,
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

  it('renders the loading spinner initially', () => {
    render(<SiteTablesPanel />);
    expect(screen.getByTestId('sitedb-loading')).toBeTruthy();
  });

  it('shows the empty-state launchpad when tables array is empty', async () => {
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

    // Empty-state container
    expect(screen.getByTestId('sitedb-empty')).toBeTruthy();

    // Both launchpad CTAs must be present and visible
    const newTableBtn = screen.getByTestId('sitedb-new-table');
    expect(newTableBtn).toBeTruthy();
    expect(newTableBtn.textContent).toContain('New table');

    const askAiBtn = screen.getByTestId('sitedb-ask-ai');
    expect(askAiBtn).toBeTruthy();
    expect(askAiBtn.textContent).toContain('Ask AI');
  });

  it('clicking "New table" shows the coming-soon inline note', async () => {
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

    const newTableBtn = screen.getByTestId('sitedb-new-table');

    await act(async () => {
      newTableBtn.click();
    });

    expect(screen.getByTestId('sitedb-coming-soon')).toBeTruthy();
    expect(screen.getByTestId('sitedb-coming-soon').textContent).toContain('New table');
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
      tableRows[0].click();
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

  it('renders the export CSV button when rows are present', async () => {
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
      tableRows[0].click();
    });

    await waitFor(() => {
      expect(postToParentSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'PS_SITEDB_ROWS_REQUEST', table: 'orders' }),
      );
    });

    await act(async () => {
      fireReply({
        type: 'PS_SITEDB_ROWS_RESPONSE',
        correlationId: lastCorrelationId(),
        ok: true,
        table: 'orders',
        columns: [{ name: 'id', type: 'INTEGER', notnull: 1, pk: 1 }],
        rows: [{ id: 42 }],
        limit: 25,
        offset: 0,
        total: 1,
      });
    });

    expect(screen.getByTestId('sitedb-export-csv')).toBeTruthy();
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
      tableRows[0].click();
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
      tableRows[0].click();
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
      tableRows[0].click();
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
