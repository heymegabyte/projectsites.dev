/**
 * Voice → Numbers tab.
 *
 * @remarks
 * Live Twilio number search (area code + word/digits), vanity-letter mapping
 * (E.164 "+18558522267" rendered as "(855) 82L-ABOR" with bolded matches), AI
 * suggestion chips for vanity words, and a capped-at-3 purchase flow.
 *
 * Endpoint contract (worker-owned, sibling agent):
 *   GET  /api/voice/numbers?siteId=…              → { data: PurchasedNumber[] }
 *   GET  /api/voice/search?siteId=…&q=…&area=…    → { data: NumberCandidate[] }
 *   GET  /api/voice/vanity-suggestions?siteId=…   → { data: VanitySuggestion[] }
 *   POST /api/voice/numbers (body { phone_number })
 *   DELETE /api/voice/numbers/:id                 → release
 *
 * @example
 * ```html
 * <app-voice-numbers />
 * ```
 */
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  signal,
  ViewChild,
  type OnDestroy,
  type OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ConfirmService } from '../../../../services/confirm.service';
import { AdminStateService } from '../../admin-state.service';
import { ApiService } from '../../../../services/api.service';
import { ToastService } from '../../../../services/toast.service';
import { RevealOnScrollDirective } from '../../../../animations/reveal-on-scroll.directive';
import { RollingCounterComponent } from '../../../../components/rolling-counter/rolling-counter.component';
import { EmptyStateComponent } from '../../empty-state.component';
import { ErrorCardComponent } from '../../../../components/states';
import { HlmInputDirective } from '../../../../ui';
import { vanityToDigits, hasVanityLetters } from '../../../../utils/vanity-keypad';

interface PurchasedNumber {
  id: string;
  phone_number: string;
  friendly_name?: string;
  capabilities: { voice: boolean; sms: boolean; mms: boolean };
  monthly_cost_usd: number;
  purchased_at: string;
}

interface NumberCandidate {
  phone_number: string;
  locality?: string;
  region?: string;
  iso_country: string;
  capabilities: { voice: boolean; sms: boolean; mms: boolean };
  monthly_cost_usd: number;
  vanity_match?: string;
}

interface VanitySuggestion {
  word: string;
  digits: string;
  rationale: string;
  score: number;
}

const MAX_NUMBERS = 3;
const LETTER_TO_DIGIT: Readonly<Record<string, string>> = Object.freeze({
  A: '2', B: '2', C: '2', D: '3', E: '3', F: '3', G: '4', H: '4', I: '4',
  J: '5', K: '5', L: '5', M: '6', N: '6', O: '6', P: '7', Q: '7', R: '7',
  S: '7', T: '8', U: '8', V: '8', W: '9', X: '9', Y: '9', Z: '9',
});

