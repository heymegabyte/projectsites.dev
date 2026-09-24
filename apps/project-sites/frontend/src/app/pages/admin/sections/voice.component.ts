/**
 * Admin → Voice section shell.
 *
 * @remarks
 * Top-level container for everything voice-related: phone number search +
 * purchase, unified conversation timeline, browser-mic test console, agent
 * system-prompt editor (with read-only immutable safety meta-prompt), MCP
 * attachment, and the Share surface. Sub-tabs are signal-driven + persisted
 * to `localStorage['voice.activeTab']` so the operator's choice survives
 * route changes and full reloads.
 *
 * @example
 * ```html
 * <app-voice />
 * ```
 */
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  type OnInit,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { AdminStateService } from '../admin-state.service';
import { RevealOnScrollDirective } from '../../../animations/reveal-on-scroll.directive';
import { RollingCounterComponent } from '../../../components/rolling-counter/rolling-counter.component';
import { VoiceNumbersComponent } from './voice/numbers.component';
import { VoiceConversationsComponent } from './voice/conversations.component';
import { VoiceInsightsComponent } from './voice/insights.component';
import { VoiceTestConsoleComponent } from './voice/test-console.component';
import { VoiceAgentSettingsComponent } from './voice/agent-settings.component';
import { VoiceMcpsComponent } from './voice/mcps.component';
import { VoiceShareComponent } from './voice/share.component';
import { EmptyStateComponent } from '../empty-state.component';

type VoiceTab = 'numbers' | 'conversations' | 'insights' | 'test' | 'agent' | 'mcps' | 'share';

interface TabSpec {
  readonly id: VoiceTab;
  readonly label: string;
  readonly hint: string;
}

const TABS: readonly TabSpec[] = [
  { id: 'numbers',       label: 'Numbers',       hint: 'Buy + manage' },
  { id: 'conversations', label: 'Conversations', hint: 'Calls + SMS feed' },
  { id: 'insights',      label: 'Insights',      hint: 'Calls at a glance' },
  { id: 'test',          label: 'Test Console',  hint: 'Call from browser' },
  { id: 'agent',         label: 'Agent',         hint: 'Prompts + voice' },
  { id: 'mcps',          label: 'MCPs',          hint: 'Tool access' },
  { id: 'share',         label: 'Share',         hint: 'Hand it out' },
];

