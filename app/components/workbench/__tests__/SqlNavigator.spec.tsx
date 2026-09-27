// @vitest-environment jsdom
/**
 * SqlNavigator.spec.tsx
 *
 * Unit tests for the RICH per-site SQL navigator (recycled from DataPanel's proven editor, re-pointed
 * at the site's OWN D1 — Brian 2026-09-27 interconnectedness directive).
 *
 * The navigator recycles the syntax-highlighted + schema-completing SqlEditor, localStorage query
 * history + named saved queries, the EXPLAIN cost hint, and typed result cells — but executes ONLY
 * through the per-site adapter (`PS_RES_MUTATE { kind:'d1', action:'exec', input:{ sql } }`), NEVER a
 * shared-platform/super-admin path. Isolation is server-resolved; the client never sends a CF id.
 *
 * Cases:
 *  1. Idle → the editor + Run/Explain render; Run disabled until there's SQL.
 *  2. A read Run sends the PER-SITE PS_RES_MUTATE exec (kind:'d1', action:'exec', confirm:false, no CF id)
 *     and renders the returned rows in the result grid.
 *  3. A successful run records the query in localStorage history + the History toggle appears.
 *  4. Save-as persists a named saved query to localStorage.
 *  5. A `confirmation_required` result surfaces the confirm affordance; confirming re-sends confirm:true.
 *  6. A dark-flag (enabled:false) reply shows the friendly "not enabled" state, never an error.
 *  7. A write result surfaces the ground-truth `rowsWritten`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import React from 'react';

// ─── Embed bridge mock ───────────────────────────────────────────────────────

const { postToParentSpy, onParentMessageSpy, parentHandlers } = vi.hoisted(() => {
  const parentHandlers = new Set<(msg: unknown) => void>();
  const postToParentSpy = vi.fn();
  const onParentMessageSpy = vi.fn((handler: (msg: unknown) => void) => {
    parentHandlers.add(handler);
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

// ─── Import AFTER mocks ───────────────────────────────────────────────────────
import { SqlNavigator } from '../SqlNavigator';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Resolve the most recent PS_RES_MUTATE exec request by pushing a reply through the parent handlers. */
function replyToLastMutate(reply: Record<string, unknown>): void {
  const call = [...postToParentSpy.mock.calls].reverse().find((c) => c[0]?.type === 'PS_RES_MUTATE_REQUEST');
  const correlationId = call?.[0]?.correlationId;
  for (const handler of parentHandlers) {
    handler({ type: 'PS_RES_MUTATE_RESPONSE', correlationId, ...reply });
  }
}

/** The last PS_RES_MUTATE exec request payload the component posted (for assertions). */
function lastMutateRequest(): Record<string, unknown> | undefined {
  return [...postToParentSpy.mock.calls].reverse().find((c) => c[0]?.type === 'PS_RES_MUTATE_REQUEST')?.[0];
}

// ─── localStorage stub ─────────────────────────────────────────────────────────

let store: Record<string, string> = {};

