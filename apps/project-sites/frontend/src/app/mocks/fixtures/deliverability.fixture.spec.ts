import {
  deliverabilityFixture,
  type DeliverabilityResponse,
  type DeliverabilityReport,
} from './deliverability.fixture';
import { findFixture, toRegistryKey } from './index';

/**
 * deliverability.fixture — mock body for the admin **Email Deliverability** section
 * (`pages/admin/sections/deliverability.component.ts`). The section fires ONE read:
 *
 *   GET /api/sites/:siteId/deliverability[?domain=]
 *     → { ok, report, needsDomain }   (`routes/email_deliverability.ts`)
 *
 * The factory mirrors the worker wire EXACTLY — `report` is a full
 * {@link DeliverabilityReport} (`domain`/`spf`/`dmarc`/`dkim`/`score`/`recommendations`)
 * whose 0-100 `score` is composed `SPF 35 + DMARC 35 + DMARC-policy 10 + DKIM 20`
 * (mirrors `checkDeliverability`), OR `null` with `needsDomain:true` on the no-domain path.
 *
 * Flag-gating: the worker route is gated by `email_deliverability_wizard` (404 when OFF),
 * but under `?mock=1` the interceptor serves this fixture regardless → no flag flip needed.
 */
function q(search = ''): URLSearchParams {
  return new URLSearchParams(search);
}

describe('deliverabilityFixture (GET /sites/:id/deliverability → { ok, report, needsDomain })', () => {
  it('populated → the worker envelope { ok, report, needsDomain } with exact field types', () => {
    const res: DeliverabilityResponse = deliverabilityFixture('populated', q());
    expect(res.ok).toBe(true);
    expect(res.needsDomain).toBe(false);
    const r = res.report as DeliverabilityReport;
    expect(r).toBeTruthy();
    // Shape parity with the worker's DeliverabilityReport (nesting + field names).
    expect(typeof r.domain).toBe('string');
    expect(typeof r.spf.present).toBe('boolean');
    expect('record' in r.spf).toBe(true);
    expect(typeof r.dmarc.present).toBe('boolean');
    expect('record' in r.dmarc).toBe(true);
    expect('policy' in r.dmarc).toBe(true);
    expect(typeof r.dkim.present).toBe('boolean');
    expect(Array.isArray(r.dkim.selectorsChecked)).toBe(true);
    expect(Array.isArray(r.dkim.foundSelectors)).toBe(true);
    expect(typeof r.score).toBe('number');
    expect(Array.isArray(r.recommendations)).toBe(true);
  });

  it('populated → a believable healthy-but-improvable domain (SPF+DKIM+DMARC present, p=none)', () => {
    const r = deliverabilityFixture('populated', q()).report as DeliverabilityReport;
    expect(r.spf.present).toBe(true);
    expect(r.spf.record).toMatch(/^v=spf1/i);
    expect(r.dmarc.present).toBe(true);
    expect(r.dmarc.record).toMatch(/^v=DMARC1/i);
    expect(r.dmarc.policy).toBe('none'); // monitor-only → the one realistic issue
    expect(r.dkim.present).toBe(true);
    expect(r.dkim.foundSelectors.length).toBeGreaterThan(0);
  });

  it('populated → score matches the worker rubric SPF 35 + DMARC 35 + policy 10 + DKIM 20', () => {
    // SPF present (35) + DMARC present (35) + policy=none (0) + DKIM present (20) = 90.
    const r = deliverabilityFixture('populated', q()).report as DeliverabilityReport;
    const expected =
      (r.spf.present ? 35 : 0) +
      (r.dmarc.present ? 35 : 0) +
      (r.dmarc.policy === 'reject' || r.dmarc.policy === 'quarantine' ? 10 : 0) +
      (r.dkim.present ? 20 : 0);
    expect(r.score).toBe(expected);
    expect(r.score).toBe(90);
  });

  it('populated → surfaces the single "strengthen DMARC" fix (present-but-p=none ⇒ one recommendation)', () => {
    const r = deliverabilityFixture('populated', q()).report as DeliverabilityReport;
    expect(r.recommendations.length).toBe(1);
    expect(r.recommendations[0]).toMatch(/strengthen dmarc/i);
  });

  it('honors ?domain= exactly like the worker — report.domain echoes the NORMALIZED override', () => {
    // scheme + path + leading www. stripped, lower-cased (mirrors normalizeDomain).
    const r = deliverabilityFixture('populated', q('domain=HTTPS://www.Example.com/path'))
      .report as DeliverabilityReport;
    expect(r.domain).toBe('example.com');
  });

  it('no ?domain= → report.domain defaults to a stable demo sending domain', () => {
    const r = deliverabilityFixture('populated', q()).report as DeliverabilityReport;
    expect(r.domain).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/); // a bare dotted hostname
    expect(r.domain).not.toContain('://');
  });

  it('empty → { ok:true, report:null, needsDomain:true } (the honest unconfigured first-run surface)', () => {
    const res = deliverabilityFixture('empty', q());
    expect(res.ok).toBe(true);
    expect(res.report).toBeNull();
    expect(res.needsDomain).toBe(true);
  });

  it('is deterministic (stable across calls for the same state + query)', () => {
    expect(deliverabilityFixture('populated', q())).toEqual(deliverabilityFixture('populated', q()));
    expect(deliverabilityFixture('empty', q())).toEqual(deliverabilityFixture('empty', q()));
  });

  it('normalizes to the :param registry key GET /sites/:id/deliverability (any site id)', () => {
    expect(toRegistryKey('GET', '/api/sites/site-001/deliverability').key).toBe(
      'GET /sites/site-001/deliverability',
    );
    // Query (the ?domain= override) is stripped before lookup.
    expect(toRegistryKey('GET', '/api/sites/abc/deliverability?domain=x.com').key).toBe(
      'GET /sites/abc/deliverability',
    );
  });

  // RED until the orchestrator repoints the registry key at THIS richer, state-aware
  // factory (currently the thin per-site.fixture `deliverabilityFixture` is wired);
  // GREEN after the merge. Asserts the :param key resolves to a defined factory that
  // serves the full worker envelope for an arbitrary site id.
  it('is wired into the registry under the :param key GET /sites/:id/deliverability', () => {
    const factory = findFixture('GET /sites/any-site/deliverability');
    expect(factory).toBe(deliverabilityFixture as unknown as ReturnType<typeof findFixture>);
    const res = factory!('populated', q()) as DeliverabilityResponse;
    expect(res.ok).toBe(true);
    expect(res.report).not.toBeNull();
    expect(res.needsDomain).toBe(false);
  });
});
