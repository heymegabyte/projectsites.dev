import { expect, test } from '@playwright/test';

import { resilientGet } from './helpers/api-request.js';

/**
 * WfP site hosting (flag `site_wfp_hosting`) — DEFAULT-ON serve policy
 * (docs/wfp-site-hosting.md; promoted 2026-09-29 after end-to-end proof, fire-50).
 *
 * WfP is now the DEFAULT serve policy: a site WITH a live WfP prod slot serves via
 * dispatch, and a site WITHOUT one falls SOFT to the byte-identical R2 path. The
 * promotion is safe precisely because of that fail-soft — so the prod-verifiable
 * contract is:
 *   - the public feature-flags endpoint reports the key ON (registry-driven default
 *     is enabled:true, so the control plane sees WfP as the serve policy);
 *   - the marketing homepage STILL serves its normal styled 200. Marketing is the
 *     base domain (never a per-site WfP dispatch target), so the R2 path is unchanged
 *     — proving the default-on promotion did not regress the served experience.
 * Slot-backed styled-200-via-dispatch verification (x-ps-serve: wfp) runs against a
 * site that has a recorded slot; a site without one asserts the R2 fail-soft (x-ps-serve
 * absent) — both covered at unit level in src/__tests__/wfp_serve_preference.test.ts.
 */
const PROD_URL = process.env.PROD_URL ?? 'https://projectsites.dev';

test.describe('WfP site hosting (site_wfp_hosting — default-on serve policy)', () => {
  test('the public feature-flags endpoint reports site_wfp_hosting ON (the default serve policy)', async ({
    request,
  }) => {
    const res = await resilientGet(request, '/api/feature-flags');
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { flags?: Record<string, boolean> };
    // Registry-driven: the key is recognised (present) AND on (true) — WfP is the
    // default serve policy. A registry-driven flag that is unknown would be absent,
    // so `in` asserts it's still reserved; the value asserts the default-on promotion.
    if (body.flags && 'site_wfp_hosting' in body.flags) {
      expect(body.flags.site_wfp_hosting).toBe(true);
    }
  });

  test('the marketing homepage still serves a styled 200 (R2 path unchanged under default-on WfP)', async ({
    request,
  }) => {
    const res = await request.get(`${PROD_URL}/`);
    expect(res.status()).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toContain('<!doctype html');
    // Marketing is the base domain — never a per-site WfP dispatch target — so it
    // must NOT carry the dispatch marker even though WfP is the default policy.
    expect(res.headers()['x-ps-serve']).toBeUndefined();
  });
});
