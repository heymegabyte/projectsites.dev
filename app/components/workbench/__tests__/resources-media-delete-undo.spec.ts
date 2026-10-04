/**
 * @file Resources › Media — optimistic DELETE + UNDO (FILES-DELETE-UNDO, Editor EPIC, fire-146).
 *
 * The media delete previously fired the destructive DELETE immediately, then filtered the
 * card out — a toast, but NO undo. This slice makes delete OPTIMISTIC + DEFERRED: the card
 * is removed from `state.assets` the instant the user clicks, an "Deleted · Undo" toast opens
 * a grace window, and the real server-side DELETE is NOT sent until that window closes. Undo =
 * cancel the pending-delete timer AND re-insert the card at its original index — ZERO server
 * compensation (nothing was deleted yet). Expiry commits the one real DELETE call.
 *
 * Tests the two PURE helpers that drive the optimistic remove + restore (one source of truth
 * shared by the component), so the logic is falsifiable without a DOM / WebContainer — mirroring
 * {@link mergeMediaAssets} / {@link mergeBuildFiles} and their specs:
 *   - `removeMediaAsset(assets, id)` → `{ assets, removed, index }` — drop the id, remember where.
 *   - `restoreMediaAsset(assets, removed, index)` — re-insert at the remembered index (undo).
 */
import { describe, expect, it } from 'vitest';
import { removeMediaAsset, restoreMediaAsset } from '../ResourcesPanel';
import type { MediaAssetEntry } from '~/lib/embed/embedded-mode';

const asset = (id: string): MediaAssetEntry => ({ id, name: `${id}.png`, url: `/${id}.png` }) as MediaAssetEntry;

describe('Resources media optimistic delete + undo (FILES-DELETE-UNDO)', () => {
  it('removeMediaAsset drops the id and remembers the removed asset + its index', () => {
    const list = [asset('a'), asset('b'), asset('c')];

    const result = removeMediaAsset(list, 'b');

    // The card is gone from the visible list immediately (optimistic remove).
    expect(result.assets.map((a) => a.id)).toEqual(['a', 'c']);
    // The removed asset + its original index are carried so undo can put it back exactly.
    expect(result.removed?.id).toBe('b');
    expect(result.index).toBe(1);
    // The input list is not mutated (pure).
    expect(list.map((a) => a.id)).toEqual(['a', 'b', 'c']);
  });

  it('restoreMediaAsset re-inserts the removed asset at its original index (undo)', () => {
    const list = [asset('a'), asset('b'), asset('c')];
    const { assets: afterRemove, removed, index } = removeMediaAsset(list, 'b');

    // Undo before the window expires: put 'b' back exactly where it was.
    const restored = restoreMediaAsset(afterRemove, removed, index);

    expect(restored.map((a) => a.id)).toEqual(['a', 'b', 'c']);
  });

  it('round-trips the first and last positions exactly', () => {
    const list = [asset('a'), asset('b'), asset('c')];

    const first = removeMediaAsset(list, 'a');
    expect(first.assets.map((a) => a.id)).toEqual(['b', 'c']);
    expect(restoreMediaAsset(first.assets, first.removed, first.index).map((a) => a.id)).toEqual(['a', 'b', 'c']);

    const last = removeMediaAsset(list, 'c');
    expect(last.assets.map((a) => a.id)).toEqual(['a', 'b']);
    expect(restoreMediaAsset(last.assets, last.removed, last.index).map((a) => a.id)).toEqual(['a', 'b', 'c']);
  });

  it('removeMediaAsset on an absent id is a no-op (nothing removed, index -1)', () => {
    const list = [asset('a'), asset('b')];

    const result = removeMediaAsset(list, 'zzz');

    expect(result.assets.map((a) => a.id)).toEqual(['a', 'b']);
    expect(result.removed).toBeUndefined();
    expect(result.index).toBe(-1);
  });

  it('restoreMediaAsset is a no-op when there is nothing to restore (undo after commit)', () => {
    const list = [asset('a'), asset('c')];

    // removed === undefined models "the delete already committed" — undo must not corrupt the list.
    expect(restoreMediaAsset(list, undefined, 1).map((a) => a.id)).toEqual(['a', 'c']);
  });

  it('restoreMediaAsset clamps an out-of-range index to the end (never drops the card)', () => {
    const list = [asset('a'), asset('b')];

    // index past the end (list shrank meanwhile) → append rather than lose the restored asset.
    const restored = restoreMediaAsset(list, asset('z'), 99);

    expect(restored.map((a) => a.id)).toEqual(['a', 'b', 'z']);
  });

  it('does not duplicate when the restored id is somehow already present (idempotent undo)', () => {
    const list = [asset('a'), asset('b')];

    // A double-fired undo must not insert 'b' twice.
    const restored = restoreMediaAsset(list, asset('b'), 1);

    expect(restored.map((a) => a.id)).toEqual(['a', 'b']);
  });
});
