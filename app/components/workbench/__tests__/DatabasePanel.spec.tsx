// @vitest-environment jsdom
/**
 * DatabasePanel.spec.tsx
 *
 * Unit tests for the consolidated per-site Database panel (Brian 2026-09-27 — menu cleanup FIRE).
 *
 * The panel is the ONE data surface: a CONCISE sub-nav BUTTON bar (Tables · SQL · KV) over the site's
 * OWN per-site D1. Tables renders SiteTablesPanel (+ an actions toolbar: Seed with AI / Import / New
 * table / History as buttons, NOT nav entries); SQL is a normal always-visible entry (no Advanced
 * toggle); KV is an HONEST "not yet available" add-on preview (never a fake paywall).
 *
 * KV honesty (fire — lying-green stub removed): the per-site KV add-on has NO configured Stripe price and
 * the embed bridge carries NO checkout message, so there is no real way to buy it from the editor today.
 * The old card promised "$10/mo" + an "Unlock" button whose onClick only wrote a localStorage flag and
 * swapped in the browser — a purchase that never happened (and the browser itself was still dark behind
 * `per_site_kv`). That deception is gone: the KV view now shows an honest, non-deceptive "on the way"
 * preview. It makes NO purchase claim, exposes NO "Unlock"/buy control, and persists NO
 * "purchased/unlocked" flag. It keeps the genuine value proposition + a read-only live preview of the
 * site's REAL keys (so it's never a dead wall). When billing actually ships, wiring a real checkout is a
 * separate task; until then the control cannot imply a purchase occurred.
 *
 * Strategy: mock the embed bridge + virtualizer exactly as SiteTablesPanel.spec does, so the embedded
 * SiteTablesPanel mounts cleanly. localStorage is mocked so we can assert NO purchase flag is ever set.
 *
 * Cases:
 *  1. Sub-nav is concise — Tables + SQL + KV render; there is NO Advanced toggle and NO schema/seed/forms.
 *  2. Tables view shows the actions toolbar (Seed with AI / Import / New table / History) as buttons.
 *  3. An action button opens a modal overlay hosting the corresponding panel (Import shown here).
 *  4. SQL is a first-class entry — selecting it mounts the SQL navigator (textarea + run + Ask toggle).
 *  5. KV manager — shows the HONEST "not yet available" add-on preview, with NO price claim and NO
 *     buy/unlock control (the deceptive fake-purchase is gone; never a dead control).
 *  6. KV manager — REGRESSION: there is no clickable "Unlock" control, and merely rendering the KV view
 *     never writes a "purchased/unlocked" localStorage flag (nothing was bought, so nothing may pretend it).
 *  7. KV preview — a READ-ONLY live preview lists the site's REAL KV keys (never a dead wall): it asks the
 *     EXISTING per-site bridge (PS_RES_DETAIL kind:'kv', action:'list'), renders real key names read-only,
 *     shows an honest "empty so far" when there are none, and stays a clean card (no broken preview) when
 *     the flag is dark. No value reads, no writes from the preview.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, within, act, waitFor } from '@testing-library/react';
import React from 'react';

// ─── Embed bridge mock (mirrors SiteTablesPanel.spec) ───────────────────────────

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
  postToastToParent: vi.fn(),
  onParentMessage: onParentMessageSpy,
  requestDbLoadSample: vi.fn(async () => ({ type: 'PS_DB_LOAD_SAMPLE_RESULT', ok: true, tablesCreated: 0 })),
  requestDbAiSeed: vi.fn(async () => ({ type: 'PS_DB_AI_SEED_RESULT', ok: true, rowsInserted: 0 })),
}));

// SiteTablesPanel uses @tanstack/react-virtual — stub it (jsdom has no layout engine).
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: vi.fn(({ count }: { count: number }) => ({
    getVirtualItems: () => Array.from({ length: count }, (_, i) => ({ key: i, index: i, start: i * 34, size: 34 })),
    getTotalSize: () => count * 34,
  })),
}));

// ─── Import AFTER mocks ─────────────────────────────────────────────────────────
import { DatabasePanel } from '../DatabasePanel';

// ─── localStorage stub (deterministic KV-unlock pref) ───────────────────────────

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
  parentHandlers.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('DatabasePanel — consolidated per-site data surface (concise nav)', () => {
  it('renders a concise sub-nav — Tables + SQL + KV, no Advanced toggle, no schema/seed/forms entries', () => {
    render(<DatabasePanel />);

    expect(screen.getByTestId('panel-segnav-table')).toBeTruthy();
    expect(screen.getByTestId('panel-segnav-sql')).toBeTruthy();
    expect(screen.getByTestId('panel-segnav-kv')).toBeTruthy();

    // The removed entries + the removed Advanced toggle must NOT be present.
    expect(screen.queryByTestId('database-advanced-toggle')).toBeNull();
    expect(screen.queryByTestId('panel-segnav-schema')).toBeNull();
    expect(screen.queryByTestId('panel-segnav-seed')).toBeNull();
    expect(screen.queryByTestId('panel-segnav-forms')).toBeNull();
    expect(screen.queryByTestId('panel-segnav-import')).toBeNull();
    expect(screen.queryByTestId('panel-segnav-history')).toBeNull();
  });

  it('shows the Tables actions (New table / Import / History) as buttons in the embedded header Actions menu', () => {
    render(<DatabasePanel />);

    /*
     * The Tables view embeds SiteTablesPanel; its header hosts the single "Actions" dropdown that carries
     * the entries removed from the top nav (New Table / Import / History) — all real buttons. A manual
     * Refresh is NOT among them: the surface self-updates (per `real-time-data-no-manual-refresh`).
     */
    const actions = screen.getByTestId('sitedb-actions');
    expect(actions).toBeTruthy();
    fireEvent.click(actions);

    expect(screen.getByTestId('sitedb-action-new-table')).toBeTruthy();
    expect(screen.getByTestId('sitedb-action-import')).toBeTruthy();
    expect(screen.getByTestId('sitedb-action-history')).toBeTruthy();
    expect(screen.queryByTestId('sitedb-action-refresh')).toBeNull();
  });

  it('opens a modal overlay hosting the Import panel when the Import action is chosen', () => {
    render(<DatabasePanel />);

    // Open the embedded header Actions menu, then choose Import → DatabasePanel mounts the Import overlay.
    fireEvent.click(screen.getByTestId('sitedb-actions'));
    fireEvent.click(screen.getByTestId('sitedb-action-import'));

    const overlay = screen.getByTestId('database-action-overlay');
    expect(overlay).toBeTruthy();

    // The import surface mounts inside the overlay with its dropzone + paste affordance.
    expect(within(overlay).getByTestId('import-panel')).toBeTruthy();
    expect(within(overlay).getByTestId('import-dropzone')).toBeTruthy();
  });

  it('routes "New Table" through the SHARED schema overlay — never the local sitedb-create-table modal (money-path, GBP#2)', () => {
    render(<DatabasePanel />);

    // Open the embedded header Actions menu, then choose New Table.
    fireEvent.click(screen.getByTestId('sitedb-actions'));
    fireEvent.click(screen.getByTestId('sitedb-action-new-table'));

    // It MUST mount the shared DatabaseActionOverlay hosting the guided Schema builder…
    const overlay = screen.getByTestId('database-action-overlay');
    expect(overlay).toBeTruthy();
    expect(within(overlay).getByTestId('schema-builder')).toBeTruthy();

    // …and MUST NOT open SiteTablesPanel's OWN local create-table modal (the dead-end this fixes).
    expect(screen.queryByTestId('sitedb-create-table')).toBeNull();
  });

  it('routes the empty-launchpad "New table" tile through the SHARED schema overlay (never the local modal)', async () => {
    render(<DatabasePanel />);

    // Reply with an empty DB so the launchpad (with its New-table tile) renders.
    await waitFor(() => {
      const req = postToParentSpy.mock.calls.find(
        (c) => (c[0] as { type?: string })?.type === 'PS_SITEDB_TABLES_REQUEST',
      );
      expect(req).toBeTruthy();
    });

    const tablesReqId = postToParentSpy.mock.calls
      .map((c) => c[0])
      .reverse()
      .find((m: unknown) => (m as { type?: string })?.type === 'PS_SITEDB_TABLES_REQUEST') as {
      correlationId?: string;
    };

    await act(async () => {
      for (const handler of parentHandlers) {
        handler({
          type: 'PS_SITEDB_TABLES_RESPONSE',
          correlationId: tablesReqId?.correlationId,
          ok: true,
          databaseId: 'db',
          provisioned: true,
          tables: [],
        });
      }
    });

    fireEvent.click(screen.getByTestId('sitedb-empty-newtable'));

    const overlay = screen.getByTestId('database-action-overlay');
    expect(within(overlay).getByTestId('schema-builder')).toBeTruthy();
    expect(screen.queryByTestId('sitedb-create-table')).toBeNull();
  });

  it('opens the AI-seed panel overlay + asks the per-site bridge for the table list from the empty launchpad', async () => {
    render(<DatabasePanel />);

    // SiteTablesPanel fetches the table list on mount — reply with an empty DB so the launchpad renders.
    await waitFor(() => {
      const req = postToParentSpy.mock.calls.find(
        (c) => (c[0] as { type?: string })?.type === 'PS_SITEDB_TABLES_REQUEST',
      );
      expect(req).toBeTruthy();
    });

    const tablesReqId = postToParentSpy.mock.calls
      .map((c) => c[0])
      .reverse()
      .find((m: unknown) => (m as { type?: string })?.type === 'PS_SITEDB_TABLES_REQUEST') as {
      correlationId?: string;
    };

    await act(async () => {
      for (const handler of parentHandlers) {
        handler({
          type: 'PS_SITEDB_TABLES_RESPONSE',
          correlationId: tablesReqId?.correlationId,
          ok: true,
          databaseId: 'db',
          provisioned: true,
          tables: [],
        });
      }
    });

    // The empty-state launchpad's "Use AI to load sample data" tile fires onSeedWithAi → the AI-seed overlay.
    fireEvent.click(screen.getByTestId('sitedb-empty-seed'));

    const overlay = screen.getByTestId('database-action-overlay');
    expect(within(overlay).getByTestId('ai-seed-panel')).toBeTruthy();

    const tablesCall = postToParentSpy.mock.calls.find(
      (c) => (c[0] as { type?: string })?.type === 'PS_SITEDB_TABLES_REQUEST',
    );
    expect(tablesCall).toBeTruthy();
  });

  it('AI-Seed empty state is never a dead-end — its inline "Create Table" CTA opens the shared schema overlay', async () => {
    render(<DatabasePanel />);

    // Empty DB → the Tables launchpad renders; open the AI-seed overlay from it.
    await waitFor(() => {
      const req = postToParentSpy.mock.calls.find(
        (c) => (c[0] as { type?: string })?.type === 'PS_SITEDB_TABLES_REQUEST',
      );
      expect(req).toBeTruthy();
    });

    const firstTablesReqId = postToParentSpy.mock.calls
      .map((c) => c[0])
      .reverse()
      .find((m: unknown) => (m as { type?: string })?.type === 'PS_SITEDB_TABLES_REQUEST') as {
      correlationId?: string;
    };

    await act(async () => {
      for (const handler of parentHandlers) {
        handler({
          type: 'PS_SITEDB_TABLES_RESPONSE',
          correlationId: firstTablesReqId?.correlationId,
          ok: true,
          databaseId: 'db',
          provisioned: true,
          tables: [],
        });
      }
    });

    fireEvent.click(screen.getByTestId('sitedb-empty-seed'));

    // The AI-seed panel fetches tables on mount; answer with an empty DB → its "create a table first" state.
    await waitFor(() => {
      const seedReq = postToParentSpy.mock.calls
        .map((c) => c[0])
        .reverse()
        .find((m: unknown) => (m as { type?: string })?.type === 'PS_SITEDB_TABLES_REQUEST') as {
        correlationId?: string;
      };
      expect(seedReq).toBeTruthy();
    });

    const seedTablesReqId = postToParentSpy.mock.calls
      .map((c) => c[0])
      .reverse()
      .find((m: unknown) => (m as { type?: string })?.type === 'PS_SITEDB_TABLES_REQUEST') as {
      correlationId?: string;
    };

    await act(async () => {
      for (const handler of parentHandlers) {
        handler({
          type: 'PS_SITEDB_TABLES_RESPONSE',
          correlationId: seedTablesReqId?.correlationId,
          ok: true,
          databaseId: 'db',
          provisioned: true,
          tables: [],
        });
      }
    });

    // The empty AI-seed state MUST carry an inline Create-Table CTA (an owner is never stuck with no way out)…
    const cta = screen.getByTestId('seed-empty-create-table');
    expect(cta).toBeTruthy();
    fireEvent.click(cta);

    // …which routes to the SHARED schema overlay (not a dead note, not the local modal).
    const overlay = screen.getByTestId('database-action-overlay');
    expect(within(overlay).getByTestId('schema-builder')).toBeTruthy();
    expect(screen.queryByTestId('sitedb-create-table')).toBeNull();
  });

  it('SQL is a first-class entry — selecting it mounts the SQL navigator (textarea + run + Ask toggle)', () => {
    render(<DatabasePanel />);

    fireEvent.click(screen.getByTestId('panel-segnav-sql'));

    expect(screen.getByTestId('database-sql-textarea')).toBeTruthy();
    expect(screen.getByTestId('database-sql-ask-toggle')).toBeTruthy();

    const run = screen.getByTestId('database-sql-run');

    // Run is disabled until there's SQL to execute.
    expect((run as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByTestId('database-sql-textarea'), {
      target: { value: 'SELECT 1;' },
    });
    expect((screen.getByTestId('database-sql-run') as HTMLButtonElement).disabled).toBe(false);
  });

  it('KV manager shows the HONEST "not yet available" add-on preview — no price claim, no buy/unlock control', () => {
    render(<DatabasePanel />);

    fireEvent.click(screen.getByTestId('panel-segnav-kv'));

    const kv = screen.getByTestId('database-kv');

    // Honest status is always present — the owner is told plainly where this stands (never dead-air).
    const note = within(kv).getByTestId('database-kv-note');
    expect(note).toBeTruthy();

    // It states KV isn't yet available and that there's nothing to buy/set up here (no purchase claim).
    expect(note.textContent).toMatch(/yet available/i);
    expect(note.textContent).toMatch(/nothing to buy/i);

    /*
     * The deceptive fake-purchase is GONE: no "$10/mo" price promise and no buy/unlock control, because
     * there is no real checkout path (no configured price, no embed-bridge checkout message). A control
     * that implied a purchase would be a lie.
     */
    expect(within(kv).queryByTestId('database-kv-unlock')).toBeNull();
    expect(within(kv).queryByText('$10')).toBeNull();
    expect(within(kv).queryByText(/\/\s*month/i)).toBeNull();

    // No checkout/purchase is ever initiated over the bridge from the KV view.
    const purchaseMsg = postToParentSpy.mock.calls.find((c) =>
      /checkout|purchase|billing|unlock/i.test((c[0] as { type?: string })?.type ?? ''),
    );
    expect(purchaseMsg).toBeUndefined();
  });

  it('REGRESSION: rendering the KV view never writes a "purchased/unlocked" flag (nothing was bought)', () => {
    render(<DatabasePanel />);

    fireEvent.click(screen.getByTestId('panel-segnav-kv'));

    // There is no clickable buy/unlock control to fire a fake purchase…
    expect(screen.queryByTestId('database-kv-unlock')).toBeNull();

    /*
     * …and the dead "purchased" localStorage flag the old stub flipped is never set. The honest "not yet
     * available" card does not pretend a purchase occurred, so no key implies entitlement.
     */
    expect(store.ps_database_kv_unlocked).toBeUndefined();
    expect(Object.keys(store).some((k) => /unlock|purchas|paid|bought/i.test(k))).toBe(false);
  });
});

