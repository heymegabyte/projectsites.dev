import { Component, inject, input, output, signal, computed, ElementRef, ViewChild, type AfterViewInit, type OnDestroy } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { Subject, of } from 'rxjs';
import { debounceTime, distinctUntilChanged, switchMap, catchError } from 'rxjs/operators';
import { scaleFade, listStagger } from '../../animations/motion';
import { FocusTrapDirective } from '../../directives/focus-trap.directive';
import { FeatureFlagService } from '../../services/feature-flag.service';
import { ApiService } from '../../services/api.service';

/** localStorage key holding the per-command execution tally that drives the
 *  "Predicted" Cmd+K group: `{ [commandId]: { n: count, last: epochMs } }`. */
const CMD_FREQ_KEY = 'ps_cmd_freq';

export interface PaletteCommand {
  id: string;
  label: string;
  icon: string;
  route?: string;
  action?: string;
  /** External/site URL for AI "smart" results (opened in a new tab). */
  url?: string;
  /** Optional context line shown under smart results (e.g. "Docs · AutoRAG"). */
  detail?: string;
}

const COMMANDS: PaletteCommand[] = [
  { id: 'home', label: 'Go to Homepage', icon: 'home', route: '/' },
  { id: 'search', label: 'Search for a Business', icon: 'search', route: '/search' },
  { id: 'create', label: 'Create New Site', icon: 'plus', route: '/create' },
  { id: 'admin', label: 'Open Dashboard', icon: 'dashboard', route: '/admin' },
  { id: 'editor', label: 'Open Editor', icon: 'edit', route: '/admin/editor' },
  { id: 'billing', label: 'Manage Billing', icon: 'billing', route: '/admin/billing' },
  { id: 'settings', label: 'Open Settings', icon: 'settings', route: '/admin/settings' },
  { id: 'shortcuts', label: 'Show Keyboard Shortcuts', icon: 'keyboard', action: 'showShortcuts' },
  { id: 'privacy', label: 'Privacy Policy', icon: 'lock', route: '/privacy' },
  { id: 'terms', label: 'Terms of Service', icon: 'document', route: '/terms' },
];

