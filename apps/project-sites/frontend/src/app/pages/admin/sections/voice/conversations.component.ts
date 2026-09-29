/**
 * Voice → Conversations tab.
 *
 * @remarks
 * Unified time-based feed of calls + SMS. Newest first, grouped by relative
 * day. Click a row → side-panel with audio player, video player (when the
 * agent used video browse), transcript view, summary, sentiment, escalation
 * flags. Filter by phone / date range / channel / only-escalated. Cursor
 * pagination via `?since=`. Live poll every 30s, pauses when tab hidden.
 *
 * Endpoint contract (sibling agent owns):
 *   GET  /api/voice/conversations?siteId=…&since=…&channel=…&q=…
 *   GET  /api/voice/conversations/:id   → full record incl. transcript JSON
 *
 * @example
 * ```html
 * <app-voice-conversations />
 * ```
 */
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  type OnDestroy,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AdminStateService } from '../../admin-state.service';
import { ApiService } from '../../../../services/api.service';
import { ToastService } from '../../../../services/toast.service';
import { RevealOnScrollDirective } from '../../../../animations/reveal-on-scroll.directive';
import { RollingCounterComponent } from '../../../../components/rolling-counter/rolling-counter.component';
import { SidePanelComponent } from '../../../../components/side-panel/side-panel.component';
import { EmptyStateComponent } from '../../empty-state.component';
import { ErrorCardComponent } from '../../../../components/states';
import { HlmInputDirective, HlmSelectDirective } from '../../../../ui';

interface TranscriptTurn {
  speaker: 'caller' | 'agent';
  text: string;
  t_ms: number;
}

interface Conversation {
  id: string;
  channel: 'call' | 'sms';
  from_number: string;
  to_number: string;
  started_at: string;
  duration_s?: number;
  message_preview?: string;
  status: 'completed' | 'in-progress' | 'missed' | 'escalated' | 'failed';
  sentiment?: 'positive' | 'neutral' | 'negative';
  has_recording?: boolean;
  has_video?: boolean;
  transcript?: TranscriptTurn[];
  summary?: string;
  escalation_reason?: string;
}

type DayGroup = { label: string; items: Conversation[] };

