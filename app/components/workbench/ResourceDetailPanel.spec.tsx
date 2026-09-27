// @vitest-environment jsdom
/**
 * ResourceDetailPanel.spec.tsx — TDD spec for the WRITE-UI slice of the generic resource detail panel.
 *
 * The panel talks to the parent admin over `postMessage`; we mock `~/lib/embed/embedded-mode` so the
 * test drives the bridge deterministically (no real iframe). The heavy `ConfirmationDialog` (framer-motion
 * + react-window) is stubbed to a lightweight button so the test stays about the write-control LOGIC.
 *
 * Covers:
 *   1. supports-driven controls — a KV target renders Provision + put + delete controls; a read-only
 *      (analytics_engine) target renders NO write strip.
 *   2. Provision — the button sends PS_RES_MUTATE_REQUEST { action:'provision', confirm:true } AFTER the
 *      confirm dialog (provision is destructive/billable-gated), and renders the success outcome.
 *   3. Destructive delete — opens the confirm dialog, then sends { action:'delete', confirm:true }.
 *   4. Honest confirmation_required — a mutate result of ok:false/confirmation_required renders the
 *      "Confirmation needed" outcome (never a fake success).
 *
 * `vi.mock` factories hoist above the module body, so the spies they close over are `vi.hoisted`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';

// ─── Hoisted bridge spies + a controllable message bus ──────────────────────────
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
      if (i >= 0) handlers.splice(i, 1);
    };
  },
}));

// Stub the heavy ConfirmationDialog (framer-motion + react-window) with a minimal, testable version.
vi.mock('~/components/ui/Dialog', () => ({
  ConfirmationDialog: ({ isOpen, title, onConfirm, onClose, confirmLabel }: { isOpen: boolean; title: string; onConfirm: () => void; onClose: () => void; confirmLabel?: string }) =>
    isOpen
      ? React.createElement('div', { role: 'dialog', 'aria-label': title }, [
          React.createElement('button', { key: 'ok', 'data-testid': 'confirm-ok', onClick: onConfirm }, confirmLabel ?? 'Confirm'),
          React.createElement('button', { key: 'no', 'data-testid': 'confirm-cancel', onClick: onClose }, 'Cancel'),
        ])
      : null,
}));

vi.mock('~/utils/classNames', () => ({
  classNames: (...a: unknown[]) => a.filter((x) => typeof x === 'string').join(' '),
}));

import { ResourceDetailPanel, buildCsv } from './ResourceDetailPanel';

// ─── Bridge helpers ──────────────────────────────────────────────────────────────

/** Reply to the last-posted request by correlationId with a PS_RES_*_RESPONSE. */
function replyToLast(type: string, extra: Record<string, unknown>) {
  const cid = lastRequest.value?.correlationId as string | undefined;
  act(() => {
    for (const h of [...handlers]) h({ type, correlationId: cid, ...extra });
  });
}

/** The last request the panel posted (detail or mutate). */
function last(): Record<string, unknown> | null {
  return lastRequest.value;
}

beforeEach(() => {
  postToParent.mockClear();
  handlers.length = 0;
  lastRequest.value = null;
});

afterEach(() => cleanup());

// ── 1. supports-driven controls ───────────────────────────────────────────────────

describe('supports-driven write controls', () => {
  it('renders the write strip with Provision for a provisionable (kv) kind', async () => {
    render(<ResourceDetailPanel target={{ kind: 'kv', environment: 'production' }} onBack={() => {}} />);

    // The panel loads `list` on mount → answer with an empty namespace.
    await waitFor(() => expect(last()?.type).toBe('PS_RES_DETAIL_REQUEST'));
    replyToLast('PS_RES_DETAIL_RESPONSE', { ok: true, result: { ok: true, data: { keys: [], listComplete: true } } });

    await waitFor(() => expect(screen.getByTestId('resource-detail-write')).toBeTruthy());
    expect(screen.getByTestId('resource-mutate-provision')).toBeTruthy();
    // KV put + delete forms are present.
    expect(screen.getByTestId('resource-mutate-kv-put')).toBeTruthy();
    expect(screen.getByTestId('resource-mutate-key-delete')).toBeTruthy();
  });

  it('renders NO write strip for a read-only kind (analytics_engine, mutations: [])', async () => {
    render(<ResourceDetailPanel target={{ kind: 'analytics_engine', environment: 'production' }} onBack={() => {}} />);

    await waitFor(() => expect(last()?.type).toBe('PS_RES_DETAIL_REQUEST'));
    replyToLast('PS_RES_DETAIL_RESPONSE', { ok: true, result: { ok: true, data: { available: false } } });

    await waitFor(() => expect(screen.getByTestId('resource-detail')).toBeTruthy());
    expect(screen.queryByTestId('resource-detail-write')).toBeNull();
  });
});