@Component({
  selector: 'app-command-palette',
  standalone: true,
  imports: [FocusTrapDirective],
  animations: [scaleFade, listStagger],
  template: `
    <div
      class="palette-backdrop"
      role="dialog"
      aria-label="Command palette"
      aria-modal="true"
      [focusTrap]="true"
      (click)="onBackdropClick($event)"
      (keydown)="onKeydown($event)"
    >
      <div @scaleFade class="palette-modal" data-testid="command-palette">
        <div class="palette-input-wrap">
          <svg class="palette-search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
          </svg>
          <input
            #searchInput
            class="palette-input"
            type="text"
            placeholder="Type a command..."
            [value]="query()"
            (input)="onInput($event)"
            autocomplete="off"
            spellcheck="false"
            role="combobox"
            aria-autocomplete="list"
            aria-controls="ps-palette-listbox"
            [attr.aria-expanded]="flatItems().length > 0"
            [attr.aria-activedescendant]="activeOptionId()"
            data-testid="command-palette-input"
          />
          <kbd class="palette-esc">esc</kbd>
        </div>
        <div class="palette-divider"></div>
        <ul id="ps-palette-listbox" class="palette-list" role="listbox" aria-label="Commands" [@listStagger]="flatItems().length">
          @if (predicted().length > 0) {
            <li class="palette-group" role="presentation" data-testid="command-predicted-header">
              <span class="palette-group-spark" [innerHTML]="getIcon('sparkle')"></span>
              Predicted
            </li>
            @for (cmd of predicted(); track cmd.id; let i = $index) {
              <li
                class="palette-item"
                [class.active]="i === activeIndex()"
                [attr.aria-selected]="i === activeIndex()"
                [id]="'ps-palette-opt-' + i"
                role="option"
                (click)="execute(cmd)"
                (mouseenter)="activeIndex.set(i)"
                [attr.data-testid]="'command-pred-' + cmd.id"
              >
                <span class="palette-item-icon" [innerHTML]="getIcon(cmd.icon)"></span>
                <span class="palette-item-label">{{ cmd.label }}</span>
                @if (cmd.route) {
                  <span class="palette-item-hint">{{ cmd.route }}</span>
                }
              </li>
            }
            <li class="palette-group-sep" role="presentation" aria-hidden="true"></li>
          }
          @for (cmd of restList(); track cmd.id; let i = $index) {
            <li
              class="palette-item"
              [class.active]="(i + predicted().length) === activeIndex()"
              [attr.aria-selected]="(i + predicted().length) === activeIndex()"
              [id]="'ps-palette-opt-' + (i + predicted().length)"
              role="option"
              (click)="execute(cmd)"
              (mouseenter)="activeIndex.set(i + predicted().length)"
              [attr.data-testid]="'command-' + cmd.id"
            >
              <span class="palette-item-icon" [innerHTML]="getIcon(cmd.icon)"></span>
              <span class="palette-item-label">{{ cmd.label }}</span>
              @if (cmd.route) {
                <span class="palette-item-hint">{{ cmd.route }}</span>
              }
            </li>
          }
          <!-- AI smart results (AutoRAG + Cloudflare Search) — appended after the
               instant command matches; keyboard-navigable, opens in a new tab. -->
          @if (smartLoading() || smartResults().length > 0) {
            <li class="palette-group" role="presentation" data-testid="command-smart-header">
              <span class="palette-group-spark" [innerHTML]="getIcon('sparkle')"></span>
              Smart results
              @if (smartLoading()) { <span class="palette-smart-load">searching…</span> }
            </li>
            @for (cmd of smartResults(); track cmd.id; let i = $index) {
              <li
                class="palette-item"
                [class.active]="(i + smartOffset()) === activeIndex()"
                [attr.aria-selected]="(i + smartOffset()) === activeIndex()"
                [id]="'ps-palette-opt-' + (i + smartOffset())"
                role="option"
                (click)="execute(cmd)"
                (mouseenter)="activeIndex.set(i + smartOffset())"
                [attr.data-testid]="'command-smart-' + cmd.id"
              >
                <span class="palette-item-icon" [innerHTML]="getIcon(cmd.icon || 'sparkle')"></span>
                <span class="palette-item-label">{{ cmd.label }}</span>
                @if (cmd.detail) {
                  <span class="palette-item-hint">{{ cmd.detail }}</span>
                } @else if (cmd.route) {
                  <span class="palette-item-hint">{{ cmd.route }}</span>
                }
              </li>
            }
          }
          @if (flatItems().length === 0 && !smartLoading()) {
            <li class="palette-empty">No results — try a different search</li>
          }
        </ul>
        <div class="palette-footer">
          <span class="palette-footer-key"><kbd>&uarr;</kbd><kbd>&darr;</kbd> navigate</span>
          <span class="palette-footer-key"><kbd>&crarr;</kbd> select</span>
          <span class="palette-footer-key"><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  `,
  styles: [`
    @keyframes fadeInBg {
      from { opacity: 0; }
      to   { opacity: 1; }
    }

    .palette-backdrop {
      position: fixed; inset: 0; z-index: 9999;
      display: flex; align-items: flex-start; justify-content: center;
      padding: min(7vh, 64px) 16px;
      background: rgba(2, 2, 12, 0.78);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      animation: fadeInBg 0.15s ease;
    }
    /* Near-full-screen experience: a large panel that shows the whole catalog at
       once, then filters instantly + appends AI smart results. */
    .palette-modal {
      width: 100%; max-width: 880px;
      height: min(86vh, 820px);
      display: flex; flex-direction: column;
      background: #0d0d1a;
      border: 1px solid rgba(0, 229, 255, 0.15);
      border-radius: 16px;
      box-shadow:
        0 24px 80px rgba(0, 0, 0, 0.6),
        0 0 0 1px rgba(0, 229, 255, 0.06),
        0 0 60px rgba(0, 229, 255, 0.04);
      overflow: hidden;
    }
    @media (max-width: 640px) { .palette-backdrop { padding: 0; } .palette-modal { height: 100%; max-width: none; border-radius: 0; } }
    @media (prefers-reduced-motion: reduce) {
      .palette-backdrop { animation: none; }
    }

    /* Input area */
    .palette-input-wrap {
      display: flex; align-items: center; gap: 12px;
      padding: 14px 18px;
    }
    .palette-search-icon {
      flex-shrink: 0; color: rgba(0, 229, 255, 0.5);
    }
    .palette-input {
      flex: 1;
      background: transparent; border: none; outline: none;
      color: #e8eaed; font-size: 1rem; font-family: var(--font, 'Inter', sans-serif);
      caret-color: #00e5ff;
    }
    .palette-input::placeholder { color: rgba(255, 255, 255, 0.28); }
    .palette-esc {
      font-size: 0.65rem; font-family: var(--font, 'Inter', sans-serif);
      padding: 2px 7px; border-radius: 5px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: rgba(255, 255, 255, 0.35);
      pointer-events: none;
    }

    /* Divider */
    .palette-divider {
      height: 1px;
      background: linear-gradient(90deg, transparent, rgba(0, 229, 255, 0.12), transparent);
    }

    /* List */
    .palette-list {
      list-style: none; margin: 0; padding: 6px;
      flex: 1; min-height: 0; overflow-y: auto;
    }
    .palette-smart-load {
      margin-left: auto; font-size: 0.6rem; font-weight: 600; letter-spacing: 0.04em;
      color: rgba(0, 229, 255, 0.5); text-transform: none;
    }
    .palette-list::-webkit-scrollbar { width: 4px; }
    .palette-list::-webkit-scrollbar-track { background: transparent; }
    .palette-list::-webkit-scrollbar-thumb { background: rgba(0, 229, 255, 0.15); border-radius: 4px; }

    .palette-item {
      display: flex; align-items: center; gap: 12px;
      padding: 10px 14px; border-radius: 10px;
      cursor: pointer; transition: background 0.12s, border-color 0.12s;
      border-left: 2px solid transparent;
    }
    .palette-item:hover,
    .palette-item.active {
      background: rgba(0, 229, 255, 0.08);
      border-left-color: #00e5ff;
    }
    .palette-item-icon {
      display: flex; align-items: center; justify-content: center;
      width: 28px; height: 28px; flex-shrink: 0;
      color: rgba(0, 229, 255, 0.6);
    }
    .palette-item-icon :deep(svg) { width: 18px; height: 18px; }
    .palette-item-label {
      flex: 1; color: #e0e2e6; font-size: 0.9rem; font-weight: 500;
    }
    .palette-item.active .palette-item-label { color: #fff; }
    .palette-item-hint {
      font-size: 0.72rem; color: rgba(255, 255, 255, 0.2);
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
    }
    .palette-empty {
      padding: 24px; text-align: center;
      color: rgba(255, 255, 255, 0.25); font-size: 0.85rem;
    }

    /* Predicted group */
    .palette-group {
      display: flex; align-items: center; gap: 6px;
      padding: 8px 14px 4px;
      font-size: 0.66rem; font-weight: 700; letter-spacing: 0.08em;
      text-transform: uppercase;
      color: rgba(0, 229, 255, 0.55);
      user-select: none; pointer-events: none;
    }
    .palette-group-spark {
      display: inline-flex; align-items: center; justify-content: center;
      color: rgba(0, 229, 255, 0.7);
    }
    .palette-group-spark :deep(svg) { width: 13px; height: 13px; }
    .palette-group-sep {
      height: 1px; margin: 6px 12px;
      background: linear-gradient(90deg, transparent, rgba(0, 229, 255, 0.1), transparent);
      list-style: none; pointer-events: none;
    }

    /* Footer */
    .palette-footer {
      display: flex; align-items: center; justify-content: center; gap: 20px;
      padding: 10px 18px;
      border-top: 1px solid rgba(0, 229, 255, 0.06);
      background: rgba(0, 0, 0, 0.15);
    }
    .palette-footer-key {
      display: flex; align-items: center; gap: 5px;
      font-size: 0.7rem; color: rgba(255, 255, 255, 0.22);
    }
    .palette-footer-key kbd {
      font-size: 0.65rem; font-family: var(--font, 'Inter', sans-serif);
      padding: 1px 5px; border-radius: 4px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.08);
      color: rgba(255, 255, 255, 0.35);
      line-height: 1.4;
    }
  `],
})
export class CommandPaletteComponent implements AfterViewInit, OnDestroy {
  @ViewChild('searchInput') searchInputRef!: ElementRef<HTMLInputElement>;
  readonly closed = output<void>();
  readonly showShortcuts = output<void>();

