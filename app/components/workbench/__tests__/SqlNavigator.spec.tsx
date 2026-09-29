// @vitest-environment jsdom
/**
 * SqlNavigator.spec.tsx
 *
 * Unit tests for the RICH per-site SQL navigator (recycled from DataPanel's proven editor, re-pointed
 * at the site's OWN D1 — Brian 2026-09-27 interconnectedness directive).
 *
 * The navigator recycles the syntax-highlighted + schema-completing SqlEditor, the localStorage query
 * history + named saved queries (Rev 6: promoted to a persistent side RAIL), the EXPLAIN cost hint, and
 * typed result cells — but executes ONLY through the per-site console endpoint `POST /db/query` via
 * `requestDbQuery({ sql })` (message `PS_SITEDB_QUERY_REQUEST` → `PS_SITEDB_QUERY_RESPONSE`), NEVER a
 * shared-platform/super-admin path. Isolation is server-resolved; the client never sends a CF id.
 *
 * Cases:
 *  1. Idle → the editor + Run/Explain render; Run disabled until there's SQL.
 *  2. A read Run sends the PER-SITE query (sql only, no CF id) and renders the returned rows.
 *  3-9. Rev 6 rail: history records + reloads-and-reruns; save persists + shows in rail; load-only;
 *       delete removes; quiet empty state.
 * 10. A destructive statement surfaces the local confirm affordance; confirming re-runs (confirm bypassed).
 * 11. A dark-flag (enabled:false) reply shows the friendly "not enabled" state, never an error.
 * 12. A write result surfaces the ground-truth `rows_written` from D1 meta.
 * 13. The always-visible "Run · LIMIT 500" button caps a bare SELECT at 500 rows before running.
 * 14. LIMIT 500 leaves an already-bounded / non-SELECT statement untouched (no double LIMIT).
 * 15. An unbounded bare SELECT surfaces the amber "Add LIMIT 500" nudge beside Run; a bounded one doesn't.
 * 16. The result meta strip shows the returned row count.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import React from 'react';

// ─── Embed bridge mock ───────────────────────────────────────────────────────

const { postToParentSpy, onParentMessageSpy, requestDbQuerySpy, parentHandlers } = vi.hoisted(() => {
  const parentHandlers = new Set<(msg: unknown) => void>();
  const postToParentSpy = vi.fn();
  const onParentMessageSpy = vi.fn((handler: (msg: unknown) => void) => {
    parentHandlers.add(handler);

    return () => {
      parentHandlers.delete(handler);
    };
  });

  /*
   * Mirror the real bridge: `requestDbQuery({sql})` posts a PS_SITEDB_QUERY_REQUEST via postToParent and
   * resolves when a matching PS_SITEDB_QUERY_RESPONSE is pushed through the parent handlers (see
   * `replyToLastQuery`). This keeps the assertion surface identical to production.
   */
  let corr = 0;
  const requestDbQuerySpy = vi.fn(
    (input: { sql: string; params?: unknown[] }): Promise<unknown> =>
      new Promise((resolve) => {
        const correlationId = `q_${++corr}`;
        postToParentSpy({ type: 'PS_SITEDB_QUERY_REQUEST', correlationId, sql: input.sql, params: input.params });

        const handler = (msg: { type?: string; correlationId?: string }): void => {
          if (msg?.type === 'PS_SITEDB_QUERY_RESPONSE' && msg.correlationId === correlationId) {
            parentHandlers.delete(handler);
            resolve(msg);
          }
        };

        parentHandlers.add(handler);
      }),
  );

  return { postToParentSpy, onParentMessageSpy, requestDbQuerySpy, parentHandlers };
});

vi.mock('~/lib/embed/embedded-mode', () => ({
  isEmbedded: true,
  postToParent: postToParentSpy,
  onParentMessage: onParentMessageSpy,
  requestDbQuery: requestDbQuerySpy,
}));

// ─── Import AFTER mocks ───────────────────────────────────────────────────────
import { SqlNavigator } from '../SqlNavigator';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** The last PS_SITEDB_QUERY_REQUEST payload the component posted (for assertions). */
function lastQueryRequest(): Record<string, unknown> | undefined {
  return [...postToParentSpy.mock.calls].reverse().find((c) => c[0]?.type === 'PS_SITEDB_QUERY_REQUEST')?.[0];
}