// ── 2. Provision (confirm-gated) ──────────────────────────────────────────────────

describe('provision', () => {
  it('opens the confirm dialog then sends PS_RES_MUTATE_REQUEST { action:provision, confirm:true } and renders success', async () => {
    render(<ResourceDetailPanel target={{ kind: 'kv', environment: 'production', availability: 'available' }} onBack={() => {}} />);

    await waitFor(() => expect(last()?.type).toBe('PS_RES_DETAIL_REQUEST'));
    // An "available to add" resource resolves not_registered on read.
    replyToLast('PS_RES_DETAIL_RESPONSE', { ok: true, result: { ok: false, error: { code: 'not_registered', message: 'Not connected yet.' } } });

    await waitFor(() => expect(screen.getByTestId('resource-mutate-provision')).toBeTruthy());
    fireEvent.click(screen.getByTestId('resource-mutate-provision'));

    // Provision is confirm-gated → the dialog appears; the mutate must NOT have been posted yet.
    await waitFor(() => expect(screen.getByTestId('confirm-ok')).toBeTruthy());
    const detailPosts = postToParent.mock.calls.filter((c) => (c[0] as { type: string }).type === 'PS_RES_MUTATE_REQUEST');
    expect(detailPosts.length).toBe(0);

    fireEvent.click(screen.getByTestId('confirm-ok'));

    await waitFor(() => expect(last()?.type).toBe('PS_RES_MUTATE_REQUEST'));
    const req = last()!;
    expect(req.action).toBe('provision');
    expect(req.confirm).toBe(true);
    expect(req.kind).toBe('kv');

    // Answer the mutate with a success → the outcome card renders.
    replyToLast('PS_RES_MUTATE_RESPONSE', { ok: true, result: { ok: true, data: { action: 'provision', resourceId: 'ns-new', created: true, displayName: 'KV namespace' } } });
    await waitFor(() => expect(screen.getByTestId('resource-mutate-outcome')).toBeTruthy());
    expect(screen.getByTestId('resource-mutate-outcome').textContent).toContain('succeeded');
  });
});

// ── 3. Destructive delete (confirm-gated) ─────────────────────────────────────────

describe('destructive delete', () => {
  it('opens the confirm dialog then sends { action:delete, input:{key}, confirm:true }', async () => {
    render(<ResourceDetailPanel target={{ kind: 'kv', environment: 'production' }} onBack={() => {}} />);

    await waitFor(() => expect(last()?.type).toBe('PS_RES_DETAIL_REQUEST'));
    replyToLast('PS_RES_DETAIL_RESPONSE', { ok: true, result: { ok: true, data: { keys: [{ name: 'greeting' }], listComplete: true } } });

    await waitFor(() => expect(screen.getByTestId('resource-mutate-key-delete')).toBeTruthy());

    // Type a key + click Delete → confirm dialog appears; no mutate yet.
    const keyInput = screen.getByTestId('resource-mutate-key-delete').querySelector('input') as HTMLInputElement;
    fireEvent.change(keyInput, { target: { value: 'greeting' } });
    const deleteBtn = screen.getByTestId('resource-mutate-key-delete').querySelector('button') as HTMLButtonElement;
    fireEvent.click(deleteBtn);

    await waitFor(() => expect(screen.getByTestId('confirm-ok')).toBeTruthy());
    expect(postToParent.mock.calls.filter((c) => (c[0] as { type: string }).type === 'PS_RES_MUTATE_REQUEST').length).toBe(0);

    fireEvent.click(screen.getByTestId('confirm-ok'));
    await waitFor(() => expect(last()?.type).toBe('PS_RES_MUTATE_REQUEST'));
    const req = last()!;
    expect(req.action).toBe('delete');
    expect(req.confirm).toBe(true);
    expect((req.input as { key: string }).key).toBe('greeting');
  });
});

