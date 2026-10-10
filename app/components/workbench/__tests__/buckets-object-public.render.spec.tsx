// @vitest-environment jsdom
/**
 * @file Resources › Buckets › Per-object public share (B9) — the two new context-menu items
 *       ("Share publicly & copy link" · "Stop sharing") render with stable testids, fire the matching
 *       handler with the object key, and are OMITTED when object ops are unavailable (no doomed control —
 *       a share link needs the server-side object-ops path, so with no creds the item must not appear).
 *
 * Context: B9 flips ONE object public via a revoke-safe signed share (the `requestObjectPublic` bridge →
 * worker `…/objects/public` → unauthed `/api/r2/public/:slug` gateway). The UI surface is these two
 * `ObjectActionMenu` items. `ObjectActionMenu` is exported from BucketsPanel for this exact falsifiability
 * (mirrors the B8 rename/copy/move coverage). We assert the menu wiring WITHOUT a real parent window.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ObjectActionMenu } from '~/components/workbench/BucketsPanel';

afterEach(cleanup);

describe('ObjectActionMenu — B9 share / stop-sharing items', () => {
  function setup(withShare = true) {
    const fns = {
      onCopy: vi.fn(),
      onCopyUrl: vi.fn(),
      onDelete: vi.fn(),
      onDownload: vi.fn(),
      onMove: vi.fn(),
      onPreview: vi.fn(),
      onRename: vi.fn(),
      onRevokeShare: vi.fn(),
      onShare: vi.fn(),
    };
    render(
      <ObjectActionMenu
        objectKey="docs/report.pdf"
        name="report.pdf"
        canPreview={false}
        onPreview={fns.onPreview}
        onCopyUrl={fns.onCopyUrl}
        onDownload={fns.onDownload}
        onDelete={fns.onDelete}
        onShare={withShare ? fns.onShare : undefined}
        onRevokeShare={withShare ? fns.onRevokeShare : undefined}
      >
        <div data-testid="the-row">report.pdf</div>
      </ObjectActionMenu>,
    );
    return fns;
  }
  async function openMenu() {
    fireEvent.contextMenu(screen.getByTestId('the-row'));
    await waitFor(() => expect(screen.getByTestId('buckets-object-context-menu')).toBeTruthy());
  }

  it('renders "Share publicly & copy link" + "Stop sharing" when object ops are available', async () => {
    setup(true);
    await openMenu();
    const share = screen.getByTestId('buckets-object-context-share');
    const revoke = screen.getByTestId('buckets-object-context-revoke-share');
    expect(share).toBeTruthy();
    expect(revoke).toBeTruthy();
    // Owner-facing copy — the owner's words, communicates the ONE-file public exposure plainly.
    expect(share.textContent).toMatch(/share publicly/i);
    expect(share.textContent).toMatch(/copy link/i);
    expect(revoke.textContent).toMatch(/stop sharing/i);
  });

  it('each item fires the matching handler with the object key', async () => {
    const fns = setup(true);
    await openMenu();
    fireEvent.click(screen.getByTestId('buckets-object-context-share'));
    expect(fns.onShare).toHaveBeenCalledWith('docs/report.pdf');

    await openMenu();
    fireEvent.click(screen.getByTestId('buckets-object-context-revoke-share'));
    expect(fns.onRevokeShare).toHaveBeenCalledWith('docs/report.pdf');
  });

  it('OMITS both share items when object ops are unavailable (no doomed control)', async () => {
    setup(false);
    await openMenu();
    expect(screen.queryByTestId('buckets-object-context-share')).toBeNull();
    expect(screen.queryByTestId('buckets-object-context-revoke-share')).toBeNull();
    // The always-available actions remain reachable.
    expect(screen.getByTestId('buckets-object-context-copy')).toBeTruthy();
    expect(screen.getByTestId('buckets-object-context-download')).toBeTruthy();
    expect(screen.getByTestId('buckets-object-context-delete')).toBeTruthy();
  });
});