beforeEach(() => {
  store = {};
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = String(v);
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      store = {};
    },
  });
  postToParentSpy.mockClear();
  onParentMessageSpy.mockClear();
  parentHandlers.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SqlNavigator — rich per-site SQL workspace', () => {
  it('renders the editor + Run/Explain; Run is disabled until there is SQL', () => {
    render(<SqlNavigator />);

    expect(screen.getByTestId('database-sql-textarea')).toBeTruthy();
    expect(screen.getByTestId('database-sql-explain')).toBeTruthy();

    const run = screen.getByTestId('database-sql-run') as HTMLButtonElement;
    expect(run.disabled).toBe(true);

    fireEvent.change(screen.getByTestId('database-sql-textarea'), { target: { value: 'SELECT 1;' } });
    expect((screen.getByTestId('database-sql-run') as HTMLButtonElement).disabled).toBe(false);
  });

  it('a read Run sends the PER-SITE exec (kind d1, action exec, confirm false, no CF id) + renders rows', async () => {
    render(<SqlNavigator />);

    fireEvent.change(screen.getByTestId('database-sql-textarea'), { target: { value: 'SELECT id, name FROM t;' } });
    fireEvent.click(screen.getByTestId('database-sql-run'));

    const req = lastMutateRequest();
    expect(req?.kind).toBe('d1');
    expect(req?.action).toBe('exec');
    expect(req?.confirm).toBe(false);
    expect((req?.input as { sql: string }).sql).toBe('SELECT id, name FROM t;');
    // INV-1: the client NEVER supplies a Cloudflare identifier of any kind.
    const flat = JSON.stringify(req);
    expect(flat).not.toMatch(/database_id|account_id|d1_database|namespace|bucket/i);

    replyToLastMutate({
      ok: true,
      result: {
        ok: true,
        data: {
          classification: 'read',
          columns: [{ name: 'id', type: 'INTEGER' }, { name: 'name', type: 'TEXT' }],
          rows: [{ id: 1, name: 'Alice' }],
          rowsRead: 1,
          durationMs: 3,
        },
      },
    });

    await waitFor(() => expect(screen.getByTestId('database-sql-result')).toBeTruthy());
    expect(screen.getByText('Alice')).toBeTruthy();
  });

  it('records a run in localStorage history and shows the History toggle', async () => {
    render(<SqlNavigator />);

    fireEvent.change(screen.getByTestId('database-sql-textarea'), { target: { value: 'SELECT 42;' } });
    fireEvent.click(screen.getByTestId('database-sql-run'));
    replyToLastMutate({ ok: true, result: { ok: true, data: { rows: [{ '42': 42 }] } } });

    await waitFor(() => expect(screen.getByTestId('database-sql-history-toggle')).toBeTruthy());
    expect(store['ps-sitedb-sql-history']).toContain('SELECT 42;');
  });

  it('saves a named query to localStorage via Save-as', () => {
    render(<SqlNavigator />);

    fireEvent.change(screen.getByTestId('database-sql-textarea'), { target: { value: 'SELECT * FROM users;' } });
    fireEvent.change(screen.getByTestId('database-sql-save-name'), { target: { value: 'all users' } });
    fireEvent.click(screen.getByTestId('database-sql-save'));

    expect(store['ps-sitedb-sql-saved']).toContain('all users');
    expect(screen.getByTestId('database-sql-saved-toggle')).toBeTruthy();
  });

  it('surfaces the confirm affordance on confirmation_required and re-sends with confirm:true', async () => {
    render(<SqlNavigator />);

    fireEvent.change(screen.getByTestId('database-sql-textarea'), { target: { value: 'DELETE FROM t;' } });
    fireEvent.click(screen.getByTestId('database-sql-run'));
    replyToLastMutate({
      ok: true,
      result: { ok: false, error: { code: 'confirmation_required', message: 'This deletes rows.' } },
    });

    await waitFor(() => expect(screen.getByTestId('database-sql-confirm')).toBeTruthy());

    postToParentSpy.mockClear();
    fireEvent.click(screen.getByTestId('database-sql-confirm-run'));

    const req = lastMutateRequest();
    expect(req?.confirm).toBe(true);
    expect((req?.input as { sql: string }).sql).toBe('DELETE FROM t;');
  });

  it('shows the friendly "not enabled" state on a dark-flag reply (never an error)', async () => {
    render(<SqlNavigator />);

    fireEvent.change(screen.getByTestId('database-sql-textarea'), { target: { value: 'SELECT 1;' } });
    fireEvent.click(screen.getByTestId('database-sql-run'));
    replyToLastMutate({ ok: false, enabled: false });

    await waitFor(() => expect(screen.getByTestId('database-sql-disabled')).toBeTruthy());
    expect(screen.queryByTestId('database-sql-error')).toBeNull();
  });

  it('surfaces the ground-truth rowsWritten for a write', async () => {
    render(<SqlNavigator />);

    fireEvent.change(screen.getByTestId('database-sql-textarea'), { target: { value: "INSERT INTO t VALUES (1);" } });
    fireEvent.click(screen.getByTestId('database-sql-run'));
    replyToLastMutate({
      ok: true,
      result: { ok: true, data: { classification: 'write', rows: [], rowsWritten: 1 } },
    });

    await waitFor(() => expect(screen.getByTestId('database-sql-rows-written')).toBeTruthy());
    const badge = screen.getByTestId('database-sql-rows-written');
    expect(within(badge).getByText(/1 row written/)).toBeTruthy();
  });
});
