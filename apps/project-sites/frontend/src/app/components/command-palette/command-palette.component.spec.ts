import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { Router } from '@angular/router';
import { of } from 'rxjs';
import { CommandPaletteComponent } from './command-palette.component';
import { FeatureFlagService } from '../../services/feature-flag.service';

/**
 * a11y coverage for the Cmd+K command palette — locks the APG combobox/listbox
 * wiring added 2026-06-04 so screen readers announce the highlighted command as
 * the user arrows: the input is role=combobox + aria-controls the listbox +
 * aria-activedescendant the active option (which carries the matching id).
 */
describe('CommandPaletteComponent (a11y: combobox + aria-activedescendant)', () => {
  afterEach(() => TestBed.resetTestingModule());

  function render(): { el: HTMLElement; cmp: CommandPaletteComponent } {
    TestBed.configureTestingModule({
      imports: [CommandPaletteComponent],
      providers: [
        provideNoopAnimations(),
        { provide: Router, useValue: { navigate: () => undefined, navigateByUrl: () => undefined, events: of() } },
        { provide: FeatureFlagService, useValue: { isOn: () => of(false) } },
      ],
    });
    const fx = TestBed.createComponent(CommandPaletteComponent);
    fx.detectChanges();
    return { el: fx.nativeElement as HTMLElement, cmp: fx.componentInstance };
  }

  it('the input is a combobox wired to the listbox', () => {
    const { el } = render();
    const input = el.querySelector('[data-testid="command-palette-input"]')!;
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-controls')).toBe('ps-palette-listbox');
    expect(el.querySelector('#ps-palette-listbox')?.getAttribute('role'))
      .withContext('aria-controls target exists + is the listbox')
      .toBe('listbox');
  });

  it('aria-activedescendant points at the active option, which carries the matching id', () => {
    const { el, cmp } = render();
    expect(cmp.flatItems().length).withContext('the catalog renders options').toBeGreaterThan(0);
    const input = el.querySelector('[data-testid="command-palette-input"]')!;
    const adId = input.getAttribute('aria-activedescendant');
    expect(adId).withContext('input names the active option').toBe('ps-palette-opt-0'); // activeIndex defaults to 0
    const activeOpt = el.querySelector('#' + adId);
    expect(activeOpt?.getAttribute('role')).toBe('option');
    expect(activeOpt?.getAttribute('aria-selected')).toBe('true');
  });
});

/**
 * Locks the signal `output()` migration (2026-09-24): the palette closes via the
 * `closed` emitter on Escape/backdrop/execute, and asks the shell to open the
 * shortcuts overlay via `showShortcuts`. `output()` exposes `.subscribe()` just
 * like the former `EventEmitter`, so parent bindings are unaffected.
 */
describe('CommandPaletteComponent (signal outputs)', () => {
  afterEach(() => TestBed.resetTestingModule());

  function render(): CommandPaletteComponent {
    TestBed.configureTestingModule({
      imports: [CommandPaletteComponent],
      providers: [
        provideNoopAnimations(),
        { provide: Router, useValue: { navigate: () => undefined, navigateByUrl: () => undefined, events: of() } },
        { provide: FeatureFlagService, useValue: { isOn: () => of(false) } },
      ],
    });
    const fx = TestBed.createComponent(CommandPaletteComponent);
    fx.detectChanges();
    return fx.componentInstance;
  }

  it('emits closed when Escape is pressed', () => {
    const cmp = render();
    let closed = 0;
    cmp.closed.subscribe(() => closed++);
    cmp.onKeydown({ key: 'Escape', preventDefault: () => undefined } as KeyboardEvent);
    expect(closed).toBe(1);
  });

  it('executing a showShortcuts command emits both closed and showShortcuts', () => {
    const cmp = render();
    let closed = 0;
    let shortcuts = 0;
    cmp.closed.subscribe(() => closed++);
    cmp.showShortcuts.subscribe(() => shortcuts++);
    cmp.execute({ id: 'shortcuts', label: 'Show Keyboard Shortcuts', icon: 'keyboard', action: 'showShortcuts' });
    expect(closed).toBe(1);
    expect(shortcuts).toBe(1);
  });
});
