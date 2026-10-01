import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';

import {
  GenerationMetricsCardComponent,
  type BuildMetricsSummary,
} from './generation-metrics-card.component';
import { ApiService, type ResolvedFlagResponse } from '../../../../services/api.service';

/**
 * "Generation speed + cost" dashboard card (fire-61 — the north-star surface
 * over GET /api/admin/build-metrics/summary). Locks:
 *  - populated branch: formatted p50 headline, green under-target delta chips
 *    (<5min speed · ≤$1 cost), 4-phase breakdown row, sparkline points;
 *  - over-target branch: chips flip to the warning state;
 *  - empty branch: builds:0 renders the honest baseline copy, never zeros;
 *  - error branch: the card hides itself entirely (403/network → no broken UI);
 *  - fire-63 FLAG GATE: the `build_metrics` endpoint 404s when its flag is OFF
 *    (dark default), so the card resolves the flag FIRST and only fetches the
 *    summary when ON. OFF / dark / errored → renders NOTHING and issues ZERO
 *    summary requests (no console 404). Per repo rules
 *    flag-gated-fetch-gate-on-ison-not-silent + flag-off-frontend-must-match-worker-404.
 */
const POPULATED: BuildMetricsSummary = {
  windowDays: 30,
  builds: 12,
  p50_ms: 168_000, // 2.8min — under the 5min target
  p95_ms: 474_000,
  avg_cost_usd: 0.58, // under the $1 target
  total_cost_usd: 7.02,
  phase_p50: { collecting: 5_000, imaging: 0, generating: 150_000, publishing: 25_000 },
  series: [
    { started_at: '2026-09-29T01:00:00.000Z', total_ms: 200_000, est_cost_usd: 0.6, outcome: 'published' },
    { started_at: '2026-09-30T01:00:00.000Z', total_ms: 120_000, est_cost_usd: 0.5, outcome: 'published' },
    { started_at: '2026-10-01T01:00:00.000Z', total_ms: null, est_cost_usd: 0.2, outcome: 'error' },
    { started_at: '2026-10-01T02:00:00.000Z', total_ms: 168_000, est_cost_usd: 0.55, outcome: 'published' },
  ],
};

const EMPTY: BuildMetricsSummary = {
  windowDays: 30,
  builds: 0,
  p50_ms: null,
  p95_ms: null,
  avg_cost_usd: null,
  total_cost_usd: null,
  phase_p50: { collecting: null, imaging: null, generating: null, publishing: null },
  series: [],
};

/** A `GET /api/feature-flags/build_metrics` body with the given resolved state. */
function flagResponse(enabled: boolean, rollout_percent = enabled ? 100 : 0): ResolvedFlagResponse {
  return {
    definition: { key: 'build_metrics' },
    resolved: { enabled, rollout_percent, stage: 'experimental', source: 'registry' },
    docs: null,
  };
}

/**
 * Build the card with a mocked ApiService.
 * @param result the summary payload, or 'error' to make the summary fetch fail.
 * @param flag how `getFeatureFlag` resolves: ON (default, so the summary branch
 *   runs), a specific ResolvedFlagResponse, or 'error' to fail resolution.
 */
function make(
  result: BuildMetricsSummary | 'error',
  flag: ResolvedFlagResponse | 'error' = flagResponse(true),
): { fixture: ReturnType<typeof TestBed.createComponent<GenerationMetricsCardComponent>>; getSpy: jasmine.Spy } {
  TestBed.resetTestingModule();
  const getSpy = jasmine.createSpy('get').and.callFake(() =>
    result === 'error' ? throwError(() => new Error('403')) : of(result),
  );
  const getFeatureFlag = jasmine
    .createSpy('getFeatureFlag')
    .and.callFake(() => (flag === 'error' ? throwError(() => new Error('404')) : of(flag)));
  TestBed.configureTestingModule({
    imports: [GenerationMetricsCardComponent],
    providers: [{ provide: ApiService, useValue: { get: getSpy, getFeatureFlag } }],
  });
  const fixture = TestBed.createComponent(GenerationMetricsCardComponent);
  fixture.detectChanges();
  return { fixture, getSpy };
}