  /** Caller-supplied commands appended to the defaults (e.g. the v2 cockpit's
   * 27 sections), so ⌘K can fuzzy-jump anywhere. Default empty → marketing
   * palette is unchanged. */
  readonly extraCommands = input<PaletteCommand[]>([]);

  private router = inject(Router);
  private flags = inject(FeatureFlagService);
  private api = inject(ApiService);

  // ── AI "smart" results (AutoRAG + Cloudflare Search), appended after the
  //    instant client-filtered commands. Debounced; degrades gracefully when
  //    the worker search endpoint isn't deployed. ──
  readonly smartResults = signal<PaletteCommand[]>([]);
  readonly smartLoading = signal(false);
  private readonly smartSubject = new Subject<string>();

  constructor() {
    this.smartSubject
      .pipe(
        debounceTime(220),
        distinctUntilChanged(),
        switchMap((q) => {
          const term = q.trim();
          if (term.length < 2) {
            this.smartLoading.set(false);
            return of({ results: [] as PaletteCommand[] });
          }
          this.smartLoading.set(true);
          return this.api
            .get<{ results?: PaletteCommand[] }>(`/search/command?q=${encodeURIComponent(term)}`)
            .pipe(catchError(() => of({ results: [] as PaletteCommand[] })));
        }),
      )
      .subscribe((res) => {
        this.smartLoading.set(false);
        const rows = Array.isArray(res?.results) ? res.results : [];
        // Namespaced ids so they never collide with command ids in keyboard nav.
        this.smartResults.set(rows.slice(0, 8).map((r, i) => ({ ...r, id: r.id || `smart-${i}` })));
      });
  }

