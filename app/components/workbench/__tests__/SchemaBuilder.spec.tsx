// @vitest-environment jsdom
/**
 * SchemaBuilder.spec.tsx — characterisation tests for the guided DDL builder.
 *
 * The component is bridge-coupled (postToParent / onParentMessage) and relies on a
 * pending-request correlationId round-trip to load the table list and execute DDL.
 * We mock `~/lib/embed/embedded-mode` with the same vi.hoisted() bus pattern used by
 * ResourceDetailPanel.spec.tsx so every bridge round-trip is driven deterministically.
 *
 * Covers:
 *   1. Pure logic — planCreateTable / planAddColumn / planDropColumn / planCreateIndex /
 *      suggestIndexName / SchemaPlanError all behave as documented.
 *   2. disabled state  — PS_SITEDB_TABLES_RESPONSE with enabled:false → renders
 *      data-testid="schema-disabled" (DisabledState), hides the op picker.
 *   3. ready state     — PS_SITEDB_TABLES_RESPONSE ok:true → op pill buttons visible.
 *   4. addColumn op    — switching to addColumn renders the column form.
 *   5. dropColumn gate — select-table→fetch-columns→select-column renders the gate; Apply starts
 *      disabled without "DROP", ungates after, then Apply posts a confirm:true destructive exec
 *      (DROP COLUMN) → success affirmation + the confirm field re-arms (Apply disabled again).
 *   6. SQL preview     — createTable with a valid name + default column renders sql preview.
 *   7. Apply success   — PS_RES_MUTATE_RESPONSE ok/result → schema-apply-ok visible.
 *   8. Apply error     — PS_RES_MUTATE_RESPONSE with error → schema-apply-error visible.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import React from 'react';

// ─── Hoisted bridge spies ────────────────────────────────────────────────────
const { postToParent, handlers, lastRequest } = vi.hoisted(() => {
  const handlers: Array<(msg: unknown) => void> = [];
  const lastRequest: { value: Record<string, unknown> | null } = { value: null };
  const postToParent = vi.fn((message: Record<string, unknown>) => {
    lastRequest.value = message;
  });

  return { postToParent, handlers, lastRequest };
});

vi.mock('~/lib/embed/embedded-mode', () => ({
  isEmbedded: true,
  postToParent,
  onParentMessage: (fn: (msg: unknown) => void) => {
    handlers.push(fn);

    return () => {
      const i = handlers.indexOf(fn);

      if (i >= 0) {
        handlers.splice(i, 1);
      }
    };
  },
}));

vi.mock('~/utils/classNames', () => ({
  classNames: (...args: unknown[]) => args.filter((x) => typeof x === 'string').join(' '),
}));

// Stub PanelShell / PanelHeader to avoid UnoCSS/CSS token issues in jsdom.
vi.mock('../panel', () => ({
  PanelShell: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'panel-shell' }, children),
  PanelHeader: ({ title }: { title: string }) => React.createElement('div', { 'data-testid': 'panel-header' }, title),
}));

// ─── Pure logic imports (no React needed) ────────────────────────────────────
import {
  planCreateTable,
  planAddColumn,
  planDropColumn,
  planCreateIndex,
  suggestIndexName,
  SchemaPlanError,
} from '../schema-builder-logic';

// ─── Component import ─────────────────────────────────────────────────────────
import { SchemaBuilder } from '../SchemaBuilder';

// ─── Bridge helpers ───────────────────────────────────────────────────────────

/** Fire a message through all registered handlers. */
function fireMsg(msg: Record<string, unknown>) {
  act(() => {
    for (const h of [...handlers]) {
      h(msg);
    }
  });
}

/** Reply to the last-posted request by correlationId. */
function replyToLast(type: string, extra: Record<string, unknown>) {
  const cid = lastRequest.value?.correlationId as string | undefined;
  fireMsg({ type, correlationId: cid, ...extra });
}

/** Reply with ready tables. */
function replyTablesReady(tables: string[] = []) {
  replyToLast('PS_SITEDB_TABLES_RESPONSE', {
    ok: true,
    tables: tables.map((name) => ({ name })),
  });
}

/** Reply with disabled (dark flag). */
function replyTablesDisabled() {
  replyToLast('PS_SITEDB_TABLES_RESPONSE', {
    ok: false,
    enabled: false,
    error: 'Per-site data is not enabled',
  });
}

/**
 * Reply with the column list for a loadColumns() round-trip.
 * loadColumns runs `SELECT name FROM pragma_table_info(?1)` via a PS_RES_MUTATE_REQUEST and reads
 * `reply.result.data.rows` → `{ name }[]`. Mirror that exact shape here.
 */
