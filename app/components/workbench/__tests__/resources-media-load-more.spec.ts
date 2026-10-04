/**
 * @file Resources › Media — "Load more" paging contract (MEDIA-UI-1b, fire-136).
 *
 * fire-135 shipped the honest "N of total" count (`filteredTotal`) but there was NO
 * way to load the remaining assets — the user saw "50 of 109" and was stuck. This
 * completes the slice: a second page APPENDS (never replaces), dedupes by id, the
 * "N of total" converges toward total, and the load-more affordance HIDES once
 * shown === total.
 *
 * Tests the two PURE helpers that drive the control (one source of truth shared by the
 * component), so the append/hasMore logic is falsifiable without a DOM:
 *   - `mergeMediaAssets(prev, next)` — append + dedupe by id (stable order, prev wins).
 *   - `hasMoreMedia(shown, total)` — is there another page to fetch?
 */
import { describe, expect, it } from 'vitest';
import { hasMoreMedia, mergeMediaAssets } from '../ResourcesPanel';
import type { MediaAssetEntry } from '~/lib/embed/embedded-mode';

const asset = (id: string): MediaAssetEntry => ({ id, name: `${id}.png` }) as MediaAssetEntry;

describe('Resources media "Load more" paging (MEDIA-UI-1b)', () => {
  it('APPENDS a second page onto the first (never replaces)', () => {
    const page1 = [asset('a'), asset('b')];
    const page2 = [asset('c'), asset('d')];

    const merged = mergeMediaAssets(page1, page2);

    expect(merged.map((a) => a.id)).toEqual(['a', 'b', 'c', 'd']);
    // The first page is still present — this is the bug the slice fixes (was `assets: reply.assets`).
    expect(merged.length).toBe(page1.length + page2.length);
  });

  it('dedupes by id when a page overlaps (no duplicate tiles)', () => {
    const page1 = [asset('a'), asset('b')];
    const page2 = [asset('b'), asset('c')]; // 'b' repeats across the page boundary

    const merged = mergeMediaAssets(page1, page2);

    expect(merged.map((a) => a.id)).toEqual(['a', 'b', 'c']);
  });

  it('"N of total" converges toward total as pages load', () => {
    let assets = [asset('a'), asset('b')]; // page 1: shown 2
    const total = 5;

    expect(hasMoreMedia(assets.length, total)).toBe(true); // 2 < 5 → more

    assets = mergeMediaAssets(assets, [asset('c'), asset('d')]); // page 2: shown 4
    expect(assets.length).toBe(4);
    expect(hasMoreMedia(assets.length, total)).toBe(true); // 4 < 5 → still more

    assets = mergeMediaAssets(assets, [asset('e')]); // page 3: shown 5 === total
    expect(assets.length).toBe(5);
    expect(hasMoreMedia(assets.length, total)).toBe(false); // converged → HIDE load-more
  });

  it('load-more HIDES when shown === total and when total is unknown', () => {
    expect(hasMoreMedia(50, 50)).toBe(false); // exactly full
    expect(hasMoreMedia(60, 50)).toBe(false); // over (defensive)
    expect(hasMoreMedia(50, undefined)).toBe(false); // no total → can't promise more
    expect(hasMoreMedia(0, 0)).toBe(false); // empty library
  });
});
