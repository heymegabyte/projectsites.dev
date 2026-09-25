import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { EngagementCardComponent, formatDwell, type EngagementBlock } from './engagement-card.component';

function render(engagement?: EngagementBlock) {
  const fixture = TestBed.createComponent(EngagementCardComponent);
  fixture.componentRef.setInput('engagement', engagement);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

describe('EngagementCardComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders the site-wide median (formatted) + sample count + per-page rows', () => {
    const { fixture, el } = render({
      medianMs: 80000, // 1m 20s
      samples: 340,
      byPage: [
        { path: '/pricing', medianMs: 125000, samples: 40 }, // 2m 5s
        { path: '/', medianMs: 30000, samples: 300 }, // 30s
      ],
    });
    const median = el.querySelector('[data-testid="an-engagement-median"]')!.textContent ?? '';
    expect(median).toContain('1m 20s');
    expect(el.textContent).toContain('340'); // sample count
    const rows = fixture.debugElement.queryAll(By.css('[data-testid="an-engagement-row"]'));
    expect(rows.length).toBe(2);
    expect(rows[0].nativeElement.textContent).toContain('/pricing');
    expect(rows[0].nativeElement.textContent).toContain('2m 5s');
    expect(el.querySelector('[data-testid="an-engagement-empty"]')).toBeNull();
  });

  it('shows "measuring…" (never a fabricated 0) when the median is null', () => {
    const { el } = render({ medianMs: null, samples: 0, byPage: [] });
    const empty = el.querySelector('[data-testid="an-engagement-empty"]');
    expect(empty).toBeTruthy();
    expect(empty!.textContent).toContain('Measuring');
    expect(el.querySelector('[data-testid="an-engagement-median"]')).toBeNull();
  });

  it('treats an undefined block (older payload) as measuring — never crashes', () => {
    const { el } = render(undefined);
    expect(el.querySelector('[data-testid="an-engagement-empty"]')).toBeTruthy();
  });

  it('formatDwell: seconds under a minute, m+s past it', () => {
    expect(formatDwell(8000)).toBe('8s');
    expect(formatDwell(60000)).toBe('1m');
    expect(formatDwell(80000)).toBe('1m 20s');
    expect(formatDwell(125000)).toBe('2m 5s');
  });
});
