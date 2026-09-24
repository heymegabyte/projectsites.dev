import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ConversionsCardComponent, type ConversionKind } from './conversions-card.component';

/**
 * ConversionsCardComponent — the by-kind conversions breakdown (calls / directions /
 * form submits …). Every count is a real tracked event; the empty state says "no
 * conversions tracked yet", never a fabricated breakdown.
 */
function render(rows: ConversionKind[], windowDays = 30) {
  TestBed.configureTestingModule({ imports: [ConversionsCardComponent] });
  const fixture = TestBed.createComponent(ConversionsCardComponent);
  fixture.componentRef.setInput('rows', rows);
  fixture.componentRef.setInput('windowDays', windowDays);
  fixture.detectChanges();
  return fixture;
}

describe('ConversionsCardComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders humanized kinds sorted by count desc, with a total', () => {
    const fixture = render([
      { label: 'call', count: 12 },
      { label: 'form_submit', count: 3 },
      { label: 'directions', count: 8 },
    ]);
    const rows = fixture.debugElement.queryAll(By.css('[data-testid="an-conv-row"]'));
    expect(rows.length).toBe(3);
    // Sorted desc: call(12) → directions(8) → form_submit(3), humanized.
    expect((rows[0].nativeElement as HTMLElement).textContent).toContain('Phone calls');
    expect((rows[0].nativeElement as HTMLElement).textContent).toContain('12');
    expect((rows[1].nativeElement as HTMLElement).textContent).toContain('Directions');
    expect((rows[2].nativeElement as HTMLElement).textContent).toContain('Form submissions');
    expect((fixture.debugElement.query(By.css('[data-testid="an-conv-total"]')).nativeElement as HTMLElement).textContent).toContain('23 total');
  });

  it('title-cases an unknown kind and buckets a null-ish kind as "other"', () => {
    const c = render([]).componentInstance;
    expect(c.humanize('call')).toBe('Phone calls');
    expect(c.humanize('gift_card_purchase')).toBe('Gift Card Purchase');
    expect(c.humanize('')).toBe('Other conversions');
  });

  it('shows the honest empty state (no fabricated rows) when there are no conversions', () => {
    const empty = render([]);
    expect(empty.debugElement.query(By.css('[data-testid="an-conv-empty"]'))).toBeTruthy();
    expect(empty.debugElement.queryAll(By.css('[data-testid="an-conv-row"]')).length).toBe(0);

    TestBed.resetTestingModule();
    // All-zero rows also count as empty — never render a 0-count breakdown.
    const zero = render([{ label: 'call', count: 0 }]);
    expect(zero.debugElement.query(By.css('[data-testid="an-conv-empty"]'))).toBeTruthy();
  });

  it('scales bar width to the largest count (min 4% so a small bar stays visible)', () => {
    const c = render([{ label: 'call', count: 100 }, { label: 'sms', count: 1 }]).componentInstance;
    expect(c.barWidth(100)).toBe(100);
    expect(c.barWidth(1)).toBe(4); // 1% rounds to 1 but floors at 4
    expect(c.barWidth(50)).toBe(50);
  });

  it('labels the window in the subtitle', () => {
    const fixture = render([{ label: 'call', count: 1 }], 7);
    expect((fixture.debugElement.query(By.css('.conv-sub')).nativeElement as HTMLElement).textContent).toContain('last 7 days');
  });
});