function replyColumnsReady(columns: string[] = []) {
  replyToLast('PS_RES_MUTATE_RESPONSE', {
    ok: true,
    result: { ok: true, data: { rows: columns.map((name) => ({ name })) } },
  });
}

/** Reply with exec success. */
function replyExecOk() {
  replyToLast('PS_RES_MUTATE_RESPONSE', {
    ok: true,
    result: { ok: true, data: { rowsWritten: 0 } },
  });
}

/** Reply with exec error. */
function replyExecError(error: string) {
  replyToLast('PS_RES_MUTATE_RESPONSE', {
    ok: false,
    error,
  });
}

beforeEach(() => {
  postToParent.mockClear();
  handlers.length = 0;
  lastRequest.value = null;
});

afterEach(() => cleanup());

// ── 1. Pure logic unit tests ──────────────────────────────────────────────────

describe('schema-builder-logic (pure, no React)', () => {
  it('planCreateTable generates a CREATE TABLE statement', () => {
    const plan = planCreateTable('users', [{ name: 'id', type: 'INTEGER', primaryKey: true }]);
    expect(plan.statements).toHaveLength(1);
    expect(plan.statements[0].sql).toMatch(/CREATE TABLE/i);
    expect(plan.statements[0].sql).toContain('"users"');
    expect(plan.statements[0].destructive).toBe(false);
  });

  it('planCreateTable adds a UNIQUE INDEX for a unique (non-PK) column', () => {
    const plan = planCreateTable('orders', [
      { name: 'id', type: 'INTEGER', primaryKey: true },
      { name: 'email', type: 'TEXT', unique: true },
    ]);
    expect(plan.statements).toHaveLength(2);
    expect(plan.statements[1].sql).toMatch(/CREATE UNIQUE INDEX/i);
  });

  it('planCreateTable throws SchemaPlanError on blank table name', () => {
    expect(() => planCreateTable('', [{ name: 'id', type: 'INTEGER' }])).toThrow(SchemaPlanError);
  });

  it('planCreateTable throws SchemaPlanError on empty column list', () => {
    expect(() => planCreateTable('items', [])).toThrow(SchemaPlanError);
  });

  it('planAddColumn generates ALTER TABLE … ADD COLUMN', () => {
    const plan = planAddColumn('items', { name: 'price', type: 'REAL' });
    expect(plan.statements[0].sql).toMatch(/ALTER TABLE/i);
    expect(plan.statements[0].sql).toContain('ADD COLUMN');
    expect(plan.statements[0].destructive).toBe(false);
  });

  it('planDropColumn generates a destructive ALTER TABLE … DROP COLUMN', () => {
    const plan = planDropColumn('items', 'price');
    expect(plan.statements[0].sql).toMatch(/DROP COLUMN/i);
    expect(plan.statements[0].destructive).toBe(true);
  });

  it('planDropColumn throws SchemaPlanError on blank column name', () => {
    expect(() => planDropColumn('items', '')).toThrow(SchemaPlanError);
  });

  it('planCreateIndex generates CREATE INDEX', () => {
    const plan = planCreateIndex('items', ['price']);
    expect(plan.statements[0].sql).toMatch(/CREATE INDEX/i);
    expect(plan.statements[0].destructive).toBe(false);
  });

  it('planCreateIndex generates CREATE UNIQUE INDEX when unique:true', () => {
    const plan = planCreateIndex('items', ['email'], { unique: true });
    expect(plan.statements[0].sql).toMatch(/CREATE UNIQUE INDEX/i);
  });

  it('planCreateIndex throws SchemaPlanError on empty column list', () => {
    expect(() => planCreateIndex('items', [])).toThrow(SchemaPlanError);
  });

  it('suggestIndexName produces idx_<table>_<cols> format', () => {
    expect(suggestIndexName('orders', ['email', 'status'])).toBe('idx_orders_email_status');
  });

  it('suggestIndexName truncates to 63 characters', () => {
    const longTable = 'a'.repeat(60);
    const result = suggestIndexName(longTable, ['col']);
    expect(result.length).toBeLessThanOrEqual(63);
  });
});

// ── 2. disabled state ─────────────────────────────────────────────────────────

describe('SchemaBuilder — disabled state (dark flag)', () => {
  it('shows disabled state and hides op picker when flag is off', async () => {
    render(<SchemaBuilder />);

    await waitFor(() =>
      expect(postToParent).toHaveBeenCalledWith(expect.objectContaining({ type: 'PS_SITEDB_TABLES_REQUEST' })),
    );

    replyTablesDisabled();

    await waitFor(() => expect(screen.getByTestId('schema-disabled')).toBeInTheDocument());
    expect(screen.queryByTestId('schema-op-createTable')).not.toBeInTheDocument();
  });
});