@Component({
  selector: 'app-voice-numbers',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RevealOnScrollDirective, RollingCounterComponent, EmptyStateComponent, ErrorCardComponent, HlmInputDirective],
  template: `
    <section class="space-y-6" psReveal>
      <!-- Your numbers -->
      <article class="card" psReveal>
        <header class="flex items-center justify-between flex-wrap gap-3 mb-3">
          <div>
            <div class="kicker">Phone numbers</div>
            <h2 class="section-h text-base font-bold text-white m-0 mt-1 flex items-center gap-2">
              Your numbers
              <span class="header-pill" aria-live="polite">
                <app-rolling-counter [value]="numbers().length" />
                <span aria-hidden="true">/</span>
                <app-rolling-counter [value]="MAX" />
              </span>
            </h2>
            <p class="muted-help m-0 mt-1">Up to {{ MAX }} numbers per site. Release one to free a slot.</p>
          </div>
          <div class="flex items-center gap-2 text-[0.7rem] text-text-secondary">
            <span>Monthly spend</span>
            <strong class="text-white"><app-rolling-counter prefix="$" [value]="monthlySpend()" [decimals]="2" /></strong>
          </div>
        </header>

        @if (loading() && numbers().length === 0) {
          <div class="space-y-2" aria-busy="true">
            <div class="skel h-12 rounded-md"></div>
            <div class="skel h-12 rounded-md"></div>
          </div>
        } @else if (loadError() && numbers().length === 0) {
          <app-error-card
            title="Couldn't load your numbers"
            [message]="loadError()!"
            (retry)="loadNumbers()"
            data-testid="numbers-error" />
        } @else if (numbers().length === 0) {
          <app-empty-state
            icon="📞"
            title="No numbers yet"
            body="Search a vanity word and your AI agent picks up the moment a caller dials."
            primary="Find a vanity number"
            (primaryClick)="focusSearch()"
          />
        } @else {
          <ul class="grid gap-2" role="list">
            @for (n of numbers(); track n.id) {
              <li class="num-row" role="listitem">
                <div class="min-w-0 flex-1">
                  <div class="vanity-display" [innerHTML]="vanityHtml(n.phone_number, n.friendly_name)"></div>
                  <div class="num-meta">
                    @if (n.capabilities?.voice) { <span class="cap-chip">Voice</span> }
                    @if (n.capabilities?.sms)   { <span class="cap-chip">SMS</span> }
                    @if (n.capabilities?.mms)   { <span class="cap-chip">MMS</span> }
                    <span class="cost-chip">\${{ (n.monthly_cost_usd ?? 0).toFixed(2) }}/mo</span>
                  </div>
                </div>
                <button class="btn-ghost text-xs"
                        type="button"
                        (click)="copy(n.phone_number)"
                        [attr.aria-label]="'Copy ' + n.phone_number">Copy</button>
                <button class="btn-danger-ghost"
                        type="button"
                        [disabled]="isReleasing(n.id)"
                        [attr.aria-busy]="isReleasing(n.id)"
                        (click)="release(n)"
                        [attr.aria-label]="'Release ' + n.phone_number">{{ isReleasing(n.id) ? 'Releasing…' : 'Release' }}</button>
              </li>
            }
          </ul>
        }
      </article>

      <!-- Search -->
      <article class="card" psReveal>
        <header class="mb-3">
          <div class="kicker">Find a number</div>
          <h2 class="section-h text-base font-bold text-white m-0 mt-1">Vanity + area-code search</h2>
          <p class="muted-help m-0 mt-1">Type letters or digits — letters map to the phone keypad (e.g. "CAFE" = 2233).</p>
        </header>

        <div class="search-row">
          <label class="flex-1 min-w-0">
            <span class="sr-only">Search query</span>
            <input hlmInput class="w-full font-mono min-h-[44px]"
                   #voiceSearchInput
                   type="text"
                   [(ngModel)]="query"
                   (ngModelChange)="onQueryChange($event)"
                   [placeholder]="vanityPlaceholder()"
                   aria-label="Vanity word or digits"
                   data-testid="voice-search-q" />
          </label>
          <label class="w-[120px]">
            <span class="sr-only">Area code</span>
            <input hlmInput class="w-full font-mono min-h-[44px]"
                   type="text"
                   inputmode="numeric"
                   maxlength="3"
                   [(ngModel)]="areaCode"
                   (ngModelChange)="onQueryChange(query)"
                   placeholder="855"
                   aria-label="Area code" />
          </label>
        </div>

        <!-- §17: live keypad-digit preview — surfaces the exact digits the
             contains= search resolves to, the moment the operator types a word. -->
        @if (queryDigits(); as digits) {
          <p class="keypad-preview mt-2" role="status" aria-live="polite" data-testid="voice-keypad-preview">
            <span class="keypad-preview-word">{{ queryUpper() }}</span>
            <span class="keypad-preview-eq" aria-hidden="true">=</span>
            <span class="keypad-preview-digits">{{ digits }}</span>
            <span class="sr-only"> on the phone keypad</span>
          </p>
        }

        @if (cappedNotice()) {
          <p class="notice notice-amber mt-3" role="status">
            <strong>You're at the {{ MAX }}-number cap.</strong>
            Release a number above before purchasing another.
          </p>
        }

        @if (searching()) {
          <div class="grid gap-2 mt-3" aria-busy="true">
            @for (i of [0,1,2,3]; track i) {
              <div class="skel h-14 rounded-md"></div>
            }
          </div>
        } @else if (searchResults().length > 0) {
          <ul role="listbox" aria-label="Available numbers" class="grid gap-2 mt-3">
            @for (c of searchResults(); track c.phone_number; let idx = $index) {
              <li role="option" [attr.aria-selected]="false"
                  class="result-row"
                  tabindex="0"
                  (keydown)="onResultKey($event, idx, c)">
                <div class="min-w-0 flex-1">
                  <div class="vanity-display" [innerHTML]="vanityHtml(c.phone_number, c.vanity_match)"></div>
                  <div class="num-meta">
                    @if (c.locality) { <span>{{ c.locality }}, {{ c.region }}</span> }
                    @if (c.capabilities?.voice) { <span class="cap-chip">Voice</span> }
                    @if (c.capabilities?.sms)   { <span class="cap-chip">SMS</span> }
                    <span class="cost-chip">\${{ (c.monthly_cost_usd ?? 0).toFixed(2) }}/mo</span>
                  </div>
                </div>
                <button class="btn-primary"
                        type="button"
                        [disabled]="capped() || buyingNumber() !== null"
                        [attr.aria-busy]="buyingNumber() === c.phone_number"
                        (click)="confirmBuy(c)"
                        [attr.aria-label]="'Buy ' + c.phone_number">{{ buyingNumber() === c.phone_number ? 'Buying…' : 'Buy' }}</button>
              </li>
            }
          </ul>
        } @else if (searchError(); as err) {
          <p class="notice notice-amber mt-3" role="status" data-testid="voice-search-error">
            <strong>{{ err }}</strong>
            <button class="btn-ghost text-xs ml-2 align-middle" type="button" (click)="retrySearch()">Retry</button>
          </p>
        } @else if (searchAttempted()) {
          <p class="muted-help mt-3" role="status">No numbers available for that search — try a different vanity word or area code.</p>
        }
      </article>

      <!-- AI suggestions -->
      <article class="card" psReveal>
        <header class="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div>
            <div class="kicker">AI</div>
            <h2 class="section-h text-base font-bold text-white m-0 mt-1">Suggested vanity words</h2>
            <p class="muted-help m-0 mt-1">Ranked by memorability + relevance to your business.</p>
          </div>
          <button class="btn-ghost text-xs" type="button" (click)="loadSuggestions(true)">Regenerate</button>
        </header>

        @if (suggestionsLoading()) {
          <div class="flex flex-wrap gap-2" aria-busy="true">
            @for (i of [0,1,2,3,4,5,6,7,8,9,10,11]; track i) {
              <span class="skel h-7 w-24 rounded-full"></span>
            }
          </div>
        } @else if (suggestions().length === 0) {
          <p class="muted-help">No suggestions yet — click Regenerate.</p>
        } @else {
          <div class="flex flex-wrap gap-2">
            @for (s of suggestions(); track s.word) {
              <button class="vanity-chip"
                      type="button"
                      [title]="s.rationale"
                      (click)="useSuggestion(s)"
                      (mouseenter)="speak(s.word)">
                <span class="font-bold">{{ s.word }}</span>
                <span class="text-text-secondary opacity-70 ml-1">→ {{ s.digits }}</span>
              </button>
            }
          </div>
        }
      </article>
    </section>
  `,
  styles: [`
    :host { display: block; }
    .kicker { font: 700 0.62rem/1 'JetBrains Mono', ui-monospace, monospace; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ps-accent, #00E5FF); opacity: 0.85; }
    .section-h { font-family: 'Sora', system-ui, sans-serif; letter-spacing: -0.02em; }
    .muted-help { font-size: 0.72rem; color: rgba(255,255,255,0.6); line-height: 1.5; }
    .card {
      background: var(--ps-surface-1, rgba(13,13,40,0.62));
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: var(--ps-radius-lg, 14px);
      padding: 1.2rem;
    }
    .search-row { display: flex; gap: 0.6rem; flex-wrap: wrap; }
    /* §17 keypad preview chip — cyan/black, monospace digits, tabular nums. */
    .keypad-preview { display: inline-flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;
      font: 600 0.74rem 'JetBrains Mono', ui-monospace, monospace; }
    .keypad-preview-word { color: rgba(255,255,255,0.62); letter-spacing: 0.06em; }
    .keypad-preview-eq { color: color-mix(in oklch, var(--ps-accent, #00E5FF) 55%, transparent); }
    .keypad-preview-digits { font-variant-numeric: tabular-nums; letter-spacing: 0.14em;
      color: oklch(from var(--ps-accent, #00E5FF) max(l, 0.8) max(c, 0.2) h);
      background: color-mix(in oklch, var(--ps-accent, #00E5FF) 10%, transparent);
      border: 1px solid color-mix(in oklch, var(--ps-accent, #00E5FF) 28%, transparent);
      padding: 0.05rem 0.45rem; border-radius: 6px; }
    /* .input-field removed — both search/area-code inputs now use hlmInput
       (mono + 44px tap target preserved via font-mono min-h-[44px] Tailwind). */

    .num-row, .result-row {
      display: flex; align-items: center; gap: 0.75rem;
      padding: 0.7rem 0.85rem;
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: var(--ps-radius-sm, 10px);
      background: rgba(255,255,255,0.02);
      min-height: 56px;
      transition: border-color 160ms ease, background 160ms ease, transform 160ms ease;
    }
    .result-row { cursor: pointer; }
    .result-row:hover, .result-row:focus-visible {
      border-color: color-mix(in oklch, var(--ps-accent, #00E5FF) 36%, transparent);
      background: rgba(0,229,255,0.04);
      transform: translateY(-1px);
      outline: none;
    }
    .vanity-display {
      font: 700 1.05rem 'Sora', system-ui, sans-serif;
      letter-spacing: -0.01em;
      color: var(--ps-ink, #fff);
    }
    /* vanityHtml injects <b> via [innerHTML] → needs ::ng-deep, NOT :global()
       (a CSS-Modules construct Angular leaves invalid → the rule was dead → the
       vanity match never went cyan). */
    :host ::ng-deep .vanity-display b { color: var(--ps-accent, #00E5FF); }
    .num-meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; font-size: 0.66rem; color: rgba(255,255,255,0.6); align-items: center; }
    .cap-chip, .cost-chip {
      padding: 2px 7px; border-radius: 999px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      font: 600 0.62rem 'JetBrains Mono', ui-monospace, monospace;
      letter-spacing: 0.06em;
    }
    .cost-chip { color: #a7f3d0; border-color: rgba(52,211,153,0.32); background: rgba(52,211,153,0.08); }

    .vanity-chip {
      padding: 0.45rem 0.85rem;
      border-radius: 999px;
      background: rgba(0,229,255,0.08);
      border: 1px solid rgba(0,229,255,0.24);
      color: var(--ps-ink, #fff);
      font: 500 0.74rem 'JetBrains Mono', ui-monospace, monospace;
      cursor: pointer;
      min-height: 36px;
      transition: transform 160ms ease, background 160ms ease, border-color 160ms ease;
    }
    .vanity-chip:hover { background: rgba(0,229,255,0.16); transform: translateY(-1px); border-color: rgba(0,229,255,0.5); }
    .vanity-chip:focus-visible { outline: 2px solid var(--ps-accent, #00E5FF); outline-offset: 2px; }

    .header-pill {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 3px 10px; border-radius: 999px;
      background: rgba(0,229,255,0.10);
      border: 1px solid rgba(0,229,255,0.32);
      color: var(--ps-accent, #00E5FF);
      font: 600 0.66rem 'JetBrains Mono', ui-monospace, monospace;
    }
    .notice { border-radius: var(--ps-radius-sm, 8px); padding: 0.7rem 0.9rem; font-size: 0.76rem; }
    .notice-amber { background: rgba(251,191,36,0.08); border: 1px solid rgba(251,191,36,0.32); color: #fde68a; }
    .notice-amber strong { color: #fcd34d; }

    .btn-primary, .btn-ghost, .btn-danger-ghost {
      min-height: 36px; padding: 0.45rem 0.85rem; border-radius: var(--ps-radius-sm, 8px);
      font-weight: 600; cursor: pointer; border: 1px solid transparent;
      transition: background 140ms ease, transform 140ms ease, border-color 140ms ease;
    }
    .btn-primary { background: rgba(0,229,255,0.14); color: var(--ps-accent, #00E5FF); border-color: rgba(0,229,255,0.36); font-size: 0.74rem; }
    .btn-primary:hover:not(:disabled) { background: rgba(0,229,255,0.22); transform: translateY(-1px); }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-ghost { background: rgba(255,255,255,0.04); color: #fff; border-color: rgba(255,255,255,0.1); font-size: 0.72rem; }
    .btn-ghost:hover { background: rgba(255,255,255,0.09); }
    .btn-danger-ghost { background: transparent; color: #fca5a5; border-color: rgba(248,113,113,0.28); font-size: 0.7rem; }
    .btn-danger-ghost:hover { background: rgba(248,113,113,0.14); color: #fecaca; }
    button:focus-visible { outline: 2px solid var(--ps-accent, #00E5FF); outline-offset: 2px; }

    .skel { background: rgba(255,255,255,0.04); border-radius: 6px; position: relative; overflow: hidden; }
    .skel::after { content: ""; position: absolute; inset: 0; background: linear-gradient(90deg, transparent, rgba(255,255,255,0.06), transparent); background-size: 200% 100%; animation: shine 1.6s linear infinite; }
    @keyframes shine { from { background-position: 200% 0; } to { background-position: -200% 0; } }
    @media (prefers-reduced-motion: reduce) {
      .skel::after, .result-row, .num-row, .vanity-chip, .btn-primary, .btn-ghost, .btn-danger-ghost {
        animation: none !important; transition: none !important; transform: none !important;
      }
    }

    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
  `],
})
export class VoiceNumbersComponent implements OnInit, OnDestroy {
  readonly state = inject(AdminStateService);
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  private readonly confirmSvc = inject(ConfirmService);

