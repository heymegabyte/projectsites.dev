/**
 * AL-385 — the status-update guard that ROOT-FIXES the AL-379 race: a stale 2nd workflow
 * instance's `updateSiteStatus('generating')` clobbering an already-`published` site back to
 * `generating` (a transient lying-status the AL-380 belt then heals in ~30 min). An
 * in-progress transition anchors `status != 'published'` so it can never regress a published
 * site; a forward/terminal transition (published/error/archived) stays unconditional so the
 * normal build progression is unaffected.
 */
import { NO_REGRESS_FROM_PUBLISHED, statusUpdateSql } from '../workflows/site-generation.js';

describe('statusUpdateSql (AL-385: never regress a published site to in-progress)', () => {
  it.each(['collecting', 'imaging', 'generating', 'building', 'queued', 'uploading'])(
    'guards the in-progress transition %s with `status != published`',
    (status) => {
      expect(NO_REGRESS_FROM_PUBLISHED.has(status)).toBe(true);
      expect(statusUpdateSql(status)).toMatch(/WHERE id = \? AND status != 'published'/);
    },
  );

  it.each(['published', 'error', 'archived'])(
    'does NOT guard the forward/terminal transition %s (unconditional WHERE id)',
    (status) => {
      expect(NO_REGRESS_FROM_PUBLISHED.has(status)).toBe(false);
      const sql = statusUpdateSql(status);
      expect(sql).toMatch(/WHERE id = \?$/);
      expect(sql).not.toContain("!= 'published'");
    },
  );

  it('always sets status + updated_at (both variants)', () => {
    for (const s of ['generating', 'published']) {
      expect(statusUpdateSql(s)).toMatch(
        /UPDATE sites SET status = \?, updated_at = datetime\('now'\)/,
      );
    }
  });
});
