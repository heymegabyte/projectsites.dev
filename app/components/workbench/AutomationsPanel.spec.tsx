// @vitest-environment jsdom
/**
 * AutomationsPanel.spec.tsx — spec for the per-site Automations tab (editor Resources → Automations).
 *
 * The panel talks to the parent admin via the typed `requestAutomations` sender (mocked here), which
 * proxies to the worker's `GET /api/sites/:id/automations` (RES-AUTO slice 1). We assert the
 * golden-path-adjacent behaviors:
 *   1. a list renders (type · status badge · relative time);
 *   2. no automations → an honest-empty state ("No automations yet");
 *   3. DARK flag / 404 → a friendly "not enabled" disabled card (never a scary error / red console);
 *   4. a transport error → an error card with a retry;
 *   5. real-time: NO manual Refresh button; the list self-updates on a visibility-aware interval.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

const { requestAutomations, requestAutomationRetry, requestAutomationCancel, postToastToParent } = vi.hoisted(() => ({
  requestAutomations: vi.fn(),
  requestAutomationRetry: vi.fn(),
  requestAutomationCancel: vi.fn(),
  postToastToParent: vi.fn(),
}));

vi.mock('~/lib/embed/embedded-mode', () => ({
  isEmbedded: true,
  requestAutomations,
  requestAutomationRetry,
  requestAutomationCancel,
  postToastToParent,
}));

vi.mock('~/utils/classNames', () => ({
  classNames: (...a: unknown[]) => a.filter((x) => typeof x === 'string').join(' '),
}));

import { AutomationsPanel } from './AutomationsPanel';

beforeEach(() => {
  requestAutomations.mockReset();
  requestAutomationRetry.mockReset();
  requestAutomationCancel.mockReset();
  postToastToParent.mockReset();
});

afterEach(() => cleanup());

describe('AutomationsPanel', () => {
  it('renders the automations list (type + status + relative time)', async () => {
    requestAutomations.mockResolvedValue({
      type: 'PS_RES_AUTOMATIONS_RESULT',
      ok: true,
      automations: [
        {
          id: 'job-1',
          type: 'site-generation',
          status: 'success',
          created_at: new Date(Date.now() - 3_600_000).toISOString(),
          finished_at: new Date(Date.now() - 3_000_000).toISOString(),
        },
        {
          id: 'job-2',
          type: 'image-generation',
          status: 'running',
          created_at: new Date().toISOString(),
          finished_at: null,
        },
      ],
    });

    render(<AutomationsPanel />);

    await waitFor(() => expect(screen.getByTestId('automations-list')).toBeTruthy());
    expect(screen.getAllByTestId('automations-row').length).toBe(2);
    expect(screen.getByText('site-generation')).toBeTruthy();
    expect(screen.getByText('image-generation')).toBeTruthy();
  });

  it('shows an honest-empty state when the site has no automations', async () => {
    requestAutomations.mockResolvedValue({ type: 'PS_RES_AUTOMATIONS_RESULT', ok: true, automations: [] });

    render(<AutomationsPanel />);

    await waitFor(() => expect(screen.getByTestId('automations-empty')).toBeTruthy());
    expect(screen.getByText(/no automations yet/i)).toBeTruthy();
  });

  it('shows a friendly disabled card (never a crash) when the flag is DARK / the endpoint 404s', async () => {
    // The parent maps the dark-flag 404 to {ok:false, enabled:false}.
    requestAutomations.mockResolvedValue({ type: 'PS_RES_AUTOMATIONS_RESULT', ok: false, enabled: false });

    render(<AutomationsPanel />);

    await waitFor(() => expect(screen.getByTestId('automations-disabled')).toBeTruthy());
    expect(screen.getByText(/aren.t enabled yet/i)).toBeTruthy();
    // Must NOT render the scary error card for the dark state.
    expect(screen.queryByTestId('automations-error')).toBeNull();
  });

  it('also treats an `enabled:undefined` 404 whose message says "not enabled" as disabled', async () => {
    requestAutomations.mockResolvedValue({
      type: 'PS_RES_AUTOMATIONS_RESULT',
      ok: false,
      error: 'automations are not enabled',
    });

    render(<AutomationsPanel />);

    await waitFor(() => expect(screen.getByTestId('automations-disabled')).toBeTruthy());
  });

  it('shows an error card with a retry on a transport failure', async () => {
    requestAutomations.mockResolvedValue({
      type: 'PS_RES_AUTOMATIONS_RESULT',
      ok: false,
      error: 'Could not load automations.',
    });

    render(<AutomationsPanel />);

    await waitFor(() => expect(screen.getByTestId('automations-error')).toBeTruthy());
    expect(screen.getByTestId('automations-retry')).toBeTruthy();
  });

  it('rejects (thrown) → error card, never an unhandled crash', async () => {
    requestAutomations.mockRejectedValue(new Error('bridge timeout'));

    render(<AutomationsPanel />);

    await waitFor(() => expect(screen.getByTestId('automations-error')).toBeTruthy());
    expect(screen.getByText(/bridge timeout/i)).toBeTruthy();
  });
});

describe('AutomationsPanel — real-time, no manual refresh', () => {
  function mockReadyWorld() {
    requestAutomations.mockResolvedValue({
      type: 'PS_RES_AUTOMATIONS_RESULT',
      ok: true,
      automations: [
        {
          id: 'job-1',
          type: 'site-generation',
          status: 'success',
          created_at: new Date().toISOString(),
          finished_at: null,
        },
      ],
    });
  }

  it('renders NO manual Refresh button — the list self-updates', async () => {
    mockReadyWorld();
    render(<AutomationsPanel />);
    await waitFor(() => expect(screen.getByTestId('automations-list')).toBeTruthy());

    expect(screen.queryByRole('button', { name: /refresh|reconcile/i })).toBeNull();
  });

  it('re-fetches automatically on a visibility-aware interval (no click)', async () => {
    vi.useFakeTimers();

    try {
      mockReadyWorld();
      render(<AutomationsPanel />);

      await act(async () => {
        await Promise.resolve();
      });

      const afterMount = requestAutomations.mock.calls.length;
      expect(afterMount).toBeGreaterThanOrEqual(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(31_000);
      });

      expect(requestAutomations.mock.calls.length).toBeGreaterThan(afterMount);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AutomationsPanel — Re-run (retry mutation)', () => {
  const failedRow = {
    id: 'job-failed',
    type: 'site-generation',
    status: 'failed',
    created_at: new Date(Date.now() - 3_600_000).toISOString(),
    finished_at: new Date(Date.now() - 3_000_000).toISOString(),
  };
  const okRow = {
    id: 'job-ok',
    type: 'image-generation',
    status: 'success',
    created_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
  };

  it('shows a Re-run button ONLY on failed rows (not on succeeded/running)', async () => {
    requestAutomations.mockResolvedValue({
      type: 'PS_RES_AUTOMATIONS_RESULT',
      ok: true,
      automations: [failedRow, okRow],
    });

    render(<AutomationsPanel />);
    await waitFor(() => expect(screen.getByTestId('automations-list')).toBeTruthy());

    // Exactly one Re-run control, for the single failed row.
    const buttons = screen.getAllByTestId('automation-retry');
    expect(buttons.length).toBe(1);
    expect(screen.getByRole('button', { name: /re-run/i })).toBeTruthy();
  });

  it('clicking Re-run calls the bridge op with the failed job id + flips the row to running', async () => {
    requestAutomations.mockResolvedValue({
      type: 'PS_RES_AUTOMATIONS_RESULT',
      ok: true,
      automations: [failedRow],
    });
    requestAutomationRetry.mockResolvedValue({
      type: 'PS_RES_AUTOMATION_RETRY_RESULT',
      ok: true,
      status: 'building',
    });

    render(<AutomationsPanel />);
    await waitFor(() => expect(screen.getByTestId('automation-retry')).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByTestId('automation-retry'));
    });

    // The op was invoked with the failed automation's id.
    expect(requestAutomationRetry).toHaveBeenCalledWith('job-failed');
    // Optimistic: the row no longer reads "failed" (flipped to running) → the Re-run button is gone.
    await waitFor(() => expect(screen.queryByTestId('automation-retry')).toBeNull());
    expect(postToastToParent).toHaveBeenCalledWith('success', expect.stringMatching(/re-run|building|rebuild/i));
  });

  it('surfaces a toast + keeps the Re-run button on a retry error (no optimistic flip stuck)', async () => {
    requestAutomations.mockResolvedValue({
      type: 'PS_RES_AUTOMATIONS_RESULT',
      ok: true,
      automations: [failedRow],
    });
    requestAutomationRetry.mockResolvedValue({
      type: 'PS_RES_AUTOMATION_RETRY_RESULT',
      ok: false,
      error: 'A build is already in progress for this site.',
    });

    render(<AutomationsPanel />);
    await waitFor(() => expect(screen.getByTestId('automation-retry')).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByTestId('automation-retry'));
    });

    expect(requestAutomationRetry).toHaveBeenCalledWith('job-failed');
    expect(postToastToParent).toHaveBeenCalledWith('error', expect.stringMatching(/already in progress/i));
    // The row reverts to failed → the Re-run control is still available for another try.
    await waitFor(() => expect(screen.getByTestId('automation-retry')).toBeTruthy());
  });
});

describe('AutomationsPanel — Cancel (cancel mutation)', () => {
  const runningRow = {
    id: 'job-running',
    type: 'site-generation',
    status: 'running',
    created_at: new Date(Date.now() - 60_000).toISOString(),
    finished_at: null,
  };
  const queuedRow = {
    id: 'job-queued',
    type: 'image-generation',
    status: 'queued',
    created_at: new Date().toISOString(),
    finished_at: null,
  };
  const okRow = {
    id: 'job-ok',
    type: 'deploy',
    status: 'success',
    created_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
  };
  const failedRow = {
    id: 'job-failed',
    type: 'site-generation',
    status: 'failed',
    created_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
  };

  it('shows a Cancel control ONLY on running/queued rows (not on succeeded/failed)', async () => {
    requestAutomations.mockResolvedValue({
      type: 'PS_RES_AUTOMATIONS_RESULT',
      ok: true,
      automations: [runningRow, queuedRow, okRow, failedRow],
    });

    render(<AutomationsPanel />);
    await waitFor(() => expect(screen.getByTestId('automations-list')).toBeTruthy());

    // One Cancel control per in-flight row (running + queued) — not on the terminal rows.
    const cancels = screen.getAllByTestId('automation-cancel');
    expect(cancels.length).toBe(2);
    // The terminal failed row still shows its Re-run control (cancel + retry are disjoint).
    expect(screen.getByTestId('automation-retry')).toBeTruthy();
  });

  it('requires a two-step confirm: first click arms, does NOT call the bridge', async () => {
    requestAutomations.mockResolvedValue({
      type: 'PS_RES_AUTOMATIONS_RESULT',
      ok: true,
      automations: [runningRow],
    });

    render(<AutomationsPanel />);
    await waitFor(() => expect(screen.getByTestId('automation-cancel')).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByTestId('automation-cancel'));
    });

    // Armed (asks to confirm) — the destructive op is NOT yet sent.
    expect(requestAutomationCancel).not.toHaveBeenCalled();
    expect(screen.getByTestId('automation-cancel').textContent).toMatch(/confirm|sure/i);
  });

  it('second click confirms → calls the bridge op with the job id + optimistically flips to cancelled', async () => {
    requestAutomations.mockResolvedValue({
      type: 'PS_RES_AUTOMATIONS_RESULT',
      ok: true,
      automations: [runningRow],
    });
    requestAutomationCancel.mockResolvedValue({
      type: 'PS_RES_AUTOMATION_CANCEL_RESULT',
      ok: true,
      status: 'cancelled',
    });

    render(<AutomationsPanel />);
    await waitFor(() => expect(screen.getByTestId('automation-cancel')).toBeTruthy());

    // Arm, then confirm.
    await act(async () => {
      fireEvent.click(screen.getByTestId('automation-cancel'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('automation-cancel'));
    });

    expect(requestAutomationCancel).toHaveBeenCalledWith('job-running');
    // Optimistic: the row is no longer in-flight (flipped to cancelled) → the Cancel control is gone.
    await waitFor(() => expect(screen.queryByTestId('automation-cancel')).toBeNull());
    expect(postToastToParent).toHaveBeenCalledWith('success', expect.stringMatching(/cancel/i));
  });

  it('reverts + keeps the Cancel control + toasts on a cancel error (no optimistic flip stuck)', async () => {
    requestAutomations.mockResolvedValue({
      type: 'PS_RES_AUTOMATIONS_RESULT',
      ok: true,
      automations: [runningRow],
    });
    requestAutomationCancel.mockResolvedValue({
      type: 'PS_RES_AUTOMATION_CANCEL_RESULT',
      ok: false,
      error: 'This automation is already success.',
    });

    render(<AutomationsPanel />);
    await waitFor(() => expect(screen.getByTestId('automation-cancel')).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByTestId('automation-cancel'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('automation-cancel'));
    });

    expect(requestAutomationCancel).toHaveBeenCalledWith('job-running');
    expect(postToastToParent).toHaveBeenCalledWith('error', expect.stringMatching(/already success/i));
    // The row reverts to running → the Cancel control is still available for another try.
    await waitFor(() => expect(screen.getByTestId('automation-cancel')).toBeTruthy());
    // And it re-disarmed back to the plain "Cancel" label (not stuck in the confirm state).
    expect(screen.getByTestId('automation-cancel').textContent).toMatch(/cancel/i);
    expect(screen.getByTestId('automation-cancel').textContent).not.toMatch(/confirm|sure/i);
  });
});