  readonly MAX = MAX_NUMBERS;

  numbers = signal<PurchasedNumber[]>([]);
  loading = signal(true);
  /** Set when the numbers fetch fails so a Retry card shows — never a fake "No numbers yet" + a misleading $0.00 spend. */
  loadError = signal<string | null>(null);
  query = '';
  areaCode = '';
  searching = signal(false);
  searchResults = signal<NumberCandidate[]>([]);
  /** Set when a search REQUEST fails (Twilio not connected / creds rejected /
   *  transient) so the UI shows an honest, actionable notice — never a lying
   *  "No numbers available for that search" empty state that hides the failure. */
  searchError = signal<string | null>(null);
  suggestions = signal<VanitySuggestion[]>([]);
  suggestionsLoading = signal(false);
  cappedNotice = signal(false);
  /** Phone number currently being purchased — double-submit guard (Buy charges money). Held from confirm → POST resolve/error. */
  buyingNumber = signal<string | null>(null);
  /** Number ids currently being released — per-row double-submit guard (Release is destructive). */
  releasingIds = signal<ReadonlySet<string>>(new Set());
  isReleasing(id: string): boolean { return this.releasingIds().has(id); }

  /** The vanity/area-code search input — focus target for the empty-state's "Find a vanity number" CTA. */
  @ViewChild('voiceSearchInput') private searchInputRef?: ElementRef<HTMLInputElement>;

