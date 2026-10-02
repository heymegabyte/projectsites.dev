/**
 * check_get_read_idor.test.ts — regression guard for the GET-READ cross-org IDOR detector
 * (`scripts/check-get-read-idor.mjs`, pure `scanGetHandler` + the file-coverage surface).
 *
 * TWIN of the fire-83 mutation-scanner bug: `check-idor-handlers.mjs` (mutations) walked only
 * `src/routes` + `libs`, so an inline `app.post('/api/sites/:siteId/…')` handler defined DIRECTLY
 * in `src/index.ts` dodged the `assertSiteOwned` gate — fixed there + locked by
 * `check_idor_handlers.test.ts`. The READ scanner still had the IDENTICAL blind-spot
 * (`SCAN_DIRS = [src/routes, libs]`, NO top-level `src/*.ts`) and NO test at all, so the three
 * inline `app.get('/api/sites/:siteId/{dashboard,annotations,sparkline}')` READ handlers in
 * `src/index.ts` were never scanned — a newly-added unscoped GET-read there could leak another
 * org's data invisibly. These tests (1) lock the CLASSIFIER so the false-negative-preferring
 * precision can't regress, and (2) assert `src/index.ts` is IN the detector's file-coverage set
 * so the inline-handler blind-spot stays closed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanGetHandler } from '../../scripts/check-get-read-idor.mjs';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('check-get-read-idor · scanGetHandler', () => {
  // The exact shape of the inline GET-read handlers that live in src/index.ts.
  const SITE_ID_ROUTE = '/api/sites/:siteId/dashboard';

  describe('FLAGS an unguarded :siteId GET-read handler', () => {
    it('flags an inline :siteId GET that reads a tenant row with NO ownership idiom', () => {
      const body = `app.get('/api/sites/:siteId/dashboard', async (c) => {
        const siteId = c.req.param('siteId');
        const row = await dbQueryOne(c.env.DB, 'SELECT * FROM metrics WHERE site_id = ?', [siteId]);
        return c.json({ data: row });
      });`;
      expect(scanGetHandler(SITE_ID_ROUTE, body).flagged).toBe(true);
    });
  });

  describe('PASSES a guarded :siteId GET-read handler', () => {
    it('passes when the handler body calls assertSiteOwned', () => {
      const body = `app.get('/api/sites/:siteId/dashboard', async (c) => {
        const siteId = c.req.param('siteId');
        const { assertSiteOwned } = await import('./services/site_ownership.js');
        if (!(await assertSiteOwned(c.env, c.get('orgId'), siteId))) return c.notFound();
        const row = await dbQueryOne(c.env.DB, 'SELECT * FROM metrics WHERE site_id = ?', [siteId]);
        return c.json({ data: row });
      });`;
      expect(scanGetHandler(SITE_ID_ROUTE, body).flagged).toBe(false);
    });

    it('passes when scoped by an explicit AND org_id = ? WHERE clause', () => {
      const body = `app.get('/api/sites/:siteId/widgets/:id', async (c) => {
        const row = await dbQueryOne(c.env.DB, 'SELECT * FROM widgets WHERE id = ? AND org_id = ?', [id, orgId]);
        return c.json({ data: row });
      });`;
      expect(scanGetHandler('/api/sites/:siteId/widgets/:id', body).flagged).toBe(false);
    });
  });

  describe('precision — false-negative-preferring guards do NOT over-flag', () => {
    it('does not flag a :siteId handler that performs NO DB read (pure compute)', () => {
      const body = `app.get('/api/sites/:siteId/sparkline', async (c) => {
        return c.json({ data: buildSparkline(c.req.param('siteId')) });
      });`;
      expect(scanGetHandler('/api/sites/:siteId/sparkline', body).flagged).toBe(false);
    });

    it('does not flag a handler with no attacker-suppliable sub-resource id', () => {
      const body = `app.get('/api/notifications/badge', async (c) => {
        const rows = await dbQuery(c.env.DB, 'SELECT * FROM notifs WHERE org_id = ?', [orgId]);
        return c.json({ data: rows });
      });`;
      expect(scanGetHandler('/api/notifications/badge', body).flagged).toBe(false);
    });

    it('does not flag an intentionally-public by-slug read on the allowlist', () => {
      const body = `app.get('/api/sites/by-slug/:slug/build-context', async (c) => {
        const row = await dbQueryOne(c.env.DB, 'SELECT * FROM sites WHERE slug = ?', [c.req.param('slug')]);
        return c.json({ data: row });
      });`;
      expect(scanGetHandler('/api/sites/by-slug/:slug/build-context', body).flagged).toBe(false);
    });
  });

  describe('file coverage — the src/index.ts inline-handler blind-spot stays closed', () => {
    it('scans the top-level src/index.ts (where inline :siteId GET handlers live)', async () => {
      // This is the twin of the fire-83 mutation fix: the READ scanner must reach src/index.ts.
      const mod = (await import('../../scripts/check-get-read-idor.mjs')) as {
        collectScanFiles?: () => string[];
      };
      expect(typeof mod.collectScanFiles).toBe('function');
      const files = mod.collectScanFiles!();
      const indexPath = join(APP_DIR, 'src', 'index.ts');
      expect(existsSync(indexPath)).toBe(true);
      expect(files).toContain(indexPath);
    });

    it('does NOT pull in test files or type decls from the top-level src dir', async () => {
      const mod = (await import('../../scripts/check-get-read-idor.mjs')) as {
        collectScanFiles?: () => string[];
      };
      const files = mod.collectScanFiles!();
      expect(files.some((f) => f.endsWith('.test.ts'))).toBe(false);
      expect(files.some((f) => f.endsWith('.d.ts'))).toBe(false);
    });

    it("confirms src/index.ts actually registers the inline GET-by-siteId handlers this guard covers", () => {
      // Sanity: if these handlers ever move out of index.ts the blind-spot shrinks, but while
      // they're inline the scanner MUST see them (the whole point of the top-level scan).
      const text = readFileSync(join(APP_DIR, 'src', 'index.ts'), 'utf8');
      expect(text).toMatch(/app\.get\(\s*['"`]\/api\/sites\/:siteId\//);
    });
  });
});