  /** Gates the Predicted group. Flag `predicted_actions` (default off). */
  private readonly predictedEnabled = toSignal(this.flags.isOn('predicted_actions'), {
    initialValue: false,
  });

  /** Bumped after each execute so the predicted computed re-derives. */
  private readonly freqVersion = signal(0);

  query = signal('');
  activeIndex = signal(0);

  private readonly all = computed(() => [...COMMANDS, ...this.extraCommands()]);

  filtered = computed(() => {
    const q = this.query().toLowerCase().trim();
    const all = this.all();
    if (!q) return all;
    return all.filter(
      cmd => cmd.label.toLowerCase().includes(q) || (cmd.route?.toLowerCase().includes(q) ?? false)
    );
  });

  /**
   * Up to 3 likely-next commands, ranked by execution frequency × recency.
   * Empty while searching (typing filters the full list instead) or when the
   * `predicted_actions` flag is off. The current route is excluded so we never
   * "predict" where the user already is.
   */
  readonly predicted = computed<PaletteCommand[]>(() => {
    this.freqVersion(); // re-derive after an execute bumps the tally
    if (this.query().trim() || !this.predictedEnabled()) return [];
    const freq = this.readFreq();
    const here = this.router.url;
    return this.all()
      .filter(c => c.route !== here)
      .map(c => ({ c, s: this.score(freq[c.id]) }))
      .filter(x => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 3)
      .map(x => x.c);
  });

  /** The remaining commands (predicted entries removed when not searching). */
  readonly restList = computed<PaletteCommand[]>(() => {
    if (this.query().trim()) return this.filtered();
    const pid = new Set(this.predicted().map(c => c.id));
    return this.all().filter(c => !pid.has(c.id));
  });

  /** Flat keyboard-nav order: predicted first, then the rest. activeIndex
   *  indexes into this combined list. */
  readonly flatItems = computed<PaletteCommand[]>(() => [...this.predicted(), ...this.restList(), ...this.smartResults()]);

