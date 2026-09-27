import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import type { DeliverySummary } from '../../../services/api.service';
import { DeliveryCardComponent, describeSampling } from './delivery-card.component';

const REAL: DeliverySummary = {
  zone_resolved: true,
  has_data: true,
  total_requests: 100,
  by_status_class: [
    { class: '2xx', count: 87 },
    { class: '5xx', count: 9 },
    { class: '3xx', count: 2 },
    { class: '4xx', count: 2 },
  ],
  top_statuses: [
    { status: 200, count: 74, bytes: 900_000_000, visits: 60 },
    { status: 504, count: 9, bytes: 46_080, visits: 7 },
    { status: 404, count: 2, bytes: 8_000, visits: 0 },
  ],
  cache: {
    hit: 1475,
    miss: 3139,
    uncacheable: 26879,
    hit_ratio_pct: 32,
    hit_bytes: 40_000_000,
    miss_bytes: 8_000_000,
    uncacheable_bytes: 500_000,
    hit_visits: 900,
    miss_visits: 1800,
    uncacheable_visits: 12000,
  },
  response_bytes: 1_159_813_769,
  range_days: 7,
};

function setup(delivery: DeliverySummary | null, windowDays = 7) {
  TestBed.configureTestingModule({ imports: [DeliveryCardComponent] });
  const fixture = TestBed.createComponent(DeliveryCardComponent);
  fixture.componentRef.setInput('delivery', delivery);
  fixture.componentRef.setInput('windowDays', windowDays);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

describe('describeSampling (honest CF sampleInterval label)', () => {
  it('quantifies real sampling as ~1:N', () => {
    expect(describeSampling(3.3)).toBe('sampled ~1:3');
    expect(describeSampling(1.9)).toBe('sampled ~1:2');
  });
  it('calls a near-1 interval "full data" (CF barely sampled — never imply an estimate it is not)', () => {
    expect(describeSampling(1.1)).toBe('full data');
    expect(describeSampling(1)).toBe('full data');
  });
  it('falls back to the generic "sampled estimate" when CF omits the interval / it is invalid', () => {
    expect(describeSampling(null)).toBe('sampled estimate');
    expect(describeSampling(undefined)).toBe('sampled estimate');
    expect(describeSampling(0)).toBe('sampled estimate');
    expect(describeSampling(Number.NaN)).toBe('sampled estimate');
  });
});

describe('DeliveryCardComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders the QUANTITATIVE sampling label from CF sampleInterval (≈1:3), not the generic one', () => {
    const { el } = setup({ ...REAL, sample_interval: 3.3 });
    const badge = el.querySelector('[data-testid="an-dl-sampled"]') as HTMLElement;
    expect(badge.textContent).toContain('sampled ~1:3');
    expect(badge.textContent).not.toContain('estimate'); // more precise than the blanket label
  });

  it('shows "full data" when CF reports little-to-no sampling (interval ≈ 1)', () => {
    const { el } = setup({ ...REAL, sample_interval: 1.05 });
    expect((el.querySelector('[data-testid="an-dl-sampled"]') as HTMLElement).textContent).toContain(
      'full data',
    );
  });

  it('renders status classes with a plain-language word + percent (WCAG use-of-color)', () => {
    const { el } = setup(REAL);
    const statuses = el.querySelector('[data-testid="an-dl-statuses"]') as HTMLElement;
    expect(statuses).toBeTruthy();
    expect(statuses.textContent).toContain('2xx · success');
    expect(statuses.textContent).toContain('87%');
    expect(statuses.textContent)
      .withContext('server-error word present, not colour-only')
      .toContain('5xx · server error');
  });

  it('surfaces bandwidth served on cache MISSES (the cacheable-to-save-bandwidth signal)', () => {
    const { el } = setup(REAL); // miss_bytes: 8_000_000
    const miss = el.querySelector('[data-testid="an-dl-cache-miss-bytes"]') as HTMLElement;
    expect(miss).withContext('miss-bytes line shown when miss_bytes > 0').toBeTruthy();
    expect(miss.textContent).toContain('7.6 MB'); // 8_000_000 bytes → 7.6 MB
    expect(miss.textContent).toContain('cache misses');
  });

  it('hides the cache-miss-bytes line when miss_bytes is 0 (never a fabricated 0 MB)', () => {
    const { el } = setup({ ...REAL, cache: { ...REAL.cache, miss_bytes: 0 } });
    expect(el.querySelector('[data-testid="an-dl-cache-miss-bytes"]')).toBeNull();
  });

  it('surfaces REAL visitors who hit cache misses (the human companion to miss bandwidth)', () => {
    const { el } = setup(REAL); // miss_visits: 1800
    const v = el.querySelector('[data-testid="an-dl-cache-miss-visits"]') as HTMLElement;
    expect(v).withContext('miss-visits line shown when miss_visits > 0').toBeTruthy();
    expect(v.textContent).toContain('real visitors');
  });

  it('hides the cache-miss-visits line when miss_visits is 0 (sampled — never a fabricated 0)', () => {
    const { el } = setup({ ...REAL, cache: { ...REAL.cache, miss_visits: 0 } });
    expect(el.querySelector('[data-testid="an-dl-cache-miss-visits"]')).toBeNull();
  });

  it('labels the ACTUAL CF-covered window (range_days), not the requested window, and flags the cap', () => {
    // 90-day request, but CF edge retention caps the delivery data at 30 days.
    const { el } = setup({ ...REAL, range_days: 30 }, 90);
    const src = el.querySelector('[data-testid="an-dl-source"]') as HTMLElement;
    expect(src.textContent).toContain('last 30 days'); // covered window, NOT "last 90 days"
    expect(src.textContent).not.toContain('last 90 days'); // must never claim the full requested window
    const cap = el.querySelector('[data-testid="an-dl-window-cap"]') as HTMLElement;
    expect(cap).withContext('cap note shown when CF window < requested').toBeTruthy();
    expect(cap.textContent).toContain('90 requested');
  });

  it('shows NO cap note when the CF window equals the requested window', () => {
    const { el } = setup({ ...REAL, range_days: 7 }, 7);
    expect(el.querySelector('[data-testid="an-dl-window-cap"]')).toBeNull();
    expect((el.querySelector('[data-testid="an-dl-source"]') as HTMLElement).textContent).toContain(
      'last 7 days',
    );
  });

  it('renders the edge breakdown (protocol / TLS / content-type / method) with request shares', () => {
    const withEdge: DeliverySummary = {
      ...REAL,
      protocols: [
        { label: 'HTTP/3', count: 70 },
        { label: 'HTTP/2', count: 30 },
      ],
      tls: [
        { label: 'TLSv1.3', count: 99 },
        { label: 'TLSv1.2', count: 1 },
      ],
      content_types: [
        { label: 'js', count: 60 },
        { label: 'html', count: 40 },
      ],
      methods: [{ label: 'GET', count: 100 }],
    };
    const { el } = setup(withEdge);
    expect(el.querySelector('[data-testid="an-dl-edge"]'))
      .withContext('edge breakdown renders when dims present')
      .toBeTruthy();
    const proto = el.querySelector('[data-testid="an-dl-edge-proto"]') as HTMLElement;
    expect(proto.textContent).toContain('HTTP/3');
    expect(proto.textContent).withContext('70 of 100 = 70% share').toContain('70%');
    expect(
      (el.querySelector('[data-testid="an-dl-edge-tls"]') as HTMLElement).textContent,
    ).toContain('TLSv1.3');
    expect(
      (el.querySelector('[data-testid="an-dl-edge-content"]') as HTMLElement).textContent,
    ).toContain('js');
  });

  it('omits edge groups with no data (never a fabricated 0) — only the non-empty dimension surfaces', () => {
    const partial = setup({
      ...REAL,
      protocols: [{ label: 'HTTP/2', count: 5 }],
      tls: [],
      content_types: [],
      methods: [],
    });
    expect(partial.fixture.componentInstance.edgeGroups().map((g) => g.key)).toEqual(['proto']);
  });

  it('hides the whole edge block when every edge dimension is empty', () => {
    const { el } = setup({ ...REAL, protocols: [], tls: [], content_types: [], methods: [] });
    expect(el.querySelector('[data-testid="an-dl-edge"]'))
      .withContext('no edge block when every dim is empty')
      .toBeNull();
  });

  it('renders verified bots (search crawlers) by category with request counts', () => {
    const { el } = setup({
      ...REAL,
      verified_bots: [
        { label: 'Search Engine Crawler', count: 312 },
        { label: 'Monitoring & Site Analytics', count: 40 },
      ],
    });
    const bots = el.querySelector('[data-testid="an-dl-bots"]') as HTMLElement;
    expect(bots).withContext('verified-bots section renders when present').toBeTruthy();
    expect(bots.textContent).toContain('Search Engine Crawler');
    expect(bots.textContent).toContain('312 requests');
    // Honest framing: verified, not a bot-management score.
    expect(
      (el.querySelector('[data-testid="an-dl-bots-note"]') as HTMLElement).textContent,
    ).toContain('verified');
  });

  it('hides the verified-bots section when the site has seen none (never a fabricated 0)', () => {
    const { el } = setup({ ...REAL, verified_bots: [] });
    expect(el.querySelector('[data-testid="an-dl-bots"]')).toBeNull();
  });

  it('shows the cache hit ratio + hit/miss/uncacheable counts + edge bandwidth', () => {
    const { el } = setup(REAL);
    expect((el.querySelector('[data-testid="an-dl-cache"]') as HTMLElement).textContent).toContain(
      '32%',
    );
    expect(el.textContent).toContain('1,475 hit');
    // 1,159,813,769 bytes ≈ 1.1 GB
    expect((el.querySelector('[data-testid="an-dl-bytes"]') as HTMLElement).textContent).toContain(
      'GB',
    );
  });

  it('VISIBLY flags the edge metrics as a sampled estimate + contrasts the exact first-party audience', () => {
    const { el } = setup(REAL);
    // The sampled nature must be VISIBLE text, not only a hover tooltip (the prompt:
    // surface sampling in the UI; never imply an estimated metric is exact).
    const badge = el.querySelector('[data-testid="an-dl-sampled"]') as HTMLElement;
    expect(badge).withContext('visible sampled-estimate indicator').toBeTruthy();
    expect(badge.textContent).toContain('sampled estimate');
    const note = el.querySelector('[data-testid="an-dl-note"]') as HTMLElement;
    expect(note.textContent).toContain('approximate, not exact');
    // Data LATENCY is disclosed (edge data lags live) — the prompt: surface data latency.
    expect(note.textContent).toContain('short delay');
    // Explicitly contrasts with the EXACT, REAL-TIME first-party audience metrics (no conflation).
    expect(note.textContent).toContain('real-time first-party');
  });

  it('flags an actionable error rate when 4xx/5xx ≥ 5% and lists the error codes', () => {
    const { el } = setup(REAL); // 5xx 9% + 4xx 2% = 11%
    const warn = el.querySelector('[data-testid="an-dl-error-warn"]') as HTMLElement;
    expect(warn).withContext('11% errors → warning shown').toBeTruthy();
    expect(warn.textContent).toContain('11%');
    const codes = el.querySelectorAll('[data-testid="an-dl-error-code"]');
    expect(Array.from(codes).map((c) => c.textContent)).toContain(jasmine.stringMatching('504'));
    expect(Array.from(codes).some((c) => c.textContent?.includes('200')))
      .withContext('only 4xx/5xx codes listed as errors — never a 200')
      .toBe(false);
  });

  it('shows real visitor counts + bytes on error responses, and NO visitor chip when 0 (sampled → honest)', () => {
    const { el } = setup(REAL);
    const rows = Array.from(el.querySelectorAll('[data-testid="an-dl-error-code"]')).map(
      (c) => c.textContent ?? '',
    );
    const all = rows.join(' | ');
    // 504 had 7 real visitors + 46 KB of edge bandwidth — the owner's actionable signal.
    expect(all).toContain('7 visitors hit');
    expect(all).toContain('45.0 KB'); // 46080 bytes → 45.0 KB (formatBytes 1-decimal)
    // 404 sampled 0 visits → its visitor chip is OMITTED (never a fabricated "0 visitors").
    const chips = el.querySelectorAll('[data-testid="an-dl-error-visits"]');
    expect(chips.length).withContext('only the 504 (visits>0) shows a visitor chip').toBe(1);
  });

  it('does NOT warn when the error rate is below 5%', () => {
    const clean: DeliverySummary = {
      ...REAL,
      by_status_class: [
        { class: '2xx', count: 98 },
        { class: '3xx', count: 2 },
      ],
      top_statuses: [{ status: 200, count: 98, bytes: 1_000_000, visits: 80 }],
    };
    const { el } = setup(clean);
    expect(el.querySelector('[data-testid="an-dl-error-warn"]')).toBeNull();
  });

  it('genuine empty: zone resolved but no edge traffic → "no requests yet", never zeros', () => {
    const empty: DeliverySummary = {
      zone_resolved: true,
      has_data: false,
      total_requests: 0,
      by_status_class: [],
      top_statuses: [],
      cache: {
        hit: 0,
        miss: 0,
        uncacheable: 0,
        hit_ratio_pct: null,
        hit_bytes: 0,
        miss_bytes: 0,
        uncacheable_bytes: 0,
        hit_visits: 0,
        miss_visits: 0,
        uncacheable_visits: 0,
      },
      response_bytes: 0,
      range_days: 7,
    };
    const { el } = setup(empty);
    expect(el.querySelector('[data-testid="an-dl-empty"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="an-dl-statuses"]'))
      .withContext('no fabricated status bars')
      .toBeNull();
    expect(el.querySelector('[data-testid="an-dl-cache"]')).toBeNull();
  });

  it('honest UNAVAILABLE: zone NOT resolved (shared-zone subdomain) never implies "no traffic yet"', () => {
    const unresolved: DeliverySummary = {
      zone_resolved: false,
      has_data: false,
      total_requests: 0,
      by_status_class: [],
      top_statuses: [],
      cache: {
        hit: 0,
        miss: 0,
        uncacheable: 0,
        hit_ratio_pct: null,
        hit_bytes: 0,
        miss_bytes: 0,
        uncacheable_bytes: 0,
        hit_visits: 0,
        miss_visits: 0,
        uncacheable_visits: 0,
      },
      response_bytes: 0,
      range_days: 7,
    };
    const { el } = setup(unresolved);
    const unavail = el.querySelector('[data-testid="an-dl-unavailable"]') as HTMLElement;
    expect(unavail)
      .withContext('unresolved zone → "not available", not the empty state')
      .toBeTruthy();
    expect(el.querySelector('[data-testid="an-dl-empty"]')).toBeNull();
    // The site MAY have visitors — the copy must not claim otherwise.
    expect((unavail.textContent ?? '').toLowerCase()).not.toContain('once traffic arrives');
  });

  it('honest unavailable: delivery=null (no CF credentials) renders the unavailable note', () => {
    const { el } = setup(null);
    expect(el.querySelector('[data-testid="an-dl-unavailable"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="an-dl-statuses"]')).toBeNull();
  });

  it('null cache hit ratio (no cacheable requests) shows "no cacheable requests", never a fake 0%', () => {
    const noCacheable: DeliverySummary = {
      ...REAL,
      cache: {
        hit: 0,
        miss: 0,
        uncacheable: 100,
        hit_ratio_pct: null,
        hit_bytes: 0,
        miss_bytes: 0,
        uncacheable_bytes: 0,
        hit_visits: 0,
        miss_visits: 0,
        uncacheable_visits: 0,
      },
    };
    const { el } = setup(noCacheable);
    const cache =
      (el.querySelector('[data-testid="an-dl-cache"]') as HTMLElement).textContent ?? '';
    expect(cache).toContain('no cacheable requests');
    expect(cache).withContext('never a fabricated 0%').not.toContain('0%');
  });
});
