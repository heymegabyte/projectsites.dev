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
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

const { requestAutomations } = vi.hoisted(() => ({
  requestAutomations: vi.fn(),
}));

vi.mock('~/lib/embed/embedded-mode', () => ({
  isEmbedded: true,
  requestAutomations,
}));

vi.mock('~/utils/classNames', () => ({
  classNames: (...a: unknown[]) => a.filter((x) => typeof x === 'string').join(' '),
}));

import { AutomationsPanel } from './AutomationsPanel';

beforeEach(() => {
  requestAutomations.mockReset();
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
