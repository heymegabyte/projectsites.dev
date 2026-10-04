/**
 * @module components/nav-icon/nav-icon.component.spec
 *
 * The inline-SVG registry that every nav presentation shares. Guards that each
 * model icon key renders a real glyph at the requested size — a blank icon in
 * the 72px rail (where the icon is the ONLY affordance) would be unusable.
 */
import { TestBed } from '@angular/core/testing';
import { NavIconComponent } from './nav-icon.component';
import type { NavIconName } from '../../pages/admin/navigation/admin-nav.model';

function render(name: NavIconName, size?: number): SVGSVGElement {
  const fixture = TestBed.createComponent(NavIconComponent);
  fixture.componentRef.setInput('name', name);
  if (size !== undefined) fixture.componentRef.setInput('size', size);
  fixture.detectChanges();
  return fixture.nativeElement.querySelector('svg') as SVGSVGElement;
}

describe('NavIconComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders a non-empty SVG for every model icon key', () => {
    // Exhaustive BY CONSTRUCTION: `satisfies Record<NavIconName, 1>` makes tsc fail
    // if an icon key is added to the union without a glyph test here. The old
    // hand-maintained array had silently drifted — 'sites' + 'billing' were missing.
    const ICON_KEYS = {
      dashboard: 1,
      sites: 1,
      editor: 1,
      snapshots: 1,
      analytics: 1,
      forms: 1,
      apps: 1,
      features: 1,
      social: 1,
      voice: 1,
      logs: 1,
      'feature-flags': 1,
      leads: 1,
      'system-services': 1,
      docs: 1,
      billing: 1,
      settings: 1,
      'super-admin': 1,
      create: 1,
    } satisfies Record<NavIconName, 1>;
    const names = Object.keys(ICON_KEYS) as NavIconName[];
    for (const n of names) {
      const svg = render(n);
      expect(svg).withContext(`${n} has an <svg>`).toBeTruthy();
      expect(svg.querySelectorAll('path, rect, circle, line, polyline, polygon').length)
        .withContext(`${n} draws at least one shape`)
        .toBeGreaterThan(0);
    }
  });

  it('defaults to the 18px sidebar optical weight', () => {
    const svg = render('dashboard');
    expect(svg.getAttribute('width')).toBe('18');
    expect(svg.getAttribute('height')).toBe('18');
  });

  it('honours a custom size', () => {
    const svg = render('settings', 24);
    expect(svg.getAttribute('width')).toBe('24');
    expect(svg.getAttribute('height')).toBe('24');
  });

  it('inherits colour via currentColor (so nav-item states tint it)', () => {
    const svg = render('voice');
    expect(svg.getAttribute('stroke')).toBe('currentColor');
  });

  it('is aria-hidden (decorative — the link text/label is the accessible name)', () => {
    const fixture = TestBed.createComponent(NavIconComponent);
    fixture.componentRef.setInput('name', 'apps');
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).getAttribute('aria-hidden')).toBe('true');
  });
});