// ── 4. Honest confirmation_required ───────────────────────────────────────────────

describe('honest outcomes', () => {
  it('renders "Confirmation needed" when the adapter returns ok:false / confirmation_required', async () => {
    render(<ResourceDetailPanel target={{ kind: 'kv', environment: 'production' }} onBack={() => {}} />);

    await waitFor(() => expect(last()?.type).toBe('PS_RES_DETAIL_REQUEST'));
    replyToLast('PS_RES_DETAIL_RESPONSE', { ok: true, result: { ok: true, data: { keys: [], listComplete: true } } });

    await waitFor(() => expect(screen.getByTestId('resource-mutate-kv-put')).toBeTruthy());

    // Write a key (put is NOT in DESTRUCTIVE_ACTIONS → runs immediately, no dialog).
    const putForm = screen.getByTestId('resource-mutate-kv-put');
    fireEvent.change(putForm.querySelector('input') as HTMLInputElement, { target: { value: 'greeting' } });
    fireEvent.change(putForm.querySelector('textarea') as HTMLTextAreaElement, { target: { value: 'hola' } });
    fireEvent.click(putForm.querySelector('button') as HTMLButtonElement);

    await waitFor(() => expect(last()?.type).toBe('PS_RES_MUTATE_REQUEST'));
    expect(last()!.action).toBe('put');

    // The server says the key exists → confirmation_required. The panel must show it honestly (not success).
    replyToLast('PS_RES_MUTATE_RESPONSE', {
      ok: true,
      result: { ok: false, error: { code: 'confirmation_required', message: 'KV key "greeting" already exists — writing overwrites it.' } },
    });

    await waitFor(() => expect(screen.getByTestId('resource-mutate-outcome')).toBeTruthy());
    expect(screen.getByTestId('resource-mutate-outcome').textContent).toContain('Confirmation needed');
  });
});

// ── 5. Rich cell formatting (generic collection rows) ───────────────────────────────

describe('rich cell formatting', () => {
  it('formats numbers, json, booleans, and null in the collection table', async () => {
    render(<ResourceDetailPanel target={{ kind: 'kv', environment: 'production' }} onBack={() => {}} />);

    await waitFor(() => expect(last()?.type).toBe('PS_RES_DETAIL_REQUEST'));
    // A generic collection with a numeric, a nested-object (json), a boolean, and a null field.
    replyToLast('PS_RES_DETAIL_RESPONSE', {
      ok: true,
      result: {
        ok: true,
        data: {
          items: [{ count: 1234567, meta: { a: 1 }, active: false, note: null }],
        },
      },
    });

    await waitFor(() => expect(screen.getByTestId('resource-detail-table')).toBeTruthy());
    const cells = screen.getByTestId('resource-detail-row').querySelectorAll('td');

    // number → locale-grouped, json → pretty-printed (shared field-type formatter), boolean false →
    // "false" (not hidden the way SQLite ✓ would), null → em-dash.
    expect(cells[0].textContent).toBe((1234567).toLocaleString());
    expect(cells[1].textContent).toBe(JSON.stringify({ a: 1 }, null, 2));
    expect(cells[2].textContent).toBe('false');
    expect(cells[3].textContent).toBe('—');
    // The null cell advertises "null" via its title (honest empty, not a real value).
    expect(cells[3].getAttribute('title')).toBe('null');
  });
});

// ── 6. Row-detail drawer (open / Esc-close / focus-restore) ─────────────────────────

