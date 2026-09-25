import { TestBed } from '@angular/core/testing';
import { InsightsStripComponent } from './insights-strip.component';
import type { AnalyticsInsight } from '../../../utils/analytics-insights';

function render(insights: AnalyticsInsight[]): HTMLElement {
  TestBed.configureTestingModule({ imports: [InsightsStripComponent] });
  const fixture = TestBed.createComponent(InsightsStripComponent);
  fixture.componentRef.setInput('insights', insights);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('InsightsStripComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders each insight sentence with a stable per-insight testid', () => {
    const el = render([
      { id: 'traffic', text: '120 page views in the last 7 days.' },
      { id: 'device', text: '68% of visitors are on mobile.' },
    ]);
    expect(el.querySelector('[data-testid="an-insights"]')).withContext('strip renders when insights exist').toBeTruthy();
    expect((el.querySelector('[data-testid="an-insight-traffic"]') as HTMLElement).textContent).toContain('120 page views');
    expect((el.querySelector('[data-testid="an-insight-device"]') as HTMLElement).textContent).toContain('68% of visitors are on mobile');
  });

  it('hides the whole strip when there are no insights (fresh site — never a fabricated highlight)', () => {
    expect(render([]).querySelector('[data-testid="an-insights"]')).toBeNull();
  });
});
