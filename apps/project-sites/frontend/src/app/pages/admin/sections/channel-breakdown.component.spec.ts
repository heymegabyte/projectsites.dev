import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ChannelBreakdownComponent, type ChannelCount } from './channel-breakdown.component';

/**
 * ChannelBreakdownComponent — the "how visitors arrive" card. Load-bearing properties: it renders
 * ONLY real channel counts (empty state, never a fabricated 0), the share % uses the FULL total, and
 * each row drills by the RAW stored channel value (so the server filter can't be lying-empty).
 */
function render(channels: ChannelCount[], activeFilter: { dim: string; value: string } | null = null) {
  TestBed.configureTestingModule({ imports: [ChannelBreakdownComponent] });
  const fixture = TestBed.createComponent(ChannelBreakdownComponent);
  fixture.componentRef.setInput('channels', channels);
  fixture.componentRef.setInput('windowDays', 30);
  fixture.componentRef.setInput('activeFilter', activeFilter);
  fixture.detectChanges();
  return fixture;
}

describe('ChannelBreakdownComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders a row per channel with a humanized label + count', () => {
    const f = render([
      { label: 'direct', count: 60 },
      { label: 'organic', count: 30 },
      { label: 'social', count: 10 },
    ]);
    const rows = f.debugElement.queryAll(By.css('[data-testid="an-channel-row"]'));
    expect(rows.length).toBe(3);
    const text = f.nativeElement.textContent as string;
    expect(text).toContain('Direct'); // humanized
    expect(text).toContain('Organic search'); // organic → Organic search
    expect(text).toContain('60');
  });

  it('shows each channel as a % share of the FULL total (not just the shown rows)', () => {
    const f = render([
      { label: 'direct', count: 75 },
      { label: 'organic', count: 25 },
    ]);
    const text = f.nativeElement.textContent as string;
    expect(text).toContain('75%'); // 75 / (75+25)
    expect(text).toContain('25%');
  });

  it('emits drill with the RAW stored channel value (not the humanized label) on click', () => {
    const f = render([{ label: 'organic', count: 5 }]);
    let emitted: { dim: string; value: string } | undefined;
    f.componentInstance.drill.subscribe((e) => (emitted = e));
    (f.debugElement.query(By.css('[data-testid="an-channel-drill"]')).nativeElement as HTMLButtonElement).click();
    expect(emitted).toEqual({ dim: 'channel', value: 'organic' }); // RAW value, safe for the server filter
  });

  it('reflects the active filter as aria-pressed on the matching row only', () => {
    const f = render([{ label: 'direct', count: 9 }, { label: 'social', count: 4 }], { dim: 'channel', value: 'direct' });
    const buttons = f.debugElement.queryAll(By.css('[data-testid="an-channel-drill"]'));
    const pressed = buttons.map((b) => (b.nativeElement as HTMLElement).getAttribute('aria-pressed'));
    expect(pressed).toEqual(['true', 'false']); // sorted desc: direct(9) then social(4)
  });

  it('shows an honest empty state when there is no channel data — NEVER a fabricated 0', () => {
    const f = render([]);
    expect(f.debugElement.query(By.css('[data-testid="an-channel-empty"]'))).toBeTruthy();
    expect(f.debugElement.queryAll(By.css('[data-testid="an-channel-row"]')).length).toBe(0);
    expect(f.nativeElement.textContent).not.toContain('0%');
  });

  it('drops zero-count channels + sorts by count desc', () => {
    const f = render([
      { label: 'social', count: 0 },
      { label: 'direct', count: 40 },
      { label: 'organic', count: 90 },
    ]);
    const labels = f.debugElement
      .queryAll(By.css('.ch-label'))
      .map((el) => (el.nativeElement as HTMLElement).textContent?.trim());
    expect(labels).toEqual(['Organic search', 'Direct']); // social(0) dropped, sorted desc
  });
});