// ── 3. ready state ────────────────────────────────────────────────────────────

describe('SchemaBuilder — ready state', () => {
  it('renders all five op buttons after a successful tables reply', async () => {
    render(<SchemaBuilder />);

    await waitFor(() =>
      expect(postToParent).toHaveBeenCalledWith(expect.objectContaining({ type: 'PS_SITEDB_TABLES_REQUEST' })),
    );

    replyTablesReady(['products']);

    await waitFor(() => expect(screen.getByTestId('schema-op-createTable')).toBeInTheDocument());
    expect(screen.getByTestId('schema-op-addColumn')).toBeInTheDocument();
    expect(screen.getByTestId('schema-op-renameColumn')).toBeInTheDocument();
    expect(screen.getByTestId('schema-op-dropColumn')).toBeInTheDocument();
    expect(screen.getByTestId('schema-op-createIndex')).toBeInTheDocument();
  });
});

// ── 4. addColumn op ───────────────────────────────────────────────────────────

describe('SchemaBuilder — addColumn operation', () => {
  it('switches to addColumn form when op button is clicked', async () => {
    render(<SchemaBuilder />);

    await waitFor(() =>
      expect(postToParent).toHaveBeenCalledWith(expect.objectContaining({ type: 'PS_SITEDB_TABLES_REQUEST' })),
    );

    replyTablesReady(['products']);

    await waitFor(() => expect(screen.getByTestId('schema-op-addColumn')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('schema-op-addColumn'));

    await waitFor(() => expect(screen.getByTestId('schema-table-picker')).toBeInTheDocument());
    // Selecting a table reveals the ColumnFields form (idPrefix="add" → add-col-* testids).
    fireEvent.change(screen.getByTestId('schema-table-picker'), { target: { value: 'products' } });
    await waitFor(() => expect(screen.getByTestId('add-col-name')).toBeInTheDocument());
  });
});

// ── 5. dropColumn destructive gate ───────────────────────────────────────────

describe('SchemaBuilder — dropColumn destructive gate', () => {
  // The destructive gate (schema-destructive-gate + schema-drop-confirm) renders only after the
  // full select-table → fetch-columns (bridge reply) → select-column chain makes compiled.plan a
  // destructive DROP COLUMN. This drives that real sequence via the columns-reply bridge mock, then
  // CONTINUES the journey through Apply to prove the gate actually translates into a guarded
  // (confirm:true) destructive exec — not merely that the button un-disables.
  it('gates the drop, then applies it as a confirm:true destructive exec and affirms success', async () => {
    render(<SchemaBuilder initialOp="dropColumn" />);

    await waitFor(() =>
      expect(postToParent).toHaveBeenCalledWith(expect.objectContaining({ type: 'PS_SITEDB_TABLES_REQUEST' })),
    );

    replyTablesReady(['users']);

    // dropColumn op is selected via initialOp; the table picker appears once tables are ready.
    await waitFor(() => expect(screen.getByTestId('schema-op-dropColumn')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('schema-table-picker')).toBeInTheDocument());

    // Select a table → the picker-table effect fires loadColumns(), posting a pragma_table_info read.
    fireEvent.change(screen.getByTestId('schema-table-picker'), { target: { value: 'users' } });

    await waitFor(() =>
      expect(postToParent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'PS_RES_MUTATE_REQUEST',
          input: expect.objectContaining({ sql: expect.stringContaining('pragma_table_info') }),
        }),
      ),
    );

    // Reply with the column list → the ColumnPicker (schema-column-picker) renders its options.
    replyColumnsReady(['id', 'email']);

    await waitFor(() => expect(screen.getByTestId('schema-column-picker')).toBeInTheDocument());

    // Pick a column → compiled.plan becomes a destructive DROP COLUMN → the gate + Apply render.
    fireEvent.change(screen.getByTestId('schema-column-picker'), { target: { value: 'email' } });

    await waitFor(() => expect(screen.getByTestId('schema-destructive-gate')).toBeInTheDocument());
    expect(screen.getByTestId('schema-apply')).toBeInTheDocument();

    // The drop-confirm input must be present for the destructive gate.
    const confirmInput = screen.getByTestId('schema-drop-confirm');
    expect(confirmInput).toBeInTheDocument();

    // Before confirmation, Apply is gated (destructiveGateOk === false).
    expect(screen.getByTestId('schema-apply')).toBeDisabled();

    // Typing DROP into the confirm field should be accepted and ungate Apply.
    fireEvent.change(confirmInput, { target: { value: 'DROP' } });
    expect(confirmInput).toHaveValue('DROP');

    await waitFor(() => expect(screen.getByTestId('schema-apply')).not.toBeDisabled());

    // CONTINUE the journey to completion: clicking Apply must post the DESTRUCTIVE drop as a
    // confirm:true exec. This is the security-critical leg — a regression that forwarded the drop
    // with confirm:false (bypassing the per-site exec rail's destructive guard) would un-disable the
    // button identically, so only asserting confirm:true on the actual mutate request catches it.
    fireEvent.click(screen.getByTestId('schema-apply'));

    await waitFor(() =>
      expect(postToParent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'PS_RES_MUTATE_REQUEST',
          action: 'exec',
          confirm: true,
          input: expect.objectContaining({ sql: expect.stringContaining('DROP COLUMN') }),
        }),
      ),
    );

    // A successful exec reply affirms the change and resets the confirm field so the gate re-arms for
    // the next drop (owner must re-type DROP — a cleared field must leave Apply disabled again).
    replyExecOk();

    await waitFor(() => expect(screen.getByTestId('schema-apply-ok')).toBeInTheDocument());
    expect(screen.getByTestId('schema-drop-confirm')).toHaveValue('');
    expect(screen.getByTestId('schema-apply')).toBeDisabled();
  });
});

