/**
 * Global keyboard-shortcuts cheat-sheet overlay.
 *
 * @remarks
 * Single source of truth for the whole app — both the marketing surface
 * (mounted in `AppComponent`) and the admin shell (mounted in
 * `AdminComponent`) use this one component. Triggered by `?` anywhere or by
 * the "Show keyboard shortcuts" action in either command palette.
 *
 * The component exposes BOTH an `open` signal (for callers that want a
 * direct `shortcuts.open.set(true)` handle, like the admin shell) AND a
 * `closed` output (for callers that prefer `@if (showShortcuts())` plus an
 * event binding, like the global app shell). Either flow keeps the modal in
 * sync — `closed` always fires when `open` flips to false.
 *
 * @example
 * ```html
 * <app-shortcuts-overlay #shortcuts />
 * <!-- open from elsewhere -->
 * shortcuts.open.set(true);
 * ```
 */
import { Component, HostListener, output, signal, type OnDestroy, type OnInit } from '@angular/core';
import { scaleFade } from '../../animations/motion';
import { FocusTrapDirective } from '../../directives/focus-trap.directive';

interface ShortcutEntry { keys: string[]; description: string; }
interface ShortcutGroup { label: string; items: ShortcutEntry[]; }

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    label: 'Navigation',
    items: [
      { keys: ['Cmd/Ctrl', 'K'], description: 'Open command palette (everything is searchable)' },
      { keys: ['/'], description: 'Focus sidebar search' },
      { keys: ['?'], description: 'Show this cheat-sheet' },
      // These mirror the actual g-chord handler in admin.component.ts (the ONLY
      // implemented chords) — keep in sync so the cheat-sheet never advertises a
      // dead shortcut. Map: e→Editor s→Snapshots a→Analytics f→Forms l→Traces
      // c→AI Chat b→Billing v→Voice d→Domains u→User.
      { keys: ['G', 'E'], description: 'Go to Editor' },
      { keys: ['G', 'S'], description: 'Go to Snapshots' },
      { keys: ['G', 'A'], description: 'Go to Analytics' },
      { keys: ['G', 'F'], description: 'Go to Forms' },
      { keys: ['G', 'L'], description: 'Go to AI Traces' },
      { keys: ['G', 'C'], description: 'Open AI Chat' },
      { keys: ['G', 'B'], description: 'Go to Billing' },
      { keys: ['G', 'V'], description: 'Go to Voice' },
      { keys: ['G', 'D'], description: 'Go to Domains' },
      { keys: ['G', 'U'], description: 'Go to User settings' },
    ],
  },
  {
    label: 'Actions',
    items: [
      { keys: ['Cmd/Ctrl', 'S'], description: 'Save & deploy (Editor / IDE)' },
      { keys: ['Cmd/Ctrl', 'Enter'], description: 'Submit current form · Send Try-It request' },
      { keys: ['Escape'], description: 'Close palette / dialog / popover (restores focus)' },
      { keys: ['Cmd/Ctrl', '.'], description: 'Toggle theme (dark / light / system)' },
      { keys: ['Cmd/Ctrl', 'B'], description: 'Toggle sidebar' },
    ],
  },
  {
    label: 'Palette tricks',
    items: [
      { keys: ['>', 'n', 'a', 'v'], description: 'Filter palette to Navigation section' },
      { keys: ['=', '2', '+', '2'], description: 'Inline calculator (Enter copies result)' },
      { keys: ['#', '0', '0', 'E', '5', 'F', 'F'], description: 'Color converter (hex → RGB / OKLCH)' },
      { keys: ['a', 'u', 'd', 'i', 't', ':'], description: 'Live-search the audit log' },
      { keys: ['f', 'o', 'r', 'm', ':'], description: 'Live-search forms inbox' },
      { keys: ['Cmd/Ctrl', 'Enter'], description: 'Open palette result in new tab' },
      { keys: ['→'], description: 'Pin highlighted palette action' },
    ],
  },
];

