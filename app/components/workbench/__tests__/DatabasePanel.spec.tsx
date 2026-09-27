// @vitest-environment jsdom
/**
 * DatabasePanel.spec.tsx
 *
 * Unit tests for the consolidated per-site Database panel (FIRE 1 — Brian 2026-09-27).
 *
 * The panel is the ONE data surface: a sub-nav BUTTON bar (Table-view · SQL navigator · KV manager)
 * over the site's OWN per-site D1. Table-view renders SiteTablesPanel; SQL navigator is tucked behind
 * a remembered Advanced/Developer toggle; KV manager is a $10/mo locked-upsell (honest, never a dead
 * control) until purchased.
 *
 * Strategy: mock the embed bridge + virtualizer exactly as SiteTablesPanel.spec does, so the embedded
 * SiteTablesPanel mounts cleanly. localStorage is mocked so the Advanced preference is deterministic.
 *
 * Cases:
 *  1. Default sub-nav — Table-view + KV manager buttons render; SQL navigator is hidden (tucked).
 *  2. Advanced toggle — turning it on reveals the SQL navigator button + surface; the pref persists.
 *  3. KV manager — shows the $10/mo locked-upsell card with an Unlock control (never a live browser).
 *  4. SQL navigator — the run control + textarea render once Advanced is on.
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
  onParentMessage: onParentMessageSpy,
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

// ─── localStorage stub (deterministic Advanced pref) ────────────────────────────

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

describe('DatabasePanel — consolidated per-site data surface', () => {
  it('renders the sub-nav with Table-view + KV manager, SQL navigator tucked by default', () => {
    render(<DatabasePanel />);

    expect(screen.getByTestId('database-subnav-table')).toBeTruthy();
    expect(screen.getByTestId('database-subnav-kv')).toBeTruthy();

    // SQL navigator is behind the Advanced toggle — not present until enabled.
    expect(screen.queryByTestId('database-subnav-sql')).toBeNull();

    // The Advanced toggle itself is present and off by default.
    const toggle = screen.getByTestId('database-advanced-toggle');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('reveals the SQL navigator when Advanced is enabled, and persists the preference', () => {
    render(<DatabasePanel />);

    fireEvent.click(screen.getByTestId('database-advanced-toggle'));

    // SQL sub-nav now visible; toggle reflects the on state; pref persisted.
    expect(screen.getByTestId('database-subnav-sql')).toBeTruthy();
    expect(screen.getByTestId('database-advanced-toggle').getAttribute('aria-checked')).toBe('true');
    expect(store.ps_database_advanced).toBe('1');
  });

  it('restores the Advanced preference from localStorage on mount', () => {
    store.ps_database_advanced = '1';
    render(<DatabasePanel />);

    // SQL sub-nav is visible immediately because the pref was remembered.
    expect(screen.getByTestId('database-subnav-sql')).toBeTruthy();
  });

  it('KV manager shows the $10/mo locked-upsell (honest, not a live browser)', () => {
    render(<DatabasePanel />);

    fireEvent.click(screen.getByTestId('database-subnav-kv'));

    const kv = screen.getByTestId('database-kv');
    expect(within(kv).getByText('$10')).toBeTruthy();
    expect(within(kv).getByTestId('database-kv-unlock')).toBeTruthy();

    // Clicking Unlock surfaces a note (seam for FIRE 3 checkout), never dead-air.
    fireEvent.click(screen.getByTestId('database-kv-unlock'));
    expect(screen.getByTestId('database-kv-note')).toBeTruthy();
  });

  it('SQL navigator renders the query textarea + run control once Advanced is on', () => {
    store.ps_database_advanced = '1';
    render(<DatabasePanel />);

    fireEvent.click(screen.getByTestId('database-subnav-sql'));

    expect(screen.getByTestId('database-sql-textarea')).toBeTruthy();
    const run = screen.getByTestId('database-sql-run');
    // Run is disabled until there's SQL to execute.
    expect((run as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByTestId('database-sql-textarea'), {
      target: { value: 'SELECT 1;' },
    });
    expect((screen.getByTestId('database-sql-run') as HTMLButtonElement).disabled).toBe(false);
  });
});
