import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { NavTimingCardComponent, type NavTimingBlock } from './nav-timing-card.component';

function render(navTiming?: NavTimingBlock) {
  const fixture = TestBed.createComponent(NavTimingCardComponent);
  fixture.componentRef.setInput('navTiming', navTiming);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

describe('NavTimingCardComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders the median total + a phase row per present phase, scaled to the largest', () => {
    const { fixture, el } = render({
      samples: 120,
      dns: 20,
      connect: 40,
      ttfb: 200, // the largest → 100% bar
      transfer: 30,
      dom: 100,
      total: 820,
    });
    expect(el.querySelector('[data-testid="an-navtiming-total"]')!.textContent).toContain('820ms');
    expect(el.textContent).toContain('120'); // sample count
    const rows = fixture.debugElement.queryAll(By.css('[data-testid="an-navtiming-phase"]'));
    expect(rows.length).toBe(5); // dns/connect/ttfb/transfer/dom
    expect(rows[0].nativeElement.textContent).toContain('DNS lookup');
    expect(rows[2].nativeElement.textContent).toContain('200ms'); // ttfb
    expect(el.querySelector('[data-testid="an-navtiming-empty"]')).toBeNull();
    // honesty note about independent medians
    expect(el.textContent).toContain('independent median');
  });

  it('formats sub-second as ms and ≥1s as seconds', () => {
    const { el } = render({ samples: 5, dns: 5, connect: 10, ttfb: 900, transfer: 20, dom: 300, total: 1500 });
    expect(el.querySelector('[data-testid="an-navtiming-total"]')!.textContent).toContain('1.5s');
  });

  it('omits a phase whose median is null (never a fabricated 0), keeps a real 0', () => {
    const { fixture } = render({
      samples: 10,
      dns: 0, // real 0 (cached) → still a row
      connect: null, // unreported → omitted
      ttfb: 150,
      transfer: null,
      dom: 80,
      total: 400,
    });
    const rows = fixture.debugElement.queryAll(By.css('[data-testid="an-navtiming-phase"]'));
    expect(rows.length).toBe(3); // dns(0) + ttfb + dom; connect + transfer omitted
    expect(rows[0].nativeElement.textContent).toContain('DNS lookup');
    expect(rows[0].nativeElement.textContent).toContain('0ms');
  });

  it('shows "measuring…" (never a fabricated 0) when total is null', () => {
    const { el } = render({ samples: 0, dns: null, connect: null, ttfb: null, transfer: null, dom: null, total: null });
    const empty = el.querySelector('[data-testid="an-navtiming-empty"]');
    expect(empty).toBeTruthy();
    expect(empty!.textContent).toContain('Measuring');
  });

  it('treats an undefined block (older payload) as measuring — never crashes', () => {
    const { el } = render(undefined);
    expect(el.querySelector('[data-testid="an-navtiming-empty"]')).toBeTruthy();
  });

  it('renders the slowest pages with total load + per-page server-wait (TTFB), server chip omitted when TTFB null', () => {
    const { fixture, el } = render({
      samples: 40,
      dns: 10,
      connect: 20,
      ttfb: 300,
      transfer: 30,
      dom: 200,
      total: 1200,
      byPage: [
        { path: '/checkout', ttfb: 800, total: 3000, samples: 5 }, // slow SERVER
        { path: '/', ttfb: null, total: 1000, samples: 20 },
      ],
    });
    const pages = fixture.debugElement.queryAll(By.css('[data-testid="an-navtiming-page"]'));
    expect(pages.length).toBe(2);
    expect(pages[0].nativeElement.textContent).toContain('/checkout'); // worst-first (server order)
    expect(pages[0].nativeElement.textContent).toContain('3.0s');
    expect(pages[0].nativeElement.textContent).toContain('800ms server'); // per-page TTFB
    // /'s TTFB is null → NO server chip (never a fabricated 0)
    expect(el.querySelectorAll('[data-testid="an-navtiming-page-ttfb"]').length).toBe(1);
  });

  it('hides the slowest-pages block when byPage is absent (no fabricated rows)', () => {
    const { fixture } = render({
      samples: 40,
      dns: 10,
      connect: 20,
      ttfb: 300,
      transfer: 30,
      dom: 200,
      total: 1200,
    });
    expect(fixture.debugElement.query(By.css('[data-testid="an-navtiming-pages"]'))).toBeNull();
  });
});
