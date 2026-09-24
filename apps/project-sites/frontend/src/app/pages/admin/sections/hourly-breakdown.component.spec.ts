import { TestBed } from '@angular/core/testing';
import {
  HourlyBreakdownComponent,
  rotateToLocalHours,
  formatHour,
} from './hourly-breakdown.component';

describe('rotateToLocalHours', () => {
  it('rotates a UTC hour to local by the whole-hour offset (EDT −4) into a dense 24-slot array', () => {
    const out = rotateToLocalHours([{ hour: 18, count: 5 }], -4);
    expect(out.length).toBe(24);
    expect(out[14]).toEqual({ hour: 14, count: 5 }); // 18:00 UTC → 2 PM EDT
    expect(out.reduce((n, b) => n + b.count, 0)).toBe(5); // nothing lost in rotation
  });

  it('wraps across midnight (UTC 02:00 at −4 → local 22:00)', () => {
    const out = rotateToLocalHours([{ hour: 2, count: 3 }], -4);
    expect(out[22]).toEqual({ hour: 22, count: 3 });
  });

  it('aggregates two UTC hours that map to the same local slot', () => {
    const out = rotateToLocalHours(
      [
        { hour: 1, count: 2 },
        { hour: 1, count: 4 },
      ],
      0,
    );
    expect(out[1].count).toBe(6);
  });

  it('ignores out-of-range hours (never throws or mis-slots)', () => {
    const out = rotateToLocalHours(
      [
        { hour: 99, count: 9 },
        { hour: -1, count: 9 },
      ],
      0,
    );
    expect(out.every((b) => b.count === 0)).toBeTrue();
  });
});

describe('formatHour', () => {
  it('formats 12-hour AM/PM labels', () => {
    expect(formatHour(0)).toBe('12 AM');
    expect(formatHour(9)).toBe('9 AM');
    expect(formatHour(12)).toBe('12 PM');
    expect(formatHour(14)).toBe('2 PM');
    expect(formatHour(23)).toBe('11 PM');
  });
});

describe('HourlyBreakdownComponent', () => {
  function render(hours: { hour: number; count: number }[]) {
    TestBed.configureTestingModule({ imports: [HourlyBreakdownComponent] });
    const fx = TestBed.createComponent(HourlyBreakdownComponent);
    fx.componentRef.setInput('hours', hours);
    fx.componentRef.setInput('windowDays', 7);
    fx.detectChanges();
    return fx;
  }
  afterEach(() => TestBed.resetTestingModule());

  it('shows the peak COUNT (offset-independent) + hides the empty state when there is data', () => {
    const fx = render([
      { hour: 3, count: 4 },
      { hour: 18, count: 11 },
    ]);
    const el = fx.nativeElement as HTMLElement;
    // The peak COUNT never depends on the local rotation (only the hour LABEL does).
    expect(fx.componentInstance.peak()?.count).toBe(11);
    expect(el.querySelector('[data-testid="an-hourly-peak"]')?.textContent).toContain('11');
    expect(el.querySelector('[data-testid="an-hourly-empty"]')).toBeNull();
  });

  it('renders an honest empty state when every hour is zero (never fake bars)', () => {
    const fx = render([]);
    const el = fx.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="an-hourly-empty"]')).not.toBeNull();
    expect(fx.componentInstance.hasData()).toBeFalse();
    expect(fx.componentInstance.peak()).toBeNull();
  });
});
