/**
 * @file forms-submission-journey.e2e.ts
 * @description THE core-loop FORM leg, proven on PROD against the real backend:
 *   a visitor submits a contact form on a live generated site → the submission
 *   PERSISTS → it surfaces in the owner's admin Forms inbox — reconciled
 *   display-vs-store per `verify-against-source-of-truth` (never render-only).
 *
 * The loop under test (all three legs, real backend, zero mocks):
 *   1. SUBMIT  — `POST /api/contact-form/:slug` (public; `contact_newsletter/handlers.ts`),
 *                validated by the shared `contactFormSchema` (name / email / message≥10 / phone?).
 *                On success it writes BOTH a `contacts` CRM row AND a `form_submissions`
 *                row (`org_id`, `form_name:'contact'`, `status:'received'`) — the latter is
 *                the canonical INBOX row.
 *   2. STORE   — the `form_submissions` table, `site_id`+`org_id`-scoped.
 *   3. INBOX   — `GET /api/sites/:siteId/form-submissions` (`site_activity/handlers.ts`;
 *                org-owned, 404-never-403), returning `{ data[], meta:{ total } }`.
 *                The marker lives inside `payload` → `fields.message`.
 *
 * RECONCILIATION (the point of this spec): after a submit with a UNIQUE marker,
 *   the authed inbox MUST (a) increment its true `meta.total` AND (b) contain a row
 *   carrying that exact marker. `groundTruth>0 && display==0` = LYING-EMPTY → hard fail.
 *   We never conclude "empty is honest" from the same source the UI reads — the submit
 *   IS the causal write, so the inbox is obligated to show it (causal test, strongest finder).
 *
 * Auth: real `E2E_API_KEY` session via `setupRealDataPage` (Pathway A). The org-scoped
 *   key is ALSO the session token, so `page.evaluate(fetch + Bearer)` authenticates as
 *   the real test user — the inbox read is genuinely authed, not stubbed.
 *
 * Target site: the E2E org's OWN live site (resolved via `resolveE2ESite`). The admin
 *   inbox is org-owned, so reconciliation is only meaningful for a site this org owns.
 *   A contact-form INSERT is purely ADDITIVE (a `form_submissions` row) and orthogonal
 *   to any build/publish/promote workflow — it cannot disturb a concurrent promotion.
 *
 * Safety: no real emails (the endpoint emails only the site OWNER, and the test org's
 *   contact email is a `@megabyte.space` test box), no charges, no destructive writes.
 *   Non-mutating beyond the single lead row this leg is designed to create + then find.
 *
 * Skips (never false-green) when `E2E_API_KEY` is absent or the org owns no live site.
 */

import { test, expect } from './fixtures.js';
import { realDataAvailable, setupRealDataPage } from './helpers/realdata.js';
import { resolveE2ESite } from './admin-verify/_resolve-e2e-site.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROD_URL = process.env.PROD_URL ?? 'https://projectsites.dev';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InboxRow {
  id: string;
  form_name: string;
  email: string | null;
  status: string;
  created_at: string;
  fields?: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// In-browser fetch helpers — run from the SITE's own origin so the request
// carries a same-site Origin/Referer (mirrors a real visitor's app.js POST)
// and, for the inbox read, the injected Bearer session (real auth, no stub).
// ---------------------------------------------------------------------------

/**
 * Submit a contact form exactly as a generated site's app.js does:
 * `POST /api/contact-form/:slug` with a same-site Origin/Referer.
 */
