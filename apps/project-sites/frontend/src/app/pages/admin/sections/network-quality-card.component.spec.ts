import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { NetworkQualityCardComponent, type NetworkQualityBlock } from './network-quality-card.component';

function render(networkQuality?: NetworkQualityBlock) {
  const fixture = TestBed.createComponent(NetworkQualityCardComponent);
  fixture.componentRef.setInput('networkQuality', networkQuality);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

describe('NetworkQualityCardComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders medians, save-data %, sample count, and the class distribution', () => {
    const { fixture, el } = render({
      samples: 100,
      byEffectiveType: [
        { type: 'slow-2g', count: 5 },
        { type: '3g', count: 15 },
        { type: '4g', count: 80 },
      ],
      medianDownlinkMbps: 8.5,
      medianRttMs: 90,
      saveDataPercent: 12,
    });
    expect(el.querySelector('[data-testid="an-network-downlink"]')!.textContent).toContain('8.5 Mbps');
    expect(el.querySelector('[data-testid="an-network-rtt"]')!.textContent).toContain('90 ms');
    expect(el.querySelector('[data-testid="an-network-savedata"]')!.textContent).toContain('12%');
    expect(el.textContent).toContain('100'); // sample count

    const rungs = fixture.debugElement.queryAll(By.css('[data-testid="an-network-rung"]'));
    expect(rungs.length).toBe(3);
    // 4G = 80/100 = 80%, humanised label
    expect(rungs[2].nativeElement.textContent).toContain('4G / fast');
    expect(rungs[2].nativeElement.textContent).toContain('80%');
    expect(el.querySelector('[data-testid="an-network-empty"]')).toBeNull();
    // honesty: Chromium-only disclosure present
    expect(el.textContent).toContain('Chromium only');
  });

  it('omits a median stat when that value is null (never a fabricated 0)', () => {
    const { el } = render({
      samples: 10,
      byEffectiveType: [{ type: '4g', count: 10 }],
      medianDownlinkMbps: null, // unreported
      medianRttMs: 50,
      saveDataPercent: null,
    });
    expect(el.querySelector('[data-testid="an-network-downlink"]')).toBeNull(); // omitted
    expect(el.querySelector('[data-testid="an-network-rtt"]')!.textContent).toContain('50 ms');
    expect(el.querySelector('[data-testid="an-network-savedata"]')).toBeNull(); // omitted
  });

  it('shows "measuring…" (never a fabricated 0) when there are no samples', () => {
    const { el } = render({
      samples: 0,
      byEffectiveType: [],
      medianDownlinkMbps: null,
      medianRttMs: null,
      saveDataPercent: null,
    });
    const empty = el.querySelector('[data-testid="an-network-empty"]');
    expect(empty).toBeTruthy();
    expect(empty!.textContent).toContain('Measuring');
  });

  it('treats an undefined block (older payload) as measuring — never crashes', () => {
    const { el } = render(undefined);
    expect(el.querySelector('[data-testid="an-network-empty"]')).toBeTruthy();
  });

  it('lists the slowest-connection pages (downlink + rtt); rtt chip omitted when null', () => {
    const { fixture, el } = render({
      samples: 20,
      byEffectiveType: [{ type: '4g', count: 20 }],
      medianDownlinkMbps: 8,
      medianRttMs: 60,
      saveDataPercent: 0,
      byPage: [
        { path: '/heavy', medianDownlinkMbps: 1.5, medianRttMs: 300, samples: 6 },
        { path: '/light', medianDownlinkMbps: 20, medianRttMs: null, samples: 8 },
      ],
    });
    const pages = fixture.debugElement.queryAll(By.css('[data-testid="an-network-page"]'));
    expect(pages.length).toBe(2);
    expect(pages[0].nativeElement.textContent).toContain('/heavy'); // slowest-first (server order)
    expect(pages[0].nativeElement.textContent).toContain('1.5 Mbps');
    expect(pages[0].nativeElement.textContent).toContain('300 ms');
    // /light has null rtt → NO rtt chip (never a fabricated 0)
    expect(el.querySelectorAll('[data-testid="an-network-page"] .nq-page-rtt').length).toBe(1);
  });

  it('hides the slowest-connection-pages block when byPage is absent', () => {
    const { fixture } = render({
      samples: 20,
      byEffectiveType: [{ type: '4g', count: 20 }],
      medianDownlinkMbps: 8,
      medianRttMs: 60,
      saveDataPercent: 0,
    });
    expect(fixture.debugElement.query(By.css('[data-testid="an-network-pages"]'))).toBeNull();
  });
});