// ── 6. SQL preview ────────────────────────────────────────────────────────────

describe('SchemaBuilder — SQL preview', () => {
  it('shows a SQL preview when createTable form has a valid name', async () => {
    render(<SchemaBuilder />);

    await waitFor(() =>
      expect(postToParent).toHaveBeenCalledWith(expect.objectContaining({ type: 'PS_SITEDB_TABLES_REQUEST' })),
    );

    replyTablesReady();

    await waitFor(() => expect(screen.getByTestId('schema-op-createTable')).toBeInTheDocument());

    const nameInput = screen.getByTestId('schema-new-table-name');
    fireEvent.change(nameInput, { target: { value: 'orders' } });

    await waitFor(() => expect(screen.getByTestId('schema-sql-preview')).toBeInTheDocument());
    expect(screen.getByTestId('schema-sql-preview').textContent).toMatch(/CREATE TABLE/i);
  });
});

// ── 7. Apply success ──────────────────────────────────────────────────────────

describe('SchemaBuilder — Apply success', () => {
  it('shows schema-apply-ok after a successful exec reply', async () => {
    render(<SchemaBuilder />);

    await waitFor(() =>
      expect(postToParent).toHaveBeenCalledWith(expect.objectContaining({ type: 'PS_SITEDB_TABLES_REQUEST' })),
    );

    replyTablesReady();

    await waitFor(() => expect(screen.getByTestId('schema-new-table-name')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('schema-new-table-name'), { target: { value: 'logs' } });

    await waitFor(() => {
      const btn = screen.getByTestId('schema-apply');
      expect(btn).not.toBeDisabled();
    });

    fireEvent.click(screen.getByTestId('schema-apply'));

    await waitFor(() =>
      expect(postToParent).toHaveBeenCalledWith(expect.objectContaining({ type: 'PS_RES_MUTATE_REQUEST' })),
    );

    replyExecOk();

    await waitFor(() => expect(screen.getByTestId('schema-apply-ok')).toBeInTheDocument());
  });
});

// ── 8. Apply error ────────────────────────────────────────────────────────────

describe('SchemaBuilder — Apply error', () => {
  it('shows schema-apply-error after a failed exec reply', async () => {
    render(<SchemaBuilder />);

    await waitFor(() =>
      expect(postToParent).toHaveBeenCalledWith(expect.objectContaining({ type: 'PS_SITEDB_TABLES_REQUEST' })),
    );

    replyTablesReady();

    await waitFor(() => expect(screen.getByTestId('schema-new-table-name')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('schema-new-table-name'), { target: { value: 'events' } });

    await waitFor(() => {
      const btn = screen.getByTestId('schema-apply');
      expect(btn).not.toBeDisabled();
    });

    fireEvent.click(screen.getByTestId('schema-apply'));

    await waitFor(() =>
      expect(postToParent).toHaveBeenCalledWith(expect.objectContaining({ type: 'PS_RES_MUTATE_REQUEST' })),
    );

    replyExecError('table "events" already exists');

    await waitFor(() => expect(screen.getByTestId('schema-apply-error')).toBeInTheDocument());
    expect(screen.getByTestId('schema-apply-error').textContent).toContain('events');
  });
});
