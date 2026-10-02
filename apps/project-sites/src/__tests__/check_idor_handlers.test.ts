/**
 * check_idor_handlers.test.ts — regression guard for the HANDLER-GRANULAR IDOR detector
 * (`scripts/check-idor-handlers.mjs`, pure `scanMutationHandler`).
 *
 * fire-83 bug: `SCAN_DIRS` only walked `src/routes` + `libs`, so an inline
 * `app.post('/api/sites/:siteId/…')` handler defined DIRECTLY in `src/index.ts` escaped the
 * `assertSiteOwned` IDOR gate entirely. The scanner now also scans the top-level `src/*.ts`
 * files; these tests lock the CLASSIFIER behaviour the fix relies on so a future edit can't
 * silently re-open the blind-spot: an inline `:siteId` mutation handler WITHOUT an ownership
 * idiom must FLAG, and a guarded one must PASS.
 */
import { scanMutationHandler } from '../../scripts/check-idor-handlers.mjs';

describe('check-idor-handlers · scanMutationHandler', () => {
  // The exact shape of the inline handlers that live in src/index.ts (the fire-83 blind-spot).
  const SITE_ID_ROUTE = '/api/sites/:siteId/dashboard/metric';

  describe('FLAGS an unguarded :siteId mutation handler', () => {
    it('flags an inline :siteId handler that writes with NO ownership idiom', () => {
      const body = `app.post('/api/sites/:siteId/dashboard/metric', async (c) => {
        const siteId = c.req.param('siteId');
        await dbUpdate(c.env.DB, 'metrics', { v: 1 }, 'site_id = ?', [siteId]);
        return c.json({ ok: true });
      });`;
      expect(scanMutationHandler(SITE_ID_ROUTE, body).flagged).toBe(true);
    });

    it('flags a service-DELEGATED write with no ownership idiom', () => {
      const body = `app.post('/api/sites/:siteId/provision', async (c) => {
        const siteId = c.req.param('siteId');
        await domainService.provisionFreeDomain(siteId);
        return c.json({ ok: true });
      });`;
      expect(scanMutationHandler('/api/sites/:siteId/provision', body).flagged).toBe(true);
    });
  });

  describe('PASSES a guarded :siteId mutation handler', () => {
    it('passes when the handler body calls assertSiteOwned', () => {
      const body = `app.post('/api/sites/:siteId/dashboard/metric', async (c) => {
        const siteId = c.req.param('siteId');
        const { assertSiteOwned } = await import('./services/site_ownership.js');
        if (!(await assertSiteOwned(c.env, c.get('orgId'), siteId))) return c.notFound();
        await dbUpdate(c.env.DB, 'metrics', { v: 1 }, 'site_id = ?', [siteId]);
        return c.json({ ok: true });
      });`;
      expect(scanMutationHandler(SITE_ID_ROUTE, body).flagged).toBe(false);
    });

    it('passes a handler whose write goes through an awaited local gate() helper', () => {
      // Mirrors libs/features/r2_buckets + site_data_api: the ownership check lives inside the
      // `gate(c, siteId)` / `gateResolveAndRequireTable(c, siteId, table)` helper, not the body.
      const body = `r2Buckets.post('/api/sites/:siteId/r2/buckets', async (c) => {
        const { siteId } = c.req.param();
        const g = await gate(c, siteId);
        if (g instanceof Response) return g;
        await provisionSiteR2(c.env, { siteId, orgId: g.orgId });
        return c.json({ ok: true }, 201);
      });`;
      expect(scanMutationHandler('/api/sites/:siteId/r2/buckets', body).flagged).toBe(false);

      const delRow = `siteDbApi.delete('/api/sites/:siteId/db/tables/:table/rows/:rowid', async (c) => {
        const { siteId, table, rowid } = c.req.param();
        const gate = await gateResolveAndRequireTable(c, siteId, table);
        if (gate instanceof Response) return gate;
        await gate.db.query('DELETE FROM x WHERE rowid = ?', [rowid]);
        return c.json({ ok: true });
      });`;
      expect(
        scanMutationHandler('/api/sites/:siteId/db/tables/:table/rows/:rowid', delRow).flagged,
      ).toBe(false);
    });

    it('passes when scoped by an explicit AND org_id = ? WHERE clause', () => {
      const body = `app.delete('/api/sites/:siteId/widgets/:id', async (c) => {
        await dbExecute(c.env.DB, 'DELETE FROM widgets WHERE id = ? AND org_id = ?', [id, orgId]);
        return c.json({ ok: true });
      });`;
      expect(scanMutationHandler('/api/sites/:siteId/widgets/:id', body).flagged).toBe(false);
    });
  });

  describe('precision — false-negative-preferring guards do NOT over-flag', () => {
    it('does not flag a handler with no attacker-suppliable sub-resource id', () => {
      const body = `app.post('/api/apps/launch', async (c) => {
        await dbInsert(c.env.DB, 'launches', { ok: 1 });
        return c.json({ ok: true });
      });`;
      expect(scanMutationHandler('/api/apps/launch', body).flagged).toBe(false);
    });

    it('does not flag a :siteId handler that performs NO write (pure compute)', () => {
      const body = `app.post('/api/sites/:siteId/social/engagement', async (c) => {
        const siteId = c.req.param('siteId');
        return c.json({ data: scoreEngagement(c.req.json()) });
      });`;
      expect(scanMutationHandler('/api/sites/:siteId/social/engagement', body).flagged).toBe(false);
    });

    it('does not flag an intentionally-public mutation endpoint on the allowlist', () => {
      const body = `app.post('/api/contact-form/:slug', async (c) => {
        await dbInsert(c.env.DB, 'form_submissions', { slug: c.req.param('slug') });
        return c.json({ ok: true });
      });`;
      expect(scanMutationHandler('/api/contact-form/:slug', body).flagged).toBe(false);
    });

    it('does not flag super-admin cross-org surfaces (cross-org BY DESIGN)', () => {
      const body = `app.post('/api/sites/:siteId/reindex', async (c) => {
        if (!isSuperAdmin(c)) return c.notFound();
        await dbExecute(c.env.DB, 'UPDATE sites SET reindex = 1 WHERE id = ?', [siteId]);
        return c.json({ ok: true });
      });`;
      expect(scanMutationHandler('/api/sites/:siteId/reindex', body).flagged).toBe(false);
    });
  });
});