  /**
   * Jump straight to the number picker: focus the "Find a number" search input and scroll
   * it into view. The empty-state CTA calls this so an operator with 0 numbers doesn't have
   * to hunt down the page for the picker (on mobile it sits ~3 screens below the empty state)
   * — the extra-mile "empty state → first-result action". Respects prefers-reduced-motion.
   */
  focusSearch(): void {
    const el = this.searchInputRef?.nativeElement;
    if (!el) return;
    el.focus({ preventScroll: true });
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
  }

  capped = computed(() => this.numbers().length >= MAX_NUMBERS);
  monthlySpend = computed(() =>
    this.numbers().reduce((sum, n) => sum + (n.monthly_cost_usd || 0), 0),
  );

  /**
   * A brand-relevant vanity EXAMPLE for the search placeholder — the first
   * memorable word of the selected site's business name (uppercased, ≤7 letters
   * so it fits a local number's 7-digit keypad span), so the operator sees THEIR
   * business as the hint instead of a generic/wrong-vertical word. Falls back to
   * "HELLO" when no site is selected or the name yields no usable word.
   */
  readonly vanityExample = computed(() => {
    const name = this.state.selectedSite()?.business_name ?? '';
    const word = name
      .split(/[^A-Za-z]+/)
      .find((w) => w.length >= 3 && !['the', 'and'].includes(w.toLowerCase()));
    return (word ? word.slice(0, 7) : 'hello').toUpperCase();
  });

