import { expect, test } from '@playwright/test';

/**
 * R2 Bucket Manager — PROD E2E skeleton (Journey A: authoritative site-scoped list + protected system
 * bucket). The Manager is the authoritative catalog layer over a site's R2 surfaces (the isogit
 * "Project code · Preview" system bucket + the site's OWN custom buckets), gated by the DARK
 * `r2_bucket_manager` flag. Handlers land in a LATER slice; this file locks the CONTRACT now (TDD):
 *
 * - Slice 1 (this fire): the surface is DARK — an authenticated route does not yet exist / is
 *   flag-off. What is verifiable on prod without a session is the auth + dark-launch contract (401
 *   JSON, never the SPA shell), identical to the sibling per-site R2 surface.
 * - Journeys A–G (create → list shows system+own → reset/rotate → delete → Code-selector → explorer)
 *   are authored as `test.fixme` seams so the inventory is visible + fails-to-pass as each slice ships.
 *
 * Homepage-first is not applicable to an API-contract probe; these hit the API directly (like the
 * sibling `e2e/r2-buckets.spec.ts`). Authed journeys will drive real UI in the editor Resources tab.
 */
const PROD_URL = process.env.PROD_URL ?? 'https://projectsites.dev';
const MANAGER_PATH = '/api/sites/any-site/r2/manager/buckets';

test.describe('R2 Bucket Manager — auth + dark-launch contract (Slice 1)', () => {
  test('an unauthenticated Manager list is rejected (401 JSON, never the SPA shell)', async ({
    request,
  }) => {
    const res = await request.get(`${PROD_URL}${MANAGER_PATH}`);
    // Dark route today: the Manager handler is not mounted yet, so an unauthenticated caller must
    // NEVER receive the 200 SPA shell (a soft-404 leak). Accept 401 (mounted+auth-gated) or 404
    // (not mounted / flag-dark) — but the body must be JSON, never text/html.
    expect([401, 404]).toContain(res.status());
    const ct = res.headers()['content-type'] ?? '';
    expect(ct).not.toContain('text/html');
  });

  test('a bogus bearer token never yields anonymous Manager access', async ({ request }) => {
    const res = await request.get(`${PROD_URL}${MANAGER_PATH}`, {
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    expect([401, 404]).toContain(res.status());
  });
});

// ── Journeys A–G — authored seams; each un-fixmes as its slice ships (TDD inventory) ────────────────
test.describe('R2 Bucket Manager — journeys A–G (seams for later slices)', () => {
  test.fixme(
    'Journey A: authed list shows the protected system bucket + the site\'s own buckets',
    async () => {
      // Sign in as the seeded test org → open editor Resources → Buckets; assert one PROTECTED
      // "Project code · Preview" entry (no delete/reset controls) + any own custom buckets, and
      // NEVER another site's buckets.
    },
  );
  test.fixme('Journey B: create a custom bucket + copy its scoped credential address', async () => {});
  test.fixme('Journey C: reset/rotate a custom bucket (system bucket has no reset control)', async () => {});
  test.fixme('Journey D: delete/empty a custom bucket (system bucket is undeletable)', async () => {});
  test.fixme('Journey E: bind a bucket to project code via the Code-panel storage selector', async () => {});
  test.fixme('Journey F: object explorer — browse/upload/download/delete objects', async () => {});
  test.fixme('Journey G: Site files / Media data is preserved after migration to the Manager', async () => {});
});
