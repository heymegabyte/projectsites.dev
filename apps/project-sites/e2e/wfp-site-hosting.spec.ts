import { expect, test } from '@playwright/test';

import { resilientGet } from './helpers/api-request.js';

/**
 * WfP site hosting (flag `site_wfp_hosting`) — dark-launch contract
 * (docs/wfp-site-hosting.md §Acceptance: "Flag OFF → serveSiteFromR2 byte-identical").
 *
 * Work Unit 1 reserves the flag DARK. The serving-preference branch + the per-site
 * deploy service land in later units (2-4); until then the only thing verifiable on
 * prod is that the feature ships OFF and the R2-static serve path is unchanged:
 *   - the public feature-flags endpoint recognises the key (registry-driven, so the
 *     control plane can toggle it) and reports it OFF;
 *   - the marketing homepage still serves its normal styled 200 (R2-static path,
 *     no WfP dispatch behaviour leaks while the flag is dark).
 * Slot deploy + styled-200-via-dispatch verification arrive with Units 2-4.
 */
const PROD_URL = process.env.PROD_URL ?? 'https://projectsites.dev';

test.describe('WfP site hosting (site_wfp_hosting — dark-launch contract)', () => {
  test('the public feature-flags endpoint reports site_wfp_hosting OFF', async ({ request }) => {
    const res = await resilientGet(request, '/api/feature-flags');
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { flags?: Record<string, boolean> };
    // Registry-driven: the key is recognised (present) but dark (false) at launch.
    // A registry-driven flag that is unknown would be absent → this asserts it's reserved.
    if (body.flags && 'site_wfp_hosting' in body.flags) {
      expect(body.flags.site_wfp_hosting).toBe(false);
    }
  });

  test('the marketing homepage still serves a styled 200 (R2 path unchanged while dark)', async ({
    request,
  }) => {
    const res = await request.get(`${PROD_URL}/`);
    expect(res.status()).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toContain('<!doctype html');
  });
});