describe('GenerationMetricsCardComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders the formatted p50 headline + builds context (populated)', () => {
    const { fixture } = make(POPULATED);
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('[data-testid="gen-metrics-card"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="gen-p50"]')?.textContent).toContain('2.8min');
    expect(el.textContent).toContain('p95 7.9min');
    expect(el.textContent).toContain('12 builds');
    expect(el.querySelector('[data-testid="gen-cost"]')?.textContent).toContain('$0.58');
    fixture.destroy();
  });

  it('shows GREEN under-target delta chips when p50 < 5min and avg cost ≤ $1', () => {
    const { fixture } = make(POPULATED);
    const el: HTMLElement = fixture.nativeElement;
    const speedChip = el.querySelector('[data-testid="gen-speed-chip"]');
    const costChip = el.querySelector('[data-testid="gen-cost-chip"]');
    expect(speedChip?.textContent).toContain('under');
    expect(speedChip?.classList.contains('ok')).toBeTrue();
    expect(costChip?.textContent).toContain('under');
    expect(costChip?.classList.contains('ok')).toBeTrue();
    fixture.destroy();
  });

  it('flips the delta chips to the warning state when over target', () => {
    const { fixture } = make({
      ...POPULATED,
      p50_ms: 360_000, // 6min — 1min over
      avg_cost_usd: 1.4, // $0.40 over
    });
    const el: HTMLElement = fixture.nativeElement;
    const speedChip = el.querySelector('[data-testid="gen-speed-chip"]');
    const costChip = el.querySelector('[data-testid="gen-cost-chip"]');
    expect(speedChip?.textContent).toContain('over');
    expect(speedChip?.classList.contains('ok')).toBeFalse();
    expect(costChip?.textContent).toContain('over');
    expect(costChip?.classList.contains('ok')).toBeFalse();
    fixture.destroy();
  });

  it('renders the 4-phase breakdown row with honest values (0 is data, null is —)', () => {
    const { fixture } = make(POPULATED);
    const el: HTMLElement = fixture.nativeElement;
    const phases = el.querySelectorAll('[data-testid="gen-phases"] li');
    expect(phases.length).toBe(4);
    const text = el.querySelector('[data-testid="gen-phases"]')?.textContent ?? '';
    expect(text).toContain('Collecting');
    expect(text).toContain('Generating');
    expect(text).toContain('2.5min'); // generating p50 150000
    expect(text).toContain('0s'); // imaging 0 — honest zero, not a dash
    fixture.destroy();
  });

  it('builds sparkline points from the non-null series values', () => {
    const { fixture } = make(POPULATED);
    const c = fixture.componentInstance;
    const pts = c.sparkPoints();
    expect(pts).toBeTruthy();
    // 3 non-null durations → 3 "x,y" pairs.
    expect((pts as string).trim().split(/\s+/).length).toBe(3);
    expect(fixture.nativeElement.querySelector('svg.gen-spark')).toBeTruthy();
    fixture.destroy();
  });

  it('renders the honest empty state when zero builds are measured', () => {
    const { fixture } = make(EMPTY);
    const el: HTMLElement = fixture.nativeElement;
    const empty = el.querySelector('[data-testid="gen-empty"]');
    expect(empty?.textContent).toContain(
      'No measured builds yet — baseline p50 2.8min from history',
    );
    expect(el.querySelector('[data-testid="gen-p50"]')).toBeNull();
    fixture.destroy();
  });

  it('hides the whole card when the summary fetch fails (never a broken card)', () => {
    const { fixture } = make('error');
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('[data-testid="gen-metrics-card"]')).toBeNull();
    expect((el.textContent ?? '').trim()).toBe('');
    fixture.destroy();
  });

  // ── fire-63 flag gate ──────────────────────────────────────────────────
  describe('build_metrics flag gate (no 404 console error when dark)', () => {
    it('when the flag resolves OFF: renders NOTHING and NEVER requests the summary endpoint', () => {
      const { fixture, getSpy } = make(EMPTY, flagResponse(false));
      const el: HTMLElement = fixture.nativeElement;
      // The whole point of the fix — zero summary calls when dark.
      expect(getSpy).not.toHaveBeenCalled();
      expect(fixture.componentInstance.hidden()).toBeTrue();
      expect(el.querySelector('[data-testid="gen-metrics-card"]')).toBeNull();
      expect((el.textContent ?? '').trim()).toBe('');
      fixture.destroy();
    });

    it('treats enabled-but-0%-rollout (dark) as OFF: no summary request, hidden', () => {
      const { fixture, getSpy } = make(EMPTY, flagResponse(true, 0));
      expect(getSpy).not.toHaveBeenCalled();
      expect(fixture.componentInstance.hidden()).toBeTrue();
      expect((fixture.nativeElement as HTMLElement).querySelector('[data-testid="gen-metrics-card"]')).toBeNull();
      fixture.destroy();
    });

    it('when flag resolution fails (e.g. 404 unregistered flag): fails safe to hidden, no summary request', () => {
      const { fixture, getSpy } = make(EMPTY, 'error');
      expect(getSpy).not.toHaveBeenCalled();
      expect(fixture.componentInstance.hidden()).toBeTrue();
      expect((fixture.nativeElement as HTMLElement).querySelector('[data-testid="gen-metrics-card"]')).toBeNull();
      fixture.destroy();
    });

    it('when the flag resolves ON: fetches the summary (one call) and reveals the card', () => {
      const { fixture, getSpy } = make(POPULATED, flagResponse(true));
      expect(getSpy).toHaveBeenCalledTimes(1);
      expect(getSpy).toHaveBeenCalledWith('/admin/build-metrics/summary', undefined, { silent: true });
      expect(fixture.componentInstance.hidden()).toBeFalse();
      expect((fixture.nativeElement as HTMLElement).querySelector('[data-testid="gen-metrics-card"]')).toBeTruthy();
      fixture.destroy();
    });
  });
});
