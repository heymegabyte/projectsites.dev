import { TestBed } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
import { ReferralCardComponent } from './referral-card.component';
import { ApiService } from '../../services/api.service';

/**
 * CLS: the referral card RESERVES its height while `GET /api/referral/code` is in
 * flight (a height-matched skeleton), so it doesn't shove the dashboard groups below
 * it down when it lands — a top /admin dashboard layout-shift contributor (measured
 * CLS 0.23). Critically, a 404 (flag off) / empty code must SETTLE to nothing — never
 * a perpetual skeleton (the error path also leaves `data` null, so a `settled` flag,
 * not `data === null`, gates loading).
 */
describe('ReferralCardComponent (loading skeleton reserves height — anti-CLS)', () => {
  const CODE = { code: 'ABC123', referral_url: 'https://projectsites.dev/r/ABC123', clicks: 5, conversions: 2 };
  afterEach(() => TestBed.resetTestingModule());

  function withApi(get: () => unknown) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: { get } }] });
    const fx = TestBed.createComponent(ReferralCardComponent);
    fx.detectChanges();
    return fx;
  }

  it('shows the skeleton (not the real card) while the code is loading', () => {
    const fx = withApi(() => new Subject()); // never emits → not settled → loading
    const el = fx.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="referral-skeleton"]')).withContext('skeleton reserves height').not.toBeNull();
    expect(el.querySelector('[data-testid="referral-widget"]')).withContext('real card not shown yet').toBeNull();
    expect(fx.componentInstance.loading()).toBeTrue();
  });

  it('swaps skeleton → real card when a referral code loads', () => {
    const fx = withApi(() => of(CODE));
    const el = fx.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="referral-skeleton"]')).withContext('skeleton gone').toBeNull();
    expect(el.querySelector('[data-testid="referral-widget"]')).withContext('real card shown').not.toBeNull();
    expect(fx.componentInstance.loading()).toBeFalse();
  });

  it('collapses to nothing on a 404 (flag off) — settles, never a perpetual skeleton', () => {
    const fx = withApi(() => throwError(() => ({ status: 404 })));
    const el = fx.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="referral-skeleton"]')).withContext('no perpetual skeleton when the flag is off').toBeNull();
    expect(el.querySelector('[data-testid="referral-widget"]')).toBeNull();
    expect(fx.componentInstance.loading()).withContext('settled after error').toBeFalse();
  });

  it('collapses to nothing when the code is empty (settled, not visible)', () => {
    const fx = withApi(() => of({ code: '', referral_url: '', clicks: 0, conversions: 0 }));
    const el = fx.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="referral-skeleton"]')).toBeNull();
    expect(el.querySelector('[data-testid="referral-widget"]')).toBeNull();
  });
});

/**
 * AA-contrast guard (AL-400). The admin surf-audit's axe pass is BLIND to two things on
 * this card: (1) the copy button's text sits on a CSS `linear-gradient` background, which
 * axe skips (can't read a gradient) — dark text there silently failed ~2.9:1 at the dark
 * end; (2) the tiny `rgba(255,255,255,.45)` stat/code labels hovered ~4.48:1. This spec
 * computes WCAG contrast from the RENDERED computed styles (Karma ChromeHeadless), locking
 * the fix: light button text + labels ≥ 4.5:1. See memory `axe-color-contrast-false-negative`.
 */
describe('ReferralCardComponent — AA contrast (axe is blind to the gradient button)', () => {
  interface RGBA { r: number; g: number; b: number; a: number }
  const CODE = { code: 'ABC123', referral_url: 'https://projectsites.dev/r/ABC123', clicks: 5, conversions: 2 };
  const PAGE_BG: RGBA = { r: 6, g: 6, b: 16, a: 1 }; // --ps-bg #060610

  const parse = (c: string): RGBA | null => {
    const m = c.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
    return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
  };
  const chan = (v: number): number => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const lum = (c: RGBA): number => 0.2126 * chan(c.r) + 0.7152 * chan(c.g) + 0.0722 * chan(c.b);
  const over = (fg: RGBA, bg: RGBA): RGBA => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const contrast = (fg: RGBA, bg: RGBA): number => { const c = over(fg, bg); const L1 = lum(c), L2 = lum(bg); return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05); };

  let host: HTMLElement;
  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: { get: () => of(CODE) } }] });
    const fx = TestBed.createComponent(ReferralCardComponent);
    fx.detectChanges();
    host = fx.nativeElement as HTMLElement;
    document.body.appendChild(host); // in-DOM so getComputedStyle resolves emulated-encapsulation styles
  });
  afterEach(() => { host.remove(); TestBed.resetTestingModule(); });

  it('stat labels (clicks/signups) clear AA 4.5:1 on the card', () => {
    const lbls = Array.from(host.querySelectorAll('.rc-lbl')) as HTMLElement[];
    expect(lbls.length).withContext('both stat labels rendered').toBe(2);
    for (const lbl of lbls) {
      const fg = parse(getComputedStyle(lbl).color);
      expect(fg).withContext(`color parsed for "${lbl.textContent}"`).not.toBeNull();
      expect(contrast(fg as RGBA, PAGE_BG)).withContext(`.rc-lbl "${lbl.textContent}" contrast`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('the "Code:" line clears AA 4.5:1', () => {
    const code = host.querySelector('.rc-code') as HTMLElement | null;
    expect(code).withContext('code line rendered').not.toBeNull();
    const fg = parse(getComputedStyle(code as HTMLElement).color);
    expect(contrast(fg as RGBA, PAGE_BG)).withContext('.rc-code contrast').toBeGreaterThanOrEqual(4.5);
  });

  it('the copy button uses LIGHT text (AA-safe on the dark-purple gradient axe cannot read)', () => {
    const btn = host.querySelector('.rc-copy-btn') as HTMLElement | null;
    expect(btn).withContext('copy button rendered').not.toBeNull();
    const fg = parse(getComputedStyle(btn as HTMLElement).color);
    // #fff (lum≈1) clears 5.3:1+ across #7c3aed→#6d28d9; dark #0b0416 (lum≈0.003) silently
    // fails ~2.9:1 at the dark end. Invariant: the button text must be light.
    expect(lum(fg as RGBA)).withContext('copy-button text luminance (near-white)').toBeGreaterThanOrEqual(0.5);
  });
});
