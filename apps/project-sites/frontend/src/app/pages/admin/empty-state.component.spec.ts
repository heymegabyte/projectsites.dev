import { TestBed, ComponentFixture } from '@angular/core/testing';
import { EmptyStateComponent } from './empty-state.component';

/**
 * The admin-local empty-state primitive is shared by admin sections (apps,
 * apps-instances, domains, marketplace). Bring it to a11y parity with the
 * components/states kit: the root is a status region (announces the empty
 * condition once) and the decorative icon glyph is aria-hidden (so SR users
 * don't hear the raw emoji/glyph — e.g. "▦" — before the real title).
 */
describe('AdminEmptyStateComponent (a11y parity)', () => {
  let fx: ComponentFixture<EmptyStateComponent>;
  afterEach(() => TestBed.resetTestingModule());

  function render(icon = '▦'): HTMLElement {
    TestBed.configureTestingModule({ imports: [EmptyStateComponent] });
    fx = TestBed.createComponent(EmptyStateComponent);
    fx.componentRef.setInput('icon', icon);
    fx.componentRef.setInput('title', 'No sections available');
    fx.detectChanges();
    return fx.nativeElement as HTMLElement;
  }

  it('marks the root as a status region so AT announces the empty condition', () => {
    const root = render().querySelector('.empty-state-pretty');
    expect(root?.getAttribute('role')).toBe('status');
  });

  it('marks the decorative icon glyph aria-hidden (SR skips the raw glyph)', () => {
    const glyph = render().querySelector('.empty-glyph');
    expect(glyph).not.toBeNull();
    expect(glyph?.getAttribute('aria-hidden')).toBe('true');
  });

  it('maps a colorful emoji icon to a monochrome cyan SVG (cockpit standard), not the raw emoji', () => {
    const glyph = render('📞').querySelector('.empty-glyph');
    expect(glyph?.querySelector('svg')).withContext('emoji → SVG').not.toBeNull();
    expect(glyph?.textContent?.trim()).withContext('raw emoji replaced by SVG').toBe('');
    expect(glyph?.querySelector('svg')?.getAttribute('stroke')).toBe('currentColor');
  });

  it('maps the colorful sparkles emoji (✨) to a cyan SVG, never the raw emoji (site-features)', () => {
    // ✨ is emoji-presentation by default → it would render in full color and
    // break the cyan/black cockpit. Site-features uses it for its empty state,
    // so it MUST resolve to a monochrome stroke SVG like every other emoji.
    const glyph = render('✨').querySelector('.empty-glyph');
    expect(glyph?.querySelector('svg')).withContext('✨ → SVG').not.toBeNull();
    expect(glyph?.querySelector('.empty-emoji')).withContext('no raw colorful emoji leaks').toBeNull();
    expect(glyph?.querySelector('svg')?.getAttribute('stroke')).toBe('currentColor');
  });

  it('falls through to the text glyph for an unmapped on-brand mono symbol (▦)', () => {
    const glyph = render('▦').querySelector('.empty-glyph');
    expect(glyph?.querySelector('svg')).withContext('mono symbol stays text, no SVG').toBeNull();
    expect(glyph?.querySelector('.empty-emoji')?.textContent?.trim()).toBe('▦');
  });
});

describe('AdminEmptyStateComponent (E2E testid contract — chaos-15/16 locators)', () => {
  let fx: ComponentFixture<EmptyStateComponent>;
  afterEach(() => TestBed.resetTestingModule());

  function render(): HTMLElement {
    TestBed.configureTestingModule({ imports: [EmptyStateComponent] });
    fx = TestBed.createComponent(EmptyStateComponent);
    fx.componentRef.setInput('icon', '🚀');
    fx.componentRef.setInput('title', 'No app instances yet');
    fx.componentRef.setInput('body', 'Deploy your first self-hosted app.');
    fx.componentRef.setInput('primary', 'Browse the app store');
    fx.detectChanges();
    return fx.nativeElement as HTMLElement;
  }

  it('carries the same testid contract as the components/states kit', () => {
    const root = render();
    expect(root.querySelector('[data-testid="empty-state"]')).withContext('root testid').not.toBeNull();
    expect(root.querySelector('[data-testid="empty-title"]')).withContext('title testid').not.toBeNull();
    expect(root.querySelector('[data-testid="empty-cta"]')).withContext('primary CTA testid').not.toBeNull();
  });
});

describe('AdminEmptyStateComponent (signal output + conditional CTA)', () => {
  let fx: ComponentFixture<EmptyStateComponent>;
  afterEach(() => TestBed.resetTestingModule());

  it('emits primaryClick when the CTA button is activated', () => {
    TestBed.configureTestingModule({ imports: [EmptyStateComponent] });
    fx = TestBed.createComponent(EmptyStateComponent);
    fx.componentRef.setInput('title', 'No app instances yet');
    fx.componentRef.setInput('primary', 'Browse the app store');
    fx.detectChanges();
    let fired = 0;
    fx.componentInstance.primaryClick.subscribe(() => (fired += 1));
    (fx.nativeElement as HTMLElement)
      .querySelector<HTMLButtonElement>('[data-testid="empty-cta"]')
      ?.click();
    expect(fired).withContext('primaryClick emits once per CTA click').toBe(1);
  });

  it('renders no CTA button when no primary label is provided', () => {
    TestBed.configureTestingModule({ imports: [EmptyStateComponent] });
    fx = TestBed.createComponent(EmptyStateComponent);
    fx.componentRef.setInput('title', 'Nothing to configure');
    fx.detectChanges();
    expect((fx.nativeElement as HTMLElement).querySelector('[data-testid="empty-cta"]'))
      .withContext('no CTA without a primary label')
      .toBeNull();
  });
});
