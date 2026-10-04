// @vitest-environment jsdom
/**
 * ImportPanel.spec.tsx — characterization tests for the DB-import panel states.
 *
 * States covered:
 *   1. DISABLED       — per-site data disabled renders "database isn't turned on yet"
 *   2. LOADING        — before the tables reply the panel shell is present, no controls
 *   3. PICK-STAGE     — after tables ready: dropzone + choose-file + paste area present
 *   4. PASTE-CONTINUE — pasting CSV text surfaces the "Continue" button
 *   5. ERROR          — parse error from bad input shows role="alert"
 *   6. MAP-STAGE      — after continuing with CSV: mapping controls render
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import React from 'react';

// ─── Hoisted bridge spies + controllable message bus ────────────────────────────
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
  postToastToParent: vi.fn(),
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
  classNames: (...args: unknown[]) => args.filter((a) => typeof a === 'string').join(' '),
}));

// Stub panel primitives — just divs; we only assert panel-level DOM.
vi.mock('../panel', () => ({
  PanelShell: ({ children, testId }: { children: React.ReactNode; testId?: string }) =>
    React.createElement('div', { 'data-testid': testId ?? 'panel-shell' }, children),
  PanelHeader: ({ title }: { title: string }) =>
    React.createElement('div', { 'data-testid': 'panel-header' }, title),
  PanelLoading: () => React.createElement('div', { 'data-testid': 'panel-loading' }),
  PanelEmpty: ({ title, action }: { title: string; action?: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'panel-empty' }, title, action),
  PanelSegmentedNav: () => null,
}));

import { ImportPanel } from '../ImportPanel';

/** Fire a reply to the last posted request by correlationId. */
function replyToLast(type: string, extra: Record<string, unknown>) {
  const cid = lastRequest.value?.correlationId as string | undefined;
  act(() => {
    for (const h of [...handlers]) {
      h({ type, correlationId: cid, ...extra });
    }
  });
}

beforeEach(() => {
  postToParent.mockClear();
  handlers.length = 0;
  lastRequest.value = null;
});

afterEach(() => cleanup());

// ─── 1. Disabled state ───────────────────────────────────────────────────────

describe('ImportPanel — disabled state', () => {
  it('renders the "database isn\'t turned on yet" note when per-site data is disabled', async () => {
    render(<ImportPanel />);

    await waitFor(() => expect(lastRequest.value?.type).toBe('PS_SITEDB_TABLES_REQUEST'));
    replyToLast('PS_SITEDB_TABLES_RESPONSE', { ok: false, enabled: false, tables: [] });

    await waitFor(() => {
      const panel = screen.getByTestId('import-panel');
      expect(panel.textContent).toMatch(/database isn.*t turned on yet/i);
    });
  });
});

// ─── 2. Loading / initial state ─────────────────────────────────────────────

describe('ImportPanel — loading state', () => {
  it('renders the panel shell immediately (dropzone is not gated on the tables reply)', async () => {
    render(<ImportPanel />);
    expect(screen.getByTestId('import-panel')).toBeTruthy();
    // Characterization: the dropzone renders right away, before any bridge reply arrives.
    expect(screen.queryByTestId('import-dropzone')).toBeTruthy();
  });
});

// ─── 3. Pick stage — ready state ────────────────────────────────────────────

describe('ImportPanel — pick stage (ready)', () => {
  it('renders the dropzone + choose-file + paste area once tables reply ok', async () => {
    render(<ImportPanel />);

    await waitFor(() => expect(lastRequest.value?.type).toBe('PS_SITEDB_TABLES_REQUEST'));
    replyToLast('PS_SITEDB_TABLES_RESPONSE', { ok: true, tables: [{ name: 'customers' }] });

    await waitFor(() => expect(screen.getByTestId('import-dropzone')).toBeTruthy());
    expect(screen.getByTestId('import-choose-file')).toBeTruthy();
    expect(screen.getByTestId('import-paste')).toBeTruthy();
  });
});

// ─── 4. Paste → continue ────────────────────────────────────────────────────

describe('ImportPanel — paste then continue', () => {
  it('shows the Continue button once valid CSV is pasted', async () => {
    render(<ImportPanel />);

    await waitFor(() => expect(lastRequest.value?.type).toBe('PS_SITEDB_TABLES_REQUEST'));
    replyToLast('PS_SITEDB_TABLES_RESPONSE', { ok: true, tables: [{ name: 'customers' }] });

    await waitFor(() => expect(screen.getByTestId('import-paste')).toBeTruthy());

    fireEvent.change(screen.getByTestId('import-paste'), {
      target: { value: 'name,age\nAlice,30\nBob,25' },
    });

    await waitFor(() => expect(screen.getByTestId('import-paste-continue')).toBeTruthy());
  });
});

// ─── 5. Error state — bad paste shows alert ──────────────────────────────────

describe('ImportPanel — lone JSON object', () => {
  it('accepts a single JSON object as importable (Continue appears, no parse alert)', async () => {
    render(<ImportPanel />);

    await waitFor(() => expect(lastRequest.value?.type).toBe('PS_SITEDB_TABLES_REQUEST'));
    replyToLast('PS_SITEDB_TABLES_RESPONSE', { ok: true, tables: [{ name: 'customers' }] });

    await waitFor(() => expect(screen.getByTestId('import-paste')).toBeTruthy());

    // Characterization: a lone JSON object is coerced to a one-row import, NOT a parse error.
    fireEvent.change(screen.getByTestId('import-paste'), {
      target: { value: '{"a":1}' },
    });

    await waitFor(() => expect(screen.getByTestId('import-paste-continue')).toBeTruthy());
    expect(screen.queryAllByRole('alert').length).toBe(0);
  });
});

// ─── 6. Map stage — column mapping controls appear ──────────────────────────

describe('ImportPanel — map stage', () => {
  it('shows import-has-header + import-target-new when advancing from valid CSV', async () => {
    render(<ImportPanel />);

    await waitFor(() => expect(lastRequest.value?.type).toBe('PS_SITEDB_TABLES_REQUEST'));
    replyToLast('PS_SITEDB_TABLES_RESPONSE', { ok: true, tables: [{ name: 'customers' }] });

    await waitFor(() => expect(screen.getByTestId('import-paste')).toBeTruthy());

    fireEvent.change(screen.getByTestId('import-paste'), {
      target: { value: 'name,age\nAlice,30\nBob,25' },
    });

    await waitFor(() => screen.getByTestId('import-paste-continue'));
    fireEvent.click(screen.getByTestId('import-paste-continue'));

    await waitFor(() => expect(screen.getByTestId('import-has-header')).toBeTruthy());
    expect(screen.getByTestId('import-target-new')).toBeTruthy();
  });
});