  /** Full placeholder string for the vanity search input, brand-derived. */
  readonly vanityPlaceholder = computed(() => `Try "${this.vanityExample()}", or digits`);

  /** A search was attempted by a vanity WORD or an AREA CODE — gates the
   *  empty-results hint so an area-code-only search never shows a silent blank. */
  searchAttempted(): boolean {
    return this.query.trim().length > 0 || this.areaCode.trim().length > 0;
  }

  /** Upper-cased query for the keypad preview label. */
  queryUpper(): string {
    return this.query.trim().toUpperCase();
  }

  /**
   * Live keypad-digit rendering of the typed vanity word — null (no chip) when
   * the query has no letters (digits-only needs no translation). Re-evaluated
   * each CD cycle, which `ngModelChange` already fires under OnPush.
   */
  queryDigits(): string | null {
    const q = this.query.trim();
    return q && hasVanityLetters(q) ? vanityToDigits(q.toUpperCase()) : null;
  }

  private debounceTimer?: ReturnType<typeof setTimeout>;
  private abortCtrl?: AbortController;

  /** Reload on site switch. */
  private readonly siteEffect = effect(() => {
    const site = this.state.selectedSite();
    if (!site) return;
    this.loadNumbers();
    this.loadSuggestions(false);
  });

  ngOnInit(): void {
    // Initial loads run via the effect.
  }