// ─── KV add-on preview — read-only live key list (never a dead wall) ────────────

/** Find the most recent `PS_RES_DETAIL_REQUEST` of a given kv action; returns its correlationId. */
function lastKvDetail(action: 'list' | 'get'): string | undefined {
  const msg = postToParentSpy.mock.calls
    .map((c) => c[0] as { type?: string; kind?: string; action?: string; correlationId?: string })
    .reverse()
    .find((m) => m?.type === 'PS_RES_DETAIL_REQUEST' && m?.kind === 'kv' && m?.action === action);

  return msg?.correlationId;
}

/** Replay a per-site KV `list` reply through every registered parent-message handler. */
async function replyKvList(
  correlationId: string | undefined,
  payload: { enabled?: boolean; error?: string; keys?: { name: string; expiration?: number }[] },
): Promise<void> {
  await act(async () => {
    for (const handler of parentHandlers) {
      handler({
        type: 'PS_RES_DETAIL_RESPONSE',
        correlationId,
        ok: !payload.error,
        kind: 'kv',
        action: 'list',
        ...(payload.enabled === undefined ? {} : { enabled: payload.enabled }),
        ...(payload.error ? { error: payload.error } : {}),
        ...(payload.error ? {} : { result: { ok: true, data: { keys: payload.keys ?? [], listComplete: true } } }),
      });
    }
  });
}

