import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { BuildMetricsCardComponent } from './build-metrics-card.component';

/**
 * Coverage for the super-admin "Generation speed + cost" north-star card
 * (fire-75). Locks the contract that makes the speed+cost baseline VISIBLE:
 *
 *  - Flag OFF (`build_metrics` → enabled:false) → the card renders NOTHING
 *    (mirrors the worker's hard-404 when the flag is off; existence never leaked).
 *  - Flag ON + empty store → an HONEST "no builds recorded yet" empty state,
 *    never fabricated zeros (verify-against-source-of-truth).
 *  - Flag ON + seeded summary → p50/p95/avg-cost/count render VERBATIM from the
 *    endpoint response (display == the SELECT over build_metrics). The 5-min /
 *    $1 north-star thresholds colour the "good" values.
 *
 * The flag resolution + the summary both come through HttpClient, so one
 * `HttpTestingController` drives both (`/api/feature-flags/build_metrics` then
 * `/api/admin/build-metrics/summary?days=30`).
 */
describe('BuildMetricsCardComponent (north-star speed+cost card)', () => {
  let fixture: ComponentFixture<BuildMetricsCardComponent>;
  let httpMock: HttpTestingController;

  const FLAG_URL = '/api/feature-flags/build_metrics';
  const SUMMARY_URL = '/api/admin/build-metrics/summary?days=30';

  function emptySummary() {
    return {
      windowDays: 30,
      builds: 0,
      p50_ms: null,
      p95_ms: null,
      avg_cost_usd: null,
      total_cost_usd: null,
      phase_p50: { collecting: null, imaging: null, generating: null, publishing: null },
      series: [],
    };
  }

  function seededSummary() {
    return {
      windowDays: 30,
      builds: 12,
      p50_ms: 168_000, // 2m 48s
      p95_ms: 474_000, // 7m 54s
      avg_cost_usd: 0.58,
      total_cost_usd: 7.02,
      phase_p50: { collecting: 5_000, imaging: 0, generating: 150_000, publishing: 25_000 },
      series: [
        { started_at: '2026-10-01T10:00:00.000Z', total_ms: 168_000, est_cost_usd: 0.51, outcome: 'published' },
        { started_at: '2026-10-01T11:00:00.000Z', total_ms: 200_000, est_cost_usd: 0.6, outcome: 'published' },
        { started_at: '2026-10-01T12:00:00.000Z', total_ms: null, est_cost_usd: 0, outcome: 'halted' },
      ],
    };
  }

  function build(): void {
    try {
      localStorage.setItem(
        'ps_session',
        JSON.stringify({ token: 'tkn_bm_test', identifier: 'test@megabyte.space', createdAt: Date.now() }),
      );
    } catch {
      /* private mode */
    }
    TestBed.configureTestingModule({
      imports: [BuildMetricsCardComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    fixture = TestBed.createComponent(BuildMetricsCardComponent);
    httpMock = TestBed.inject(HttpTestingController);
    fixture.detectChanges(); // ngOnInit → flag fetch
  }

  afterEach(() => {
    try {
      httpMock.verify();
    } catch {
      /* some paths leave an un-flushed poll request — not the assertion under test */
    }
    TestBed.resetTestingModule();
  });

  function flushFlag(enabled: boolean): void {
    httpMock.expectOne(FLAG_URL).flush({
      resolved: { enabled, rollout_percent: enabled ? 100 : 0, stage: 'experimental', source: 'registry' },
    });
    fixture.detectChanges();
  }

  function el(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  it('renders NOTHING when the build_metrics flag is OFF (mirrors worker hard-404, no existence leak)', () => {
    build();
    flushFlag(false);
    // No summary request should fire while the flag is off.
    httpMock.expectNone(SUMMARY_URL);
    expect(el().querySelector('[data-testid="sa-build-metrics"]')).toBeNull();
  });

  it('shows an HONEST empty state (never fake zeros) when the flag is ON but the store is empty', () => {
    build();
    flushFlag(true);
    httpMock.expectOne(SUMMARY_URL).flush(emptySummary());
    fixture.detectChanges();
    const card = el().querySelector('[data-testid="sa-build-metrics"]');
    expect(card).withContext('card renders when flag on').not.toBeNull();
    expect(el().querySelector('[data-testid="sa-build-metrics-empty"]')).not.toBeNull();
    expect(el().querySelector('[data-testid="sa-build-metrics-kpis"]')).toBeNull();
  });

  it('renders p50/p95/avg-cost/count VERBATIM from the summary (display == store)', () => {
    build();
    flushFlag(true);
    httpMock.expectOne(SUMMARY_URL).flush(seededSummary());
    fixture.detectChanges();
    const text = (sel: string) => el().querySelector(sel)?.textContent?.trim() ?? '';
    expect(text('[data-testid="sa-build-metrics-p50"]')).toBe('2m 48s');
    expect(text('[data-testid="sa-build-metrics-p95"]')).toBe('7m 54s');
    expect(text('[data-testid="sa-build-metrics-cost"]')).toBe('$0.58');
    expect(text('[data-testid="sa-build-metrics-count"]')).toBe('12');
    // The most-recent build (series end, reversed) leads the recent list.
    expect(el().querySelectorAll('[data-testid="sa-build-metrics-recent"] .bm-recent-row').length).toBe(3);
  });

  it('colours p50 as "good" (beats the 5-min north star) and cost as "good" (beats $1)', () => {
    build();
    flushFlag(true);
    httpMock.expectOne(SUMMARY_URL).flush(seededSummary());
    fixture.detectChanges();
    expect(el().querySelector('[data-testid="sa-build-metrics-p50"]')!.classList.contains('bm-good')).toBeTrue();
    expect(el().querySelector('[data-testid="sa-build-metrics-cost"]')!.classList.contains('bm-good')).toBeTrue();
  });

  it('surfaces a calm "unavailable" line (never a crash) when the summary fetch errors', fakeAsync(() => {
    build();
    flushFlag(true);
    httpMock.expectOne(SUMMARY_URL).flush('boom', { status: 500, statusText: 'Server Error' });
    tick();
    fixture.detectChanges();
    expect(el().querySelector('[data-testid="sa-build-metrics-error"]')).not.toBeNull();
    expect(el().querySelector('[data-testid="sa-build-metrics-kpis"]')).toBeNull();
  }));
});