@Component({
  selector: 'app-voice',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RevealOnScrollDirective,
    RollingCounterComponent,
    VoiceNumbersComponent,
    VoiceConversationsComponent,
    VoiceInsightsComponent,
    VoiceTestConsoleComponent,
    VoiceAgentSettingsComponent,
    VoiceMcpsComponent,
    VoiceShareComponent,
    EmptyStateComponent,
  ],
  template: `
    <div class="p-7 flex-1 overflow-y-auto animate-fade-in max-md:p-4 space-y-6" data-testid="voice-section">
      <!-- Header -->
      <header psReveal>
        <div class="kicker">Phone · SMS · Browser</div>
        <h1 class="section-h text-lg font-bold text-white m-0 mt-1 flex items-center gap-3 flex-wrap">
          Voice
          @if (state.selectedSite()) {
            <span class="header-pill" data-testid="voice-live-pill">
              <span class="header-pill-dot" aria-hidden="true"></span>
              Live for <strong class="ml-1">{{ state.selectedSite()!.business_name }}</strong>
            </span>
          }
        </h1>
        <p class="text-[0.78rem] text-text-secondary m-0 mt-1 max-w-prose leading-relaxed">
          Same AI persona that powers your web chat answers every call and text. Pick a vanity number,
          listen to recordings, tune the system prompt — without ever rewriting your agent.
        </p>
      </header>

      <!-- Surface stat strip (cyan/black) -->
      <div class="stat-strip" psReveal data-testid="voice-stat-strip">
        <span class="stat-strip-num">
          <app-rolling-counter [value]="tabsCount()" [duration]="900" />
        </span>
        <span class="stat-strip-label">control surfaces — numbers, calls, agent, MCPs &amp; more, one persona</span>
      </div>

      <!-- No-site guard -->
      @if (!state.selectedSite()) {
        <app-empty-state
          icon="📞"
          title="No site selected"
          body="Pick a site from the sidebar — every voice setting is scoped per-site."
        />
      } @else {
        <!-- Tabs -->
        <nav class="tabs" role="tablist" aria-label="Voice sections" psReveal (keydown)="onTabKey($event)">
          @for (t of tabs; track t.id) {
            <button
              type="button"
              role="tab"
              class="tab"
              [class.is-active]="activeTab() === t.id"
              [attr.aria-selected]="activeTab() === t.id"
              [attr.aria-controls]="'voice-panel-' + t.id"
              [attr.tabindex]="activeTab() === t.id ? 0 : -1"
              [attr.data-testid]="'voice-tab-' + t.id"
              [id]="'voice-tab-' + t.id"
              (click)="setTab(t.id)">
              <span class="tab-label">{{ t.label }}</span>
              <span class="tab-hint">{{ t.hint }}</span>
            </button>
          }
        </nav>

        <!-- Panels -->
        <section role="tabpanel"
                 [id]="'voice-panel-' + activeTab()"
                 [attr.aria-labelledby]="'voice-tab-' + activeTab()">
          @switch (activeTab()) {
            @case ('numbers') { <app-voice-numbers /> }
            @case ('conversations') { <app-voice-conversations /> }
            @case ('insights') { <app-voice-insights /> }
            @case ('test') { <app-voice-test-console /> }
            @case ('agent') { <app-voice-agent-settings /> }
            @case ('mcps') { <app-voice-mcps /> }
            @case ('share') { <app-voice-share /> }
          }
        </section>
      }
    </div>
  `,
  styles: [`
    :host { display: block; height: 100%; }
    .kicker { font: 700 0.62rem/1 'JetBrains Mono', ui-monospace, monospace; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ps-accent, #00E5FF); opacity: 0.85; }
    .section-h { font-family: 'Sora', system-ui, sans-serif; letter-spacing: -0.02em; }

    /* Cyan/black brand pill — replaces off-brand green. Neon-clamped ink keeps
       contrast safely above WCAG AA on the dark canvas (text-contrast rule). */
    .header-pill {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 3px 10px; border-radius: 999px;
      background: color-mix(in oklch, var(--ps-accent, #00E5FF) 12%, transparent);
      border: 1px solid color-mix(in oklch, var(--ps-accent, #00E5FF) 36%, transparent);
      color: oklch(from var(--ps-accent, #00E5FF) max(l, 0.82) max(c, 0.18) h);
      font: 600 0.65rem 'Sora', system-ui, sans-serif; letter-spacing: 0.02em;
    }
    .header-pill strong { color: oklch(from var(--ps-accent, #00E5FF) max(l, 0.88) max(c, 0.16) h); }
    .header-pill-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: var(--ps-accent, #00E5FF);
      box-shadow: 0 0 6px color-mix(in oklch, var(--ps-accent, #00E5FF) 70%, transparent);
      animation: pillpulse 2.4s ease-in-out infinite;
    }
    @keyframes pillpulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
    @media (prefers-reduced-motion: reduce) { .header-pill-dot { animation: none; } }

    /* Cyan/black surface-count stat strip */
    .stat-strip {
      display: flex; align-items: baseline; gap: 0.55rem; flex-wrap: wrap;
      padding: 0.7rem 1rem; border-radius: var(--ps-radius-lg, 14px);
      background: linear-gradient(135deg,
        color-mix(in oklch, var(--ps-accent, #00E5FF) 8%, transparent),
        var(--ps-surface-1, rgba(13,13,40,0.62)));
      border: 1px solid color-mix(in oklch, var(--ps-accent, #00E5FF) 22%, rgba(255,255,255,0.06));
    }
    .stat-strip-num {
      font: 800 1.5rem/1 'Sora', system-ui, sans-serif; font-variant-numeric: tabular-nums;
      color: oklch(from var(--ps-accent, #00E5FF) max(l, 0.8) max(c, 0.2) h);
      text-shadow: 0 1px 2px rgba(0,0,0,0.6);
    }
    .stat-strip-label { font-size: 0.78rem; color: var(--ps-ink, #f4f4ff); opacity: 0.78; }

    .tabs {
      display: flex; gap: 6px; flex-wrap: wrap;
      padding: 6px; border-radius: var(--ps-radius-lg, 14px);
      background: var(--ps-surface-1, rgba(13,13,40,0.62));
      border: 1px solid rgba(255,255,255,0.06);
    }
    .tab {
      display: flex; flex-direction: column; align-items: flex-start; gap: 1px;
      padding: 0.55rem 0.95rem;
      border-radius: var(--ps-radius-sm, 10px);
      background: transparent;
      border: 1px solid transparent;
      color: rgba(255,255,255,0.72);
      cursor: pointer;
      min-height: 44px; min-width: 110px;
      transition: background 140ms ease, color 140ms ease, border-color 140ms ease, transform 140ms ease;
    }
    .tab:hover { background: rgba(255,255,255,0.04); color: #fff; }
    .tab.is-active {
      background: rgba(0,229,255,0.10);
      color: var(--ps-accent, #00E5FF);
      border-color: rgba(0,229,255,0.32);
      box-shadow: 0 6px 24px -16px rgba(0,229,255,0.6);
    }
    .tab-label { font: 600 0.84rem 'Sora', system-ui, sans-serif; letter-spacing: -0.01em; }
    .tab-hint { font: 500 0.62rem 'JetBrains Mono', ui-monospace, monospace; color: rgba(255,255,255,0.45); letter-spacing: 0.04em; }
    .tab.is-active .tab-hint { color: color-mix(in oklch, var(--ps-accent, #00E5FF) 70%, white 30%); }
    .tab:focus-visible { outline: 2px solid var(--ps-accent, #00E5FF); outline-offset: 2px; }

    @media (prefers-reduced-motion: reduce) {
      .tab { transition: none; }
    }
  `],
})
export class VoiceComponent implements OnInit {
  readonly state = inject(AdminStateService);
  readonly tabs = TABS;
  /** Count of voice control surfaces — rendered in the cyan stat strip via
   *  `<app-rolling-counter>` (every numeric stat animates per the brand mandate). */
  readonly tabsCount = computed(() => TABS.length);

  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  activeTab = signal<VoiceTab>('numbers');