  ngOnDestroy(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.abortCtrl?.abort();
  }

  loadNumbers(): void {
    const site = this.state.selectedSite();
    if (!site) return;
    this.loading.set(true);
    this.loadError.set(null);
    // Worker GET /api/voice/numbers returns { numbers } (voice.ts:310) — NOT
    // { data }. Reading r.data left the list empty → "No numbers yet" + $0.00
    // spend even when the site owns purchased numbers (the sibling search below
    // already reads r.numbers correctly; only this list-load regressed).
    this.api.get<{ numbers: PurchasedNumber[] }>(`/voice/numbers?siteId=${site.id}`, undefined, { silent: true }).subscribe({
      next: (r) => { this.numbers.set(r.numbers ?? []); this.loadError.set(null); this.loading.set(false); },
      // Keep already-loaded numbers on a transient failure; surface a Retry card
      // (not a fake "No numbers" + $0.00 spend) when there's nothing to show.
      error: () => { this.loading.set(false); this.loadError.set('The numbers service did not respond.'); },
    });
  }

  loadSuggestions(force: boolean): void {
    const site = this.state.selectedSite();
    if (!site) return;
    this.suggestionsLoading.set(true);
    const url = `/voice/vanity-suggestions?siteId=${site.id}${force ? '&refresh=1' : ''}`;
    this.api.get<{ data: VanitySuggestion[] }>(url).subscribe({
      next: (r) => { this.suggestions.set((r.data ?? []).slice(0, 12)); this.suggestionsLoading.set(false); },
      error: () => { this.suggestions.set([]); this.suggestionsLoading.set(false); },
    });
  }

  onQueryChange(q: string): void {
    this.query = q;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (!q.trim() && !this.areaCode.trim()) {
      this.searchResults.set([]);
      this.searchError.set(null);
      return;
    }
    this.debounceTimer = setTimeout(() => this.runSearch(), 300);
  }

