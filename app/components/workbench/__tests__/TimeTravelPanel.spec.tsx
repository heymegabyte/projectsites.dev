// @vitest-environment jsdom
/**
 * TimeTravelPanel.spec.tsx — characterization tests for the DB time-travel panel.
 *
 * States covered:
 *   1. LOADING      — spinner present before the bridge reply arrives.
 *   2. DISABLED     — enabled:false reply → tt-disabled shown, tt-current absent.
 *   3. ERROR        — reply.error set or result.ok=false → loading clears, tt-current shown.
 *   4. READY        — ok:true, bookmark present → tt-current, label/save controls, scrubber.
 *   5. RESTORE CONFIRM — clicking Restore on a saved point opens tt-confirm modal.
 *   6. RESTORE CANCEL  — Cancel closes the modal.
 *   7. RESTORE SUCCESS — typing RESTORE + Restore now → tt-restore-result shown.
 *   8. SAVE SNAPSHOT   — Create snapshot adds a tt-saved-row entry.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import React from 'react';

// ─── Hoisted bridge spies ──────────────────────────────────────────────────────
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
      if (i >= 0) handlers.splice(i, 1);
    };
  },
}));

vi.mock('~/utils/classNames', () => ({
  classNames: (...args: unknown[]) => args.filter((a) => typeof a === 'string').join(' '),
}));

// Stub panel primitives — thin divs; only assert panel-level DOM.
vi.mock('../panel', () => ({
  PanelShell: ({ children, testId }: { children: React.ReactNode; testId?: string }) =>
    React.createElement('div', { 'data-testid': testId ?? 'panel-shell' }, children),
  PanelHeader: ({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'panel-header' }, title, subtitle, actions),
}));

import { TimeTravelPanel } from '../TimeTravelPanel';

/** Deliver a PS_RES_MUTATE_RESPONSE keyed to the last pending correlationId. */
function replyToLast(extra: Record<string, unknown>) {
  const cid = lastRequest.value?.correlationId as string | undefined;
  act(() => {
    for (const h of [...handlers]) {
      h({ type: 'PS_RES_MUTATE_RESPONSE', correlationId: cid, ...extra });
    }
  });
}

beforeEach(() => {
  postToParent.mockClear();
  handlers.length = 0;
  lastRequest.value = null;
  try { localStorage.clear(); } catch { /* jsdom may restrict */ }
});

afterEach(() => cleanup());

// ─── 1. Loading state ────────────────────────────────────────────────────────

