import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { VoiceInsightsComponent } from './insights.component';
import { ApiService } from '../../../../services/api.service';

const INSIGHTS = {
  total_calls: 12,
  by_direction: { inbound: 8, outbound: 4 },
  avg_duration_seconds: 95,
  sentiment_breakdown: { positive: 7, neutral: 3, negative: 1, escalated_safety: 1, flagged_scam: 0 },
  total_cost_cents: 337,
};

function build(getImpl: () => unknown): VoiceInsightsComponent {
  TestBed.configureTestingModule({
    imports: [VoiceInsightsComponent],
    providers: [{ provide: ApiService, useValue: { get: getImpl } }],
  });
  const fx = TestBed.createComponent(VoiceInsightsComponent);
  fx.detectChanges();
  return fx.componentInstance;
}

describe('VoiceInsightsComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('surfaces aggregate KPIs stored per call but never summarized before', () => {
    const c = build(() => of({ data: INSIGHTS }));
    expect(c.loading()).toBe(false);
    expect(c.error()).toBe(false);
    expect(c.data()?.total_calls).toBe(12);
    expect(c.avgDurationLabel()).withContext('95s → mm:ss').toBe('1:35');
    expect(c.costLabel()).withContext('337 cents → dollars').toBe('$3.37');
    expect(c.positivePct()).withContext('7 of 12 scored').toBe(58);
    expect(c.sentimentRows().length).toBe(5);
    expect(c.barPct(7)).withContext('largest sentiment fills the bar').toBe(100);
  });

  it('degrades to an error flag when the endpoint fails — never crashes the tab', () => {
    const c = build(() => throwError(() => new Error('boom')));
    expect(c.error()).toBe(true);
    expect(c.loading()).toBe(false);
    expect(c.data()).toBeNull();
  });

  it('renders the empty launchpad (not a lying KPI grid) when there are zero calls', () => {
    const c = build(() => of({ data: { ...INSIGHTS, total_calls: 0 } }));
    expect(c.data()?.total_calls).toBe(0);
    expect(c.positivePct()).toBe(0);
  });
});
