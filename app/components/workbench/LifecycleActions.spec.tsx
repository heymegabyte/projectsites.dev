// @vitest-environment jsdom
/**
 * LifecycleActions.spec.tsx — TDD spec for the resource lifecycle action strip (FIRE 5).
 *
 * The strip takes a uniform `mutate` prop (the panel owns the bridge), so we drive it with a spy and assert:
 *   1. it renders promote/teardown/clone buttons ONLY for the kind's declared lifecycle mutations;
 *   2. teardown (destructive) opens the confirm dialog, then calls mutate('teardown', undefined, true);
 *   3. promote (billable) opens the confirm dialog, then calls mutate('promote', undefined, true);
 *   4. an honest `not_available` outcome (clone) renders the amber info card, never a fake success;
 *   5. a successful teardown calls onMutated (so the panel refetches).
 *
 * The heavy ConfirmationDialog is stubbed to a lightweight button pair.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

vi.mock('~/components/ui/Dialog', () => ({
  ConfirmationDialog: ({
    isOpen,
    title,
    onConfirm,
    onClose,
    confirmLabel,
  }: {
    isOpen: boolean;
    title: string;
    onConfirm: () => void;
    onClose: () => void;
    confirmLabel?: string;
  }) =>
    isOpen
      ? React.createElement('div', { role: 'dialog', 'aria-label': title }, [
          React.createElement(
            'button',
            { key: 'ok', 'data-testid': 'confirm-ok', onClick: onConfirm },
            confirmLabel ?? 'Confirm',
          ),
          React.createElement('button', { key: 'no', 'data-testid': 'confirm-cancel', onClick: onClose }, 'Cancel'),
        ])
      : null,
}));

vi.mock('~/utils/classNames', () => ({
  classNames: (...a: unknown[]) => a.filter((x) => typeof x === 'string').join(' '),
}));

import { LifecycleActions } from './LifecycleActions';
import type { MutateOutcome } from './ResourceDetailPanel';

const R2_MUTATIONS = ['put', 'delete', 'provision', 'promote', 'teardown', 'clone'];

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('lifecycle action strip', () => {
  it('renders promote/teardown/clone buttons for a kind that declares them', () => {
    render(<LifecycleActions kind="r2" mutations={R2_MUTATIONS} mutate={vi.fn()} onMutated={() => {}} />);
    expect(screen.getByTestId('resource-lifecycle')).toBeTruthy();
    expect(screen.getByTestId('resource-lifecycle-promote')).toBeTruthy();
    expect(screen.getByTestId('resource-lifecycle-teardown')).toBeTruthy();
    expect(screen.getByTestId('resource-lifecycle-clone')).toBeTruthy();
  });

  it('renders nothing when the kind declares no lifecycle mutations', () => {
    const { container } = render(
      <LifecycleActions kind="analytics_engine" mutations={[]} mutate={vi.fn()} onMutated={() => {}} />,
    );
    expect(container.querySelector('[data-testid="resource-lifecycle"]')).toBeNull();
  });

  it('teardown opens the confirm dialog then calls mutate(teardown, undefined, true) + onMutated on success', async () => {
    const mutate = vi.fn(
      async (): Promise<MutateOutcome> => ({
        action: 'teardown',
        kind: 'success',
        result: { deletedCfResource: true },
      }),
    );
    const onMutated = vi.fn();
    render(<LifecycleActions kind="r2" mutations={R2_MUTATIONS} mutate={mutate} onMutated={onMutated} />);

    fireEvent.click(screen.getByTestId('resource-lifecycle-teardown'));
    await waitFor(() => expect(screen.getByTestId('confirm-ok')).toBeTruthy());
    fireEvent.click(screen.getByTestId('confirm-ok'));

    await waitFor(() => expect(mutate).toHaveBeenCalledWith('teardown', undefined, true));
    await waitFor(() => expect(onMutated).toHaveBeenCalled());
    expect(screen.getByTestId('resource-lifecycle-outcome')).toBeTruthy();
  });

  it('promote opens the confirm dialog then calls mutate(promote, undefined, true)', async () => {
    const mutate = vi.fn(
      async (): Promise<MutateOutcome> => ({
        action: 'promote',
        kind: 'success',
        result: { note: 'Production ensured.' },
      }),
    );
    render(<LifecycleActions kind="kv" mutations={R2_MUTATIONS} mutate={mutate} onMutated={() => {}} />);

    fireEvent.click(screen.getByTestId('resource-lifecycle-promote'));
    await waitFor(() => expect(screen.getByTestId('confirm-ok')).toBeTruthy());
    fireEvent.click(screen.getByTestId('confirm-ok'));

    await waitFor(() => expect(mutate).toHaveBeenCalledWith('promote', undefined, true));
  });

  it('renders an honest not_available outcome (never a fake success) for clone', async () => {
    const mutate = vi.fn(
      async (): Promise<MutateOutcome> => ({
        action: 'clone',
        kind: 'not_available',
        message: 'Cloning is not available for this resource.',
      }),
    );
    render(<LifecycleActions kind="d1" mutations={R2_MUTATIONS} mutate={mutate} onMutated={() => {}} />);

    // Clone runs immediately (no confirm).
    fireEvent.click(screen.getByTestId('resource-lifecycle-clone'));
    await waitFor(() => expect(mutate).toHaveBeenCalledWith('clone', undefined, undefined));
    await waitFor(() => expect(screen.getByTestId('resource-lifecycle-outcome')).toBeTruthy());
    expect(screen.getByTestId('resource-lifecycle-outcome').textContent).toContain('not available');
  });
});