/** Resolve the most recent /db/query request by pushing a matching PS_SITEDB_QUERY_RESPONSE. */
function replyToLastQuery(reply: Record<string, unknown>): void {
  const req = lastQueryRequest();
  const correlationId = req?.correlationId;

  for (const handler of [...parentHandlers]) {
    handler({ type: 'PS_SITEDB_QUERY_RESPONSE', correlationId, ...reply });
  }
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
  requestDbQuerySpy.mockClear();
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

  it('a read Run sends the PER-SITE query (sql only, no CF id) + renders rows', async () => {
    render(<SqlNavigator />);

    fireEvent.change(screen.getByTestId('database-sql-textarea'), { target: { value: 'SELECT id, name FROM t;' } });
    fireEvent.click(screen.getByTestId('database-sql-run'));

    const req = lastQueryRequest();
    expect(req?.type).toBe('PS_SITEDB_QUERY_REQUEST');
    expect(req?.sql).toBe('SELECT id, name FROM t;');

    // INV-1: the client NEVER supplies a Cloudflare identifier of any kind.
    const flat = JSON.stringify(req);
    expect(flat).not.toMatch(/database_id|account_id|d1_database|namespace|bucket/i);

    replyToLastQuery({
      ok: true,
      columns: [
        { name: 'id', type: 'INTEGER' },
        { name: 'name', type: 'TEXT' },
      ],
      rows: [{ id: 1, name: 'Alice' }],
      rowCount: 1,
      meta: { rows_read: 1, duration: 3 },
    });

    await waitFor(() => expect(screen.getByTestId('database-sql-result')).toBeTruthy());
    expect(screen.getByText('Alice')).toBeTruthy();
  });

  // ── Rev 6 — saved-queries + run-history rail ──────────────────────────────

  it('records a run in the timestamped history rail (per-site localStorage key)', async () => {
    render(<SqlNavigator />);

    fireEvent.change(screen.getByTestId('database-sql-textarea'), { target: { value: 'SELECT 42;' } });
    fireEvent.click(screen.getByTestId('database-sql-run'));
    replyToLastQuery({ ok: true, rows: [{ '42': 42 }] });

    // The run appears in the rail's history list, and persists under the (shared-fallback) per-site key.
    await waitFor(() => expect(screen.getByTestId('database-sql-history-item')).toBeTruthy());
    expect(screen.getByTestId('database-sql-history-item').getAttribute('title')).toContain('SELECT 42;');
    expect(store['ps-sitedb-sql-history:__shared']).toContain('SELECT 42;');
  });

  it('reloads + re-runs a history entry when clicked in the rail', async () => {
    render(<SqlNavigator />);

    fireEvent.change(screen.getByTestId('database-sql-textarea'), { target: { value: 'SELECT 7;' } });
    fireEvent.click(screen.getByTestId('database-sql-run'));
    replyToLastQuery({ ok: true, rows: [{ '7': 7 }] });

    await waitFor(() => expect(screen.getByTestId('database-sql-history-item')).toBeTruthy());

    // Clicking the history row re-issues the SAME query (a one-click "run this again").
    postToParentSpy.mockClear();
    fireEvent.click(screen.getByTestId('database-sql-history-item'));

    const req = lastQueryRequest();
    expect(req?.type).toBe('PS_SITEDB_QUERY_REQUEST');
    expect(req?.sql).toBe('SELECT 7;');
  });

  it('saves a named query (per-site localStorage key) and shows it in the rail', () => {
    render(<SqlNavigator />);

    fireEvent.change(screen.getByTestId('database-sql-textarea'), { target: { value: 'SELECT * FROM users;' } });
    fireEvent.change(screen.getByTestId('database-sql-save-name'), { target: { value: 'all users' } });
    fireEvent.click(screen.getByTestId('database-sql-save'));

    expect(store['ps-sitedb-sql-saved:__shared']).toContain('all users');
    expect(screen.getByTestId('database-sql-saved-load')).toBeTruthy();
  });

  it('loads a saved query into the editor from the rail without running it', () => {
    render(<SqlNavigator />);

    fireEvent.change(screen.getByTestId('database-sql-textarea'), { target: { value: 'SELECT * FROM orders;' } });
    fireEvent.change(screen.getByTestId('database-sql-save-name'), { target: { value: 'orders' } });
    fireEvent.click(screen.getByTestId('database-sql-save'));

    // Clear the editor, then load the saved query — the editor repopulates and NOTHING runs.
    fireEvent.change(screen.getByTestId('database-sql-textarea'), { target: { value: '' } });
    postToParentSpy.mockClear();
    fireEvent.click(screen.getByTestId('database-sql-saved-load'));

    expect((screen.getByTestId('database-sql-textarea') as HTMLTextAreaElement).value).toBe('SELECT * FROM orders;');

    // load-only: no query was sent.
    expect(lastQueryRequest()).toBeUndefined();
  });

  it('deletes a saved query from the rail (removes it from localStorage)', async () => {
    render(<SqlNavigator />);

    fireEvent.change(screen.getByTestId('database-sql-textarea'), { target: { value: 'SELECT 1;' } });
    fireEvent.change(screen.getByTestId('database-sql-save-name'), { target: { value: 'temp' } });
    fireEvent.click(screen.getByTestId('database-sql-save'));
    expect(screen.getByTestId('database-sql-saved-load')).toBeTruthy();

    fireEvent.click(screen.getByTestId('database-sql-saved-delete'));

    await waitFor(() => expect(screen.queryByTestId('database-sql-saved-load')).toBeNull());
    expect(store['ps-sitedb-sql-saved:__shared']).not.toContain('temp');

    // Empty state is a quiet note, never a broken panel.
    expect(screen.getByTestId('database-sql-saved-empty')).toBeTruthy();
  });

  it('shows a quiet empty-history note (not a broken panel) before any run', () => {
    render(<SqlNavigator />);

    expect(screen.getByTestId('database-sql-rail')).toBeTruthy();
    expect(screen.getByTestId('database-sql-history-empty')).toBeTruthy();
    expect(screen.queryByTestId('database-sql-history-item')).toBeNull();
  });

  it('the rail toggle hides + reveals the rail', () => {
    render(<SqlNavigator />);

    // Open by default.
    expect(screen.getByTestId('database-sql-rail')).toBeTruthy();

    fireEvent.click(screen.getByTestId('database-sql-rail-toggle'));
    expect(screen.queryByTestId('database-sql-rail')).toBeNull();

    fireEvent.click(screen.getByTestId('database-sql-rail-toggle'));
    expect(screen.getByTestId('database-sql-rail')).toBeTruthy();
  });

  // ── Safety + result surfaces ──────────────────────────────────────────────

  it('surfaces the local confirm affordance for a destructive statement; confirming re-runs it', async () => {
    render(<SqlNavigator />);

    // A DELETE with no WHERE is destructive → the client gates BEFORE hitting the endpoint.
    fireEvent.change(screen.getByTestId('database-sql-textarea'), { target: { value: 'DELETE FROM t;' } });
    fireEvent.click(screen.getByTestId('database-sql-run'));

    await waitFor(() => expect(screen.getByTestId('database-sql-confirm')).toBeTruthy());

    // Confirming runs the same SQL through the per-site query endpoint.
    postToParentSpy.mockClear();
    fireEvent.click(screen.getByTestId('database-sql-confirm-run'));

    const req = lastQueryRequest();
    expect(req?.type).toBe('PS_SITEDB_QUERY_REQUEST');
    expect(req?.sql).toBe('DELETE FROM t;');
  });

  it('shows the friendly "not enabled" state on a dark-flag reply (never an error)', async () => {
    render(<SqlNavigator />);

    fireEvent.change(screen.getByTestId('database-sql-textarea'), { target: { value: 'SELECT 1;' } });
    fireEvent.click(screen.getByTestId('database-sql-run'));
    replyToLastQuery({ ok: false, enabled: false });

    await waitFor(() => expect(screen.getByTestId('database-sql-disabled')).toBeTruthy());
    expect(screen.queryByTestId('database-sql-error')).toBeNull();
  });

  it('surfaces the ground-truth rows_written for a write', async () => {
    render(<SqlNavigator />);

    // INSERT is non-destructive → runs immediately (no confirm gate).
    fireEvent.change(screen.getByTestId('database-sql-textarea'), { target: { value: 'INSERT INTO t VALUES (1);' } });
    fireEvent.click(screen.getByTestId('database-sql-run'));
    replyToLastQuery({ ok: true, rows: [], meta: { rows_written: 1 } });

    await waitFor(() => expect(screen.getByTestId('database-sql-rows-written')).toBeTruthy());

    const badge = screen.getByTestId('database-sql-rows-written');
    expect(within(badge).getByText(/1 row written/)).toBeTruthy();
  });

  it('the always-visible LIMIT 500 button caps a bare SELECT at 500 rows before running', () => {
    render(<SqlNavigator />);

    fireEvent.change(screen.getByTestId('database-sql-textarea'), { target: { value: 'SELECT * FROM big_table' } });

    const limitBtn = screen.getByTestId('database-sql-limit') as HTMLButtonElement;
    expect(limitBtn).toBeTruthy();
    expect(limitBtn.disabled).toBe(false);

    fireEvent.click(limitBtn);

    const req = lastQueryRequest();
    expect(req?.type).toBe('PS_SITEDB_QUERY_REQUEST');
    expect(req?.sql).toBe('SELECT * FROM big_table LIMIT 500');
  });

  it('LIMIT 500 leaves an already-bounded SELECT untouched (no double LIMIT)', () => {
    render(<SqlNavigator />);

    fireEvent.change(screen.getByTestId('database-sql-textarea'), { target: { value: 'SELECT * FROM t LIMIT 10' } });
    fireEvent.click(screen.getByTestId('database-sql-limit'));

    const req = lastQueryRequest();
    expect(req?.sql).toBe('SELECT * FROM t LIMIT 10');
  });

  it('shows the amber "Add LIMIT" nudge only for an unbounded bare SELECT', () => {
    render(<SqlNavigator />);

    // Unbounded → the nudge appears.
    fireEvent.change(screen.getByTestId('database-sql-textarea'), { target: { value: 'SELECT * FROM users' } });
    expect(screen.getByTestId('database-sql-add-limit')).toBeTruthy();

    // Already bounded → no nudge.
    fireEvent.change(screen.getByTestId('database-sql-textarea'), { target: { value: 'SELECT * FROM users LIMIT 5' } });
    expect(screen.queryByTestId('database-sql-add-limit')).toBeNull();
  });

  it('the amber nudge runs the bounded variant', () => {
    render(<SqlNavigator />);

    fireEvent.change(screen.getByTestId('database-sql-textarea'), { target: { value: 'SELECT * FROM users' } });
    fireEvent.click(screen.getByTestId('database-sql-add-limit'));

    const req = lastQueryRequest();
    expect(req?.sql).toBe('SELECT * FROM users LIMIT 500');
  });

  it('the result meta strip shows the returned row count', async () => {
    render(<SqlNavigator />);

    fireEvent.change(screen.getByTestId('database-sql-textarea'), { target: { value: 'SELECT id FROM t;' } });
    fireEvent.click(screen.getByTestId('database-sql-run'));
    replyToLastQuery({
      ok: true,
      columns: [{ name: 'id', type: 'INTEGER' }],
      rows: [{ id: 1 }, { id: 2 }, { id: 3 }],
      rowCount: 3,
      meta: { duration: 2 },
    });

    await waitFor(() => expect(screen.getByTestId('database-sql-row-count')).toBeTruthy());
    expect(within(screen.getByTestId('database-sql-row-count')).getByText(/3 rows/)).toBeTruthy();
  });

  // ── Rev 7 — AI "Explain this" (REUSES the existing editor chat via PS_SUBMIT_PROMPT) ──

  it('Explain is disabled-with-reason until a query exists (never a dead control)', () => {
    render(<SqlNavigator />);

    const explain = screen.getByTestId('database-sql-ai-explain') as HTMLButtonElement;
    expect(explain).toBeTruthy();
    expect(explain.disabled).toBe(true);
    // The reason is surfaced (title/tooltip), not silent.
    expect(explain.getAttribute('title') ?? '').toMatch(/run a query first/i);

    fireEvent.change(screen.getByTestId('database-sql-textarea'), { target: { value: 'SELECT 1;' } });
    expect((screen.getByTestId('database-sql-ai-explain') as HTMLButtonElement).disabled).toBe(false);
  });

  it('Explain composes the query + rows and posts PS_SUBMIT_PROMPT to the existing chat', async () => {
    render(<SqlNavigator />);

    fireEvent.change(screen.getByTestId('database-sql-textarea'), { target: { value: 'SELECT id, name FROM users;' } });
    fireEvent.click(screen.getByTestId('database-sql-run'));
    replyToLastQuery({
      ok: true,
      columns: [
        { name: 'id', type: 'INTEGER' },
        { name: 'name', type: 'TEXT' },
      ],
      rows: [{ id: 1, name: 'Alice' }],
      rowCount: 1,
      meta: { duration: 2 },
    });

    await waitFor(() => expect(screen.getByTestId('database-sql-result')).toBeTruthy());

    /*
     * Clicking Explain hands the prompt to the EDITOR AI CHAT by raw-posting PS_SUBMIT_PROMPT to the parent
     * (the same admin-relay pattern Preview uses) — the admin forwards it into Chat.client.tsx. No new
     * endpoint. Spy on window.parent.postMessage to observe the relay.
     */
    const postSpy = vi.spyOn(window.parent, 'postMessage');
    fireEvent.click(screen.getByTestId('database-sql-ai-explain'));

    const submit = [...postSpy.mock.calls].reverse().find((c) => (c[0] as { type?: string })?.type === 'PS_SUBMIT_PROMPT')?.[0] as
      | { type: string; prompt: string }
      | undefined;
    expect(submit).toBeTruthy();
    expect(submit!.type).toBe('PS_SUBMIT_PROMPT'); // the chat's existing auto-submit message
    expect(submit!.prompt).toContain('Explain this SQL query and what its results mean, in plain English:');
    expect(submit!.prompt).toContain('SELECT id, name FROM users;');
    expect(submit!.prompt).toContain('"name": "Alice"'); // the sampled rows are embedded

    // The user gets a "Sent to chat" confirmation.
    await waitFor(() => expect(screen.getByTestId('database-sql-ai-explain-sent')).toBeTruthy());
    postSpy.mockRestore();
  });
});