describe('TimeTravelPanel — loading state', () => {
  it('shows the loading spinner before the bridge reply arrives', async () => {
    render(<TimeTravelPanel />);
    await waitFor(() => expect(lastRequest.value?.type).toBe('PS_RES_MUTATE_REQUEST'));
    expect(screen.getByTestId('tt-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('tt-current')).not.toBeInTheDocument();
  });
});

// ─── 2. Disabled state ───────────────────────────────────────────────────────

describe('TimeTravelPanel — disabled state', () => {
  it('renders tt-disabled when the reply carries enabled:false', async () => {
    render(<TimeTravelPanel />);
    await waitFor(() => expect(lastRequest.value?.type).toBe('PS_RES_MUTATE_REQUEST'));

    replyToLast({ ok: true, enabled: false });

    await waitFor(() => expect(screen.getByTestId('tt-disabled')).toBeInTheDocument());
    expect(screen.queryByTestId('tt-current')).not.toBeInTheDocument();
  });
});

// ─── 3. Error state ──────────────────────────────────────────────────────────

describe('TimeTravelPanel — error state', () => {
  it('clears loading and shows tt-current after a result.ok=false reply', async () => {
    render(<TimeTravelPanel />);
    await waitFor(() => expect(lastRequest.value?.type).toBe('PS_RES_MUTATE_REQUEST'));

    replyToLast({
      ok: true,
      result: { ok: false, error: { code: 'tt_unavailable', message: 'D1 Time Travel is not available.' } },
    });

    await waitFor(() => expect(screen.queryByTestId('tt-loading')).not.toBeInTheDocument());
    expect(screen.getByTestId('tt-current')).toBeInTheDocument();
  });

  it('clears loading and shows tt-current when reply.error is set (transport failure)', async () => {
    render(<TimeTravelPanel />);
    await waitFor(() => expect(lastRequest.value?.type).toBe('PS_RES_MUTATE_REQUEST'));

    replyToLast({ ok: false, error: 'Time Travel is not available right now.' });

    await waitFor(() => expect(screen.queryByTestId('tt-loading')).not.toBeInTheDocument());
    expect(screen.getByTestId('tt-current')).toBeInTheDocument();
  });
});

// ─── 4. Ready state ─────────────────────────────────────────────────────────

describe('TimeTravelPanel — ready state (bookmark present)', () => {
  async function renderReady() {
    render(<TimeTravelPanel />);
    await waitFor(() => expect(lastRequest.value?.type).toBe('PS_RES_MUTATE_REQUEST'));

    replyToLast({
      ok: true,
      result: {
        ok: true,
        data: { available: true, bookmark: '00000085-0000abcd-00000001-00000002', retentionDays: 30 },
      },
    });

    await waitFor(() => expect(screen.queryByTestId('tt-loading')).not.toBeInTheDocument());
  }

  it('renders tt-current with the truncated live bookmark', async () => {
    await renderReady();
    expect(screen.getByTestId('tt-current')).toBeInTheDocument();
    expect(screen.getByTestId('tt-current').textContent).toMatch(/00000085/);
  });

  it('renders tt-label-input and tt-save-point controls', async () => {
    await renderReady();
    expect(screen.getByTestId('tt-label-input')).toBeInTheDocument();
    expect(screen.getByTestId('tt-save-point')).toBeInTheDocument();
  });

  it('renders the tt-scrubber section with range slider and readout', async () => {
    await renderReady();
    expect(screen.getByTestId('tt-scrubber')).toBeInTheDocument();
    expect(screen.getByTestId('tt-scrubber-range')).toBeInTheDocument();
    expect(screen.getByTestId('tt-scrubber-readout')).toBeInTheDocument();
  });

  it('renders the datetime picker and tt-restore-at button', async () => {
    await renderReady();
    expect(screen.getByTestId('tt-restore-datetime')).toBeInTheDocument();
    expect(screen.getByTestId('tt-restore-at')).toBeInTheDocument();
  });

  it('tt-restore-at is disabled until a valid datetime is picked', async () => {
    await renderReady();
    // No date entered yet → the button is disabled.
    expect(screen.getByTestId('tt-restore-at')).toBeDisabled();
  });
});

// ─── 5. Restore confirm modal (destructive gate) ─────────────────────────────

describe('TimeTravelPanel — restore confirm modal', () => {
  async function renderReadyWithSave() {
    render(<TimeTravelPanel />);
    await waitFor(() => expect(lastRequest.value?.type).toBe('PS_RES_MUTATE_REQUEST'));

    replyToLast({
      ok: true,
      result: {
        ok: true,
        data: { available: true, bookmark: '00000085-0000abcd-00000001', retentionDays: 30 },
      },
    });

    await waitFor(() => expect(screen.queryByTestId('tt-loading')).not.toBeInTheDocument());

    // Save current bookmark so a Restore button appears.
    fireEvent.click(screen.getByTestId('tt-save-point'));
    await waitFor(() => expect(screen.getByTestId('tt-restore-saved')).toBeInTheDocument());
  }

  it('opens the confirm modal when Restore is clicked on a saved point', async () => {
    await renderReadyWithSave();
    fireEvent.click(screen.getByTestId('tt-restore-saved'));
    await waitFor(() => expect(screen.getByTestId('tt-confirm')).toBeInTheDocument());
  });

  it('renders tt-confirm-input and the disabled tt-confirm-restore button inside the modal', async () => {
    await renderReadyWithSave();
    fireEvent.click(screen.getByTestId('tt-restore-saved'));
    await waitFor(() => expect(screen.getByTestId('tt-confirm')).toBeInTheDocument());

    expect(screen.getByTestId('tt-confirm-input')).toBeInTheDocument();
    // Gate: button stays disabled until user types "RESTORE".
    expect(screen.getByTestId('tt-confirm-restore')).toBeDisabled();
  });

  it('enables tt-confirm-restore only after the user types "RESTORE"', async () => {
    await renderReadyWithSave();
    fireEvent.click(screen.getByTestId('tt-restore-saved'));
    await waitFor(() => expect(screen.getByTestId('tt-confirm-input')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('tt-confirm-input'), { target: { value: 'RESTORE' } });
    expect(screen.getByTestId('tt-confirm-restore')).not.toBeDisabled();
  });
});

// ─── 6. Cancel closes the modal ─────────────────────────────────────────────

describe('TimeTravelPanel — restore confirm cancel', () => {
  it('closes the confirm modal when the Cancel button is clicked', async () => {
    render(<TimeTravelPanel />);
    await waitFor(() => expect(lastRequest.value?.type).toBe('PS_RES_MUTATE_REQUEST'));

    replyToLast({
      ok: true,
      result: {
        ok: true,
        data: { available: true, bookmark: 'bk-0000abcd', retentionDays: 30 },
      },
    });

    await waitFor(() => expect(screen.queryByTestId('tt-loading')).not.toBeInTheDocument());

    fireEvent.click(screen.getByTestId('tt-save-point'));
    await waitFor(() => expect(screen.getByTestId('tt-restore-saved')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('tt-restore-saved'));
    await waitFor(() => expect(screen.getByTestId('tt-confirm')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('tt-confirm-cancel'));
    await waitFor(() => expect(screen.queryByTestId('tt-confirm')).not.toBeInTheDocument());
  });
});

// ─── 7. Restore success ──────────────────────────────────────────────────────

describe('TimeTravelPanel — restore success', () => {
  it('shows tt-restore-result after a successful confirmed restore', async () => {
    render(<TimeTravelPanel />);
    await waitFor(() => expect(lastRequest.value?.type).toBe('PS_RES_MUTATE_REQUEST'));

    // loadInfo reply
    replyToLast({
      ok: true,
      result: {
        ok: true,
        data: { available: true, bookmark: 'bk-00001234', retentionDays: 30 },
      },
    });

    await waitFor(() => expect(screen.queryByTestId('tt-loading')).not.toBeInTheDocument());

    // Save, open confirm.
    fireEvent.click(screen.getByTestId('tt-save-point'));
    await waitFor(() => expect(screen.getByTestId('tt-restore-saved')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('tt-restore-saved'));
    await waitFor(() => expect(screen.getByTestId('tt-confirm-input')).toBeInTheDocument());

    // Unlock and click Restore now.
    fireEvent.change(screen.getByTestId('tt-confirm-input'), { target: { value: 'RESTORE' } });
    fireEvent.click(screen.getByTestId('tt-confirm-restore'));

    // Wait for the restore request then reply.
    await waitFor(() => expect(lastRequest.value?.action).toBe('restore'));

    replyToLast({
      ok: true,
      result: {
        ok: true,
        data: {
          restored: true,
          bookmark: 'bk-00001234',
          previousBookmark: 'bk-000000aa',
          message: 'Your database was restored to the selected point.',
        },
      },
    });

    // Panel fires loadInfo again after restore. Reply to that too.
    await waitFor(() => expect(lastRequest.value?.action).toBe('time_travel_info'));

    replyToLast({
      ok: true,
      result: {
        ok: true,
        data: { available: true, bookmark: 'bk-00001234', retentionDays: 30 },
      },
    });

    await waitFor(() => expect(screen.getByTestId('tt-restore-result')).toBeInTheDocument());
    expect(screen.getByTestId('tt-restore-result').textContent).toMatch(/restored/i);
  });
});

// ─── 8. Save snapshot ────────────────────────────────────────────────────────

describe('TimeTravelPanel — save snapshot', () => {
  it('adds a tt-saved-row after clicking Create snapshot', async () => {
    render(<TimeTravelPanel />);
    await waitFor(() => expect(lastRequest.value?.type).toBe('PS_RES_MUTATE_REQUEST'));

    replyToLast({
      ok: true,
      result: {
        ok: true,
        data: { available: true, bookmark: 'bk-snap-0001', retentionDays: 30 },
      },
    });

    await waitFor(() => expect(screen.queryByTestId('tt-loading')).not.toBeInTheDocument());

    expect(screen.queryByTestId('tt-saved-row')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('tt-save-point'));
    await waitFor(() => expect(screen.getByTestId('tt-saved-row')).toBeInTheDocument());
  });

  it('uses a custom label typed before clicking Create snapshot', async () => {
    render(<TimeTravelPanel />);
    await waitFor(() => expect(lastRequest.value?.type).toBe('PS_RES_MUTATE_REQUEST'));

    replyToLast({
      ok: true,
      result: {
        ok: true,
        data: { available: true, bookmark: 'bk-snap-0002', retentionDays: 30 },
      },
    });

    await waitFor(() => expect(screen.queryByTestId('tt-loading')).not.toBeInTheDocument());

    fireEvent.change(screen.getByTestId('tt-label-input'), { target: { value: 'Before big import' } });
    fireEvent.click(screen.getByTestId('tt-save-point'));

    await waitFor(() => expect(screen.getByTestId('tt-saved-row')).toBeInTheDocument());
    expect(screen.getByTestId('tt-saved-row').textContent).toMatch(/Before big import/);
  });
});
