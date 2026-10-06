/**
 * @module mocks/fixtures/deliverability
 *
 * @description
 * Mock fixture for the admin **Email Deliverability** section
 * (`pages/admin/sections/deliverability.component.ts`) — the SPF/DKIM/DMARC
 * inbox-placement wizard (`/admin/deliverability`, also embedded in Settings →
 * Email). The section fires ONE read through
 * {@link import('../../services/api.service').ApiService} once a site is selected
 * and the operator clicks **Check deliverability**:
 *
 *   GET /api/sites/:siteId/deliverability[?domain=]
 *     → { ok, report, needsDomain }
 *
 * The factory is typed to the EXACT worker wire shape (`checkDeliverability` +
 * the `email_deliverability` route), so wiring the real endpoint later is a
 * provider SWAP, not a rewrite.
 *
 * | Registry key                        | Factory                           | Worker contract (traced)                                               |
 * | ----------------------------------- | --------------------------------- | ---------------------------------------------------------------------- |
 * | `GET /sites/:id/deliverability`     | {@link deliverabilityFixture}     | `{ ok; report: Report\|null; needsDomain }` (`routes/email_deliverability.ts`) |
 *
 * **Flag-gating:** the worker route is gated by `email_deliverability_wizard`
 * (registry default `default_enabled:false`, `stage:'beta'`) → it 404s in prod
 * when the flag is OFF, and the component maps that to a calm cyan flag-gate
 * notice (never a red error). In `?mock=1` the interceptor serves this fixture
 * REGARDLESS of the live flag, so the full score UI is demoable — the demo needs
 * NO flag flip. (`error` is handled by the interceptor, which throws a 500 before
 * this runs; a worker 404/flag-gate is a prod-only path this fixture bypasses.)
 *
 * @remarks
 * - Believable DNS-auth states, not lorem: the populated report is a REAL,
 *   internally-consistent healthy-but-improvable domain — SPF ✓, DKIM ✓, DMARC ✓
 *   but at `p=none` (monitor-only), which scores exactly 90/100 under the worker's
 *   `SPF 35 + DMARC 35 + DMARC-policy 10 + DKIM 20` rubric and surfaces the single
 *   "strengthen DMARC to p=quarantine/reject" fix. Enough texture that the score
 *   meter, the three per-record rows, and the recommendations list all render.
 * - `state` variants mirror the worker's two 200 shapes:
 *   - `empty` → `{ ok:true, report:null, needsDomain:true }` — the honest
 *     unconfigured first-run surface (no custom sending domain + no `?domain=`),
 *     which drives the component's calm neutral "enter a domain" prompt.
 *   - `populated` / `loading` / default → the healthy-with-a-couple-issues report
 *     (`needsDomain:false`), so the full cyan score cockpit renders.
 * - Honors the `?domain=` query override exactly like the worker: when the operator
 *   types a sending domain and re-runs, the report's `domain` reflects the
 *   NORMALIZED input (scheme/path/`www.` stripped, lower-cased), so the card header
 *   reads the right hostname. With no override it defaults to the demo site's
 *   sending domain.
 * - The `:param` segment means ONE fixture serves EVERY demo site id (the route is
 *   per-site; prod-nonexistent ids 404 before, but under `?mock=1` they resolve here).
 */
import type { FixtureFactory, MockState } from './index';

// ───────────────────────── GET /sites/:id/deliverability ─────────────────────────

/**
 * The SPF/DKIM/DMARC report body — mirrors `DeliverabilityReport` in
 * `services/email_deliverability.ts` EXACTLY (field names + nesting + the 0-100
 * `score` composed of `SPF 35 + DMARC 35 + DMARC-policy 10 + DKIM 20`).
 */
export interface DeliverabilityReport {
  domain: string;
  spf: { present: boolean; record: string | null };
  dmarc: { present: boolean; record: string | null; policy: string | null };
  dkim: { present: boolean; selectorsChecked: string[]; foundSelectors: string[] };
  /** 0-100: SPF 35 + DMARC 35 + DMARC-policy 10 + DKIM 20. */
  score: number;
  recommendations: string[];
}

/**
 * The `GET /api/sites/:siteId/deliverability` envelope — the worker returns
 * `{ ok, report, needsDomain }`: `report` is `null` on the no-domain path (with
 * `needsDomain:true`), else the full {@link DeliverabilityReport} (`needsDomain:false`).
 */
export interface DeliverabilityResponse {
  ok: boolean;
  report: DeliverabilityReport | null;
  needsDomain: boolean;
}

/** The common DKIM selectors the worker probes (mirrors `COMMON_DKIM_SELECTORS`). */
const COMMON_DKIM_SELECTORS = ['google', 'default', 'k1', 's1', 'selector1', 'mail'] as const;

/** The demo site's own sending domain (used when no `?domain=` override is typed). */
const DEFAULT_SENDING_DOMAIN = 'mail.beverwyckbarber.com';

/**
 * Normalize user input to a bare hostname — a faithful mirror of the worker's
 * `normalizeDomain` (strip scheme + path + leading `www.`, lower-case), so the
 * fixtured report's `domain` matches what the real handler would echo back.
 */
function normalizeDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '');
}

/**
 * Build the believable HEALTHY-BUT-IMPROVABLE report for a domain: SPF present,
 * DKIM present (google selector found), DMARC present but at `p=none` (monitor
 * only). Under the worker's rubric that is `35 + 35 + 0 + 20 = 90`, surfacing the
 * single "strengthen DMARC" fix — a realistic "almost-there" sending domain, not a
 * perfect 100 (which would render an empty fixes list and a less interesting demo).
 */
function buildHealthyReport(domain: string): DeliverabilityReport {
  return {
    domain,
    spf: { present: true, record: `v=spf1 include:amazonses.com include:_spf.${domain} -all` },
    dmarc: {
      present: true,
      record: `v=DMARC1; p=none; rua=mailto:dmarc@${domain}; fo=1`,
      policy: 'none',
    },
    dkim: {
      present: true,
      selectorsChecked: [...COMMON_DKIM_SELECTORS],
      foundSelectors: ['google'],
    },
    score: 90, // SPF 35 + DMARC 35 + DMARC-policy 0 (p=none) + DKIM 20
    recommendations: [
      'Strengthen DMARC to p=quarantine or p=reject once monitoring reports look clean.',
    ],
  };
}

/**
 * Deliverability factory.
 *
 * - `empty` → `{ ok:true, report:null, needsDomain:true }`: the honest unconfigured
 *   first-run surface (no sending domain) → the component's calm neutral prompt.
 * - `populated` / `loading` / default → `{ ok:true, report, needsDomain:false }`: the
 *   believable healthy-but-improvable SPF/DKIM/DMARC report (score 90, one fix) → the
 *   full cyan score cockpit. Honors `?domain=` exactly like the worker (the report's
 *   `domain` echoes the NORMALIZED override; defaults to the demo site's sending domain).
 *
 * `error` is handled by the interceptor (it throws a 500 before this runs).
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 * @param query - Parsed query params (honors the optional `?domain=` sending-domain override).
 */
export const deliverabilityFixture: FixtureFactory<DeliverabilityResponse> = (
  state: MockState,
  query: URLSearchParams,
): DeliverabilityResponse => {
  if (state === 'empty') {
    // No custom sending domain + no override → the worker's clean no-domain 200.
    return { ok: true, report: null, needsDomain: true };
  }
  const override = (query.get('domain') ?? '').trim();
  const domain = override ? normalizeDomain(override) : DEFAULT_SENDING_DOMAIN;
  return { ok: true, report: buildHealthyReport(domain), needsDomain: false };
};
