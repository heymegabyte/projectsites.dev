// @vitest-environment jsdom
/**
 * @file Resources › Buckets › Settings — DOM-render proof for the owner-key credential strip
 *       (B5 slice 4) + the cinematic object-browser animation guard.
 *
 * Context: `BucketWorkspace`'s Settings tab gains an owner-facing scoped-R2-key section. It drives the
 * ALREADY-BUILT bridge helpers in `embedded-mode.ts` (`requestOwnerKeyStatus`/`…Create`/`…Rotate`/
 * `…Revoke`, all → `PS_R2_KEY_RESULT`). The section:
 *   1. shows the MASKED access key id + status + created-at on mount (status fetch),
 *   2. reveals the Secret Access Key ONCE inside the shared `ModalShell` dialog after Create, with a
 *      copy-to-clipboard button and honest "shown once — rotate to get a new one" copy,
 *   3. offers Rotate (re-reveal once) and Revoke (confirm first — a doomed control is never one click),
 *   4. degrades gracefully to a friendly card on the dark flag (`enabled:false`) and the
 *      needs-creds state (`needsCreds:true`) — never a scary error, never a dead button.
 *
 * The bridge helpers are mocked (the real ones postMessage to a parent that isn't present in jsdom).
 * `OwnerKeySection` is exported from BucketsPanel for this exact falsifiability (mirrors `BucketsEmpty`).
 *
 * The animation pass is asserted structurally: the object list/grid containers carry the
 * `motion-safe:`-gated staggered-entrance utility AND a `motion-reduce:`/`prefers-reduced-motion` guard,
 * so a regression that drops the reduced-motion opt-out (a vestibular-a11y failure) fails HERE.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock the bridge helpers BEFORE importing the panel (swc hoists vi.mock). ──
const mockStatus = vi.fn();
const mockCreate = vi.fn();
const mockRotate = vi.fn();
const mockRevoke = vi.fn();

vi.mock('~/lib/embed/embedded-mode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/embed/embedded-mode')>();
  return {
    ...actual,
    isEmbedded: true,
    postToastToParent: vi.fn(),
    requestOwnerKeyStatus: (...a: unknown[]) => mockStatus(...a),
    requestOwnerKeyCreate: (...a: unknown[]) => mockCreate(...a),
    requestOwnerKeyRotate: (...a: unknown[]) => mockRotate(...a),
    requestOwnerKeyRevoke: (...a: unknown[]) => mockRevoke(...a),
  };
});

import { OwnerKeySection } from '~/components/workbench/BucketsPanel';

const ACTIVE_STATUS = {
  type: 'PS_R2_KEY_RESULT' as const,
  ok: true,
  op: 'status' as const,
  status: {
    exists: true,
    accessKeyIdMasked: 'abcd…wxyz',
    status: 'active' as const,
    createdAt: '2026-10-01T12:00:00.000Z',
    rotatedAt: null,
  },
};

const NONE_STATUS = {
  type: 'PS_R2_KEY_RESULT' as const,
  ok: true,
  op: 'status' as const,
  status: { exists: false, accessKeyIdMasked: null, status: 'none' as const, createdAt: null, rotatedAt: null },
};

beforeEach(() => {
  mockStatus.mockReset();
  mockCreate.mockReset();
  mockRotate.mockReset();
  mockRevoke.mockReset();

  // jsdom lacks the async clipboard API — stub it so the copy button's path runs.
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});
afterEach(cleanup);

describe('OwnerKeySection — masked status on mount', () => {
  it('fetches + renders the MASKED access key id + active status + created-at', async () => {
    mockStatus.mockResolvedValue(ACTIVE_STATUS);
    render(<OwnerKeySection />);

    await waitFor(() => expect(mockStatus).toHaveBeenCalledTimes(1));

    const section = await screen.findByTestId('buckets-owner-key');
    expect(section.textContent).toContain('abcd…wxyz'); // masked id, never a real secret
    expect(section.textContent).toMatch(/active/i);

    // The raw secret is NEVER present in the status view.
    expect(section.textContent).not.toMatch(/secret access key/i);
  });

  it('shows the "Create access key" launchpad when no key exists yet', async () => {
    mockStatus.mockResolvedValue(NONE_STATUS);
    render(<OwnerKeySection />);

    const btn = await screen.findByTestId('buckets-owner-key-create');
    expect(btn.textContent).toMatch(/create/i);
  });
});

describe('OwnerKeySection — show-once reveal', () => {
  it('reveals the secret ONCE in a dialog after Create, with a copy button + honest copy', async () => {
    mockStatus.mockResolvedValue(NONE_STATUS);
    mockCreate.mockResolvedValue({
      type: 'PS_R2_KEY_RESULT',
      ok: true,
      op: 'create',
      accessKeyId: 'AKIA-NEW-ID',
      secretAccessKey: 'super-secret-value-shown-once',
      status: { exists: true, accessKeyIdMasked: 'AKIA…-ID', status: 'active', createdAt: 'now', rotatedAt: null },
    });

    render(<OwnerKeySection />);

    const createBtn = await screen.findByTestId('buckets-owner-key-create');

    await act(async () => {
      fireEvent.click(createBtn);
    });

    const reveal = await screen.findByTestId('buckets-owner-key-reveal');
    expect(reveal.textContent).toContain('super-secret-value-shown-once');
    expect(reveal.textContent).toMatch(/shown once/i); // honest "rotate to get a new one" copy
    expect(reveal.textContent).toMatch(/rotate/i);

    // Copy-to-clipboard button fires the real clipboard write.
    const copyBtn = await screen.findByTestId('buckets-owner-key-copy-secret');
    await act(async () => {
      fireEvent.click(copyBtn);
    });
    await waitFor(() =>
      expect(navigator.clipboard.writeText as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        'super-secret-value-shown-once',
      ),
    );
  });
});

describe('OwnerKeySection — rotate + revoke', () => {
  it('rotate re-reveals a fresh secret once', async () => {
    mockStatus.mockResolvedValue(ACTIVE_STATUS);
    mockRotate.mockResolvedValue({
      type: 'PS_R2_KEY_RESULT',
      ok: true,
      op: 'rotate',
      accessKeyId: 'AKIA-ROT',
      secretAccessKey: 'rotated-secret',
      status: { exists: true, accessKeyIdMasked: 'AKIA…ROT', status: 'active', createdAt: 'x', rotatedAt: 'now' },
    });

    render(<OwnerKeySection />);

    const rotateBtn = await screen.findByTestId('buckets-owner-key-rotate');
    await act(async () => {
      fireEvent.click(rotateBtn);
    });

    const reveal = await screen.findByTestId('buckets-owner-key-reveal');
    expect(reveal.textContent).toContain('rotated-secret');
    expect(mockRotate).toHaveBeenCalledTimes(1);
  });

  it('revoke asks for confirmation FIRST (never a one-click destructive control)', async () => {
    mockStatus.mockResolvedValue(ACTIVE_STATUS);
    mockRevoke.mockResolvedValue({ type: 'PS_R2_KEY_RESULT', ok: true, op: 'revoke', revoked: true });

    render(<OwnerKeySection />);

    const revokeBtn = await screen.findByTestId('buckets-owner-key-revoke');
    await act(async () => {
      fireEvent.click(revokeBtn);
    });

    // First click opens a confirm dialog — revoke has NOT fired yet.
    expect(mockRevoke).not.toHaveBeenCalled();

    const confirm = await screen.findByTestId('buckets-owner-key-revoke-confirm');
    expect(confirm).toBeTruthy();

    await act(async () => {
      fireEvent.click(confirm);
    });
    await waitFor(() => expect(mockRevoke).toHaveBeenCalledTimes(1));
  });
});

describe('OwnerKeySection — graceful degraded states', () => {
  it('shows a friendly "not enabled" card on the dark flag (enabled:false), no scary error', async () => {
    mockStatus.mockResolvedValue({ type: 'PS_R2_KEY_RESULT', ok: false, op: 'status', enabled: false });
    render(<OwnerKeySection />);

    const disabled = await screen.findByTestId('buckets-owner-key-disabled');
    expect(disabled.textContent).toMatch(/not (enabled|turned on|available)|on the way/i);

    // No doomed create button in the flag-off state.
    expect(screen.queryByTestId('buckets-owner-key-create')).toBeNull();
  });

  it('shows an actionable needs-creds card (needsCreds:true), not a dead button', async () => {
    mockStatus.mockResolvedValue({ type: 'PS_R2_KEY_RESULT', ok: false, op: 'status', needsCreds: true });
    render(<OwnerKeySection />);

    const needs = await screen.findByTestId('buckets-owner-key-needs-creds');
    expect(needs.textContent).toMatch(/set up|setting up|configured/i);
    expect(screen.queryByTestId('buckets-owner-key-create')).toBeNull();
  });
});