describe('DatabasePanel — KV add-on read-only preview (never a dead wall)', () => {
  it('lists the site REAL KV keys read-only via the existing PS_RES_DETAIL kv:list bridge', async () => {
    render(<DatabasePanel />);
    fireEvent.click(screen.getByTestId('panel-segnav-kv'));

    // The card must ASK the same per-site bridge KvBrowser uses — no new endpoint, read-only list.
    await waitFor(() => expect(lastKvDetail('list')).toBeTruthy());

    await replyKvList(lastKvDetail('list'), {
      keys: [{ name: 'feature:new-hero' }, { name: 'session:abc123', expiration: 4102444800 }],
    });

    // Real key names render inside the read-only preview; the honest status note stands beside them.
    const preview = screen.getByTestId('database-kv-preview');
    expect(within(preview).getByText('feature:new-hero')).toBeTruthy();
    expect(within(preview).getByText('session:abc123')).toBeTruthy();
    expect(screen.getByTestId('database-kv-note')).toBeTruthy();

    // No deceptive buy/unlock control beside the preview.
    expect(screen.queryByTestId('database-kv-unlock')).toBeNull();

    // Read-only: the preview must NOT read a value (no kv:get) and must NOT expose write controls.
    expect(lastKvDetail('get')).toBeUndefined();
    expect(within(preview).queryByTestId('database-kv-preview-add')).toBeNull();
    expect(within(preview).queryByTestId('database-kv-preview-delete')).toBeNull();
  });

  it('shows an honest empty preview when the KV store has no keys yet (not a dead control)', async () => {
    render(<DatabasePanel />);
    fireEvent.click(screen.getByTestId('panel-segnav-kv'));

    await waitFor(() => expect(lastKvDetail('list')).toBeTruthy());
    await replyKvList(lastKvDetail('list'), { keys: [] });

    expect(screen.getByTestId('database-kv-preview-empty')).toBeTruthy();

    // Still an honest status note beneath the empty state — no fake buy control.
    expect(screen.getByTestId('database-kv-note')).toBeTruthy();
    expect(screen.queryByTestId('database-kv-unlock')).toBeNull();
  });

  it('stays a clean card (no broken preview) when per_site_kv is dark', async () => {
    render(<DatabasePanel />);
    fireEvent.click(screen.getByTestId('panel-segnav-kv'));

    await waitFor(() => expect(lastKvDetail('list')).toBeTruthy());

    // Dark flag → enabled:false. The preview hides entirely; the honest status note remains.
    await replyKvList(lastKvDetail('list'), { enabled: false });

    expect(screen.queryByTestId('database-kv-preview')).toBeNull();
    expect(screen.queryByTestId('database-kv-preview-empty')).toBeNull();
    expect(screen.getByTestId('database-kv-note')).toBeTruthy();
    expect(screen.queryByTestId('database-kv-unlock')).toBeNull();
  });
});
