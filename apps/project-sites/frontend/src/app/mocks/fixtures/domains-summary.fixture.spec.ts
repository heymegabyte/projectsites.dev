import { domainsSummaryFixture, type DomainsSummaryResponse } from './domains-summary.fixture';
import { toRegistryKey } from './index';

/**
 * domains-summary.fixture — the mock body for GET /api/admin/domains/summary (one of the
 * three reads AdminStateService.loadData forkJoins to light up the shell/dashboard).
 * Contract: matches the WORKER WIRE shape EXACTLY — `{ data: { total, by_status, by_type } }`
 * (hostnames/handlers.ts), NOT the lossy frontend `DomainSummary` type — so the real
 * endpoint is a drop-in swap. State variants: populated (a real mix) · empty (no domains).
 */
function q(search = ''): URLSearchParams {
  return new URLSearchParams(search);
}

describe('domainsSummaryFixture (worker-wire GET /admin/domains/summary)', () => {
  it('returns the worker envelope { data: { total, by_status, by_type } } exactly', () => {
    const res: DomainsSummaryResponse = domainsSummaryFixture('populated', q());
    const d = res.data;
    expect(typeof d.total).toBe('number');
    expect(typeof d.by_status.active).toBe('number');
    expect(typeof d.by_status.pending).toBe('number');
    expect(typeof d.by_status.verification_failed).toBe('number');
    expect(typeof d.by_type.free_subdomain).toBe('number');
    expect(typeof d.by_type.custom_cname).toBe('number');
  });

  it('populated → total equals the sum of the status buckets (internally consistent)', () => {
    const d = domainsSummaryFixture('populated', q()).data;
    expect(d.total).toBeGreaterThan(0);
    expect(d.by_status.active + d.by_status.pending + d.by_status.verification_failed).toBe(
      d.total,
    );
  });

  it('populated → total equals the sum of the type buckets (free + custom)', () => {
    const d = domainsSummaryFixture('populated', q()).data;
    expect(d.by_type.free_subdomain + d.by_type.custom_cname).toBe(d.total);
  });

  it('populated → exercises every bucket (a non-zero active, pending, failed, and custom)', () => {
    const d = domainsSummaryFixture('populated', q()).data;
    expect(d.by_status.active).toBeGreaterThan(0);
    expect(d.by_status.pending).toBeGreaterThan(0);
    expect(d.by_status.verification_failed).toBeGreaterThan(0);
    expect(d.by_type.custom_cname).toBeGreaterThan(0);
  });

  it('empty → all-zero counts (honest no-domains state, never a fabricated non-zero)', () => {
    const d = domainsSummaryFixture('empty', q()).data;
    expect(d.total).toBe(0);
    expect(d.by_status).toEqual({ active: 0, pending: 0, verification_failed: 0 });
    expect(d.by_type).toEqual({ free_subdomain: 0, custom_cname: 0 });
  });

  it('normalizes to the registry key GET /admin/domains/summary', () => {
    expect(toRegistryKey('GET', '/api/admin/domains/summary').key).toBe(
      'GET /admin/domains/summary',
    );
  });
});
