/**
 * @file data-tab-journey.e2e.ts
 * @description Per-site D1 "Data / Database" journey — proven GREEN on PROD, end-to-end,
 *              against the site's OWN dedicated Cloudflare D1 (never the shared platform DB).
 *
 * WHAT THIS PROVES (the `per_site_data` flag is ENABLED for the E2E org via a D1
 * `flag_overrides` row — `scope='org', scope_id='e2e-test-org'`, mirroring how
 * `durable_preview` was enabled out-of-band for the same org):
 *
 *  1. **Reconcile leg (the load-bearing proof — verify-against-source-of-truth).** As the REAL
 *     user (real `E2E_API_KEY` session, real browser `fetch` with the Bearer), drive the WHOLE
 *     data journey — create a typed table → insert a row → add / rename / drop a column → run a
 *     SQL-console query → drop the table — and after EVERY mutation reconcile the DISPLAY endpoint
 *     (`GET /api/sites/:id/db/tables[/:table]`) against the store. The endpoint reads the site's
 *     OWN per-site D1 (`resolveSiteDataDb` → `site_database_allocations`, shared-platform ids
 *     denylisted), so `groundTruth != display` is a hard FAIL. This is the causal display-vs-store
 *     test (`[[verify-against-source-of-truth]]`), the thing render-integrity is blind to.
 *
 *  2. **Browser UI leg.** Log in for real, open the bolt.diy editor iframe for the E2E site, click
 *     the **Database** top-tab, and assert the per-site **Tables** surface MOUNTS in a real browser
 *     with the flag ON — i.e. the interactive `sitedb-*` surface renders (NOT the flag-off
 *     `sitedb-disabled` / `sitedb-coming-soon` state, NOT a raw error). This proves the DARK-gated
 *     UI is genuinely reachable once the override is live (`[[interaction≠build]]`).
 *
 * ARCHITECTURE NOTES (load-bearing):
 *  - The editor is a CROSS-ORIGIN iframe (`editor.projectsites.dev`) + WebContainer cold-boot
 *    (~30–60s once/session), hosted by the Angular admin at `/admin/editor`. It has NO cross-origin
 *    session, so the Data UI talks to the worker via the admin PARENT over the `PS_SITEDB_*`
 *    postMessage bridge — the parent makes the authed HTTP calls. The reconcile leg therefore
 *    asserts the STORE directly (parent-session `fetch`), and the browser leg asserts the UI mounts.
 *  - Bare `/admin/editor` (never `/admin/editor/:siteId`): no code maps the `:siteId` route param to
 *    `selectSite`; the admin boots on the resolved/default site (`selectedSite ?? sites[0]`).
 *  - Tables browse exposes a hidden `_rowid` handle + real columns; `total` is authoritative row count
 *    (`rows_written` in a mutation meta counts index writes and is NOT the row count).
 *
 * HONESTY: no mocks, real per-site D1, assertions never weakened. If the editor frame genuinely
 * can't mount, the browser leg surfaces a precise gap (a real gap is a valid result); the reconcile
 * leg — the core money-path proof — does not depend on the iframe and must pass. A false green is
 * never acceptable: the reconcile leg fails LOUDLY on any display-vs-store divergence.
 *
 * VERIFY: cd apps/project-sites && npx playwright test e2e/data-tab-journey.e2e.ts --config=playwright.prod.config.ts
 */

import { test, expect, type FrameLocator, type Page } from '@playwright/test';

import { gotoAdmin, SYS_ADMIN_TEST_EMAIL } from './helpers/auth.js';
import { realDataAvailable, setupRealDataPage } from './helpers/realdata.js';
import { resolveE2ESite } from './admin-verify/_resolve-e2e-site.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROD_URL = process.env.PROD_URL ?? 'https://projectsites.dev';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

/** A deterministic, obviously-test table name (safe ident). Torn down at the end of the journey. */
const PROBE_TABLE = 'e2e_data_journey';

/** WebContainer cold-boot is slow-but-progressing; waits are BOUNDED (never sleeps), so a truly-stuck frame still fails. */
const EDITOR_BOOT_MS = 90_000;

