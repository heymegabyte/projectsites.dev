// @vitest-environment jsdom
/**
 * DatabasePanel.spec.tsx
 *
 * Unit tests for the consolidated per-site Database panel (Brian 2026-09-27 — menu cleanup FIRE).
 *
 * The panel is the ONE data surface: a CONCISE sub-nav BUTTON bar (Tables · SQL · KV) over the site's
 * OWN per-site D1. Tables renders SiteTablesPanel (+ an actions toolbar: Seed with AI / Import / New
 * table / History as buttons, NOT nav entries); SQL is a normal always-visible entry (no Advanced
 * toggle); KV is a $10/mo locked-upsell (honest, never a dead control) until purchased.
 *
 * Strategy: mock the embed bridge + virtualizer exactly as SiteTablesPanel.spec does, so the embedded
 * SiteTablesPanel mounts cleanly. localStorage is mocked so the KV-unlock preference is deterministic.
 *
 * Cases:
 *  1. Sub-nav is concise — Tables + SQL + KV render; there is NO Advanced toggle and NO schema/seed/forms.
 *  2. Tables view shows the actions toolbar (Seed with AI / Import / New table / History) as buttons.
 *  3. An action button opens a modal overlay hosting the corresponding panel (Import shown here).
 *  4. SQL is a first-class entry — selecting it mounts the SQL navigator (textarea + run + Ask toggle).
 *  5. KV manager — shows the $10/mo locked-upsell with an Unlock control (never a dead control).
 *  6. KV manager — clicking Unlock swaps the upsell for the REAL per-site KV browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
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
    getVirtualItems: () =>
      Array.from({ length: count }, (_, i) => ({ key: i, index: i, start: i * 34, size: 34 })),
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

    expect(screen.getByTestId('database-subnav-table')).toBeTruthy();
    expect(screen.getByTestId('database-subnav-sql')).toBeTruthy();
    expect(screen.getByTestId('database-subnav-kv')).toBeTruthy();

    // The removed entries + the removed Advanced toggle must NOT be present.
    expect(screen.queryByTestId('database-advanced-toggle')).toBeNull();
    expect(screen.queryByTestId('database-subnav-schema')).toBeNull();
    expect(screen.queryByTestId('database-subnav-seed')).toBeNull();
    expect(screen.queryByTestId('database-subnav-forms')).toBeNull();
    expect(screen.queryByTestId('database-subnav-import')).toBeNull();
    expect(screen.queryByTestId('database-subnav-history')).toBeNull();
  });

  it('shows the Tables actions toolbar (Seed with AI / Import / New table / History) as buttons', () => {
    render(<DatabasePanel />);

    // Tables is the default view; its actions toolbar hosts the entries removed from the nav.
    expect(screen.getByTestId('database-tables-toolbar')).toBeTruthy();
    expect(screen.getByTestId('database-action-seed')).toBeTruthy();
    expect(screen.getByTestId('database-action-import')).toBeTruthy();
    expect(screen.getByTestId('database-action-schema')).toBeTruthy();
    expect(screen.getByTestId('database-action-history')).toBeTruthy();
  });

  it('opens a modal overlay hosting the Import panel when the Import action is clicked', () => {
    render(<DatabasePanel />);

    fireEvent.click(screen.getByTestId('database-action-import'));

    const overlay = screen.getByTestId('database-action-overlay');
    expect(overlay).toBeTruthy();
    // The import surface mounts inside the overlay with its dropzone + paste affordance.
    expect(within(overlay).getByTestId('import-panel')).toBeTruthy();
    expect(within(overlay).getByTestId('import-dropzone')).toBeTruthy();
  });

  it('opens the AI-seed panel overlay + asks the per-site bridge for the table list when Seed action is clicked', () => {
    render(<DatabasePanel />);

    fireEvent.click(screen.getByTestId('database-action-seed'));

    const overlay = screen.getByTestId('database-action-overlay');
    expect(within(overlay).getByTestId('ai-seed-panel')).toBeTruthy();
    const tablesCall = postToParentSpy.mock.calls.find(
      (c) => (c[0] as { type?: string })?.type === 'PS_SITEDB_TABLES_REQUEST',
    );
    expect(tablesCall).toBeTruthy();
  });

  it('SQL is a first-class entry — selecting it mounts the SQL navigator (textarea + run + Ask toggle)', () => {
    render(<DatabasePanel />);

    fireEvent.click(screen.getByTestId('database-subnav-sql'));

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

  it('KV manager shows the $10/mo locked-upsell (honest, not a dead control)', () => {
    render(<DatabasePanel />);

    fireEvent.click(screen.getByTestId('database-subnav-kv'));

    const kv = screen.getByTestId('database-kv');
    expect(within(kv).getByText('$10')).toBeTruthy();
    expect(within(kv).getByTestId('database-kv-unlock')).toBeTruthy();
    // The honest note is always present on the locked card (never dead-air).
    expect(within(kv).getByTestId('database-kv-note')).toBeTruthy();
  });

  it('KV manager swaps the upsell for the REAL per-site KV browser once unlocked', () => {
    render(<DatabasePanel />);

    fireEvent.click(screen.getByTestId('database-subnav-kv'));
    fireEvent.click(screen.getByTestId('database-kv-unlock'));

    // The locked-upsell card is gone; the real per-site KV browser is mounted (recycled KvBrowser).
    expect(screen.queryByTestId('database-kv')).toBeNull();
    expect(screen.getByTestId('database-kv-browser')).toBeTruthy();
    // The browser lists keys over the per-site bridge (PS_RES_DETAIL kind:'kv', action:'list').
    const listCall = postToParentSpy.mock.calls.find(
      (c) => (c[0] as { type?: string; kind?: string })?.type === 'PS_RES_DETAIL_REQUEST',
    );
    expect(listCall).toBeTruthy();
    expect((listCall?.[0] as { kind?: string })?.kind).toBe('kv');
    // The unlock persists.
    expect(store.ps_database_kv_unlocked).toBe('1');
  });
});