  private runSearch(): void {
    const site = this.state.selectedSite();
    if (!site) return;
    this.abortCtrl?.abort();
    this.abortCtrl = new AbortController();
    this.searching.set(true);
    // Worker route is GET /api/voice/numbers/search (params: contains / areaCode
    // [3 digits] / country / limit; returns { numbers, total }). Earlier this
    // called a nonexistent /api/voice/search → 404 → search always came up empty.
    const params: Record<string, string> = {};
    if (this.query.trim()) params['contains'] = this.query.trim().toUpperCase();
    const area = this.areaCode.trim();
    if (/^\d{3}$/.test(area)) params['areaCode'] = area; // worker rejects non-3-digit → omit
    // {silent}: the section owns its own failure surface (the searchError notice
    // below) — no generic ApiService toast on top of it.
    this.api.get<{ numbers?: NumberCandidate[] }>('/voice/numbers/search', params, { silent: true }).subscribe({
      next: (r) => { this.searchResults.set((r.numbers ?? []).slice(0, 20)); this.searchError.set(null); this.searching.set(false); },
      // A failed search must NEVER masquerade as "No numbers available" (a lie).
      // 501 = phone provider not connected / Twilio creds rejected → calm,
      // actionable notice. Any other status = a real transient failure → Retry.
      error: (e: { status?: number }) => {
        this.searchResults.set([]);
        this.searchError.set(
          e?.status === 501
            ? 'Number search needs a connected phone provider — add valid Twilio credentials to search live numbers.'
            : 'Could not search numbers right now. Check your connection and press Retry.',
        );
        this.searching.set(false);
      },
    });
  }

  /** Public retry entry for the search-error notice's Retry button. */
  retrySearch(): void {
    this.runSearch();
  }

  useSuggestion(s: VanitySuggestion): void {
    this.query = s.word;
    this.onQueryChange(s.word);
  }

  /**
   * Open a confirmation dialog and POST the purchase.
   * @param c Candidate to buy.
   */
  async confirmBuy(c: NumberCandidate): Promise<void> {
    if (this.capped()) {
      this.cappedNotice.set(true);
      return;
    }
    // Double-submit guard: Buy charges money. Claim the in-flight slot BEFORE the
    // confirm dialog opens so a second click can't open a 2nd dialog or fire a 2nd
    // purchase; cleared on cancel + on POST resolve/error so a retry always works.
    if (this.buyingNumber()) return;
    this.buyingNumber.set(c.phone_number);
    // Provisioning a number starts a recurring monthly charge — verify via the
    // branded cyan confirm modal (not a native window.confirm).
    const ok = await this.confirmSvc.confirm({
      title: 'Buy this number?',
      message: `Buy ${this.format(c.phone_number)} for $${c.monthly_cost_usd.toFixed(2)}/mo? This provisions the number and starts the recurring monthly charge.`,
      confirmLabel: 'Buy number',
      danger: true,
    });
    if (!ok) { this.buyingNumber.set(null); return; }
    // Worker route is POST /api/voice/numbers/purchase with a camelCase body
    // ({ siteId, phoneNumber }) per purchaseBody in routes/voice.ts. The old
    // call hit bare /voice/numbers (no such route → SPA HTML) with snake_case
    // keys (would 400 even if the path matched) — the Buy button never worked.
    this.api.post<{ data: PurchasedNumber }>(`/voice/numbers/purchase`, {
      siteId: this.state.selectedSite()?.id,
      phoneNumber: c.phone_number,
    }, { silent: true }).subscribe({
      next: () => {
        this.buyingNumber.set(null);
        this.toast.success(`${this.format(c.phone_number)} added`);
        this.searchResults.set([]);
        this.query = '';
        this.loadNumbers();
      },
      // {silent}: the specific message below is the sole failure surface (no generic double-toast).
      error: () => { this.buyingNumber.set(null); this.toast.error('Purchase failed — check Twilio funds + permissions'); },
    });
  }

