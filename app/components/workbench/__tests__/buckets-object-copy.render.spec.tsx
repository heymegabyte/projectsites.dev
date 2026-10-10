// @vitest-environment jsdom
/**
 * @file Resources › Buckets › Object copy / move / rename (B8) — the pure destination-key math, the three
 *       new context-menu items, and the shared `ObjectCopyDialog` (prefill · live collision guard ·
 *       submit → bridge · mode-specific deleteSource).
 *
 * Context: the object browser already had Preview · Copy URL · Download · Delete. B8 adds same-bucket
 * Rename · Copy to… · Move to… — a server-side S3 CopyObject proxied via the `requestR2Copy` bridge
 * (`PS_R2_COPY_RESULT`). This asserts, WITHOUT a real parent window:
 *   1. the pure key derivation (`renameDestKey` keeps the parent folder; `moveDestKey` keeps the
 *      basename; both reject the doomed cases) — a regression fails HERE, not just in a headless run;
 *   2. the three menu items render with stable testids + fire the matching handler;
 *   3. the dialog prefills by mode, guards a collision (submit disabled + reason, never a doomed
 *      overwrite), and on submit calls the bridge with the right destKey + deleteSource and closes.
 *
 * The bridge helper is mocked (the real one postMessages a parent absent in jsdom). The dialog +
 * helpers are exported from BucketsPanel for this exact falsifiability (mirrors `ObjectPreviewModal`).
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ObjectActionMenu,
  ObjectCopyDialog,
  moveDestKey,
  objectBaseName,
  objectParentPrefix,
  renameDestKey,
} from '~/components/workbench/BucketsPanel';

afterEach(cleanup);

// ── 1. Pure destination-key math (SSOT for the dialog) ─────────────────────────

describe('objectParentPrefix / objectBaseName', () => {
  it('splits a nested key into parent folder + basename', () => {
    expect(objectParentPrefix('images/sub/hero.png')).toBe('images/sub/');
    expect(objectBaseName('images/sub/hero.png')).toBe('hero.png');
  });
  it('a root key has no parent prefix', () => {
    expect(objectParentPrefix('readme.txt')).toBe('');
    expect(objectBaseName('readme.txt')).toBe('readme.txt');
  });
});

describe('renameDestKey — rename keeps the parent folder, swaps the name', () => {
  it('keeps the folder of a nested object', () => {
    expect(renameDestKey('images/old.png', 'new.png')).toBe('images/new.png');
  });
  it('renames a root object', () => {
    expect(renameDestKey('old.txt', 'new.txt')).toBe('new.txt');
  });
  it('rejects a blank name or a name containing “/” (that would be a move, not a rename)', () => {
    expect(renameDestKey('a/old.png', '   ')).toBeNull();
    expect(renameDestKey('a/old.png', 'sub/new.png')).toBeNull();
  });
});

describe('moveDestKey — move keeps the basename, swaps the folder', () => {
  it('moves into a folder (trailing slash normalized)', () => {
    expect(moveDestKey('images/hero.png', 'archive')).toBe('archive/hero.png');
    expect(moveDestKey('images/hero.png', 'archive/')).toBe('archive/hero.png');
  });
  it('a blank folder moves to the bucket root', () => {
    expect(moveDestKey('images/hero.png', '')).toBe('hero.png');
  });
  it('strips a leading slash (keys never start with “/”)', () => {
    expect(moveDestKey('a.png', '/b')).toBe('b/a.png');
  });
});

// ── 2. The three new context-menu items ────────────────────────────────────────

describe('ObjectActionMenu — B8 rename/copy/move items', () => {
  function setup(withOps = true) {
    const fns = {
      onPreview: vi.fn(),
      onCopyUrl: vi.fn(),
      onDownload: vi.fn(),
      onDelete: vi.fn(),
      onRename: vi.fn(),
      onCopy: vi.fn(),
      onMove: vi.fn(),
    };
    render(
      <ObjectActionMenu
        objectKey="images/hero.png"
        name="hero.png"
        canPreview
        {...fns}
        onRename={withOps ? fns.onRename : undefined}
        onCopy={withOps ? fns.onCopy : undefined}
        onMove={withOps ? fns.onMove : undefined}
      >
        <div data-testid="the-row">hero.png</div>
      </ObjectActionMenu>,
    );

    return fns;
  }
  async function openMenu() {
    fireEvent.contextMenu(screen.getByTestId('the-row'));
    await waitFor(() => expect(screen.getByTestId('buckets-object-context-menu')).toBeTruthy());
  }

  it('renders Rename · Copy to… · Move to… when the ops are available', async () => {
    setup(true);
    await openMenu();
    expect(screen.getByTestId('buckets-object-context-rename')).toBeTruthy();
    expect(screen.getByTestId('buckets-object-context-duplicate')).toBeTruthy();
    expect(screen.getByTestId('buckets-object-context-move')).toBeTruthy();
  });

  it('each new item fires the matching handler with the object key', async () => {
    const fns = setup(true);
    await openMenu();
    fireEvent.click(screen.getByTestId('buckets-object-context-rename'));
    expect(fns.onRename).toHaveBeenCalledWith('images/hero.png');

    await openMenu();
    fireEvent.click(screen.getByTestId('buckets-object-context-duplicate'));
    expect(fns.onCopy).toHaveBeenCalledWith('images/hero.png');

    await openMenu();
    fireEvent.click(screen.getByTestId('buckets-object-context-move'));
    expect(fns.onMove).toHaveBeenCalledWith('images/hero.png');
  });

  it('omits the three items when ops are unavailable (no doomed controls)', async () => {
    setup(false);
    await openMenu();
    expect(screen.queryByTestId('buckets-object-context-rename')).toBeNull();
    expect(screen.queryByTestId('buckets-object-context-duplicate')).toBeNull();
    expect(screen.queryByTestId('buckets-object-context-move')).toBeNull();
    // The original four remain.
    expect(screen.getByTestId('buckets-object-context-download')).toBeTruthy();
    expect(screen.getByTestId('buckets-object-context-delete')).toBeTruthy();
  });
});

// ── 3. The ObjectCopyDialog ────────────────────────────────────────────────────

describe('ObjectCopyDialog — rename / copy / move', () => {
  function setup(mode: 'rename' | 'copy' | 'move', existingKeys: string[] = []) {
    const onClose = vi.fn();
    const onSubmit = vi.fn(async () => ({ ok: true }));
    render(
      <ObjectCopyDialog
        mode={mode}
        srcKey="images/hero.png"
        existingKeys={existingKeys}
        onClose={onClose}
        onSubmit={onSubmit}
      />,
    );

    return { onClose, onSubmit };
  }
  const input = () => screen.getByTestId('buckets-object-op-input') as HTMLInputElement;
  const submitBtn = () => screen.getByTestId('buckets-object-op-submit') as HTMLButtonElement;

  it('rename prefills the current basename + submit is disabled until the name changes', () => {
    setup('rename');
    expect(input().value).toBe('hero.png');
    // Unchanged name → disabled (no self-rename).
    expect(submitBtn().disabled).toBe(true);
  });

  it('rename submits the SAME-folder destKey with deleteSource=true (parent unmounts on success)', async () => {
    const { onSubmit } = setup('rename');
    fireEvent.change(input(), { target: { value: 'banner.png' } });
    expect(submitBtn().disabled).toBe(false);
    fireEvent.click(submitBtn());
    // The dialog hands the derived destKey + deleteSource (+ destBucket — undefined with no picker) to the
    // parent; the PARENT closes on {ok:true} (asserted at the ObjectBrowser layer), so no self-close.
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('images/banner.png', true, undefined));
  });

  it('copy prefills the name + submits with deleteSource=false (source kept)', async () => {
    const { onSubmit } = setup('copy');
    fireEvent.change(input(), { target: { value: 'hero-copy.png' } });
    fireEvent.click(submitBtn());
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('images/hero-copy.png', false, undefined));
  });

  it('move prefills the current folder + submits the NEW-folder destKey (basename kept) with deleteSource=true', async () => {
    const { onSubmit } = setup('move');
    expect(input().value).toBe('images/'); // prefilled with the current folder
    fireEvent.change(input(), { target: { value: 'archive' } });
    fireEvent.click(submitBtn());
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('archive/hero.png', true, undefined));
  });

  it('COLLISION guard — a destKey that already exists disables submit + shows a reason (no overwrite)', async () => {
    setup('copy', ['images/taken.png']);
    fireEvent.change(input(), { target: { value: 'taken.png' } });
    expect(submitBtn().disabled).toBe(true);
    expect(screen.getByTestId('buckets-object-op-error').textContent).toMatch(/already exists/i);
  });

  it('rename rejects a name with “/” (that would be a move) — submit stays disabled', () => {
    setup('rename');
    fireEvent.change(input(), { target: { value: 'sub/x.png' } });
    expect(submitBtn().disabled).toBe(true);
  });

  it('surfaces a server-side conflict inline when onSubmit reports it', async () => {
    const onClose = vi.fn();
    const onSubmit = vi.fn(async () => ({ conflict: true, ok: false }));
    render(
      <ObjectCopyDialog mode="copy" srcKey="a.png" existingKeys={[]} onClose={onClose} onSubmit={onSubmit} />,
    );
    fireEvent.change(screen.getByTestId('buckets-object-op-input'), { target: { value: 'b.png' } });
    fireEvent.click(screen.getByTestId('buckets-object-op-submit'));
    await waitFor(() => expect(screen.getByTestId('buckets-object-op-error').textContent).toMatch(/already exists/i));
    expect(onClose).not.toHaveBeenCalled(); // stays open so the owner can retry
  });

  it('Escape closes the dialog (ModalShell contract)', () => {
    const { onClose } = setup('rename');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('has an accessible dialog role + label', () => {
    setup('rename');
    const dialog = screen.getByTestId('buckets-object-op-modal');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-label')).toBe('Rename file');
  });
});

// ── 4. Cross-bucket destination picker (B8 cross-bucket) ────────────────────────

describe('ObjectCopyDialog — cross-bucket destination picker', () => {
  /** Mount with a multi-bucket site so the picker has somewhere to go. */
  function setup(mode: 'copy' | 'move', opts: { buckets?: string[]; currentBucket?: string; existingKeys?: string[] } = {}) {
    const onClose = vi.fn();
    const onSubmit = vi.fn(async () => ({ ok: true }));
    render(
      <ObjectCopyDialog
        mode={mode}
        srcKey="images/hero.png"
        existingKeys={opts.existingKeys ?? []}
        buckets={opts.buckets ?? ['uploads', 'archive']}
        currentBucket={opts.currentBucket ?? 'uploads'}
        onClose={onClose}
        onSubmit={onSubmit}
      />,
    );
    return { onClose, onSubmit };
  }
  const picker = () => screen.queryByTestId('buckets-object-op-destbucket') as HTMLSelectElement | null;
  const submitBtn = () => screen.getByTestId('buckets-object-op-submit') as HTMLButtonElement;
  const input = () => screen.getByTestId('buckets-object-op-input') as HTMLInputElement;

  it('renders a destination-bucket picker (copy mode) defaulting to the CURRENT bucket', () => {
    setup('copy');
    const sel = picker();
    expect(sel).toBeTruthy();
    expect(sel!.value).toBe('uploads'); // default = current bucket → same-bucket path unchanged
    // Every one of the site's buckets is an option.
    const opts = Array.from(sel!.options).map((o) => o.value);
    expect(opts).toContain('uploads');
    expect(opts).toContain('archive');
  });

  it('copy to ANOTHER bucket submits destBucket (3rd onSubmit arg) with deleteSource=false', async () => {
    const { onSubmit } = setup('copy');
    fireEvent.change(picker()!, { target: { value: 'archive' } });
    // With a cross-bucket destination the SAME key is allowed (no self-collision in the other bucket).
    fireEvent.change(input(), { target: { value: 'hero.png' } });
    fireEvent.click(submitBtn());
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('images/hero.png', false, 'archive'));
  });

  it('move to ANOTHER bucket submits destBucket with deleteSource=true (copy-then-delete)', async () => {
    const { onSubmit } = setup('move');
    fireEvent.change(picker()!, { target: { value: 'archive' } });
    fireEvent.change(input(), { target: { value: 'done' } });
    fireEvent.click(submitBtn());
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('done/hero.png', true, 'archive'));
  });

  it('keeping the picker on the CURRENT bucket submits the current bucket as destBucket (same-bucket semantics preserved)', async () => {
    const { onSubmit } = setup('copy');
    fireEvent.change(input(), { target: { value: 'hero-copy.png' } });
    fireEvent.click(submitBtn());
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('images/hero-copy.png', false, 'uploads'));
  });

  it('a same-NAME collision is only checked within the CURRENT bucket — the SAME key to ANOTHER bucket is allowed', async () => {
    // `taken.png` exists in the CURRENT bucket; copying it (same name) to the OTHER bucket must NOT collide.
    setup('copy', { existingKeys: ['images/taken.png'] });
    fireEvent.change(input(), { target: { value: 'taken.png' } });
    // Same bucket → blocked.
    expect(submitBtn().disabled).toBe(true);
    // Switch to the other bucket → the collision no longer applies.
    fireEvent.change(picker()!, { target: { value: 'archive' } });
    expect(submitBtn().disabled).toBe(false);
  });

  it('rename mode has NO destination picker (rename is always in-place, same bucket)', () => {
    render(
      <ObjectCopyDialog
        mode="rename"
        srcKey="images/hero.png"
        existingKeys={[]}
        buckets={['uploads', 'archive']}
        currentBucket="uploads"
        onClose={vi.fn()}
        onSubmit={vi.fn(async () => ({ ok: true }))}
      />,
    );
    expect(screen.queryByTestId('buckets-object-op-destbucket')).toBeNull();
  });

  it('a single-bucket site shows no picker (nowhere else to go) + still submits the current bucket', async () => {
    const onSubmit = vi.fn(async () => ({ ok: true }));
    render(
      <ObjectCopyDialog
        mode="copy"
        srcKey="a.png"
        existingKeys={[]}
        buckets={['uploads']}
        currentBucket="uploads"
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    expect(screen.queryByTestId('buckets-object-op-destbucket')).toBeNull();
    fireEvent.change(screen.getByTestId('buckets-object-op-input'), { target: { value: 'b.png' } });
    fireEvent.click(screen.getByTestId('buckets-object-op-submit'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('b.png', false, 'uploads'));
  });
});
