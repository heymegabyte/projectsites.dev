// @vitest-environment jsdom
/**
 * KvBrowser.spec.tsx — TDD spec for the per-site KV manager's empty-state primary CTA (K1 finish).
 *
 * The browser lists keys via PS_RES_DETAIL_REQUEST { kind:'kv', action:'list' } (resolved by
 * correlationId) and adds a key via the `beginAdd` flow (header "Add key" → add form). Per the
 * embarrassingly-easy mandate, the "no keys yet" empty state must itself carry the primary Add CTA
 * (not only the header). We mock the parent bridge, render, reply with an EMPTY key list, and assert:
 *   1. the empty state renders an "Add key" button that is keyboard-focusable + accessibly labelled;
 *   2. clicking it is wired to the SAME `beginAdd` the header uses (the add form appears).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

const { postToParent, handlers } = vi.hoisted(() => {
  const handlers: Array<(msg: unknown) => void> = [];
  const postToParent = vi.fn();

  return { handlers, postToParent };
});

vi.mock('~/lib/embed/embedded-mode', () => ({
  isEmbedded: true,
  onParentMessage: (fn: (msg: unknown) => void) => {
    handlers.push(fn);

    return () => {
      const i = handlers.indexOf(fn);

      if (i >= 0) {
        handlers.splice(i, 1);
      }
    };
  },
  postToParent,
}));

vi.mock('~/utils/classNames', () => ({
  classNames: (...a: unknown[]) => a.filter((x) => typeof x === 'string').join(' '),
}));

import { KvBrowser } from '../KvBrowser';

/** Reply to the LAST pending KV list request with the given keys. */
function replyList(keys: Array<{ name: string; expiration?: number }>): void {
  const call = [...postToParent.mock.calls]
    .reverse()
    .find((c) => (c[0] as { type?: string })?.type === 'PS_RES_DETAIL_REQUEST');

  if (!call) {
    throw new Error('no pending list request');
  }

  const cid = (call[0] as { correlationId: string }).correlationId;

  for (const h of [...handlers]) {
    h({
      type: 'PS_RES_DETAIL_RESPONSE',
      correlationId: cid,
      ok: true,
      kind: 'kv',
      action: 'list',
      result: { ok: true, data: { keys, listComplete: true } },
    });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  handlers.length = 0;
});

afterEach(() => {
  cleanup();
});

describe('KvBrowser — empty-state primary CTA (K1)', () => {
  it('renders an accessible "Add key" button inside the empty state', async () => {
    render(<KvBrowser />);
    await waitFor(() => expect(postToParent.mock.calls.length).toBeGreaterThanOrEqual(1));

    replyList([]); // no keys → the empty state renders

    const emptyAdd = await screen.findByTestId('database-kv-empty-add');

    // It lives inside the empty-state cell, is a real button (keyboard-focusable), and is labelled.
    expect(screen.getByTestId('database-kv-empty').contains(emptyAdd)).toBe(true);
    expect(emptyAdd.tagName).toBe('BUTTON');
    expect(emptyAdd.getAttribute('aria-label')).toBeTruthy();
    expect(emptyAdd.textContent).toContain('Add key');
  });

  it('is wired to the same beginAdd flow as the header (opens the add form)', async () => {
    render(<KvBrowser />);
    await waitFor(() => expect(postToParent.mock.calls.length).toBeGreaterThanOrEqual(1));

    replyList([]);

    const emptyAdd = await screen.findByTestId('database-kv-empty-add');

    // No add form yet…
    expect(screen.queryByTestId('database-kv-add-form')).toBeNull();

    fireEvent.click(emptyAdd);

    // …clicking the empty-state CTA opens the SAME add form the header "Add key" opens.
    expect(screen.getByTestId('database-kv-add-form')).toBeTruthy();
    expect(screen.getByTestId('database-kv-new-key')).toBeTruthy();
  });
});
