import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HlmTablistDirective } from '../../../../ui';
import { type DisclosureMode } from './disclosure-mode';

/**
 * Reusable Simple / Advanced / Expert mode switcher. Both control-plane layers
 * (Feature Flags + Site Features) embed this; the owning component
 * persists the choice per-layer in localStorage and feeds it back via `mode`.
 *
 * WAI-ARIA Tabs pattern: roving tabindex + Arrow/Home/End keys + `aria-selected`.
 */
@Component({
  selector: 'app-flag-mode-switcher',
  standalone: true,
  imports: [CommonModule, HlmTablistDirective],
  template: `
    <div class="ms" role="tablist" hlmTablist [attr.aria-label]="label" data-testid="ff-mode-switcher">
      @for (m of modes; track m.id) {
        <button
          type="button"
          class="ms-btn"
          [class.ms-btn-active]="mode === m.id"
          (click)="pick(m.id)"
          (keydown)="onKey($event, m.id)"
          role="tab"
          [attr.aria-selected]="mode === m.id"
          [tabindex]="mode === m.id ? 0 : -1"
          [attr.data-testid]="'ff-mode-' + m.id"
          [attr.title]="m.hint"
          [attr.aria-label]="m.label + ' mode — ' + m.hint"
        >
          {{ m.label }}
        </button>
      }
    </div>
  `,
  styles: [`
    .ms { display: inline-flex; gap: .2rem; padding: .2rem; border-radius: 10px;
      background: color-mix(in oklch, var(--ps-bg, #060610) 60%, transparent);
      border: 1px solid color-mix(in oklch, currentColor 12%, transparent); }
    .ms-btn { background: transparent; color: inherit; border: 0; padding: .35rem .7rem; border-radius: 7px;
      cursor: pointer; font: inherit; font-size: .8rem; min-height: 24px; transition: background .12s ease; }
    .ms-btn:hover { background: color-mix(in oklch, currentColor 8%, transparent); }
    .ms-btn-active { background: var(--ps-accent, #00e5ff); color: var(--ps-bg, #060610); font-weight: 600; }
    .ms-btn-active:hover { background: var(--ps-accent, #00e5ff); }
    .ms-btn:focus-visible { outline: 2px solid var(--ps-accent, #00e5ff); outline-offset: 2px; }
  `],
})
export class FlagModeSwitcherComponent {
  @Input() mode: DisclosureMode = 'simple';
  @Input() label = 'Disclosure mode';
  @Output() modeChange = new EventEmitter<DisclosureMode>();

  readonly modes: Array<{ id: DisclosureMode; label: string; hint: string }> = [
    { id: 'simple', label: 'Simple', hint: 'cards + toggles' },
    { id: 'advanced', label: 'Advanced', hint: 'targeting + rollout + scheduling' },
    { id: 'expert', label: 'Expert', hint: 'raw key + JSON + evaluation trace' },
  ];

  pick(m: DisclosureMode): void {
    if (m === this.mode) return;
    this.mode = m;
    this.modeChange.emit(m);
  }

  onKey(event: KeyboardEvent, current: DisclosureMode): void {
    const ids = this.modes.map((m) => m.id);
    const i = ids.indexOf(current);
    let next = current;
    switch (event.key) {
      case 'ArrowRight': case 'ArrowDown': next = ids[(i + 1) % ids.length]; break;
      case 'ArrowLeft': case 'ArrowUp': next = ids[(i - 1 + ids.length) % ids.length]; break;
      case 'Home': next = ids[0]; break;
      case 'End': next = ids[ids.length - 1]; break;
      default: return;
    }
    event.preventDefault();
    this.pick(next);
    const host = event.currentTarget as HTMLElement | null;
    const btn = host?.parentElement?.querySelector<HTMLElement>(`[data-testid="ff-mode-${next}"]`);
    btn?.focus();
  }
}