  /** Keyboard index where the smart-results group starts. */
  readonly smartOffset = computed<number>(() => this.predicted().length + this.restList().length);

  /** id of the active option for the input's aria-activedescendant — so screen
   *  readers announce the highlighted command as the user arrows (APG combobox). */
  readonly activeOptionId = computed<string | null>(() => {
    const i = this.activeIndex();
    return i >= 0 && i < this.flatItems().length ? `ps-palette-opt-${i}` : null;
  });

  /** Read the per-command tally from localStorage (defensive: {} on any error). */
  private readFreq(): Record<string, { n: number; last: number }> {
    try {
      return JSON.parse(localStorage.getItem(CMD_FREQ_KEY) || '{}') as Record<
        string,
        { n: number; last: number }
      >;
    } catch {
      return {};
    }
  }

  /** Frequency × recency score. Recency decays linearly over ~30 days to a
   *  0.2 floor so a once-loved-but-stale action still ranks below a fresh one. */
  private score(entry?: { n: number; last: number }): number {
    if (!entry || !entry.n) return 0;
    const ageDays = (Date.now() - (entry.last || 0)) / 86_400_000;
    const recency = Math.max(0.2, 1 - ageDays / 30);
    return entry.n * recency;
  }

  /** Record one execution so future predictions reflect real usage. */
  private bumpFreq(id: string): void {
    try {
      const f = this.readFreq();
      f[id] = { n: (f[id]?.n ?? 0) + 1, last: Date.now() };
      localStorage.setItem(CMD_FREQ_KEY, JSON.stringify(f));
      this.freqVersion.update(v => v + 1);
    } catch {
      /* private mode / quota — predictions just won't personalize */
    }
  }

  /** SVG icons keyed by name */
  private icons: Record<string, string> = {
    home: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>',
    search: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>',
    plus: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>',
    dashboard: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
    edit: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>',
    billing: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>',
    settings: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1.08Z"/></svg>',
    keyboard: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M8 16h8"/></svg>',
    changelog: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>',
    status: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>',
    lock: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
    document: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
    sparkle: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/></svg>',
  };

  getIcon(name: string): string {
    return this.icons[name] ?? '';
  }

  ngAfterViewInit(): void {
    // Focus the input on the next tick so the animation can settle
    setTimeout(() => this.searchInputRef?.nativeElement?.focus(), 50);
  }

  ngOnDestroy(): void {
    // Cleanup if needed
  }

  onInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.query.set(value);
    this.activeIndex.set(0);
    // Instant client filter happens via query(); kick the AI/AutoRAG enrichment.
    if (value.trim().length >= 2) {
      this.smartLoading.set(true);
    } else {
      this.smartLoading.set(false);
      this.smartResults.set([]);
    }
    this.smartSubject.next(value);
  }

  onBackdropClick(event: MouseEvent): void {
    // Only close if clicking the backdrop itself, not the modal
    if ((event.target as HTMLElement).classList.contains('palette-backdrop')) {
      this.closed.emit();
    }
  }

  onKeydown(event: KeyboardEvent): void {
    const items = this.flatItems();

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.activeIndex.update(i => (i + 1) % Math.max(items.length, 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.activeIndex.update(i => (i - 1 + items.length) % Math.max(items.length, 1));
        break;
      case 'Enter':
        event.preventDefault();
        if (items.length > 0) {
          this.execute(items[this.activeIndex()]);
        }
        break;
      case 'Escape':
        event.preventDefault();
        this.closed.emit();
        break;
    }
  }

  execute(cmd: PaletteCommand): void {
    this.bumpFreq(cmd.id); // feed the Predicted ranking with real usage
    this.closed.emit();
    if (cmd.action === 'showShortcuts') {
      this.showShortcuts.emit();
      return;
    }
    if (cmd.url) {
      window.open(cmd.url, '_blank', 'noopener,noreferrer');
      return;
    }
    if (cmd.route) {
      this.router.navigate([cmd.route]);
    }
  }
}
