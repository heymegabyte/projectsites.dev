import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ScrollDepthCardComponent, type ScrollDepthBlock } from './scroll-depth-card.component';

function render(scrollDepth?: ScrollDepthBlock) {
  const fixture = TestBed.createComponent(ScrollDepthCardComponent);
  fixture.componentRef.setInput('scrollDepth', scrollDepth);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

describe('ScrollDepthCardComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders the median depth, sample count, reach funnel, and per-page rows', () => {
    const { fixture, el } = render({
      samples: 200,
      medianPercent: 60,
      reach: { p25: 200, p50: 120, p75: 80, p100: 40 },
      byPage: [
        { path: '/story', medianPercent: 90, samples: 50, completionPercent: 30 },
        { path: '/', medianPercent: 100, samples: 150, completionPercent: 100 },
      ],
    });
    const median = el.querySelector('[data-testid="an-scroll-median"]')!.textContent ?? '';
    expect(median).toContain('60%');
    expect(el.textContent).toContain('200'); // sample count

    const rungs = fixture.debugElement.queryAll(By.css('[data-testid="an-scroll-rung"]'));
    expect(rungs.length).toBe(4); // 25/50/75/100
    // reach rates: 200/200=100%, 120/200=60%, 80/200=40%, 40/200=20%
    expect(rungs[0].nativeElement.textContent).toContain('100%');
    expect(rungs[1].nativeElement.textContent).toContain('60%');
    expect(rungs[3].nativeElement.textContent).toContain('20%');

    const rows = fixture.debugElement.queryAll(By.css('[data-testid="an-scroll-row"]'));
    expect(rows.length).toBe(2);
    expect(rows[0].nativeElement.textContent).toContain('/story');
    expect(rows[0].nativeElement.textContent).toContain('90%'); // median depth
    expect(rows[0].nativeElement.textContent).toContain('30%'); // completion
    expect(el.querySelector('[data-testid="an-scroll-empty"]')).toBeNull();
  });

  it('shows "measuring…" (never a fabricated 0) when the median is null', () => {
    const { el } = render({
      samples: 0,
      medianPercent: null,
      reach: { p25: 0, p50: 0, p75: 0, p100: 0 },
      byPage: [],
    });
    const empty = el.querySelector('[data-testid="an-scroll-empty"]');
    expect(empty).toBeTruthy();
    expect(empty!.textContent).toContain('Measuring');
    expect(el.querySelector('[data-testid="an-scroll-median"]')).toBeNull();
  });

  it('treats an undefined block (older payload) as measuring — never crashes', () => {
    const { el } = render(undefined);
    expect(el.querySelector('[data-testid="an-scroll-empty"]')).toBeTruthy();
  });
});
