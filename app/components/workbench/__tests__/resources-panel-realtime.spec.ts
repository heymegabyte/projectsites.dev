/**
 * @file ResourcesPanel real-time contract — no manual refresh, self-updating.
 *
 * Deep UI Explorer live probe (fire-55, run dux-2026-09-29T22-52-17-937Z): ONE manual
 * Refresh control persisted across EVERY Resources state — the PARENT panel's own
 * header button (`aria-label="Refresh resources"`), missed by the fire-54 sub-panel
 * sweep which covered Buckets/EnvGrid/R2Browser/NamespaceSummary/ResourceDetail but
 * not ResourcesPanel's chrome. Rule: real-time-data-no-manual-refresh — a data surface
 * self-updates; a click-to-refresh control is a defect.
 *
 * Static contract lock (the behavioral proof is the explorer's live probe, which must
 * report zero /refresh|reconcile/i controls across the Resources journey):
 *  1. ResourcesPanel renders NO Refresh/Reconcile button.
 *  2. ResourcesPanel carries a visibility-aware poll (interval + visibilitychange +
 *     document.hidden guard) driving the same reload path the button used.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'ResourcesPanel.tsx'), 'utf8');

describe('ResourcesPanel real-time contract (fire-55)', () => {
  it('renders no manual Refresh/Reconcile control', () => {
    expect(SRC).not.toMatch(/aria-label="Refresh/i);
    expect(SRC).not.toMatch(/title="Refresh"/i);
    expect(SRC).not.toMatch(/>\s*Reconcile\s*</i);
  });

  it('self-updates via a visibility-aware poll on the reload path', () => {
    expect(SRC).toMatch(/visibilitychange/);
    expect(SRC).toMatch(/document\.hidden/);
    expect(SRC).toMatch(/setInterval/);

    /*
     * Latest-ref pattern so the inline onRefresh closure never goes stale
     * (per the datapanel empty-deps-needs-latest-ref incident).
     */
    expect(SRC).toMatch(/onRefreshRef/);
  });
});