@Component({
  selector: 'app-voice-conversations',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, DatePipe, RevealOnScrollDirective, RollingCounterComponent, SidePanelComponent, EmptyStateComponent, ErrorCardComponent, HlmInputDirective, HlmSelectDirective],
  template: `
    <section class="space-y-5" psReveal>
      <!-- Stat strip -->
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3" psReveal>
        <article class="stat-card">
          <span class="kicker">This week</span>
          <strong class="stat-num"><app-rolling-counter [value]="weekStats().calls" /></strong>
          <span class="muted-help">Calls answered</span>
        </article>
        <article class="stat-card">
          <span class="kicker">This week</span>
          <strong class="stat-num"><app-rolling-counter [value]="weekStats().sms" /></strong>
          <span class="muted-help">SMS conversations</span>
        </article>
        <article class="stat-card">
          <span class="kicker">Escalated</span>
          <strong class="stat-num"><app-rolling-counter [value]="weekStats().escalated" /></strong>
          <span class="muted-help">Needed human review</span>
        </article>
        <article class="stat-card">
          <span class="kicker">Top caller</span>
          @if (topCallerRaw()) {
            <a class="stat-num text-base truncate stat-tel" [href]="'tel:' + telHref(topCallerRaw())"
               [title]="'Call ' + topCaller()" [attr.aria-label]="'Call top caller ' + topCaller()">{{ topCaller() }}</a>
          } @else {
            <strong class="stat-num text-base">—</strong>
          }
          <span class="muted-help">{{ topCallerCount() }} touchpoints</span>
        </article>
      </div>

      <!-- Filter bar -->
      <article class="card" psReveal>
        <div class="filter-row">
          <label class="flex-1 min-w-[180px]">
            <span class="sr-only">Search phone or text</span>
            <input hlmInput class="w-full font-mono min-h-[40px]"
                   type="search"
                   [ngModel]="searchQ()"
                   (ngModelChange)="searchQ.set($event)"
                   placeholder="Search phone or text"
                   aria-label="Search conversations" />
          </label>
          <select hlmSelect class="font-mono min-h-[40px]" [ngModel]="channelFilter()" (ngModelChange)="channelFilter.set($event)" aria-label="Channel">
            <option value="all">All channels</option>
            <option value="call">Calls</option>
            <option value="sms">SMS</option>
          </select>
          <label class="ck">
            <input type="checkbox" [ngModel]="escalatedOnly()" (ngModelChange)="escalatedOnly.set($event)" />
            <span>Escalated only</span>
          </label>
          <!-- Live-sync affordance (no manual Refresh — the feed self-updates every 30s,
               visibility-aware). Mirrors the feature-flags/analytics "always live" pattern
               per real-time-data-no-manual-refresh. -->
          <span class="conv-synced" role="status" aria-live="off" data-testid="conversations-synced"
                [attr.title]="'Auto-refreshes every 30 seconds. ' + syncedLabel()">
            <span class="conv-synced-dot" aria-hidden="true"></span>
            <span>{{ syncedLabel() }}</span>
          </span>
        </div>
      </article>

      <!-- Timeline -->
      @if (loading() && filtered().length === 0) {
        <div class="space-y-2" aria-busy="true">
          @for (i of [0,1,2,3,4]; track i) { <div class="skel h-14 rounded-md"></div> }
        </div>
      } @else if (loadError() && conversations().length === 0) {
        <app-error-card
          title="Couldn't load conversations"
          [message]="loadError()!"
          (retry)="refresh()"
          data-testid="conversations-error" />
      } @else if (filterNoMatch()) {
        <app-empty-state
          icon="🔍"
          title="No conversations match your filters"
          body="Try a different search term or channel — your calls are still here."
          primary="Clear filters"
          (primaryClick)="clearFilters()"
        />
      } @else if (filtered().length === 0) {
        <app-empty-state
          icon="💬"
          title="No conversations yet"
          body="Share your phone number on the Share tab — the moment a caller dials, this feed lights up."
        />
      } @else {
        @for (g of grouped(); track g.label) {
          <section class="space-y-2" psReveal>
            <h4 class="group-label">{{ g.label }}</h4>
            <ul class="grid gap-2" role="list">
              @for (c of g.items; track c.id) {
                <li class="conv-row" role="listitem"
                    tabindex="0"
                    (click)="openDetail(c)"
                    (keydown.enter)="openDetail(c)"
                    (keydown.space)="openDetail(c); $event.preventDefault()">
                  <span class="ch-icon" [attr.aria-label]="c.channel">
                    {{ c.channel === 'call' ? '📞' : '💬' }}
                  </span>
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2 flex-wrap">
                      <strong class="text-white">{{ format(c.from_number) }}</strong>
                      @if (c.sentiment) {
                        <span class="sent-chip"
                              [class.sent-pos]="c.sentiment === 'positive'"
                              [class.sent-neu]="c.sentiment === 'neutral'"
                              [class.sent-neg]="c.sentiment === 'negative'"
                              [attr.aria-label]="'Sentiment: ' + c.sentiment">
                          {{ c.sentiment }}
                        </span>
                      }
                      <span class="status-chip is-{{ c.status }}">{{ statusLabel(c.status) }}</span>
                      @if (c.has_recording) { <span class="rec-badge" title="Recording available">REC</span> }
                      @if (c.has_video) { <span class="rec-badge" title="Video browse available">VID</span> }
                    </div>
                    <div class="text-[0.72rem] text-text-secondary mt-1 line-clamp-1">
                      {{ c.message_preview || (c.channel === 'call' ? formatDuration(c.duration_s) : '—') }}
                    </div>
                  </div>
                  <time class="text-[0.65rem] text-text-secondary whitespace-nowrap">{{ c.started_at | date:'shortTime' }}</time>
                </li>
              }
            </ul>
          </section>
        }
      }
    </section>

    <!-- Detail panel -->
    <app-side-panel [open]="!!detail()" [widthFraction]="0.55" ariaLabel="Conversation detail" (closed)="closeDetail()">
      <span panelTitle>
        @if (detail(); as d) {
          <a class="stat-tel" [href]="'tel:' + telHref(d.from_number)"
             [title]="'Call ' + format(d.from_number)" [attr.aria-label]="'Call ' + format(d.from_number)">{{ format(d.from_number) }}</a>
        }
      </span>
      <span panelSubtitle>
        @if (detail()) {
          {{ detail()!.channel }} · {{ detail()!.started_at | date:'medium' }}
          @if (detail()!.duration_s) { · {{ formatDuration(detail()!.duration_s) }} }
        }
      </span>

      @if (detail(); as d) {
        <div class="space-y-4">
          @if (d.summary) {
            <div class="panel-block">
              <h5 class="block-h">Summary</h5>
              <p class="text-[0.85rem] leading-relaxed">{{ d.summary }}</p>
            </div>
          }

          @if (d.escalation_reason) {
            <div class="panel-block escalation">
              <h5 class="block-h">⚠ Escalation</h5>
              <p class="text-[0.85rem] leading-relaxed">{{ d.escalation_reason }}</p>
            </div>
          }

          @if (audioUrl(); as au) {
            <div class="panel-block">
              <h5 class="block-h">Recording</h5>
              <audio controls preload="metadata" class="w-full" [src]="au"></audio>
            </div>
          } @else if (d.has_recording) {
            <div class="panel-block">
              <h5 class="block-h">Recording</h5>
              <p class="muted-help">Loading audio…</p>
            </div>
          }

          @if (videoUrl(); as vu) {
            <div class="panel-block">
              <h5 class="block-h">Video browse session</h5>
              <video controls preload="metadata" class="w-full rounded-md" [src]="vu"></video>
            </div>
          } @else if (d.has_video) {
            <div class="panel-block">
              <h5 class="block-h">Video browse session</h5>
              <p class="muted-help">Loading video…</p>
            </div>
          }

          @if (d.transcript && d.transcript.length) {
            <div class="panel-block">
              <h5 class="block-h">Transcript</h5>
              <div class="transcript">
                @for (t of d.transcript; track $index) {
                  <div class="t-turn" [class.t-agent]="t.speaker === 'agent'">
                    <span class="t-speaker">{{ t.speaker === 'agent' ? 'AI' : 'Caller' }}</span>
                    <span class="t-time">{{ msToClock(t.t_ms) }}</span>
                    <p class="t-text">{{ t.text }}</p>
                  </div>
                }
              </div>
            </div>
          }

          <div class="flex flex-wrap gap-2">
            <button class="btn-ghost text-xs" type="button" (click)="download(d, 'mp3')" [disabled]="!d.has_recording">Download MP3</button>
            <button class="btn-ghost text-xs" type="button" (click)="download(d, 'mp4')" [disabled]="!d.has_video">Download MP4</button>
            <button class="btn-ghost text-xs" type="button" (click)="download(d, 'txt')">Transcript (TXT)</button>
            <button class="btn-ghost text-xs" type="button" (click)="download(d, 'vtt')">Subtitles (VTT)</button>
          </div>
        </div>
      }
    </app-side-panel>
  `,
  styles: [`
    :host { display: block; }
    .kicker { font: 700 0.6rem/1 'JetBrains Mono', ui-monospace, monospace; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ps-accent, #00E5FF); opacity: 0.85; }
    .muted-help { font-size: 0.7rem; color: rgba(255,255,255,0.55); }
    .card, .stat-card {
      background: var(--ps-surface-1, rgba(13,13,40,0.62));
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: var(--ps-radius-lg, 14px);
      padding: 1rem 1.1rem;
    }
    .stat-card { display: flex; flex-direction: column; gap: 0.25rem; }
    .stat-num { font: 700 1.5rem 'Sora', system-ui, sans-serif; color: #fff; letter-spacing: -0.03em; }
    /* Top-caller click-to-call: cyan link, max-width so the number truncates inside the card. */
    a.stat-tel { display: block; max-width: 100%; color: var(--ps-accent, #00e5ff); text-decoration: none; transition: color .15s ease; }
    a.stat-tel:hover { text-decoration: underline; }
    a.stat-tel:focus-visible { outline: 2px solid var(--ps-accent, #00e5ff); outline-offset: 3px; border-radius: 4px; }

    .filter-row { display: flex; gap: 0.6rem; flex-wrap: wrap; align-items: center; }
    /* .input-field removed — search input + channel select now use hlmInput
       (mono + 40px preserved via font-mono min-h-[40px] Tailwind). */
    .ck { display: inline-flex; align-items: center; gap: 6px; font-size: 0.74rem; color: rgba(255,255,255,0.78); cursor: pointer; }

    /* Quiet live-sync chip (replaces the manual Refresh button) — a pulsing dot +
       "Synced · updated Ns ago". Freshness is visible but never gated behind a click. */
    .conv-synced { margin-left: auto; display: inline-flex; align-items: center; gap: 0.4rem; font: 600 0.66rem 'JetBrains Mono', ui-monospace, monospace; letter-spacing: 0.06em; text-transform: uppercase; color: rgba(255,255,255,0.58); }
    .conv-synced-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ps-success, #4dffb5); flex: none; animation: conv-pulse 2.4s ease-out infinite; }
    @keyframes conv-pulse { 0% { box-shadow: 0 0 0 0 color-mix(in oklch, var(--ps-success, #4dffb5) 55%, transparent); } 70% { box-shadow: 0 0 0 6px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
    @media (prefers-reduced-motion: reduce) { .conv-synced-dot { animation: none; } }

    .group-label {
      font: 600 0.66rem 'JetBrains Mono', ui-monospace, monospace;
      text-transform: uppercase; letter-spacing: 0.12em;
      color: rgba(255,255,255,0.5);
      margin: 0;
    }
    .conv-row {
      display: flex; align-items: center; gap: 0.75rem;
      padding: 0.7rem 0.9rem;
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: var(--ps-radius-sm, 10px);
      background: rgba(255,255,255,0.02);
      cursor: pointer; min-height: 56px;
      transition: border-color 160ms ease, background 160ms ease, transform 160ms ease;
    }
    .conv-row:hover, .conv-row:focus-visible {
      border-color: color-mix(in oklch, var(--ps-accent, #00E5FF) 36%, transparent);
      background: rgba(0,229,255,0.04);
      transform: translateX(2px);
      outline: none;
    }
    .ch-icon { font-size: 1.2rem; line-height: 1; flex-shrink: 0; }

    .sent-chip {
      padding: 1px 7px; border-radius: 999px;
      font: 600 0.62rem 'JetBrains Mono', ui-monospace, monospace;
      text-transform: uppercase; letter-spacing: 0.06em;
    }
    .sent-pos { background: rgba(52,211,153,0.14); color: #86efac; border: 1px solid rgba(52,211,153,0.35); }
    .sent-neu { background: rgba(251,191,36,0.12); color: #fde68a; border: 1px solid rgba(251,191,36,0.32); }
    .sent-neg { background: rgba(248,113,113,0.14); color: #fecaca; border: 1px solid rgba(248,113,113,0.32); }

    .status-chip {
      padding: 1px 7px; border-radius: 999px;
      font: 600 0.62rem 'JetBrains Mono', ui-monospace, monospace;
      text-transform: uppercase; letter-spacing: 0.06em;
      background: rgba(255,255,255,0.04); color: rgba(255,255,255,0.7); border: 1px solid rgba(255,255,255,0.08);
    }
    .status-chip.is-completed { background: rgba(52,211,153,0.10); color: #86efac; border-color: rgba(52,211,153,0.3); }
    .status-chip.is-in-progress { background: rgba(0,229,255,0.10); color: var(--ps-accent,#00e5ff); border-color: rgba(0,229,255,0.32); }
    .status-chip.is-escalated { background: rgba(251,191,36,0.10); color: #fde68a; border-color: rgba(251,191,36,0.3); }
    .status-chip.is-missed, .status-chip.is-failed { background: rgba(248,113,113,0.10); color: #fecaca; border-color: rgba(248,113,113,0.3); }

    .rec-badge {
      padding: 1px 6px; border-radius: 4px;
      font: 700 0.58rem 'JetBrains Mono', ui-monospace, monospace; letter-spacing: 0.1em;
      background: rgba(0,229,255,0.12); color: var(--ps-accent, #00E5FF);
      border: 1px solid rgba(0,229,255,0.3);
    }

    .panel-block {
      padding: 0.85rem 1rem;
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: var(--ps-radius-sm, 10px);
      background: rgba(255,255,255,0.02);
    }
    .escalation { border-color: rgba(251,191,36,0.32); background: rgba(251,191,36,0.04); }
    .block-h { font: 600 0.7rem 'JetBrains Mono', ui-monospace, monospace; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ps-accent, #00E5FF); margin: 0 0 0.5rem; }

    .transcript { display: flex; flex-direction: column; gap: 0.4rem; max-height: 360px; overflow-y: auto; }
    .t-turn {
      padding: 0.6rem 0.75rem;
      border-radius: var(--ps-radius-sm, 8px);
      background: rgba(255,255,255,0.025);
    }
    .t-turn.t-agent { background: rgba(0,229,255,0.05); }
    .t-speaker { font: 600 0.62rem 'JetBrains Mono', ui-monospace, monospace; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ps-accent, #00E5FF); }
    .t-time { font: 500 0.6rem 'JetBrains Mono', ui-monospace, monospace; color: rgba(255,255,255,0.45); margin-left: 8px; }
    .t-text { font-size: 0.84rem; line-height: 1.5; margin: 4px 0 0; color: rgba(255,255,255,0.9); }

    .btn-ghost { padding: 0.4rem 0.75rem; border-radius: var(--ps-radius-sm, 8px); background: rgba(255,255,255,0.04); color: #fff; border: 1px solid rgba(255,255,255,0.1); cursor: pointer; min-height: 36px; font-weight: 600; }
    .btn-ghost:hover:not(:disabled) { background: rgba(255,255,255,0.09); }
    .btn-ghost:disabled { opacity: 0.4; cursor: not-allowed; }
    button:focus-visible { outline: 2px solid var(--ps-accent, #00E5FF); outline-offset: 2px; }

    .skel { background: rgba(255,255,255,0.04); border-radius: 6px; position: relative; overflow: hidden; }
    .skel::after { content: ""; position: absolute; inset: 0; background: linear-gradient(90deg, transparent, rgba(255,255,255,0.06), transparent); background-size: 200% 100%; animation: shine 1.6s linear infinite; }
    @keyframes shine { from { background-position: 200% 0; } to { background-position: -200% 0; } }
    @media (prefers-reduced-motion: reduce) {
      .skel::after, .conv-row { animation: none !important; transition: none !important; transform: none !important; }
    }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); border: 0; }
    .line-clamp-1 { overflow: hidden; display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; }
  `],
})
export class VoiceConversationsComponent implements OnDestroy {
  readonly state = inject(AdminStateService);
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);

  conversations = signal<Conversation[]>([]);
  loading = signal(true);
  /** Set when the feed fetch fails so a load error shows a Retry card — never a fake "No conversations yet" (which hides real calls behind a silent failure). */
  loadError = signal<string | null>(null);
  detail = signal<Conversation | null>(null);

  /**
   * Object URLs for authed-blob media playback. A plain `<audio src="/api/…">` /
   * `<video src>` can't carry the `Authorization: Bearer` header (auth is bearer-only),
   * so those would 401 — we fetch the recording as a blob and bind an object URL
   * instead. Revoked on detail-change / close / destroy to avoid leaks.
   */
  audioUrl = signal<string | null>(null);
  videoUrl = signal<string | null>(null);

  // Signals (not plain props) so the list re-filters LIVE on keystroke and a
  // Clear button that resets them actually updates the view (a `computed`
  // doesn't react to plain-property mutation).
  searchQ = signal('');
  channelFilter = signal<'all' | 'call' | 'sms'>('all');
  escalatedOnly = signal(false);

  private pollTimer?: ReturnType<typeof setInterval>;
  private tickTimer?: ReturnType<typeof setInterval>;
  private visibilityHandler = (): void => {
    if (document.hidden) { this.stopPolling(); }
    else { this.startPolling(); this.refresh(); }
  };

  /**
   * Live-sync affordance state (per real-time-data-no-manual-refresh). The feed
   * self-updates on the visibility-aware 30s poll — no manual Refresh button.
   * `lastSynced` is stamped on every successful load; `nowTick` ticks each second
   * so the "updated Ns ago" label stays live without spamming change detection.
   */
  private readonly lastSynced = signal<number | null>(null);
  private readonly nowTick = signal<number>(Date.now());

  /** Human "Synced · updated Ns ago" — recomputes each 1s tick off lastSynced. */
  readonly syncedLabel = computed<string>(() => {
    const ts = this.lastSynced();
    if (ts === null) return 'Syncing…';
    const secs = Math.max(0, Math.round((this.nowTick() - ts) / 1000));
    if (secs < 5) return 'Synced · just now';
    if (secs < 60) return `Synced · updated ${secs}s ago`;
    const mins = Math.floor(secs / 60);
    return `Synced · updated ${mins}m ago`;
  });

  filtered = computed(() => {
    const q = this.searchQ().toLowerCase().trim();
    const channel = this.channelFilter();
    const escalatedOnly = this.escalatedOnly();
    return this.conversations().filter((c) => {
      if (channel !== 'all' && c.channel !== channel) return false;
      if (escalatedOnly && c.status !== 'escalated') return false;
      if (q) {
        const blob = `${c.from_number} ${c.message_preview ?? ''} ${c.summary ?? ''}`.toLowerCase();
        if (!blob.includes(q)) return false;
      }
      return true;
    });
  });

  /** True when calls EXIST but the active filter hides them all — so the empty
   *  state reads "no match" + offers Clear, never a misleading "No conversations yet". */
  readonly filterNoMatch = computed(() => this.conversations().length > 0 && this.filtered().length === 0);

  /** Reset every filter so the full feed returns (signal-reactive → updates live). */
  clearFilters(): void {
    this.searchQ.set('');
    this.channelFilter.set('all');
    this.escalatedOnly.set(false);
  }

  grouped = computed<DayGroup[]>(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const ystr = new Date(today); ystr.setDate(today.getDate() - 1);
    const weekAgo = new Date(today); weekAgo.setDate(today.getDate() - 7);
    const buckets: Record<string, Conversation[]> = { Today: [], Yesterday: [], 'This week': [], Earlier: [] };
    for (const c of this.filtered()) {
      const d = new Date(c.started_at);
      if (d >= today) buckets['Today'].push(c);
      else if (d >= ystr) buckets['Yesterday'].push(c);
      else if (d >= weekAgo) buckets['This week'].push(c);
      else buckets['Earlier'].push(c);
    }
    return (['Today', 'Yesterday', 'This week', 'Earlier'] as const)
      .filter((k) => buckets[k].length > 0)
      .map((k) => ({ label: k, items: buckets[k] }));
  });

  weekStats = computed(() => {
    const weekAgo = Date.now() - 7 * 86_400_000;
    let calls = 0, sms = 0, escalated = 0;
    for (const c of this.conversations()) {
      if (new Date(c.started_at).getTime() < weekAgo) continue;
      if (c.channel === 'call') calls++; else sms++;
      if (c.status === 'escalated') escalated++;
    }
    return { calls, sms, escalated };
  });

  /** Formatted most-frequent number for display (matches the conversation list). */
  topCaller = computed(() => { const e = this.topCallerEntry(); return e ? this.format(e[0]) : ''; });
  /** Raw E.164 of the top caller — kept dialable for the click-to-call tel: link. */
  topCallerRaw = computed(() => this.topCallerEntry()?.[0] ?? '');
  topCallerCount = computed(() => this.topCallerEntry()?.[1] || 0);
  private topCallerEntry = computed<[string, number] | null>(() => {
    const counts = new Map<string, number>();
    for (const c of this.conversations()) {
      counts.set(c.from_number, (counts.get(c.from_number) ?? 0) + 1);
    }
    let best: [string, number] | null = null;
    for (const e of counts.entries()) {
      // Store the RAW number (not the formatted string) so the tel: href stays dialable.
      if (!best || e[1] > best[1]) best = [e[0], e[1]];
    }
    return best;
  });

  /** Reduce a (possibly formatted) number to a dialable tel: target — keep digits + a leading +. */
  telHref(raw: string): string {
    return raw.replace(/[^\d+]/g, '');
  }

  /** Display label for a conversation status — hyphenated keys spaced (the chip CSS uppercases). */
  statusLabel(status: string): string {
    return status.replace(/-/g, ' ');
  }

  private readonly siteEffect = effect(() => {
    const site = this.state.selectedSite();
    if (!site) return;
    this.refresh();
    this.startPolling();
  });

  constructor() {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.visibilityHandler);
    }
  }

  ngOnDestroy(): void {
    this.stopPolling();
    this.clearMedia();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.visibilityHandler);
  }

  refresh(): void {
    const site = this.state.selectedSite();
    if (!site) return;
    this.loading.set(true);
    this.loadError.set(null);
    // Worker GET /api/voice/conversations returns { items } of RAW merged
    // voice_calls + voice_messages rows (aliased to a common { kind, event_at }
    // for merge-sorting) — NOT { data } in the Conversation shape. Reading r.data
    // left the feed empty ("No conversations yet") even with real calls; map the
    // raw rows → Conversation so it populates correctly.
    this.api.get<{ items: Record<string, unknown>[] }>(`/voice/conversations?siteId=${site.id}`, undefined, { silent: true }).subscribe({
      next: (r) => {
        this.conversations.set((r.items ?? []).map((row) => this.mapConversation(row)));
        this.loadError.set(null);
        this.loading.set(false);
        // Stamp the live-sync clock only on a successful load (drives "updated Ns ago").
        this.lastSynced.set(Date.now());
        this.nowTick.set(Date.now());
      },
      // Keep any already-loaded calls on a transient poll blip; surface a Retry
      // card (not a fake "No conversations yet") when there's nothing to show.
      error: () => { this.loading.set(false); this.loadError.set('The conversation feed did not respond.'); },
    });
  }

  /**
   * Map a raw merged conversation row (voice_calls / voice_messages, exactly as
   * the worker returns them) to the {@link Conversation} view-model. The worker
   * aliases both tables to a common `{ kind, event_at }` for merge-sorting; the
   * UI needs `channel` / `started_at` / `message_preview` / `duration_s`.
   * @example mapConversation({ id: 'c1', kind: 'sms', event_at: '2026-08-03T…', body: 'hi' })
   *   // → { id: 'c1', channel: 'sms', started_at: '2026-08-03T…', message_preview: 'hi', … }
   */
  private mapConversation(row: Record<string, unknown>): Conversation {
    const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
    return {
      id: String(row['id'] ?? ''),
      channel: row['kind'] === 'sms' ? 'sms' : 'call',
      from_number: String(row['from_number'] ?? ''),
      to_number: String(row['to_number'] ?? ''),
      started_at: String(row['event_at'] ?? ''),
      duration_s: num(row['duration_seconds']),
      message_preview: str(row['body']),
      status: (str(row['status']) as Conversation['status']) ?? 'completed',
      sentiment: str(row['sentiment']) as Conversation['sentiment'] | undefined,
      summary: str(row['summary']),
    };
  }

  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => this.refresh(), 30_000);
    // Keep the "updated Ns ago" label live between reloads (cheap signal write).
    this.tickTimer = setInterval(() => this.nowTick.set(Date.now()), 1000);
  }

  private stopPolling(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = undefined; }
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = undefined; }
  }


  openDetail(c: Conversation): void {
    this.clearMedia();
    if (c.transcript) { this.detail.set(c); this.loadMedia(c); return; }
    this.api.get<{ data: Conversation }>(`/voice/conversations/${c.id}`).subscribe({
      next: (r) => { this.detail.set(r.data); this.loadMedia(r.data); },
      error: () => this.detail.set(c),
    });
  }

  closeDetail(): void { this.clearMedia(); this.detail.set(null); }

  /**
   * Fetch the call's audio/video recordings as authed blobs (only when the detail
   * reports one is present) and bind object URLs for inline playback. A plain
   * `<audio src="/api/…">` can't send the Bearer — the exact class the download()
   * fix solved — so playback must also go through an authed blob fetch.
   */
  private loadMedia(conv: Conversation): void {
    if (conv.has_recording) {
      this.api.getBlob(`/voice/conversations/${conv.id}/download.mp3`).subscribe({
        next: (b) => this.setMedia('audio', b),
        error: () => { /* ApiService already surfaced it; player stays hidden. */ },
      });
    }
    if (conv.has_video) {
      this.api.getBlob(`/voice/conversations/${conv.id}/download.mp4`).subscribe({
        next: (b) => this.setMedia('video', b),
        error: () => { /* player stays hidden */ },
      });
    }
  }

  private setMedia(kind: 'audio' | 'video', blob: Blob): void {
    const sig = kind === 'audio' ? this.audioUrl : this.videoUrl;
    const prev = sig(); if (prev) URL.revokeObjectURL(prev);
    sig.set(URL.createObjectURL(blob));
  }

  /** Revoke + clear any bound media object URLs (detail-change / close / destroy). */
  private clearMedia(): void {
    const a = this.audioUrl(); if (a) URL.revokeObjectURL(a);
    const v = this.videoUrl(); if (v) URL.revokeObjectURL(v);
    this.audioUrl.set(null);
    this.videoUrl.set(null);
  }

  /**
   * Download the chosen artifact (transcript txt/vtt, or mp3/mp4 recording).
   *
   * The worker route is bearer-authenticated, so a plain `<a download href>`
   * navigation — which can't send the `Authorization` header — would 401. We fetch
   * the bytes WITH auth via {@link ApiService.getBlob}, wrap them in an object URL,
   * click a transient link, then revoke the URL. Errors surface through the shared
   * ApiService toast; nothing else to do here.
   * @param c Conversation to download.
   * @param kind File kind — mp3, mp4, txt, or vtt.
   */
  download(c: Conversation, kind: 'mp3' | 'mp4' | 'txt' | 'vtt'): void {
    this.api.getBlob(`/voice/conversations/${c.id}/download.${kind}`).subscribe({
      next: (blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `${c.id}.${kind}`;
        document.body.appendChild(a); a.click(); a.remove();
        // Revoke on the next macrotask so the download has committed first.
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      },
      error: () => { /* ApiService already toasted the failure. */ },
    });
  }

  format(e164: string): string {
    const d = e164.replace(/[^\d]/g, '').replace(/^1/, '');
    return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : e164;
  }

  formatDuration(s?: number): string {
    if (!s && s !== 0) return '—';
    const m = Math.floor(s / 60); const ss = s % 60;
    return `${m}:${ss.toString().padStart(2, '0')}`;
  }

  msToClock(ms: number): string {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
  }
}