/**
 * `/api/*` the editor + admin parent legitimately need against REAL prod (authed → real per-site D1).
 * Everything else is benignly stubbed by `setupRealDataPage` so an unstubbed GET never 401→bounce.
 */
const EDITOR_PASSTHROUGH =
  /\/api\/(auth\/me|sites\b|sites\/[^/]+\/(db\/|workflow|readiness|build-context|chat|preview-state|releases)|sites\/by-slug\/|feature-flags)/;

// ---------------------------------------------------------------------------
// Reconcile helpers — every call runs AS THE REAL USER against the site's OWN D1.
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

/** In-browser authed fetch (the parent-session pattern the Data UI uses). Returns `{ status, body }`. */
async function apiFetch(
  page: Page,
  method: string,
  path: string,
  body?: Json,
): Promise<{ status: number; body: any }> {
  return page.evaluate(
    async ({ base, m, p, b, token }) => {
      const res = await fetch(`${base}${p}`, {
        method: m,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(b ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(b ? { body: JSON.stringify(b) } : {}),
      });
      let parsed: unknown = null;
      try {
        parsed = await res.json();
      } catch {
        /* non-JSON — leave null */
      }
      return { status: res.status, body: parsed };
    },
    { base: PROD_URL, m: method, p: path, b: body ?? null, token: process.env.E2E_API_KEY! },
  );
}

/** GROUND TRUTH: the list of table names in the site's OWN per-site D1 (+ the resolved databaseId). */
async function groundTruthTables(
  page: Page,
  siteId: string,
): Promise<{ status: number; tables: string[]; databaseId: string | null }> {
  const { status, body } = await apiFetch(page, 'GET', `/api/sites/${siteId}/db/tables`);
  const tables: string[] = Array.isArray(body?.data?.tables)
    ? body.data.tables.map((t: { name: string }) => t.name)
    : [];
  return { status, tables, databaseId: body?.data?.databaseId ?? null };
}

/** GROUND TRUTH for one table: `{ total, columns[], rows[] }` from the site's OWN D1. */
async function groundTruthTable(
  page: Page,
  siteId: string,
  table: string,
): Promise<{ status: number; total: number; columns: string[]; rows: Json[] }> {
  const { status, body } = await apiFetch(page, 'GET', `/api/sites/${siteId}/db/tables/${table}`);
  const d = body?.data ?? {};
  return {
    status,
    total: Number(d.total ?? 0),
    columns: Array.isArray(d.columns) ? d.columns.map((c: { name: string }) => c.name) : [],
    rows: Array.isArray(d.rows) ? d.rows : [],
  };
}

/** Best-effort teardown so a re-run starts clean; never throws (a 404 is fine — nothing to drop). */
async function dropProbeTable(page: Page, siteId: string): Promise<void> {
  await apiFetch(page, 'DELETE', `/api/sites/${siteId}/db/tables/${PROBE_TABLE}`).catch(() => {});
}

/** Resolve the E2E org's real site; skip (never false-fail) when the org has no site. */
async function resolveSiteOrSkip(): Promise<{ id: string; slug: string }> {
  const { id, slug } = await resolveE2ESite(PROD_URL, process.env.E2E_API_KEY!, UA);
  test.skip(!id, 'E2E org has no site — nothing to drive the Data journey against');
  return { id, slug };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

test.describe('Per-site D1 Data journey (real UI + display-vs-store reconcile on prod)', () => {
  // The whole suite needs a REAL session — a real per-site D1 to write to + reconcile against.
  test.skip(!realDataAvailable(), 'needs E2E_API_KEY for a real session + a real per-site D1');

  test.beforeEach(async ({ page }) => {
    // Real session + `/api` routing so every db/* + auth/me call hits live prod (authed → real data).
    await page.goto(PROD_URL, { waitUntil: 'domcontentloaded' });
    await setupRealDataPage(page, { passthrough: EDITOR_PASSTHROUGH, email: SYS_ADMIN_TEST_EMAIL });
  });

  // -------------------------------------------------------------------------
  // Scenario 1 — the FULL data journey, reconciling display-vs-store after every mutation.
  // This is the load-bearing money-path proof (verify-against-source-of-truth).
  // -------------------------------------------------------------------------
  test('1. create → row → add/rename/drop column → SQL console → drop, each reconciled to the site OWN D1', async ({
    page,
  }) => {
    const { id: siteId } = await resolveSiteOrSkip();

    // Flag ON for the E2E org ⇒ the endpoint is reachable (200), NOT dark (404). If this is 404 the
    // override didn't land — a real, loud failure (never silently skip past a dark flag).
    const seed = await groundTruthTables(page, siteId);
    expect(
      seed.status,
      'GET /db/tables must be 200 (per_site_data ON for E2E org) — 404 means the flag override is missing',
    ).toBe(200);
    expect(seed.databaseId, 'the site must resolve to its OWN per-site D1 (a databaseId)').toBeTruthy();

    // Clean slate for a deterministic re-run.
    await dropProbeTable(page, siteId);

    // ── CREATE TABLE (typed columns) ─────────────────────────────────────────
    const created = await apiFetch(page, 'POST', `/api/sites/${siteId}/db/tables`, {
      table: PROBE_TABLE,
      columns: [
        { name: 'title', type: 'TEXT', notnull: true },
        { name: 'qty', type: 'INTEGER' },
      ],
    });
    expect(created.status, 'create table must 201').toBe(201);
    // RECONCILE: the new table exists in the store.
    let gtTables = await groundTruthTables(page, siteId);
    expect(gtTables.tables, 'display: created table must appear in the site OWN D1').toContain(PROBE_TABLE);

    // ── INSERT ROW ───────────────────────────────────────────────────────────
    const inserted = await apiFetch(page, 'POST', `/api/sites/${siteId}/db/tables/${PROBE_TABLE}/rows`, {
      values: { title: 'Widget', qty: 7 },
    });
    expect(inserted.status, 'insert row must 201').toBe(201);
    // RECONCILE: exactly one row, values match the store (never trust the write's echoed count).
    let gt = await groundTruthTable(page, siteId, PROBE_TABLE);
    expect(gt.total, 'display: exactly 1 row present in the store after insert').toBe(1);
    expect(gt.rows[0]?.title, 'display: inserted title reconciles with the store').toBe('Widget');
    expect(Number(gt.rows[0]?.qty), 'display: inserted qty reconciles with the store').toBe(7);

    // ── ADD COLUMN ───────────────────────────────────────────────────────────
    const added = await apiFetch(page, 'POST', `/api/sites/${siteId}/db/tables/${PROBE_TABLE}/columns`, {
      name: 'note',
      type: 'TEXT',
    });
    expect(added.status, 'add column must 201').toBe(201);
    gt = await groundTruthTable(page, siteId, PROBE_TABLE);
    expect(gt.columns, 'display: added column present in the store').toContain('note');

    // ── RENAME COLUMN note → memo ────────────────────────────────────────────
    const renamed = await apiFetch(
      page,
      'PATCH',
      `/api/sites/${siteId}/db/tables/${PROBE_TABLE}/columns/note`,
      { name: 'memo' },
    );
    expect(renamed.status, 'rename column must 200').toBe(200);
    gt = await groundTruthTable(page, siteId, PROBE_TABLE);
    expect(gt.columns, 'display: renamed column reflects new name in the store').toContain('memo');
    expect(gt.columns, 'display: old column name is gone from the store').not.toContain('note');

    // ── DROP COLUMN memo ─────────────────────────────────────────────────────
    const droppedCol = await apiFetch(
      page,
      'DELETE',
      `/api/sites/${siteId}/db/tables/${PROBE_TABLE}/columns/memo`,
    );
    expect(droppedCol.status, 'drop column must 200').toBe(200);
    gt = await groundTruthTable(page, siteId, PROBE_TABLE);
    expect(gt.columns, 'display: dropped column removed from the store').not.toContain('memo');
    // The row survives the column churn (data-integrity check).
    expect(gt.total, 'display: the row survives column add/rename/drop').toBe(1);

    // ── SQL CONSOLE — a real single-statement query against the site OWN D1 ────
    const sql = await apiFetch(page, 'POST', `/api/sites/${siteId}/db/query`, {
      sql: `SELECT COUNT(*) AS n FROM ${PROBE_TABLE}`,
    });
    expect(sql.status, 'SQL console query must 200').toBe(200);
    expect(sql.body?.ok, 'SQL console reports ok').toBe(true);
    expect(
      Number(sql.body?.data?.rows?.[0]?.n),
      'SQL console COUNT(*) reconciles with the reconciled row total (1)',
    ).toBe(1);

    // ── DROP TABLE (teardown, itself reconciled) ─────────────────────────────
    const droppedTable = await apiFetch(page, 'DELETE', `/api/sites/${siteId}/db/tables/${PROBE_TABLE}`);
    expect(droppedTable.status, 'drop table must 200').toBe(200);
    gtTables = await groundTruthTables(page, siteId);
    expect(gtTables.tables, 'display: dropped table gone from the site OWN D1').not.toContain(PROBE_TABLE);
  });

  // -------------------------------------------------------------------------
  // Scenario 2 — the Data UI mounts in a REAL browser with the flag ON.
  // Proves the DARK-gated interactive surface is reachable (not the disabled/coming-soon state).
  // -------------------------------------------------------------------------
  test('2. editor Database tab mounts the per-site Tables surface in a real browser (flag ON, not the disabled state)', async ({
    page,
  }) => {
    await resolveSiteOrSkip();

    // Open the editor via the REAL admin route (lifts the persistent bolt iframe into place).
    await gotoAdmin(page, 'editor');
    await expect(page.locator('app-admin, [data-cockpit="v2"]')).toBeVisible({ timeout: 20_000 });

    const iframeEl = page.locator(
      'iframe[title="bolt.diy editor"], iframe[src*="editor.projectsites.dev"]',
    );
    await expect(iframeEl, 'the bolt.diy editor iframe must mount on /admin/editor').toBeVisible({
      timeout: EDITOR_BOOT_MS,
    });
    const frame: FrameLocator = page.frameLocator(
      'iframe[title="bolt.diy editor"], iframe[src*="editor.projectsites.dev"]',
    );

    // WebContainer cold-boot: the workbench top-tabs prove the editor shell (not just the doc) is up.
    const dbTab = frame.getByRole('button', { name: 'Database', exact: true });
    await expect(dbTab, 'the Database top-tab must render inside the booted editor frame').toBeVisible({
      timeout: EDITOR_BOOT_MS,
    });

    // Open the Database tab → its Tables sub-view.
    await dbTab.click();

    // With the flag ON for this org, the Tables surface must render its INTERACTIVE state — the
    // "Add row"/create-table/grid affordances OR an honest empty state — and MUST NOT render the
    // flag-off `sitedb-disabled` / `sitedb-coming-soon` panel. We accept any live sitedb surface
    // (loading → grid/empty), and hard-fail on the disabled/coming-soon panel.
    const liveSurface = frame.locator(
      [
        '[data-testid="sitedb-actions"]',
        '[data-testid="sitedb-grid"]',
        '[data-testid="sitedb-table-list"]',
        '[data-testid="sitedb-empty"]',
        '[data-testid="sitedb-loading"]',
        '[data-testid="sitedb-skeleton"]',
        '[data-testid="sitedb-create-table"]',
        '[data-testid="database-panel"]',
      ].join(', '),
    );
    await expect(
      liveSurface.first(),
      'flag ON: the per-site Tables surface must mount (interactive/empty/loading), not the disabled state',
    ).toBeVisible({ timeout: EDITOR_BOOT_MS });

    // Explicit anti-assertion: the flag-off panels must NOT be showing.
    await expect(
      frame.locator('[data-testid="sitedb-disabled"]'),
      'flag ON: the "Per-site data isn\'t enabled" panel must NOT render',
    ).toHaveCount(0);
    await expect(
      frame.locator('[data-testid="sitedb-coming-soon"]'),
      'flag ON: the "coming soon" panel must NOT render',
    ).toHaveCount(0);
  });
});