@Component({
  selector: 'app-shortcuts-overlay',
  standalone: true,
  animations: [scaleFade],
  imports: [FocusTrapDirective],
  template: `
    @if (open()) {
      <div
        class="shortcuts-backdrop"
        role="dialog"
        aria-label="Keyboard shortcuts"
        aria-modal="true"
        (click)="onBackdropClick($event)"
      >
        <div @scaleFade class="shortcuts-modal" data-testid="shortcuts-overlay" [focusTrap]="open()">
          <div class="shortcuts-header">
            <h2 class="shortcuts-title">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <rect x="2" y="4" width="20" height="16" rx="2"/>
                <path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M8 16h8"/>
              </svg>
              Keyboard Shortcuts
            </h2>
            <button class="shortcuts-close" (click)="close()" aria-label="Close shortcuts">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M18 6 6 18M6 6l12 12"/>
              </svg>
            </button>
          </div>
          <div class="shortcuts-divider"></div>
          <div class="shortcuts-body">
            @for (g of groups; track g.label) {
              <section class="shortcuts-group">
                <h3 class="shortcuts-group-label">{{ g.label }}</h3>
                <div class="shortcuts-grid">
                  @for (s of g.items; track s.description) {
                    <div class="shortcut-row">
                      <span class="shortcut-desc">{{ s.description }}</span>
                      <span class="shortcut-keys">
                        @for (key of s.keys; track $index; let last = $last) {
                          <kbd class="shortcut-key">{{ key }}</kbd>
                          @if (!last) { <span class="shortcut-plus">+</span> }
                        }
                      </span>
                    </div>
                  }
                </div>
              </section>
            }
          </div>
          <div class="shortcuts-footer">
            <span>Press <kbd class="footer-kbd">?</kbd> anytime to reopen</span>
            <span class="footer-right">Press <kbd class="footer-kbd">Esc</kbd> to close</span>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    :host { display: contents; }

    @keyframes fadeInBg {
      from { opacity: 0; }
      to   { opacity: 1; }
    }
    @media (prefers-reduced-motion: reduce) {
      .shortcuts-backdrop { animation: none; }
    }

    .shortcuts-backdrop {
      position: fixed; inset: 0; z-index: 9999;
      display: flex; align-items: center; justify-content: center;
      padding: 24px;
      background: rgba(2, 2, 12, 0.72);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      animation: fadeInBg 0.15s ease;
    }
    .shortcuts-modal {
      width: 100%; max-width: 640px;
      max-height: 84vh; overflow: hidden;
      background: linear-gradient(180deg, rgba(20,20,42,0.97), rgba(10,10,28,0.97));
      border: 1px solid rgba(0, 229, 255, 0.18);
      border-radius: 16px;
      box-shadow:
        0 24px 80px rgba(0, 0, 0, 0.6),
        0 0 0 1px rgba(0, 229, 255, 0.06),
        0 0 60px rgba(0, 229, 255, 0.04);
      display: flex; flex-direction: column;
    }

    .shortcuts-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 18px 20px 14px;
    }
    .shortcuts-title {
      display: flex; align-items: center; gap: 10px;
      margin: 0; font-size: 1rem; font-weight: 600;
      color: #e8eaed;
      font-family: 'Sora', var(--font, 'Inter', sans-serif);
    }
    .shortcuts-title svg { color: rgba(0, 229, 255, 0.6); }
    .shortcuts-close {
      display: flex; align-items: center; justify-content: center;
      width: 32px; height: 32px; border-radius: 8px;
      border: none; background: transparent;
      color: rgba(255, 255, 255, 0.3); cursor: pointer;
      transition: background 0.15s, color 0.15s;
    }
    .shortcuts-close:hover {
      background: rgba(0, 229, 255, 0.08);
      color: rgba(255, 255, 255, 0.7);
    }
    .shortcuts-close:focus-visible {
      outline: 2px solid #00e5ff; outline-offset: 2px;
    }

    .shortcuts-divider {
      height: 1px;
      background: linear-gradient(90deg, transparent, rgba(0, 229, 255, 0.12), transparent);
    }

    .shortcuts-body {
      padding: 4px 20px 8px;
      overflow-y: auto;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0 24px;
    }
    @media (max-width: 560px) {
      .shortcuts-body { grid-template-columns: 1fr; }
    }
    .shortcuts-group {
      padding: 8px 0 12px;
      break-inside: avoid;
    }
    .shortcuts-group-label {
      margin: 0 0 4px;
      padding: 6px 4px;
      font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.09em; font-weight: 700;
      color: rgba(0, 229, 255, 0.7);
      font-family: 'Sora', var(--font, 'Inter', sans-serif);
    }
    .shortcuts-grid {
      display: flex; flex-direction: column; gap: 2px;
    }
    .shortcut-row {
      display: flex; align-items: center; justify-content: space-between;
      gap: 10px;
      padding: 8px 8px; border-radius: 8px;
      transition: background 0.12s;
    }
    .shortcut-row:hover { background: rgba(0, 229, 255, 0.04); }
    .shortcut-desc {
      font-size: 0.82rem; color: #c8cad0; font-weight: 500;
      flex: 1; min-width: 0;
    }
    .shortcut-keys {
      display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0;
    }
    .shortcut-key {
      display: inline-flex; align-items: center; justify-content: center;
      min-width: 22px;
      font-size: 0.7rem; font-family: ui-monospace, 'JetBrains Mono', monospace;
      padding: 2px 7px; border-radius: 5px; font-weight: 600;
      background: rgba(0, 229, 255, 0.06);
      border: 1px solid rgba(0, 229, 255, 0.18);
      border-bottom-width: 2px;
      color: rgba(0, 229, 255, 0.85);
      line-height: 1.4;
    }
    .shortcut-plus {
      font-size: 0.68rem; color: rgba(255, 255, 255, 0.25);
    }

    .shortcuts-footer {
      display: flex; align-items: center; justify-content: space-between; gap: 6px;
      padding: 12px 20px;
      border-top: 1px solid rgba(0, 229, 255, 0.06);
      background: rgba(0, 0, 0, 0.15);
      font-size: 0.72rem; color: rgba(255, 255, 255, 0.4);
    }
    .footer-right { color: rgba(255, 255, 255, 0.4); }
    .footer-kbd {
      font-size: 0.65rem; font-family: ui-monospace, monospace;
      padding: 1px 5px; border-radius: 4px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: rgba(255, 255, 255, 0.5);
    }
  `],
})
export class ShortcutsOverlayComponent implements OnInit, OnDestroy {
  /**
   * Whether the overlay is currently visible. Defaults to `true` so callers
   * that wrap the component in `@if (showShortcuts()) { <app-shortcuts-overlay /> }`
   * see it the moment it's mounted. Callers that keep the component
   * permanently mounted should listen on `(closed)` and re-mount on demand
   * — this is the canonical pattern used by `AppComponent` and `AdminComponent`.
   */
  open = signal(true);

  readonly closed = output<void>();

  readonly groups = SHORTCUT_GROUPS;

  private esc = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape' && this.open()) {
      ev.preventDefault();
      this.close();
    }
  };

  ngOnInit(): void {
    document.addEventListener('keydown', this.esc);
  }

  ngOnDestroy(): void {
    document.removeEventListener('keydown', this.esc);
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.open()) this.close();
  }

  close(): void {
    this.open.set(false);
    this.closed.emit();
  }

  onBackdropClick(event: MouseEvent): void {
    if ((event.target as HTMLElement).classList.contains('shortcuts-backdrop')) {
      this.close();
    }
  }
}