  ngOnInit(): void {
    // Deep-link: `?tab=agent` opens that sub-view (bookmarkable/shareable),
    // winning over the localStorage-remembered tab for this visit (validated;
    // unknown ignored). Falls back to the stored tab, then the 'numbers' default.
    const fromUrl = this.route.snapshot.queryParamMap.get('tab') as VoiceTab | null;
    if (fromUrl && TABS.some((t) => t.id === fromUrl)) {
      this.activeTab.set(fromUrl);
      return;
    }
    try {
      const stored = localStorage.getItem('voice.activeTab') as VoiceTab | null;
      if (stored && TABS.some((t) => t.id === stored)) this.activeTab.set(stored);
    } catch { /* private mode — ignore */ }
  }

  setTab(id: VoiceTab): void {
    // Re-selecting the already-active tab is a no-op — early-return so we don't
    // fire a redundant router.navigate() (or localStorage write). Without this,
    // clicking the active tab, pressing Home/End at a boundary, or holding an
    // arrow key while it wraps spams a replaceUrl navigation per keystroke for
    // zero state change. Same "re-entry is a no-op" instinct as a mutation
    // double-submit guard, applied to redundant navigation.
    if (id === this.activeTab()) return;
    this.activeTab.set(id);
    try { localStorage.setItem('voice.activeTab', id); } catch { /* */ }
    // Reflect in the URL so a voice sub-view is bookmarkable/shareable
    // (replaceUrl = no back-button spam; merge keeps other params; SPA no-reload).
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab: id },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  /** Left/Right arrow nav between tabs per WCAG 2.2 tab-list pattern. */
  onTabKey(ev: KeyboardEvent): void {
    // Let native browser/OS gestures win — Alt/Cmd+Left (back), Cmd+Right
    // (forward), Ctrl+arrow shortcuts. Only bare arrows drive the tablist, so
    // a keyboard user's history navigation isn't swallowed while focus is here.
    if (ev.altKey || ev.metaKey || ev.ctrlKey || ev.shiftKey) return;
    if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft' && ev.key !== 'Home' && ev.key !== 'End') return;
    ev.preventDefault();
    const ids = TABS.map((t) => t.id);
    const cur = ids.indexOf(this.activeTab());
    let next = cur;
    if (ev.key === 'ArrowRight') next = (cur + 1) % ids.length;
    else if (ev.key === 'ArrowLeft') next = (cur - 1 + ids.length) % ids.length;
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = ids.length - 1;
    this.setTab(ids[next]);
    queueMicrotask(() => {
      const el = document.getElementById(`voice-tab-${ids[next]}`);
      el?.focus();
    });
  }
}