  async release(n: PurchasedNumber): Promise<void> {
    // Double-submit guard: Release is destructive (gives up a live number). Claim
    // the row BEFORE the confirm so a second click can't fire a 2nd DELETE; cleared
    // on cancel + on DELETE resolve/error so a failed release stays retryable.
    if (this.isReleasing(n.id)) return;
    this.releasingIds.update((s) => new Set(s).add(n.id));
    const done = () => this.releasingIds.update((s) => { const next = new Set(s); next.delete(n.id); return next; });
    const ok = await this.confirmSvc.confirm({
      title: 'Release number',
      message: `Release ${this.format(n.phone_number)}? Inbound calls + texts stop immediately and the number is given up — you may not be able to get it back.`,
      confirmLabel: 'Release',
      danger: true,
    });
    if (!ok) { done(); return; }
    this.api.delete<void>(`/voice/numbers/${n.id}`, { silent: true }).subscribe({
      next: () => { done(); this.toast.success('Number released'); this.loadNumbers(); },
      // {silent}: the specific message below is the sole failure surface (no generic double-toast).
      error: () => { done(); this.toast.error('Failed to release number'); },
    });
  }

  copy(num: string): void {
    navigator.clipboard.writeText(num).then(
      () => this.toast.success(`Copied ${this.format(num)}`),
      () => this.toast.error('Copy failed'),
    );
  }

  /**
   * Speak a vanity word aloud via Web Speech API on hover. Best-effort —
   * skipped silently if the browser doesn't support speech synthesis.
   * @example speak('LABOR')
   */
  speak(word: string): void {
    try {
      if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
      const optIn = (() => { try { return localStorage.getItem('voice.speak.optin') === 'true'; } catch { return false; } })();
      if (!optIn) return;
      const u = new SpeechSynthesisUtterance(word.toLowerCase());
      u.volume = 0.6; u.rate = 1.05;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch { /* ignore */ }
  }

  // ── Formatting helpers ────────────────────────────────────────────

  /** Format an E.164 number as "(NPA) NXX-XXXX" for human display. */
  format(e164: string): string {
    const d = e164.replace(/[^\d]/g, '').replace(/^1/, '');
    if (d.length !== 10) return e164;
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  }

  /**
   * Render a phone number with vanity letters bolded.
   * For "+18558522267" with vanity_match "LABOR" we render
   * "(855) 82L-ABOR" with L, A, B, O, R bolded.
   */
  vanityHtml(e164: string, vanity?: string): string {
    const d = e164.replace(/[^\d]/g, '').replace(/^1/, '');
    if (d.length !== 10) return this.escape(e164);
    const word = (vanity || '').toUpperCase().replace(/[^A-Z]/g, '');
    // Map letters → digits, find first contiguous match in the last 7 digits.
    const last7 = d.slice(3);
    let startIdx = -1;
    if (word.length >= 2) {
      const wordDigits = [...word].map((ch) => LETTER_TO_DIGIT[ch] ?? ch).join('');
      const idx = last7.indexOf(wordDigits);
      if (idx !== -1) startIdx = idx;
    }
    const parts: string[] = [];
    for (let i = 0; i < 7; i++) {
      const dgt = last7[i];
      if (startIdx !== -1 && i >= startIdx && i < startIdx + word.length) {
        parts.push(`<b>${this.escape(word[i - startIdx])}</b>`);
      } else {
        parts.push(this.escape(dgt));
      }
    }
    // Insert dash between position 3 and 4 of last7.
    const styled = `${parts.slice(0, 3).join('')}-${parts.slice(3).join('')}`;
    return `(${d.slice(0, 3)}) ${styled}`;
  }

  private escape(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
  }

  // ── Keyboard nav on result rows ───────────────────────────────────

  onResultKey(ev: KeyboardEvent, idx: number, c: NumberCandidate): void {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); void this.confirmBuy(c); return; }
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      const rows = (ev.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLElement>('[role="option"]');
      if (!rows) return;
      const next = ev.key === 'ArrowDown' ? Math.min(rows.length - 1, idx + 1) : Math.max(0, idx - 1);
      rows[next]?.focus();
    }
  }
}