describe('row-detail drawer', () => {
  it('opens the drawer on row click, closes on Esc, and restores focus to the row', async () => {
    render(<ResourceDetailPanel target={{ kind: 'kv', environment: 'production' }} onBack={() => {}} />);

    await waitFor(() => expect(last()?.type).toBe('PS_RES_DETAIL_REQUEST'));
    replyToLast('PS_RES_DETAIL_RESPONSE', {
      ok: true,
      result: { ok: true, data: { items: [{ id: 'row-a', value: 42 }] } },
    });

    await waitFor(() => expect(screen.getByTestId('resource-detail-row')).toBeTruthy());
    const row = screen.getByTestId('resource-detail-row') as HTMLElement;

    // Focus + click the row → the drawer opens showing the row's full field set.
    act(() => row.focus());
    fireEvent.click(row);

    await waitFor(() => expect(screen.getByTestId('resource-detail-row-drawer')).toBeTruthy());
    const drawer = screen.getByTestId('resource-detail-row-drawer');
    expect(drawer.textContent).toContain('Id');
    expect(drawer.textContent).toContain('row-a');
    expect(drawer.textContent).toContain('Value');
    expect(drawer.getAttribute('title')).toBeNull(); // sanity: it's the drawer, not a cell

    // Esc closes the drawer and restores focus to the invoking row.
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });

    await waitFor(() => expect(screen.queryByTestId('resource-detail-row-drawer')).toBeNull());
    expect(document.activeElement).toBe(row);
  });

  it('closes the drawer via the close button', async () => {
    render(<ResourceDetailPanel target={{ kind: 'kv', environment: 'production' }} onBack={() => {}} />);

    await waitFor(() => expect(last()?.type).toBe('PS_RES_DETAIL_REQUEST'));
    replyToLast('PS_RES_DETAIL_RESPONSE', {
      ok: true,
      result: { ok: true, data: { items: [{ id: 'row-b' }] } },
    });

    await waitFor(() => expect(screen.getByTestId('resource-detail-row')).toBeTruthy());
    fireEvent.click(screen.getByTestId('resource-detail-row'));

    await waitFor(() => expect(screen.getByTestId('resource-detail-row-drawer')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Close'));

    await waitFor(() => expect(screen.queryByTestId('resource-detail-row-drawer')).toBeNull());
  });
});

// ── 7. CSV export (RFC-4180) ────────────────────────────────────────────────────────

describe('CSV export', () => {
  it('buildCsv quotes values containing commas, quotes, and newlines (RFC-4180)', () => {
    const csv = buildCsv(
      ['name', 'note', 'qty'],
      [
        { name: 'Ada, Lovelace', note: 'she said "hi"', qty: 3 },
        { name: 'line1\nline2', note: null, qty: 0 },
      ],
    );

    const lines = csv.split('\n');
    // Header (no special chars → unquoted).
    expect(lines[0]).toBe('name,note,qty');
    // Comma → quoted; embedded double-quote → doubled + wrapped.
    expect(lines[1]).toBe('"Ada, Lovelace","she said ""hi""",3');
    // A newline inside a field quotes it, so the record spans two physical lines; null → empty.
    expect(csv).toContain('"line1\nline2",,0');
    // Trailing newline terminates the last record.
    expect(csv.endsWith('\n')).toBe(true);
  });

  it('renders an Export CSV button on a collection view', async () => {
    render(<ResourceDetailPanel target={{ kind: 'kv', environment: 'production' }} onBack={() => {}} />);

    await waitFor(() => expect(last()?.type).toBe('PS_RES_DETAIL_REQUEST'));
    replyToLast('PS_RES_DETAIL_RESPONSE', {
      ok: true,
      result: { ok: true, data: { items: [{ id: 'x', n: 1 }] } },
    });

    await waitFor(() => expect(screen.getByTestId('resource-detail-export-csv')).toBeTruthy());
    // Clicking is fail-soft even without URL.createObjectURL in jsdom (never throws).
    expect(() => fireEvent.click(screen.getByTestId('resource-detail-export-csv'))).not.toThrow();
  });
});
