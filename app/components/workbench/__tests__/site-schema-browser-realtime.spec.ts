/**
 * @file Site Schema Browser real-time contract — no manual refresh, self-updating.
 *
 * fire-74 regression guard (commit 2e3d1ec19): `/admin/sites/:id` Schema tab
 * (`site-schema-browser.component.ts`, Angular frontend) previously loaded its D1
 * schema ONCE in `ngOnInit` and never again — a manual "Refresh" affordance was the
 * only path to current data, a defect per real-time-data-no-manual-refresh. The fix
 * replaced it with a visibility-aware 60s poll (pauses on `document.hidden`, refreshes
 * immediately on foreground, torn down in `ngOnDestroy`) plus a silent `refresh()`
 * variant and an "updated Ns ago" / "Live" / "Paused" affordance — never a click target.
 *
 * The component lives in the Angular frontend (Karma + Jasmine via `ng test`), outside
 * this repo's root Vitest scope (`vite.config.ts` test.include is `app/**` only — the
 * Angular SPA and the Worker each run their own suite). Mirrors the proven
 * `resources-panel-realtime.spec.ts` pattern: read the real source as text and assert
 * the behavioral contract statically — RED against the pre-fix single-load component,
 * GREEN against the shipped visibility-aware poller.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    '..',
    'apps',
    'project-sites',
    'frontend',
    'src',
    'app',
    'pages',
    'admin',
    'sections',
    'site-schema-browser.component.ts',
  ),
  'utf8',
);

describe('SiteSchemaBrowserComponent real-time contract (fire-74)', () => {
  it('renders no manual Refresh/Reconcile/Sync button for the schema data', () => {
    // Pre-fix the ONLY way to see current data was a click target. A reappearing
    // button-labelled affordance on the schema surface is the defect resurfacing.
    expect(SRC).not.toMatch(/>\s*Refresh\s*</i);
    expect(SRC).not.toMatch(/>\s*Reconcile\s*</i);
    expect(SRC).not.toMatch(/aria-label="Refresh/i);
    expect(SRC).not.toMatch(/\(click\)="(load|refresh)\(\)"/);
  });

  it('arms a visibility-aware poll: interval + visibilitychange + document.hidden guard', () => {
    expect(SRC).toMatch(/setInterval/);
    expect(SRC).toMatch(/visibilitychange/);
    expect(SRC).toMatch(/document\.hidden/);
    // Paused while backgrounded — the poll tick itself must no-op, not just the listener.
    expect(SRC).toMatch(/document\.hidden\)\s*return/);
  });

  it('refreshes immediately on foreground return (no stale wait for the next tick)', () => {
    // onVisibility must call the silent refresh path the instant the tab re-foregrounds,
    // not merely flip a `polling` flag and wait up to POLL_MS for the next tick.
    expect(SRC).toMatch(/const\s+visible\s*=\s*!document\.hidden/);
    expect(SRC).toMatch(/if\s*\(visible\)\s*this\.refresh\(\)/);
  });

  it('tears the poll + listener down in ngOnDestroy (no leaked interval/listener)', () => {
    expect(SRC).toMatch(/ngOnDestroy\(\)[^}]*stopLiveRefresh\(\)/s);
    expect(SRC).toMatch(/clearInterval/);
    expect(SRC).toMatch(/removeEventListener\(\s*'visibilitychange'/);
  });

  it('surfaces a non-interactive "updated Ns ago" / Live / Paused affordance, not a control', () => {
    // The replacement UI is a status span (role="status"), never a <button>.
    expect(SRC).toMatch(/role="status"/);
    expect(SRC).toMatch(/updatedLabel/);
    expect(SRC).not.toMatch(/<button[^>]*updatedLabel/);
  });

  it('the silent refresh() path keeps the last-good schema on a transient error (no error flash)', () => {
    // refresh() must guard the response shape and bail WITHOUT touching `error` or
    // clearing `tables` — only load() (the first/manual fetch) is allowed to surface
    // a retryable error card. A regression that routes refresh() through the same
    // error-setting path would flash an error on every transient poll failure.
    const refreshFn = SRC.match(/refresh\(\):\s*void\s*\{([\s\S]*?)\n  \}/)?.[1] ?? '';
    expect(refreshFn).not.toBe('');
    expect(refreshFn).not.toMatch(/this\.error\.set/);
    // Tolerate a nested-paren guard, e.g. `if (!res || !Array.isArray(res.data?.tables)) return;`.
    expect(refreshFn).toMatch(/if\s*\(!res[\s\S]*?\)\s*return/);
  });
});
