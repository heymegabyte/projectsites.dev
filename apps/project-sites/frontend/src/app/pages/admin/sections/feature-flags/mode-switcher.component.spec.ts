import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FlagModeSwitcherComponent } from './mode-switcher.component';
import { type DisclosureMode } from './disclosure-mode';

/**
 * First coverage for the shared Simple/Advanced/Expert mode switcher — the
 * progressive-disclosure control embedded by BOTH control-plane layers
 * (System-Admin feature-flags + site-features). Locks the APG Tabs contract
 * (role=tab + aria-selected + roving tabindex + Arrow/Home/End) + the
 * pick→modeChange emit + the sighted hover-hint (title) parity with the
 * SR-only aria-label hint.
 */
describe('FlagModeSwitcherComponent', () => {
  let fixture: ComponentFixture<FlagModeSwitcherComponent>;
  let component: FlagModeSwitcherComponent;

  function build(mode: DisclosureMode = 'simple'): void {
    TestBed.configureTestingModule({ imports: [FlagModeSwitcherComponent] });
    fixture = TestBed.createComponent(FlagModeSwitcherComponent);
    component = fixture.componentInstance;
    component.mode = mode;
    fixture.detectChanges();
  }
  function buttons(): HTMLButtonElement[] {
    return Array.from(fixture.nativeElement.querySelectorAll('.ms-btn'));
  }
  afterEach(() => TestBed.resetTestingModule());

  it('renders 3 mode tabs with aria-selected + roving tabindex on the active one', () => {
    build('advanced');
    const btns = buttons();
    expect(btns.length).toBe(3);
    btns.forEach((b) => expect(b.getAttribute('role')).toBe('tab'));
    const advanced = fixture.nativeElement.querySelector('[data-testid="ff-mode-advanced"]') as HTMLButtonElement;
    expect(advanced.getAttribute('aria-selected')).toBe('true');
    expect(advanced.getAttribute('tabindex')).withContext('active tab is the roving tab stop').toBe('0');
    const simple = fixture.nativeElement.querySelector('[data-testid="ff-mode-simple"]') as HTMLButtonElement;
    expect(simple.getAttribute('aria-selected')).toBe('false');
    expect(simple.getAttribute('tabindex')).toBe('-1');
  });

  it('pick() emits modeChange and is a no-op when re-selecting the active mode', () => {
    build('simple');
    const emits: DisclosureMode[] = [];
    component.modeChange.subscribe((m) => emits.push(m));
    component.pick('expert');
    expect(emits).toEqual(['expert']);
    component.pick('expert'); // already active → no duplicate emit
    expect(emits).toEqual(['expert']);
  });

  it('ArrowRight/ArrowLeft/Home/End move the selection (APG roving)', () => {
    build('simple');
    const emits: DisclosureMode[] = [];
    component.modeChange.subscribe((m) => emits.push(m));
    component.onKey(new KeyboardEvent('keydown', { key: 'ArrowRight' }), 'simple');
    expect(emits.at(-1)).toBe('advanced');
    component.onKey(new KeyboardEvent('keydown', { key: 'End' }), 'advanced');
    expect(emits.at(-1)).toBe('expert');
    component.onKey(new KeyboardEvent('keydown', { key: 'ArrowRight' }), 'expert'); // wraps
    expect(emits.at(-1)).toBe('simple');
    component.onKey(new KeyboardEvent('keydown', { key: 'Home' }), 'advanced');
    expect(emits.at(-1)).toBe('simple');
  });

  // The per-mode hint ("cards + toggles" / "targeting + rollout…" / "raw + JSON…")
  // lived only in the aria-label (SR-only). Sighted users get no hover tooltip
  // explaining what each mode reveals — surface it via title too.
  it('each mode button exposes its hint as a hover title (sighted parity with the aria-label)', () => {
    build('simple');
    const btns = buttons();
    component.modes.forEach((m, i) => {
      expect(btns[i].getAttribute('title')).withContext(`${m.id} hover hint`).toBe(m.hint);
      expect(btns[i].getAttribute('aria-label')).withContext(`${m.id} SR label still carries the hint`).toContain(m.hint);
    });
  });
});