async function submitContactForm(
  page: import('@playwright/test').Page,
  slug: string,
  marker: string,
): Promise<{ status: number; body: unknown }> {
  return page.evaluate(
    async ({ base, s, m }: { base: string; s: string; m: string }) => {
      const r = await fetch(`${base}/api/contact-form/${encodeURIComponent(s)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'E2E Forms Journey',
          email: 'e2e-forms@megabyte.space',
          phone: '555-0100',
          message: `Automated forms-leg reconciliation probe. marker=${m}`,
        }),
      });
      const body = await r.json().catch(() => ({}));
      return { status: r.status, body };
    },
    { base: PROD_URL, s: slug, m: marker },
  );
}

/**
 * Read the owner's Forms inbox as the authenticated org user (real Bearer session).
 * Ground truth for reconciliation.
 */
async function readInbox(
  page: import('@playwright/test').Page,
  siteId: string,
  token: string,
): Promise<{ status: number; total: number; rows: InboxRow[] }> {
  return page.evaluate(
    async ({ base, id, tkn }: { base: string; id: string; tkn: string }) => {
      const r = await fetch(`${base}/api/sites/${id}/form-submissions?limit=200`, {
        headers: { Authorization: `Bearer ${tkn}`, Accept: 'application/json' },
      });
      const j = (await r.json().catch(() => ({}))) as {
        data?: unknown[];
        meta?: { total?: number };
      };
      return {
        status: r.status,
        total: Number(j?.meta?.total ?? (j?.data ?? []).length),
        rows: (j?.data ?? []) as Array<{
          id: string;
          form_name: string;
          email: string | null;
          status: string;
          created_at: string;
          fields?: Record<string, unknown> | null;
        }>,
      };
    },
    { base: PROD_URL, id: siteId, tkn: token },
  );
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

test.describe('Core-loop FORM leg — submit → persist → admin inbox (reconciled)', () => {
  // Meaningless without a real session + a real owned site — skip, never false-green.
  test.skip(!realDataAvailable(), 'needs E2E_API_KEY for a real authed session');

  // Serial: scenario 1 creates the marker row that scenario 2 reconciles.
  test.describe.configure({ mode: 'serial' });

  // Shared across the serial scenarios so the second reconciles the first's write.
  const marker = `ps-e2e-forms-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  let siteId = '';
  let siteSlug = '';

  // -------------------------------------------------------------------------
  // Scenario 1 — a visitor submits the contact form on a live site → 200 + persisted
  // -------------------------------------------------------------------------
  test('1. visitor submits contact form → 200, marker row persisted in form_submissions', async ({
    page,
  }) => {
    const token = process.env.E2E_API_KEY!;

    // Resolve the E2E org's OWN live site (the only site whose inbox this org may read).
    const resolved = await resolveE2ESite(PROD_URL, token, UA);
    siteId = resolved.id;
    siteSlug = resolved.slug;
    test.skip(!siteId || !siteSlug, 'E2E org owns no resolvable site — nothing to reconcile');

    // Start the journey at the platform homepage (real-user entry). Any
    // `page.evaluate(fetch)` needs a real document origin — a fetch from
    // about:blank fails — so navigate FIRST, then set up the authed session.
    await page.goto(PROD_URL, { waitUntil: 'domcontentloaded' });
    // Passthrough MUST include `contact-form` so the REAL submit POST reaches prod
    // (else the `**/api/**` stub fakes a 200 and no row is ever written); `sites`
    // covers both the inbox read (/api/sites/:id/form-submissions) and the lookup.
    await setupRealDataPage(page, { passthrough: /\/api\/(auth\/me|sites|contact-form)\b/ });

    // Confirm the site is genuinely live before we drive a visitor journey against it.
    const live = await page.evaluate(
      async ({ base, s }: { base: string; s: string }) => {
        const r = await fetch(`${base}/api/sites/lookup?slug=${encodeURIComponent(s)}`);
        const j = (await r.json().catch(() => ({}))) as {
          data?: { exists?: boolean; status?: string };
        };
        return { exists: Boolean(j?.data?.exists), status: j?.data?.status ?? null };
      },
      { base: PROD_URL, s: siteSlug },
    );
    expect(live.exists, `site "${siteSlug}" must exist to receive a submission`).toBe(true);

    // GROUND TRUTH BEFORE: the authed inbox count for this site.
    const before = await readInbox(page, siteId, token);
    expect(before.status, 'authed inbox read must be 200 (real session)').toBe(200);
    const beforeTotal = before.total;
    const beforeHasMarker = before.rows.some((r) => JSON.stringify(r).includes(marker));
    expect(beforeHasMarker, 'marker must not pre-exist (fresh submission)').toBe(false);

    // SUBMIT — from the generated SITE's own origin so the POST carries a same-site
    // Origin/Referer, exactly like the site's app.js contact-form handler.
    await page.goto(`https://${siteSlug}.projectsites.dev/`, { waitUntil: 'domcontentloaded' });
    const submit = await submitContactForm(page, siteSlug, marker);
    expect(
      submit.status,
      `submit must 200 (got ${submit.status}: ${JSON.stringify(submit.body)})`,
    ).toBe(200);
    expect(submit.body).toMatchObject({ data: { success: true } });

    // PERSISTED? Re-read the authed inbox — the store MUST reflect the write.
    // Poll briefly (D1 write is synchronous on this path, but allow for edge latency).
    let afterTotal = beforeTotal;
    await expect
      .poll(
        async () => {
          const after = await readInbox(page, siteId, token);
          afterTotal = after.total;
          return after.status === 200 && after.total > beforeTotal ? after.total : -1;
        },
        {
          timeout: 15_000,
          message: 'form_submissions total must increment after submit (persist proof)',
        },
      )
      .toBeGreaterThan(beforeTotal);

    // LYING-EMPTY guard (verify-against-source-of-truth): groundTruth>0 && display==0.
    // The submit IS the causal write, so total==0 here would be a lying-empty store.
    expect(afterTotal, 'store must not be lying-empty after a real submit').toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Scenario 2 — the submission surfaces in the admin Forms inbox WITH the marker
  // -------------------------------------------------------------------------
  test('2. submission surfaces in admin Forms inbox with the exact marker (display reconciles store)', async ({
    page,
  }) => {
    const token = process.env.E2E_API_KEY!;
    test.skip(!siteId, 'scenario 1 did not resolve a site');

    await page.goto(PROD_URL, { waitUntil: 'domcontentloaded' });
    // Passthrough MUST include `contact-form` so the REAL submit POST reaches prod
    // (else the `**/api/**` stub fakes a 200 and no row is ever written); `sites`
    // covers both the inbox read (/api/sites/:id/form-submissions) and the lookup.
    await setupRealDataPage(page, { passthrough: /\/api\/(auth\/me|sites|contact-form)\b/ });

    const inbox = await readInbox(page, siteId, token);
    expect(inbox.status).toBe(200);

    // DISPLAY: the exact row must be present with our marker, form_name, and status.
    const match = inbox.rows.find((r) => JSON.stringify(r).includes(marker));
    expect(
      match,
      `admin Forms inbox must contain the submission (marker=${marker}). ` +
        `groundTruth total=${inbox.total}, returned=${inbox.rows.length}. ` +
        `A missing marker with total>0 = WRONG-SOURCE; with total==0 = LYING-EMPTY.`,
    ).toBeTruthy();

    // Field-level reconciliation — the inbox row carries the real submitted content.
    expect(match!.form_name, 'contact-form leg writes form_name="contact"').toBe('contact');
    expect(match!.email, 'submitted email must round-trip to the inbox').toBe(
      'e2e-forms@megabyte.space',
    );
    const message = String((match!.fields ?? {})['message'] ?? '');
    expect(message, 'the message field must carry the marker (payload → fields)').toContain(marker);
    expect(match!.status, 'a freshly captured lead is "received"').toBe('received');
  });

  // -------------------------------------------------------------------------
  // Scenario 3 — negative: a malformed submission is rejected (400), writes nothing
  // -------------------------------------------------------------------------
  test('3. malformed submission → 400 VALIDATION_ERROR, no phantom inbox row', async ({ page }) => {
    const token = process.env.E2E_API_KEY!;
    test.skip(!siteId || !siteSlug, 'scenario 1 did not resolve a site');

    await page.goto(PROD_URL, { waitUntil: 'domcontentloaded' });
    // Passthrough MUST include `contact-form` so the REAL submit POST reaches prod
    // (else the `**/api/**` stub fakes a 200 and no row is ever written); `sites`
    // covers both the inbox read (/api/sites/:id/form-submissions) and the lookup.
    await setupRealDataPage(page, { passthrough: /\/api\/(auth\/me|sites|contact-form)\b/ });
    const before = await readInbox(page, siteId, token);
    expect(before.status).toBe(200);

    // Missing email + sub-10-char message → contactFormSchema rejects (safeParse → 400).
    await page.goto(`https://${siteSlug}.projectsites.dev/`, { waitUntil: 'domcontentloaded' });
    const bad = await page.evaluate(
      async ({ base, s }: { base: string; s: string }) => {
        const r = await fetch(`${base}/api/contact-form/${encodeURIComponent(s)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'x' }),
        });
        const body = (await r.json().catch(() => ({}))) as { error?: { code?: string } };
        return { status: r.status, code: body?.error?.code ?? null };
      },
      { base: PROD_URL, s: siteSlug },
    );
    expect(bad.status, 'malformed body must be rejected, not silently accepted').toBe(400);
    expect(bad.code).toBe('VALIDATION_ERROR');

    // The rejected submission must NOT have written a row (count unchanged).
    const after = await readInbox(page, siteId, token);
    expect(after.total, 'a 400 must not create a phantom inbox row').toBe(before.total);
  });
});
