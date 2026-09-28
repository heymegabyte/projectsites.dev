import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { PricingComponent } from './pricing.component';

/**
 * The pricing page is conversion-critical marketing prose sourced from
 * `docs/PRICING-MODEL.md` (exact metered cost + a flat $50/month fee). These
 * guards lock the model + the copy quality: the "$50" fee and the exact-cost
 * promise must render, a raw template placeholder must never leak ("looks
 * broken = is broken"), and none of the banned AI-slop words may appear.
 */
describe('PricingComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PricingComponent],
      providers: [provideRouter([])],
    }).compileComponents();
  });

  it('renders the exact-cost + $50 model, no leaked placeholder', () => {
    const fixture = TestBed.createComponent(PricingComponent);
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';

    // The headline promise + the flat fee are the load-bearing copy.
    expect(text).toContain('You pay what it costs');
    expect(text).toContain('$50');
    expect(text).toContain('platform fee');

    // No unrendered template variable ever reaches a prospect.
    expect(text).not.toContain('{slug}');
    expect(text).not.toContain('{{');
  });

  it('shows all 10 charge components + the competitor comparison', () => {
    const fixture = TestBed.createComponent(PricingComponent);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    // Exactly 10 charge-component cards (the spec's "sum of 10 things").
    expect(el.querySelectorAll('.component-card').length).toBe(10);

    // Every opaque-tier competitor is present alongside us.
    const text = el.textContent ?? '';
    for (const vendor of [
      'ProjectSites.dev',
      'Vercel',
      'Netlify',
      'WP Engine',
      'Squarespace',
      'Webflow',
      'Wix',
    ]) {
      expect(text).withContext(vendor).toContain(vendor);
    }
  });

  it('carries no banned AI-slop words in the customer copy', () => {
    const fixture = TestBed.createComponent(PricingComponent);
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent?.toLowerCase() ?? '';
    for (const banned of [
      'revolutionize',
      'cutting-edge',
      'world-class',
      'leverage',
      'limitless',
    ]) {
      expect(text).withContext(banned).not.toContain(banned);
    }
  });
});
