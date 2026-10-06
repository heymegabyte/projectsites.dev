/**
 * Getting Started hub at `/admin`.
 *
 * Orientation page: introduces every admin section grouped by purpose, with a
 * live search that filters all sections, pinned + recently-opened rows, tips,
 * and help links. The former welcome hero + features-banner were removed; the
 * page now opens straight on a search bar over the "Build your site" content.
 *
 */
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  HostListener,
  computed,
  effect,
  inject,
  signal,
  viewChild,
  type ElementRef,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { RevealDirective } from '../../../directives/reveal.directive';
import { CmdGlyphComponent } from '../../../components/cmd-glyph/cmd-glyph.component';
import { RollingCounterComponent } from '../../../components/rolling-counter/rolling-counter.component';
import { QuotaChipComponent } from '../quota-chip.component';
import { OnboardingChecklistComponent } from '../../../components/onboarding-checklist/onboarding-checklist.component';
import { ReferralCardComponent } from '../../../components/referral-card/referral-card.component';
import { GenerationMetricsCardComponent } from './dashboard/generation-metrics-card.component';
import { AdminStateService } from '../admin-state.service';
import { AuthService } from '../../../services/auth.service';
import { isSysAdminEmail } from '../sys-admin';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ApiService, type Site } from '../../../services/api.service';

interface SectionCard {
  label: string;
  desc: string;
  link: string;
  glyph: string;
  keywords?: readonly string[];
  external?: boolean;
}

interface SectionGroup {
  title: string;
  cards: readonly SectionCard[];
}

interface Tip {
  glyph: string;
  text: string;
}

/** Text split around the active query match — rendered with a <mark> (no innerHTML). */
interface HlParts {
  pre: string;
  hit: string;
  post: string;
}

interface SnapshotMetrics {
  lh_performance: number | null;
  lcp_ms: number | null;
  tbt_ms: number | null;
  cls: number | null;
  inp_ms: number | null;
}

type MetricTier = 'green' | 'yellow' | 'red' | 'neutral';

interface CwvPill {
  key: string;
  label: string;
  rawValue: number | null;
  formatted: string;
  tier: MetricTier;
  tooltip: string;
  budget: number;
}

/**
 * One tile in the operator KPI strip. Every value is derived from a metric
 * `AdminStateService` genuinely provides (sites list / domain summary /
 * subscription) — never a fabricated number. `numeric` tiles animate a
 * rolling counter; text tiles (e.g. plan name) show `display` verbatim.
 */
interface KpiTile {
  key: string;
  label: string;
  /** Numeric value for the rolling counter (numeric tiles only). */
  value: number;
  /** Verbatim string for text tiles (e.g. the plan name); null for numeric tiles. */
  display: string | null;
  /** One-line honest interpretation shown under the value. */
  sub: string;
  glyph: string;
  tone: 'accent' | 'good' | 'building' | 'attention' | 'neutral';
  numeric: boolean;
}

/**
 * One actionable row in the "Needs attention" queue — a site that is in
 * `error`/`failed`, or a `published` site with no finished build (serves the
 * branded 503 — the lying-published guard, mirrored from `siteStatusSummary`).
 * `action` maps to an existing `AdminStateService`/router affordance.
 */
interface AttentionItem {
  siteId: string;
  name: string;
  status: string;
  reason: string;
  actionLabel: string;
  /** 'rebuild' → goToWaiting (retry the build); 'open' → site detail route. */
  action: 'rebuild' | 'open';
}

const FAV_KEY = 'ps_dash_favs';
const RECENT_KEY = 'ps_dash_recents';

@Component({
  selector: 'app-admin-dashboard',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgTemplateOutlet,
    FormsModule,
    RouterLink,
    RevealDirective,
    CmdGlyphComponent,
    RollingCounterComponent,
    QuotaChipComponent,
    OnboardingChecklistComponent,
    ReferralCardComponent,
    GenerationMetricsCardComponent,
  ],
  template: `
    <section class="dash" aria-label="Getting started">
      <h1 class="sr-only">Dashboard</h1>
      <!-- Site-quota chip (#35) — owner sees usage before a create-limit 403 -->
      <div class="flex justify-end mb-1"><app-quota-chip /></div>
      <!-- Onboarding activation checklist (feature: onboarding_copilot) — self-hides
           when the flag is off (API 404), complete, or dismissed. -->
      <app-onboarding-checklist />

      <!-- ══ Operator cockpit (additive — top of dashboard) ══════════
           A live KPI tile strip + an actionable "Needs attention" queue,
           both derived from the already-loaded AdminStateService signals
           (poll-driven, no manual Refresh). Only renders once the sites
           list has loaded AND the account has ≥1 site — never a fabricated
           number, never a doomed control. -->
      @if (!isLoading() && hasSites()) {
        <section class="cockpit" appReveal aria-labelledby="cockpit-h">
          <div class="cockpit-head">
            <h2 class="group-title" id="cockpit-h">
              <app-cmd-glyph name="activity" /> Operator cockpit
            </h2>
            <span class="cockpit-live" aria-hidden="true">
              <span class="cockpit-live-dot"></span> Live
            </span>
          </div>
          <p class="status-source">
            Live · from your account, auto-refreshed every 30s — no refresh needed
          </p>

          @if (kpiTiles().length > 0) {
            <ul class="kpi-strip" aria-label="Key metrics">
              @for (t of kpiTiles(); track t.key) {
                <li class="kpi-tile" [class]="'tone-' + t.tone">
                  <span class="kpi-top">
                    <span class="kpi-glyph" aria-hidden="true"
                      ><app-cmd-glyph [name]="t.glyph"
                    /></span>
                    <span class="kpi-live-dot" aria-hidden="true"></span>
                  </span>
                  @if (t.numeric) {
                    <app-rolling-counter class="kpi-value" [value]="t.value" />
                  } @else {
                    <span class="kpi-value">{{ t.display }}</span>
                  }
                  <span class="kpi-label">{{ t.label }}</span>
                  <span class="kpi-sub">{{ t.sub }}</span>
                </li>
              }
            </ul>
          }

          <!-- ── Needs attention queue ──────────────────────────── -->
          <h3 class="cockpit-sub" id="attn-h">
            <app-cmd-glyph name="shield" /> Needs attention
          </h3>
          @if (attentionItems(); as items) {
            @if (items.length > 0) {
              <ul class="attn-list" aria-labelledby="attn-h">
                @for (item of items; track item.siteId) {
                  <li
                    class="attn-row"
                    tabindex="0"
                    role="button"
                    [attr.aria-label]="
                      item.name + ' — ' + item.reason + ' Press Enter to rebuild.'
                    "
                    (click)="rebuildFromQueue(item)"
                    (keydown.enter)="rebuildFromQueue(item)"
                    (keydown.space)="$event.preventDefault(); rebuildFromQueue(item)"
                    [attr.data-testid]="'dash-attn-' + item.siteId"
                  >
                    <span class="attn-dot" aria-hidden="true"></span>
                    <span class="attn-body">
                      <span class="attn-name">{{ item.name }}</span>
                      <span class="attn-reason">{{ item.reason }}</span>
                    </span>
                    <span class="attn-status" aria-hidden="true">{{ item.status }}</span>
                    <button
                      type="button"
                      class="attn-action"
                      (click)="$event.stopPropagation(); rebuildFromQueue(item)"
                      [attr.aria-label]="item.actionLabel + ' ' + item.name"
                      [attr.data-testid]="'dash-attn-action-' + item.siteId"
                    >
                      <app-cmd-glyph name="rocket" /> {{ item.actionLabel }}
                    </button>
                  </li>
                }
              </ul>
            } @else {
              <div class="attn-clear" data-testid="dash-attn-clear">
                <span class="attn-clear-glyph" aria-hidden="true"
                  ><app-cmd-glyph name="shield"
                /></span>
                <p class="attn-clear-title">All clear</p>
                <p class="attn-clear-sub">
                  Every site is healthy — no failed or stalled builds right now.
                </p>
              </div>
            }
          }
        </section>
      }

      <!-- ── Generation speed + cost (operator-only, fire-61) ────
           Platform-wide build speed/cost rollup from the super-admin
           /api/admin/build-metrics/summary endpoint. Mounted only for
           operators (mirrors the Feature Flags card gate); the card
           additionally self-hides if the endpoint rejects, so it can
           never render broken. -->
      @if (isSysAdmin()) {
        <app-generation-metrics-card appReveal />
      }

      <!-- ── Search ─────────────────────────────────────────────── -->
      <div class="search-wrap" appReveal role="search">
        <span class="search-ic" aria-hidden="true"><app-cmd-glyph name="search" /></span>
        <input
          #searchInput
          class="search-input"
          type="search"
          [ngModel]="query()"
          (ngModelChange)="query.set($event)"
          placeholder="Search the dashboard — sections, tools, anything…"
          aria-label="Search dashboard sections"
          autocomplete="off"
          spellcheck="false"
          data-testid="dash-search"
        />
        @if (query()) {
          <button
            class="search-clear"
            type="button"
            (click)="clear()"
            aria-label="Clear search"
            data-testid="dash-search-clear"
          >
            ✕
          </button>
        } @else {
          <span class="search-kbd" aria-hidden="true"><kbd>/</kbd></span>
        }
      </div>
      <p class="sr-only" role="status" aria-live="polite">{{ resultAnnounce() }}</p>

      @if (filtered(); as results) {
        <!-- ── Flat filtered results ──────────────────────────── -->
        @if (results.length === 0) {
          <div class="no-match" appReveal data-testid="dash-no-match">
            <span class="no-match-glyph" aria-hidden="true"><app-cmd-glyph name="search" /></span>
            <p class="no-match-title">No sections match “{{ query() }}”</p>
            <p class="no-match-sub">Try a different word, or browse everything below.</p>
            <button
              class="cta cta-ghost"
              type="button"
              (click)="clear()"
              data-testid="dash-no-match-clear"
            >
              Clear search
            </button>
          </div>
        } @else {
          <section class="group" aria-label="Search results">
            <h2 class="group-title">
              {{ results.length }} {{ results.length === 1 ? 'result' : 'results' }}
              <span class="muted">for “{{ query() }}”</span>
            </h2>
            <ul class="cards">
              @for (card of results; track card.link) {
                <li class="card-cell" [style.animation-delay.ms]="$index * 28">
                  <ng-container
                    [ngTemplateOutlet]="cardTpl"
                    [ngTemplateOutletContext]="{ card: card }"
                  />
                </li>
              }
            </ul>
          </section>
        }
      } @else {
        <!-- Reserve the command-center height while EITHER the sites OR the (later,
             separate) CWV-metrics fetch is in flight, so Site status + CWV appearing
             (staggered) never shove the section-guide groups down — the residual
             dashboard layout shift after the async sections were reserved (CLS ≤0.05).
             Skeleton doubles as a loading affordance; the reserve (324px) matches the
             loaded status+CWV height (317px incl. margins) so the swap is height-neutral. -->
        <div class="cc-slot" [class.cc-reserve]="ccLoading() || hasSites()">
        @if (ccLoading()) {
          <div class="cc-skeleton" data-testid="dash-cc-skeleton" aria-hidden="true">
            <div class="cc-skel-line" style="width: 8rem"></div>
            <div class="cc-skel-strip">
              <div class="cc-skel-tile"></div><div class="cc-skel-tile"></div>
              <div class="cc-skel-tile"></div><div class="cc-skel-tile"></div>
            </div>
            <div class="cc-skel-line" style="width: 11rem; margin-top: 16px"></div>
            <div class="cc-skel-pills">
              <div class="cc-skel-pill"></div><div class="cc-skel-pill"></div>
              <div class="cc-skel-pill"></div><div class="cc-skel-pill"></div>
            </div>
          </div>
        } @else {
        <!-- ── Site status command-center strip (P4) ──────────────
             Real data from the already-loaded sites list; each tile is a
             metric→record link into the FIRST matching site's detail
             (/admin/sites/:id) — the drill-in the tile's styling + copy promise. -->
        @if (hasSites() && siteStatusSummary().length > 0) {
          <section class="group" appReveal aria-labelledby="grp-status">
            <h2 class="group-title" id="grp-status">
              <app-cmd-glyph name="activity" /> Site status
            </h2>
            <p class="status-source">Live · from your account, auto-refreshed every 30s</p>
            <ul class="status-strip" aria-label="Site status summary">
              @for (b of siteStatusSummary(); track b.key) {
                <li>
                  <a
                    class="status-tile"
                    [class]="'tone-' + b.tone"
                    [routerLink]="['/admin/sites', b.siteId]"
                    (click)="recordOpen('/admin/sites/' + b.siteId)"
                    [attr.aria-label]="b.count + ' ' + b.label + ' — ' + b.interp + '. Open site.'"
                  >
                    <span class="status-dot" aria-hidden="true"></span>
                    <app-rolling-counter class="status-count" [value]="b.count" />
                    <span class="status-label">{{ b.label }}</span>
                    <span class="status-interp">{{ b.interp }}</span>
                  </a>
                </li>
              }
            </ul>
          </section>
        }

        @if (hasSites() && latestMetrics()) {
          <section class="group cwv-group" appReveal aria-labelledby="grp-cwv">
            <h2 class="group-title" id="grp-cwv">
              <app-cmd-glyph name="activity" /> Core Web Vitals
            </h2>
            @if (hasCwvData()) {
              <p class="status-source">From your latest snapshot · real Lighthouse data</p>
              <ul class="cwv-strip" aria-label="Core Web Vitals">
                @for (pill of cwvPills(latestMetrics()!); track pill.key) {
                  <li>
                    <span class="cwv-chip" [attr.data-tier]="pill.tier" [attr.title]="pill.tooltip">
                      <span class="cwv-label">{{ pill.label }}</span>
                      <span class="cwv-value">{{ pill.formatted }}</span>
                    </span>
                  </li>
                }
                <li>
                  <span
                    class="cwv-chip"
                    [attr.data-tier]="tierForLh(latestMetrics()!.lh_performance)"
                    title="Lighthouse Performance score (0-100). Target ≥90."
                  >
                    <span class="cwv-label">Perf</span>
                    <span class="cwv-value">{{
                      latestMetrics()!.lh_performance !== null
                        ? latestMetrics()!.lh_performance
                        : '—'
                    }}</span>
                  </span>
                </li>
              </ul>
            } @else {
              <p class="status-source">
                Latest snapshot captured — Lighthouse metrics not run on it yet
              </p>
              <p class="cwv-empty" data-testid="cwv-empty">
                No Core Web Vitals on your most recent snapshot. They populate automatically once a
                snapshot runs with Lighthouse enabled.
              </p>
              <a class="cwv-cta" routerLink="/admin/snapshots" data-testid="cwv-empty-cta">
                Capture a snapshot →
              </a>
            }
          </section>
        }
        }
        </div>

        <!-- ── Pinned ─────────────────────────────────────────── -->
        @if (pinnedCards().length > 0) {
          <section class="group" appReveal aria-labelledby="grp-pinned">
            <h2 class="group-title" id="grp-pinned"><app-cmd-glyph name="star" /> Pinned</h2>
            <ul class="cards">
              @for (card of pinnedCards(); track card.link) {
                <li class="card-cell" [style.animation-delay.ms]="$index * 28">
                  <ng-container
                    [ngTemplateOutlet]="cardTpl"
                    [ngTemplateOutletContext]="{ card: card }"
                  />
                </li>
              }
            </ul>
          </section>
        }

        <!-- ── Recently opened ────────────────────────────────── -->
        @if (recentCards().length > 0) {
          <section class="group" appReveal aria-labelledby="grp-recent">
            <h2 class="group-title" id="grp-recent">
              <app-cmd-glyph name="activity" /> Jump back in
            </h2>
            <ul class="cards">
              @for (card of recentCards(); track card.link) {
                <li class="card-cell" [style.animation-delay.ms]="$index * 28">
                  <ng-container
                    [ngTemplateOutlet]="cardTpl"
                    [ngTemplateOutletContext]="{ card: card }"
                  />
                </li>
              }
            </ul>
          </section>
        }

        <!-- ── Section guide ──────────────────────────────────── -->
        @for (group of displayGroups(); track group.title) {
          <section class="group" appReveal aria-labelledby="grp-{{ $index }}">
            <h2 class="group-title" id="grp-{{ $index }}">{{ group.title }}</h2>
            <ul class="cards">
              @for (card of group.cards; track card.link) {
                <li class="card-cell" [style.animation-delay.ms]="$index * 28">
                  <ng-container
                    [ngTemplateOutlet]="cardTpl"
                    [ngTemplateOutletContext]="{ card: card }"
                  />
                </li>
              }
            </ul>
          </section>
        }

        <!-- Refer-a-friend (feature: referral_loop) — growth card; self-hides
             when the flag is off (API 404) or the org has no site yet. -->
        <app-referral-card />

        <!-- ── Tips & tricks ──────────────────────────────────── -->
        <section class="group" appReveal aria-labelledby="grp-tips">
          <h2 class="group-title" id="grp-tips">Tips &amp; tricks</h2>
          <ul class="tips">
            @for (tip of tips; track tip.text) {
              <li class="tip">
                <span class="tip-glyph" aria-hidden="true"
                  ><app-cmd-glyph [name]="tip.glyph"
                /></span>
                <span class="tip-text">{{ tip.text }}</span>
              </li>
            }
          </ul>
        </section>

        <!-- ── Helpful links ──────────────────────────────────── -->
        <section class="group links-group" appReveal aria-labelledby="grp-links">
          <h2 class="group-title" id="grp-links">Need a hand?</h2>
          <nav class="links" aria-label="Helpful links">
            <a routerLink="/admin/docs"><app-cmd-glyph name="book" /> Read the API docs</a>
            <a routerLink="/admin/user"><app-cmd-glyph name="gear" /> Account &amp; preferences</a>
            <a routerLink="/contact"><app-cmd-glyph name="life-buoy" /> Contact support</a>
          </nav>
          @if (hasSites()) {
            <p class="stat" aria-live="polite">
              <app-rolling-counter [value]="siteCount()" />
              {{ siteCount() === 1 ? 'site' : 'sites' }} in your account
            </p>
          }
        </section>
      }
    </section>

    <!-- ── Reusable section-card (anchor + pin button sibling) ──── -->
    <ng-template #cardTpl let-card="card">
      @if (card.external) {
        <a
          class="sec-card"
          [href]="card.link"
          target="_blank"
          rel="noopener"
          [attr.data-testid]="'dash-sec-' + card.glyph"
        >
          <span class="sec-glyph" aria-hidden="true"><app-cmd-glyph [name]="card.glyph" /></span>
          <span class="sec-body">
            <strong class="sec-label">
              @for (p of parts(card.label); track $index) {
                <span>{{ p.pre }}</span>
                @if (p.hit) {
                  <mark>{{ p.hit }}</mark>
                }
                <span>{{ p.post }}</span>
              }
            </strong>
            <span class="sec-desc">{{ card.desc }}</span>
            @if (card.keywords?.length) {
              <span class="sec-tags" aria-hidden="true">
                @for (kw of card.keywords; track kw) {
                  <span class="tag">{{ kw }}</span>
                }
              </span>
            }
          </span>
          <span class="sec-cta" aria-hidden="true">↗</span>
        </a>
      } @else {
        <a
          class="sec-card"
          [routerLink]="card.link"
          (click)="recordOpen(card.link)"
          [attr.data-testid]="'dash-sec-' + card.glyph"
        >
          <span class="sec-glyph" aria-hidden="true"><app-cmd-glyph [name]="card.glyph" /></span>
          <span class="sec-body">
            <strong class="sec-label">
              @for (p of parts(card.label); track $index) {
                <span>{{ p.pre }}</span>
                @if (p.hit) {
                  <mark>{{ p.hit }}</mark>
                }
                <span>{{ p.post }}</span>
              }
            </strong>
            <span class="sec-desc">{{ card.desc }}</span>
            @if (card.keywords?.length) {
              <span class="sec-tags" aria-hidden="true">
                @for (kw of card.keywords; track kw) {
                  <span class="tag">{{ kw }}</span>
                }
              </span>
            }
          </span>
          <span class="sec-cta" aria-hidden="true">→</span>
        </a>
        <button
          class="sec-pin"
          type="button"
          (click)="toggleFav(card.link)"
          [class.is-pinned]="isFav(card.link)"
          [attr.aria-pressed]="isFav(card.link)"
          [attr.aria-label]="(isFav(card.link) ? 'Unpin ' : 'Pin ') + card.label"
          [attr.data-testid]="'dash-pin-' + card.glyph"
        >
          <app-cmd-glyph name="star" />
        </button>
      }
    </ng-template>
  `,
  styles: [
    `
      :host {
        display: block;
        position: relative;
        min-height: calc(100vh - 64px);
      }
      .dash {
        position: relative;
        padding: 28px 24px 96px;
        max-width: 1100px;
        margin: 0 auto;
        color: var(--ps-ink, #f4f4ff);
      }

      /* Search */
      .search-wrap {
        position: sticky;
        /* WCAG 2.2 §2.4.11 Focus Not Obscured (AA): pin BELOW the admin top bar, not
           at the scrollport top. A plain top:8px stuck this at viewport y=8 — behind the
           sticky .admin-topbar (y=0..62, z-50) — so once the dashboard scrolled, the
           section-search rode UNDER the header (z-5 < z-50) and a focused query landed
           entirely hidden. Offset by the SSOT bar height (inherited from the admin host)
           so it always pins in the clear, keeping the original 8px gap. */
        top: calc(var(--ps-admin-topbar-h, 62px) + 8px);
        z-index: 5;
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 0 14px;
        height: 54px;
        border-radius: 16px;
        background: color-mix(in oklch, var(--ps-bg, #060610) 78%, transparent);
        border: 1px solid rgba(0, 229, 255, 0.22);
        box-shadow: 0 18px 48px -28px rgba(0, 229, 255, 0.5);
        backdrop-filter: blur(14px) saturate(140%);
        -webkit-backdrop-filter: blur(14px) saturate(140%);
        transition:
          border-color 0.333s ease,
          box-shadow 0.333s ease;
      }
      .search-wrap:focus-within {
        border-color: var(--ps-accent, #00e5ff);
        box-shadow: 0 22px 60px -26px rgba(0, 229, 255, 0.7);
      }
      .search-ic {
        color: var(--ps-accent, #00e5ff);
        font-size: 1.15rem;
        display: inline-flex;
      }
      .search-input {
        flex: 1;
        min-width: 0;
        background: transparent;
        border: 0;
        outline: none;
        color: var(--ps-ink, #f4f4ff);
        font: inherit;
        font-size: 1rem;
      }
      /* No focus/focus-visible outline on the input — the wrapping search bar
         provides the affordance. Brian directive 2026-08-20. */
      .search-input:focus,
      .search-input:focus-visible {
        outline: none !important;
        box-shadow: none !important;
      }
      .search-input::placeholder {
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 78%, var(--ps-bg, #060610));
      }
      .search-input::-webkit-search-cancel-button {
        display: none;
      }
      .search-kbd kbd {
        font-family: 'JetBrains Mono', monospace;
        font-size: 0.72rem;
        padding: 2px 8px;
        border-radius: 7px;
        background: rgba(0, 229, 255, 0.08);
        border: 1px solid rgba(0, 229, 255, 0.22);
        color: color-mix(in oklch, var(--ps-accent, #00e5ff) 85%, var(--ps-ink) 15%);
      }
      .search-clear {
        flex-shrink: 0;
        width: 28px;
        height: 28px;
        border-radius: 8px;
        border: 1px solid rgba(255, 255, 255, 0.1);
        background: rgba(255, 255, 255, 0.04);
        color: var(--ps-ink, #f4f4ff);
        cursor: pointer;
        transition:
          border-color 0.333s ease,
          transform 0.333s ease,
          background 0.333s ease;
      }
      .search-clear:hover {
        border-color: rgba(0, 229, 255, 0.5);
        transform: translateY(-1px);
      }
      .search-clear:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 2px;
      }

      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }

      /* No match */
      .no-match {
        text-align: center;
        padding: 54px 16px;
      }
      .no-match-glyph {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 56px;
        height: 56px;
        border-radius: 16px;
        font-size: 1.5rem;
        color: var(--ps-accent, #00e5ff);
        background: rgba(0, 229, 255, 0.08);
        border: 1px solid rgba(0, 229, 255, 0.2);
        margin-bottom: 16px;
      }
      .no-match-title {
        font-family: 'Sora', system-ui, sans-serif;
        font-size: 1.1rem;
        font-weight: 600;
        margin: 0 0 6px;
      }
      .no-match-sub {
        opacity: 0.65;
        font-size: 0.9rem;
        margin: 0 0 18px;
      }

      /* Section groups */
      .group {
        margin-top: 38px;
      }
      .group-title {
        display: flex;
        align-items: center;
        gap: 8px;
        font-family: 'Sora', system-ui, sans-serif;
        font-size: 1.05rem;
        font-weight: 600;
        margin: 0 0 14px;
        letter-spacing: -0.01em;
      }
      .group-title app-cmd-glyph {
        color: var(--ps-accent, #00e5ff);
        font-size: 1rem;
      }
      .group-title .muted {
        font-weight: 400;
        opacity: 0.55;
        font-size: 0.92rem;
      }
      .cards {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(248px, 1fr));
        gap: 12px;
      }
      .card-cell {
        position: relative;
        animation: dashCardIn 0.333s cubic-bezier(0.16, 1, 0.3, 1) both;
      }
      @keyframes dashCardIn {
        from {
          opacity: 0;
          transform: translateY(12px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }
      .sec-card {
        display: flex;
        align-items: flex-start;
        gap: 13px;
        height: 100%;
        padding: 15px 16px;
        background: rgba(8, 8, 32, 0.45);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 14px;
        text-decoration: none;
        color: inherit;
        transition:
          border-color 0.333s ease,
          transform 0.333s ease,
          background 0.333s ease,
          box-shadow 0.333s ease;
      }
      .sec-card:hover {
        border-color: rgba(0, 229, 255, 0.5);
        background: rgba(0, 229, 255, 0.04);
        transform: translateY(-2px);
        box-shadow: 0 16px 40px -26px rgba(0, 229, 255, 0.55);
      }
      .sec-card:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 2px;
      }
      .sec-glyph {
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 38px;
        height: 38px;
        border-radius: 10px;
        font-size: 1.15rem;
        color: var(--ps-accent, #00e5ff);
        background: rgba(0, 229, 255, 0.08);
        border: 1px solid rgba(0, 229, 255, 0.18);
        transition: transform 0.333s ease;
      }
      .sec-card:hover .sec-glyph {
        transform: scale(1.06);
      }
      .sec-body {
        display: flex;
        flex-direction: column;
        gap: 4px;
        flex: 1;
        min-width: 0;
      }
      .sec-label {
        font-size: 0.95rem;
        font-weight: 600;
      }
      .sec-label mark {
        background: rgba(0, 229, 255, 0.28);
        color: inherit;
        border-radius: 3px;
        padding: 0 1px;
      }
      .sec-desc {
        font-size: 0.8rem;
        line-height: 1.45;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 62%, transparent);
        text-wrap: pretty;
      }
      .sec-tags {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
        margin-top: 4px;
      }
      .tag {
        font-size: 0.62rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        padding: 2px 7px;
        border-radius: 999px;
        background: rgba(124, 58, 237, 0.14);
        border: 1px solid rgba(124, 58, 237, 0.22);
        color: color-mix(in oklch, #b794f6 70%, var(--ps-ink) 30%);
      }
      .sec-cta {
        align-self: center;
        font-size: 1.1rem;
        opacity: 0;
        transform: translateX(-4px);
        transition:
          opacity 0.333s ease,
          transform 0.333s ease;
        color: var(--ps-accent, #00e5ff);
      }
      .sec-card:hover .sec-cta {
        opacity: 1;
        transform: translateX(0);
      }
      .sec-pin {
        position: absolute;
        top: 9px;
        right: 9px;
        width: 26px;
        height: 26px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 8px;
        border: 1px solid transparent;
        background: transparent;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 78%, var(--ps-bg, #060610));
        cursor: pointer;
        opacity: 0;
        font-size: 0.85rem;
        transition:
          opacity 0.333s ease,
          color 0.333s ease,
          border-color 0.333s ease,
          transform 0.333s ease;
      }
      .card-cell:hover .sec-pin,
      .sec-pin:focus-visible,
      .sec-pin.is-pinned {
        opacity: 1;
      }
      .sec-pin:hover {
        color: var(--ps-accent, #00e5ff);
        border-color: rgba(0, 229, 255, 0.4);
        transform: translateY(-1px);
      }
      .sec-pin.is-pinned {
        color: #fbbf24;
      }
      .sec-pin:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 2px;
      }

      /* Tips */
      .tips {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(248px, 1fr));
        gap: 12px;
      }
      .tip {
        display: flex;
        align-items: center;
        gap: 11px;
        padding: 13px 15px;
        background: rgba(124, 58, 237, 0.06);
        border: 1px solid rgba(124, 58, 237, 0.16);
        border-radius: 12px;
        font-size: 0.86rem;
        line-height: 1.4;
        transition:
          border-color 0.333s ease,
          transform 0.333s ease;
      }
      .tip:hover {
        border-color: rgba(124, 58, 237, 0.4);
        transform: translateY(-1px);
      }
      .tip-glyph {
        flex-shrink: 0;
        font-size: 1.05rem;
        color: color-mix(in oklch, #7c3aed 50%, var(--ps-ink, #f4f4ff) 50%);
      }

      /* Links */
      .links {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
      .links a {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        min-height: 40px;
        padding: 0 15px;
        border-radius: 999px;
        background: rgba(8, 8, 32, 0.5);
        border: 1px solid rgba(255, 255, 255, 0.08);
        color: var(--ps-ink, #f4f4ff);
        text-decoration: none;
        font-size: 0.85rem;
        transition:
          border-color 0.333s ease,
          transform 0.333s ease;
      }
      .links a app-cmd-glyph {
        font-size: 1rem;
        color: var(--ps-accent, #00e5ff);
      }
      .links a:hover {
        border-color: rgba(0, 229, 255, 0.5);
        transform: translateY(-1px);
      }
      .links a:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 2px;
      }
      .stat {
        margin: 16px 0 0;
        font-size: 0.9rem;
        opacity: 0.7;
      }
      /* ── Command-center loading skeleton + reserve (kills the CLS from Site status +
         CWV inserting after their async fetches; see the template comment). ── */
      .cc-slot.cc-reserve {
        /* ≥ the loaded status+CWV height incl. section margins (measured 317px) so the
           slot never grows when data lands — the skeleton→content swap is height-neutral. */
        min-height: 324px;
      }
      .cc-skeleton {
        margin-bottom: 8px;
      }
      .cc-skel-line {
        height: 14px;
        border-radius: 6px;
        background: rgba(255, 255, 255, 0.06);
        margin-bottom: 12px;
      }
      .cc-skel-strip {
        display: grid;
        gap: 10px;
        grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
      }
      .cc-skel-tile {
        height: 74px;
        border-radius: var(--ps-radius-lg, 14px);
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(255, 255, 255, 0.06);
      }
      .cc-skel-pills {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .cc-skel-pill {
        height: 44px;
        width: 92px;
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(255, 255, 255, 0.06);
      }
      .cc-skeleton > * {
        animation: cc-pulse 1.4s ease-in-out infinite;
      }
      @keyframes cc-pulse {
        0%,
        100% {
          opacity: 0.5;
        }
        50% {
          opacity: 0.85;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .cc-skeleton > * {
          animation: none;
        }
      }
      @media (max-width: 640px) {
        .cc-slot.cc-reserve {
          min-height: 364px;
        }
      }

      /* ── Site-status command-center strip (P4) ── */
      .status-source {
        margin: -2px 0 10px;
        font-family: var(--ps-font-code, 'Fira Code', ui-monospace, monospace);
        font-size: 0.62rem;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        /* 66% (not 45%) so this 0.62rem caption clears WCAG AA 4.5:1 on the dark
           bg — the axe serious color-contrast advisory the real-Chrome sweep flagged. */
        color: rgba(255, 255, 255, 0.66);
      }
      .status-strip {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: 10px;
        grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
      }
      .status-tile {
        display: grid;
        grid-template-columns: auto auto 1fr;
        align-items: center;
        gap: 4px 8px;
        padding: 12px 14px;
        text-decoration: none;
        color: inherit;
        cursor: pointer;
        background: var(--ps-surface-1, rgba(255, 255, 255, 0.03));
        border: 1px solid var(--ps-hairline, rgba(255, 255, 255, 0.08));
        border-radius: var(--ps-radius-lg, 14px);
        transition:
          border-color 0.333s ease,
          transform 0.333s cubic-bezier(0.16, 1, 0.3, 1),
          background 0.333s ease;
      }
      .status-tile:hover {
        transform: translateY(-2px);
        border-color: var(--ps-accent, #00e5ff);
      }
      .status-tile:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 2px;
      }
      .status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--ps-text-muted, #7aa7b3);
      }
      .status-count {
        grid-column: 2;
        font-size: 1.5rem;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        color: #e8fbff;
      }
      .status-label {
        grid-column: 1 / -1;
        font-size: 0.82rem;
        font-weight: 600;
        color: #e8fbff;
      }
      .status-interp {
        grid-column: 1 / -1;
        font-size: 0.68rem;
        color: var(--ps-text-muted, rgba(255, 255, 255, 0.5));
      }
      .status-tile.tone-published .status-dot {
        background: var(--ps-success, #4dffb5);
      }
      .status-tile.tone-building .status-dot {
        background: var(--ps-accent, #00e5ff);
      }
      .status-tile.tone-draft .status-dot {
        background: rgba(255, 255, 255, 0.4);
      }
      .status-tile.tone-error .status-dot {
        background: #ff4d6d;
      }
      .status-tile.tone-error {
        border-color: color-mix(in oklch, #ff4d6d 30%, transparent);
      }
      @media (prefers-reduced-motion: reduce) {
        .status-tile:hover {
          transform: none;
        }
      }

      /* ══ Operator cockpit (KPI strip + Needs-attention queue) ══ */
      .cockpit {
        margin: 4px 0 30px;
        padding: 18px 18px 20px;
        border: 1px solid var(--ps-hairline, rgba(255, 255, 255, 0.08));
        border-radius: var(--ps-radius-xl, 22px);
        background:
          radial-gradient(
            120% 140% at 0% 0%,
            color-mix(in oklch, var(--ps-accent, #00e5ff) 7%, transparent),
            transparent 60%
          ),
          var(--ps-surface-1, rgba(255, 255, 255, 0.02));
      }
      .cockpit-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      .cockpit-head .group-title {
        margin: 0;
      }
      .cockpit-live {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-family: var(--ps-font-code, 'Fira Code', ui-monospace, monospace);
        font-size: 0.62rem;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--ps-success, #4dffb5);
      }
      .cockpit-live-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--ps-success, #4dffb5);
        box-shadow: 0 0 0 0 color-mix(in oklch, var(--ps-success, #4dffb5) 60%, transparent);
        animation: cockpit-pulse 2.4s ease-out infinite;
      }
      @keyframes cockpit-pulse {
        0% {
          box-shadow: 0 0 0 0 color-mix(in oklch, var(--ps-success, #4dffb5) 55%, transparent);
        }
        70% {
          box-shadow: 0 0 0 7px transparent;
        }
        100% {
          box-shadow: 0 0 0 0 transparent;
        }
      }

      /* KPI tile strip */
      .kpi-strip {
        list-style: none;
        margin: 4px 0 6px;
        padding: 0;
        display: grid;
        gap: 10px;
        grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
      }
      .kpi-tile {
        display: grid;
        grid-template-rows: auto auto auto auto;
        gap: 3px;
        padding: 12px 14px;
        border: 1px solid var(--ps-hairline, rgba(255, 255, 255, 0.08));
        border-radius: var(--ps-radius-lg, 16px);
        background: var(--ps-surface-1, rgba(255, 255, 255, 0.03));
        transition:
          border-color 0.333s ease,
          transform 0.333s cubic-bezier(0.16, 1, 0.3, 1);
      }
      .kpi-tile:hover {
        transform: translateY(-2px);
        border-color: var(--ps-accent-line, rgba(0, 229, 255, 0.28));
      }
      .kpi-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .kpi-glyph {
        display: inline-flex;
        color: var(--ps-accent, #00e5ff);
        opacity: 0.9;
      }
      .kpi-glyph app-cmd-glyph {
        width: 16px;
        height: 16px;
        display: inline-flex;
      }
      .kpi-live-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--ps-text-muted, rgba(255, 255, 255, 0.4));
        animation: cockpit-pulse 2.8s ease-out infinite;
      }
      .kpi-value {
        font-size: 1.6rem;
        font-weight: 700;
        line-height: 1.1;
        font-variant-numeric: tabular-nums;
        color: #e8fbff;
      }
      .kpi-label {
        font-size: 0.8rem;
        font-weight: 600;
        color: #e8fbff;
      }
      .kpi-sub {
        font-size: 0.66rem;
        /* 0.66 alpha ≈ AA on the dark bg (mirrors .status-source contrast fix). */
        color: rgba(255, 255, 255, 0.66);
      }
      .kpi-tile.tone-good .kpi-glyph,
      .kpi-tile.tone-good .kpi-live-dot {
        color: var(--ps-success, #4dffb5);
        background: var(--ps-success, #4dffb5);
      }
      .kpi-tile.tone-good .kpi-glyph {
        background: none;
      }
      .kpi-tile.tone-building .kpi-glyph,
      .kpi-tile.tone-building .kpi-live-dot {
        color: var(--ps-accent, #00e5ff);
        background: var(--ps-accent, #00e5ff);
      }
      .kpi-tile.tone-building .kpi-glyph {
        background: none;
      }
      .kpi-tile.tone-attention {
        border-color: color-mix(in oklch, #ff4d6d 30%, transparent);
      }
      .kpi-tile.tone-attention .kpi-glyph,
      .kpi-tile.tone-attention .kpi-live-dot {
        color: #ff4d6d;
        background: #ff4d6d;
      }
      .kpi-tile.tone-attention .kpi-glyph {
        background: none;
      }

      /* Needs-attention queue */
      .cockpit-sub {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 14px 0 8px;
        font-size: 0.82rem;
        font-weight: 600;
        color: #e8fbff;
      }
      .cockpit-sub app-cmd-glyph {
        width: 16px;
        height: 16px;
        color: var(--ps-accent, #00e5ff);
      }
      .attn-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .attn-row {
        display: grid;
        grid-template-columns: auto 1fr auto auto;
        align-items: center;
        gap: 4px 12px;
        padding: 11px 14px;
        cursor: pointer;
        border: 1px solid color-mix(in oklch, #ff4d6d 26%, transparent);
        border-left-width: 3px;
        border-radius: var(--ps-radius-md, 12px);
        background: color-mix(in oklch, #ff4d6d 6%, transparent);
        transition:
          border-color 0.333s ease,
          transform 0.333s cubic-bezier(0.16, 1, 0.3, 1);
      }
      .attn-row:hover {
        transform: translateY(-1px);
        border-color: #ff4d6d;
      }
      .attn-row:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 2px;
      }
      .attn-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #ff4d6d;
      }
      .attn-body {
        display: flex;
        flex-direction: column;
        gap: 1px;
        min-width: 0;
      }
      .attn-name {
        font-size: 0.86rem;
        font-weight: 600;
        color: #e8fbff;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .attn-reason {
        font-size: 0.7rem;
        color: rgba(255, 255, 255, 0.66);
      }
      .attn-status {
        font-family: var(--ps-font-code, 'Fira Code', ui-monospace, monospace);
        font-size: 0.6rem;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: #ff9db0;
      }
      .attn-action {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-height: 36px;
        padding: 0 14px;
        font: inherit;
        font-size: 0.78rem;
        font-weight: 600;
        cursor: pointer;
        color: var(--ps-ink, #f4f4ff);
        background: rgba(0, 229, 255, 0.06);
        border: 1px solid rgba(0, 229, 255, 0.28);
        border-radius: 999px;
        transition:
          border-color 0.333s ease,
          transform 0.333s ease;
      }
      .attn-action app-cmd-glyph {
        width: 14px;
        height: 14px;
      }
      .attn-action:hover {
        transform: translateY(-1px);
        border-color: rgba(0, 229, 255, 0.55);
      }
      .attn-action:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 2px;
      }
      .attn-clear {
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
        gap: 4px;
        padding: 18px 14px;
        border: 1px dashed color-mix(in oklch, var(--ps-success, #4dffb5) 26%, transparent);
        border-radius: var(--ps-radius-md, 12px);
        background: color-mix(in oklch, var(--ps-success, #4dffb5) 5%, transparent);
      }
      .attn-clear-glyph {
        display: inline-flex;
        color: var(--ps-success, #4dffb5);
      }
      .attn-clear-glyph app-cmd-glyph {
        width: 22px;
        height: 22px;
      }
      .attn-clear-title {
        margin: 2px 0 0;
        font-size: 0.9rem;
        font-weight: 600;
        color: #e8fbff;
      }
      .attn-clear-sub {
        margin: 0;
        font-size: 0.72rem;
        color: rgba(255, 255, 255, 0.66);
      }
      @media (prefers-reduced-motion: reduce) {
        .kpi-tile:hover,
        .attn-row:hover,
        .attn-action:hover {
          transform: none;
        }
        .cockpit-live-dot,
        .kpi-live-dot {
          animation: none;
        }
      }

      .stat app-rolling-counter {
        font-weight: 700;
        color: var(--ps-accent, #00e5ff);
        font-variant-numeric: tabular-nums;
      }
      .cta {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        min-height: 42px;
        padding: 0 18px;
        border-radius: 999px;
        font: inherit;
        font-weight: 600;
        cursor: pointer;
        text-decoration: none;
        transition:
          transform 0.333s ease,
          border-color 0.333s ease;
      }
      .cta-ghost {
        background: rgba(0, 229, 255, 0.05);
        border: 1px solid rgba(0, 229, 255, 0.22);
        color: var(--ps-ink, #f4f4ff);
      }
      .cta-ghost:hover {
        transform: translateY(-1px);
        border-color: rgba(0, 229, 255, 0.5);
      }
      .cta:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 2px;
      }

      /* CWV strip */
      .cwv-strip {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        list-style: none;
        padding: 0;
        margin: 8px 0 0;
      }
      .cwv-empty {
        /* 0.66 alpha ≈ 6.5:1 on the dark bg — clears WCAG AA (matches .status-source fix). */
        color: rgba(255, 255, 255, 0.66);
        font-size: 13px;
        line-height: 1.5;
        max-width: 560px;
        margin: 8px 0 0;
      }
      /* First-action on the CWV empty state — every sibling empty state (Voice, */
      /* Deliverability) offers a next step; this one was a passive dead-end.     */
      .cwv-cta {
        display: inline-block;
        margin-top: 10px;
        font-size: 13px;
        font-weight: 600;
        color: var(--ps-accent, #00e5ff);
        text-decoration: none;
      }
      .cwv-cta:hover {
        text-decoration: underline;
      }
      .cwv-cta:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 3px;
        border-radius: 4px;
      }
      .cwv-chip {
        display: inline-flex;
        flex-direction: column;
        align-items: center;
        gap: 2px;
        min-width: 64px;
        padding: 8px 12px;
        border-radius: 10px;
        border: 1px solid rgba(255, 255, 255, 0.1);
        background: rgba(8, 8, 32, 0.45);
        cursor: default;
        transition: border-color 0.2s ease;
      }
      .cwv-label {
        font-size: 0.62rem;
        text-transform: uppercase;
        letter-spacing: 0.07em;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent);
      }
      .cwv-value {
        font-size: 0.88rem;
        font-weight: 600;
        font-family: 'JetBrains Mono', monospace;
        color: var(--ps-ink, #f4f4ff);
      }
      .cwv-chip[data-tier='green'] {
        border-color: rgba(34, 197, 94, 0.4);
        background: rgba(34, 197, 94, 0.07);
      }
      .cwv-chip[data-tier='green'] .cwv-value {
        color: #4ade80;
      }
      .cwv-chip[data-tier='yellow'] {
        border-color: rgba(234, 179, 8, 0.4);
        background: rgba(234, 179, 8, 0.07);
      }
      .cwv-chip[data-tier='yellow'] .cwv-value {
        color: #facc15;
      }
      .cwv-chip[data-tier='red'] {
        border-color: rgba(239, 68, 68, 0.4);
        background: rgba(239, 68, 68, 0.07);
      }
      .cwv-chip[data-tier='red'] .cwv-value {
        color: #f87171;
      }

      @media (max-width: 720px) {
        .dash {
          padding: 18px 14px 72px;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .card-cell,
        .sec-card,
        .sec-glyph,
        .sec-cta,
        .sec-pin,
        .tip,
        .search-wrap,
        .links a {
          animation: none !important;
          transition: none !important;
        }
      }
    `,
  ],
})
export class AdminDashboardComponent {
  private state = inject(AdminStateService);
  private auth = inject(AuthService);
  private readonly api = inject(ApiService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('searchInput');

  /** Operator-only gate for the "Feature Flags" discovery card — mirrors the sidebar nav + sysAdminGuard. */
  readonly isSysAdmin = computed(() => isSysAdminEmail(this.auth.email()));
  readonly siteCount = computed(() => this.state.sites().length);
  readonly hasSites = computed(() => this.siteCount() > 0);
  /** True while the SITES fetch is in flight (AdminStateService.loading). */
  readonly isLoading = computed(() => this.state.loading());
  /** True while EITHER the sites OR the (separately-timed, ~1s later) CWV-metrics fetch
   *  is in flight — drives the command-center skeleton. Spanning both keeps the reserved
   *  .cc-slot filled until status + CWV can swap in together (zero CLS from the late CWV). */
  readonly ccLoading = computed(() => this.isLoading() || this.metricsLoading());
  readonly latestMetrics = signal<SnapshotMetrics | null>(null);
  readonly metricsLoading = signal(false);
  /**
   * True when the latest snapshot actually captured Lighthouse/CWV numbers. Cron
   * snapshots frequently store only a screenshot (all metric columns null) → we
   * show an honest "not run yet" note instead of a strip of bare "—" dashes under
   * a "real Lighthouse data" heading (reads as broken). Caught by the dashboard
   * AI-vision pass 2026-08-02.
   */
  readonly hasCwvData = computed(() => {
    const m = this.latestMetrics();
    return (
      !!m &&
      (m.lcp_ms !== null ||
        m.cls !== null ||
        m.inp_ms !== null ||
        m.tbt_ms !== null ||
        m.lh_performance !== null)
    );
  });
  readonly activeSiteDomain = computed(() => {
    const site = this.state.selectedSite() ?? this.state.sites()[0];
    return (site as { domain?: string })?.domain ?? null;
  });

  constructor() {
    effect(() => {
      const site = this.state.selectedSite() ?? this.state.sites()[0];
      if (site) {
        this.loadLatestMetrics(site.id);
      } else {
        this.latestMetrics.set(null);
      }
    });
  }

  /**
   * Command-center site-status summary (P4) — derived from the ALREADY-loaded
   * `state.sites()` (no new fetch), bucketed via the shared `getStatusClass`
   * map. Each bucket is a metric→record link to the FIRST matching site's detail
   * (`/admin/sites/:id`). The `/admin/sites` LIST route resolves a real
   * AdminSitesComponent grid, but these tiles deep-link straight to the site
   * itself — where a failed build is retried, fulfilling the "open to retry" affordance.
   * Only non-zero buckets render; `attention` (error/failed) is surfaced first.
   */
  readonly siteStatusSummary = computed(() => {
    const buckets: Record<string, number> = { published: 0, building: 0, draft: 0, error: 0 };
    const firstId: Record<string, string | undefined> = {};
    for (const s of this.state.sites()) {
      let cls = this.state.getStatusClass(s.status);
      // A 'published' site with NO build serves the branded 503 ("the last build
      // didn't finish") — it is NOT live/serving. Count it as needs-attention so
      // the strip reflects real health (never "Live · published + serving" for a
      // site that 503s). Mirrors the public-search lying-published guard.
      if (cls === 'published' && !s.current_build_version) cls = 'error';
      buckets[cls] = (buckets[cls] ?? 0) + 1;
      firstId[cls] ??= s.id; // first site in the bucket = the tile's drill-in target
    }
    const defs: { key: string; label: string; interp: string; tone: string }[] = [
      {
        key: 'error',
        label: 'Needs attention',
        interp: 'build failed — open to retry',
        tone: 'error',
      },
      { key: 'published', label: 'Live', interp: 'published + serving', tone: 'published' },
      { key: 'building', label: 'Building', interp: 'generating or deploying', tone: 'building' },
      { key: 'draft', label: 'Draft', interp: 'not yet published', tone: 'draft' },
    ];
    // siteId is non-null for every emitted bucket: a bucket only survives the
    // count>0 filter when ≥1 site set firstId for it in the loop above.
    return defs
      .filter((d) => buckets[d.key] > 0)
      .map((d) => ({ ...d, count: buckets[d.key], siteId: firstId[d.key] as string }));
  });

  /** True when a 'published' site has no finished build → it serves the branded
   *  503, so it is NOT actually live. Mirrors the `siteStatusSummary` guard +
   *  the public-search lying-published check. A single source for both the KPI
   *  "Live" count and the attention queue so they can never disagree. */
  private isServingLive(s: Site): boolean {
    return s.status === 'published' && !!s.current_build_version;
  }

  /** True while a site is mid-build (any pre-published working status). */
  private isBuildingSite(s: Site): boolean {
    return this.state.isBuilding(s);
  }

  /**
   * Operator KPI strip — real metrics only, straight off the already-loaded
   * `AdminStateService` signals (zero new fetches). A tile is OMITTED, never
   * faked, when its underlying data isn't provided:
   *  - "Sites live" / "Total sites": always (sites list is loaded).
   *  - "Building now": only when ≥1 site is mid-build.
   *  - "Custom domains": only when `domainSummary().total > 0` (else the service
   *    has no domains to report — omitted, not shown as 0).
   *  - "Plan": only when a subscription record exists.
   * Analytics / leads / form-submission counts are intentionally absent — the
   * service does NOT expose them here, so no tile is invented for them.
   */
  readonly kpiTiles = computed<readonly KpiTile[]>(() => {
    const sites = this.state.sites();
    const tiles: KpiTile[] = [];
    if (sites.length === 0) return tiles;

    const live = sites.filter((s) => this.isServingLive(s)).length;
    const building = sites.filter((s) => this.isBuildingSite(s)).length;

    tiles.push({
      key: 'live',
      label: 'Sites live',
      value: live,
      display: null,
      sub: live === 1 ? 'site published + serving' : 'sites published + serving',
      glyph: 'globe',
      tone: live > 0 ? 'good' : 'neutral',
      numeric: true,
    });
    tiles.push({
      key: 'total',
      label: 'Total sites',
      value: sites.length,
      display: null,
      sub: 'in your account',
      glyph: 'grid',
      tone: 'accent',
      numeric: true,
    });
    if (building > 0) {
      tiles.push({
        key: 'building',
        label: 'Building now',
        value: building,
        display: null,
        sub: 'generating or deploying',
        glyph: 'rocket',
        tone: 'building',
        numeric: true,
      });
    }
    const attention = this.attentionItems().length;
    if (attention > 0) {
      tiles.push({
        key: 'attention',
        label: 'Needs attention',
        value: attention,
        display: null,
        sub: attention === 1 ? 'site needs a look' : 'sites need a look',
        glyph: 'shield',
        tone: 'attention',
        numeric: true,
      });
    }
    const domains = this.state.domainSummary();
    // `?? 0` defense-in-depth: `DomainSummary` TYPES these as required numbers, but a
    // wire-shape drift (the worker's nested `{ by_status }` envelope assigned verbatim)
    // once left them `undefined` here — binding `undefined` into the numeric KPI tile's
    // <app-rolling-counter> crashed `format()` (`undefined.toLocaleString()`). ApiService
    // now flattens the wire so this is belt-and-suspenders; keep it so no future producer
    // drift can crash this first-paint tile. (fire #34)
    const domTotal = domains.total ?? 0;
    const domActive = domains.active ?? 0;
    const domPending = domains.pending ?? 0;
    const domFailed = domains.failed ?? 0;
    if (domTotal > 0) {
      tiles.push({
        key: 'domains',
        label: 'Custom domains',
        value: domActive,
        display: null,
        sub:
          domPending > 0
            ? `${domPending} pending setup`
            : domFailed > 0
              ? `${domFailed} need attention`
              : 'active + verified',
        glyph: 'globe',
        tone: domFailed > 0 ? 'attention' : domActive > 0 ? 'good' : 'neutral',
        numeric: true,
      });
    }
    const sub = this.state.subscription();
    if (sub) {
      tiles.push({
        key: 'plan',
        label: 'Plan',
        value: 0,
        display: this.titleCase(sub.plan),
        sub: sub.status ? this.titleCase(sub.status) : 'current plan',
        glyph: 'credit-card',
        tone: sub.status === 'active' || sub.status === 'trialing' ? 'good' : 'neutral',
        numeric: false,
      });
    }
    return tiles;
  });

  /**
   * Actionable "Needs attention" queue — every site that is in `error`/`failed`
   * or is `published` without a finished build (lying-published → serves 503).
   * Real rows only; an empty result renders a truthful "all clear" state, never
   * a fabricated list. Each row's action reuses an existing affordance.
   */
  readonly attentionItems = computed<readonly AttentionItem[]>(() =>
    this.state
      .sites()
      .filter((s) => {
        const cls = this.state.getStatusClass(s.status);
        return cls === 'error' || (s.status === 'published' && !s.current_build_version);
      })
      .map<AttentionItem>((s) => {
        const failedBuild = s.status === 'published' && !s.current_build_version;
        return {
          siteId: s.id,
          name: s.business_name || s.slug,
          status: failedBuild ? 'incomplete' : this.state.getStatusLabel(s.status),
          reason: failedBuild
            ? 'Published but the last build didn’t finish — it serves an error page.'
            : 'The build failed. Rebuild to try again.',
          actionLabel: 'Rebuild',
          action: 'rebuild',
        };
      }),
  );

  /** Rebuild a site from the attention queue — reuses the existing waiting flow
   *  (`goToWaiting`), the same path the site-status tiles + waiting page use. */
  rebuildFromQueue(item: AttentionItem): void {
    const site = this.state.sites().find((s) => s.id === item.siteId);
    if (site) this.state.goToWaiting(site);
  }

  /** Small helper: Title-Case a plan/status token ("active" → "Active"). */
  private titleCase(v: string): string {
    if (!v) return '';
    return v.charAt(0).toUpperCase() + v.slice(1).toLowerCase();
  }

  /** Live search query. Empty → grouped view; non-empty → flat filtered results. */
  readonly query = signal('');

  private readonly favorites = signal<readonly string[]>(this.readList(FAV_KEY));
  private readonly recents = signal<readonly string[]>(this.readList(RECENT_KEY));

  /** Section guide, grouped by what a customer is trying to do. Every link resolves to a live admin route. */
  readonly groups: readonly SectionGroup[] = [
    {
      title: 'Build your site',
      cards: [
        {
          label: 'Editor',
          desc: 'Edit your site’s code and content in the live Bolt editor.',
          link: '/admin/editor',
          glyph: 'code',
          keywords: ['bolt', 'code', 'content', 'build'],
        },
        {
          label: 'Snapshots',
          desc: 'Frozen versions of every build — preview, restore, or roll back.',
          link: '/admin/snapshots',
          glyph: 'camera',
          keywords: ['versions', 'restore', 'rollback', 'history'],
        },
        {
          label: 'Domains',
          desc: 'Connect a custom domain and manage your hostnames.',
          link: '/admin/domains',
          glyph: 'globe',
          keywords: ['dns', 'hostname', 'custom', 'ssl'],
        },
      ],
    },
    {
      title: 'Grow your audience',
      cards: [
        {
          label: 'Analytics',
          desc: 'Traffic, conversions, and funnel insight for every site.',
          link: '/admin/analytics',
          glyph: 'chart',
          keywords: ['traffic', 'conversions', 'funnel', 'metrics'],
        },
        {
          label: 'SEO',
          desc: 'Titles, meta, structured data, and search readiness.',
          link: '/admin/seo',
          glyph: 'search',
          keywords: ['meta', 'schema', 'keywords', 'ranking'],
        },
        {
          label: 'Social',
          desc: 'Compose, schedule, and measure posts across 11 networks.',
          link: '/admin/social',
          glyph: 'share',
          keywords: ['posts', 'schedule', 'twitter', 'linkedin'],
        },
        {
          label: 'Forms',
          desc: 'Every form submission, routed and searchable.',
          link: '/admin/forms',
          glyph: 'inbox',
          keywords: ['submissions', 'leads', 'contact'],
        },
      ],
    },
    {
      title: 'Operate & monitor',
      cards: [
        {
          label: 'Voice',
          desc: 'A phone number, SMS, and a browser test console.',
          link: '/admin/voice',
          glyph: 'phone',
          keywords: ['phone', 'sms', 'call', 'number'],
        },
        {
          label: 'Apps',
          desc: 'A self-hostable app store on Cloudflare Containers.',
          link: '/admin/apps',
          glyph: 'grid',
          keywords: ['marketplace', 'install', 'containers', 'self-host'],
        },
        {
          label: 'Traces',
          desc: 'Every AI call — forms, chat, endpoints, and search.',
          link: '/admin/traces',
          glyph: 'activity',
          keywords: ['ai', 'llm', 'observability', 'calls'],
        },
        {
          label: 'Logs',
          desc: 'Audit trail plus structured request, AI, and job logs.',
          link: '/admin/logs',
          glyph: 'list',
          keywords: ['audit', 'requests', 'jobs', 'debug'],
        },
      ],
    },
    {
      title: 'Account & help',
      cards: [
        {
          label: 'Settings',
          desc: 'Site preferences, integrations, and notifications.',
          link: '/admin/settings',
          glyph: 'gear',
          keywords: ['preferences', 'integrations', 'mcp', 'webhooks'],
        },
        {
          label: 'Billing',
          desc: 'Your plan, credits, and invoices in one place.',
          link: '/admin/billing',
          glyph: 'credit-card',
          keywords: ['plan', 'credits', 'invoices', 'subscription'],
        },
        {
          label: 'API Docs',
          desc: 'An interactive explorer — call any endpoint from your session.',
          link: '/admin/docs',
          glyph: 'book',
          keywords: ['openapi', 'reference', 'endpoints'],
        },
        {
          label: 'Features',
          desc: 'Turn site capabilities on — plan-aware and reversible.',
          link: '/admin/site-features',
          glyph: 'layers',
          keywords: ['capabilities', 'addons', 'plan', 'autopilot'],
        },
      ],
    },
  ];

  private readonly sysAdminTools: SectionGroup = {
    title: 'More tools',
    cards: [
      {
        label: 'Mail',
        desc: 'Self-hosted Listmonk — newsletters, campaigns, and transactional email.',
        link: 'https://mail.projectsites.dev',
        glyph: 'mail',
        keywords: ['email', 'listmonk', 'newsletter', 'campaigns'],
        external: true,
      },
      {
        label: 'CRM',
        desc: 'Twenty CRM — contacts, companies, deals, and workflows.',
        link: 'https://crm.projectsites.dev',
        glyph: 'users',
        keywords: ['twenty', 'crm', 'contacts', 'deals', 'sales'],
        external: true,
      },
      {
        label: 'Social',
        desc: 'Native social scheduling — compose, schedule, measure across 14 platforms.',
        link: '/admin/social',
        glyph: 'send',
        keywords: ['posts', 'schedule', 'social-media'],
        external: false,
      },
      {
        label: 'CMS',
        desc: 'Payload CMS — headless content management for teams.',
        link: 'https://cms.projectsites.dev',
        glyph: 'file-text',
        keywords: ['payload', 'content', 'headless', 'cms'],
        external: true,
      },
    ],
  };

  /** Operator-only discovery card (Feature Flags) appended when the user is a sysadmin. */
  private readonly operatorCard: SectionCard = {
    label: 'Feature Flags',
    desc: 'Platform-ops control plane — toggle, roll out, and killswitch feature flags.',
    link: '/admin/feature-flags',
    glyph: 'gear',
    keywords: ['flags', 'rollout', 'killswitch', 'ops'],
  };

  /** Groups shown in the default view — appends an operator-only "Operator" group when applicable. */
  readonly displayGroups = computed<readonly SectionGroup[]>(() =>
    this.isSysAdmin()
      ? [...this.groups, { title: 'Operator', cards: [this.operatorCard] }, this.sysAdminTools]
      : this.groups,
  );

  /** Flat list of every visible card (operator card included only for sysadmins). */
  private readonly allCards = computed<readonly SectionCard[]>(() =>
    this.displayGroups().flatMap((g) => g.cards),
  );

  private byLink(links: readonly string[]): readonly SectionCard[] {
    const all = this.allCards();
    return links.map((l) => all.find((c) => c.link === l)).filter((c): c is SectionCard => !!c);
  }

  readonly pinnedCards = computed(() => this.byLink(this.favorites()));
  readonly recentCards = computed(() => this.byLink(this.recents()).slice(0, 4));

  /** Filtered results when a query is active; null when the box is empty (→ grouped view). */
  readonly filtered = computed<readonly SectionCard[] | null>(() => {
    const q = this.query().trim().toLowerCase();
    if (!q) return null;
    return this.allCards().filter((c) => {
      const hay = `${c.label} ${c.desc} ${(c.keywords ?? []).join(' ')}`.toLowerCase();
      return hay.includes(q);
    });
  });

  /** SR-only live announcement of the result count. */
  readonly resultAnnounce = computed(() => {
    const f = this.filtered();
    if (f === null) return '';
    return f.length === 0
      ? `No results for ${this.query()}`
      : `${f.length} ${f.length === 1 ? 'result' : 'results'}`;
  });

  /** Keyboard + workflow tricks most customers never discover on their own. */
  readonly tips: readonly Tip[] = [
    { glyph: 'command', text: 'Press ⌘K (or Ctrl+K) to jump to any section or action instantly.' },
    { glyph: 'search', text: 'Press / to focus this search and filter every section as you type.' },
    {
      glyph: 'star',
      text: 'Hover a card and tap the ☆ to pin your most-used sections to the top.',
    },
    { glyph: 'image', text: 'Drag a file onto any admin page to add it to your Media library.' },
  ];

  /** Split a label around the active query match so the template can wrap the hit in <mark> (no innerHTML). */
  parts(label: string): readonly HlParts[] {
    const q = this.query().trim();
    if (!q) return [{ pre: label, hit: '', post: '' }];
    const idx = label.toLowerCase().indexOf(q.toLowerCase());
    if (idx < 0) return [{ pre: label, hit: '', post: '' }];
    return [
      {
        pre: label.slice(0, idx),
        hit: label.slice(idx, idx + q.length),
        post: label.slice(idx + q.length),
      },
    ];
  }

  clear(): void {
    this.query.set('');
    this.searchInput()?.nativeElement.focus();
  }

  isFav(link: string): boolean {
    return this.favorites().includes(link);
  }

  toggleFav(link: string): void {
    const next = this.isFav(link)
      ? this.favorites().filter((l) => l !== link)
      : [...this.favorites(), link];
    this.favorites.set(next);
    this.writeList(FAV_KEY, next);
  }

  /** Record an opened section (most-recent-first, deduped, capped) for the "Jump back in" row. */
  recordOpen(link: string): void {
    const next = [link, ...this.recents().filter((l) => l !== link)].slice(0, 8);
    this.recents.set(next);
    this.writeList(RECENT_KEY, next);
  }

  /** Focus the search box on "/" (unless already typing in a field). */
  @HostListener('document:keydown./', ['$event'])
  onSlash(ev: Event): void {
    const t = ev.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    ev.preventDefault();
    this.searchInput()?.nativeElement.focus();
  }

  /** Esc clears an active query. */
  @HostListener('document:keydown.escape')
  onEsc(): void {
    if (this.query()) this.clear();
  }

  private readList(key: string): readonly string[] {
    try {
      const raw = localStorage.getItem(key);
      const arr = raw ? (JSON.parse(raw) as unknown) : [];
      return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  private writeList(key: string, val: readonly string[]): void {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch {
      /* private mode / quota — non-fatal */
    }
  }

  private loadLatestMetrics(siteId: string): void {
    this.metricsLoading.set(true);
    // `silent: true` — CWV is a non-critical background widget that already
    // degrades gracefully to "—". Without this, a transient status-0 (network
    // blip) fired ApiService's alarming "Can't reach the server" toast on the
    // dashboard even though the page is fine. Fail-soft: degrade quietly, no toast;
    // 401 handling + telemetry still run. (Caught by the dashboard AI-vision pass.)
    this.api
      .get<{ data: Record<string, SnapshotMetrics | null> }>(
        `/sites/${siteId}/snapshots/metrics`,
        undefined,
        { silent: true },
      )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          const entries = Object.values(res.data ?? {});
          this.latestMetrics.set(entries.length > 0 ? (entries[0] as SnapshotMetrics) : null);
          this.metricsLoading.set(false);
        },
        error: () => {
          this.latestMetrics.set(null);
          this.metricsLoading.set(false);
        },
      });
  }

  tierForLh(value: number | null): MetricTier {
    if (value === null || value === undefined) return 'neutral';
    if (value >= 90) return 'green';
    if (value >= 50) return 'yellow';
    return 'red';
  }

  private cwvTier(value: number | null, good: number, poor: number): MetricTier {
    if (value === null || value === undefined) return 'neutral';
    if (value <= good) return 'green';
    if (value <= poor) return 'yellow';
    return 'red';
  }

  formatMs(n: number | null): string {
    if (n === null || n === undefined) return '—';
    if (n < 1000) return `${Math.round(n)}ms`;
    return `${(n / 1000).toFixed(2)}s`;
  }

  formatCls(n: number | null): string {
    if (n === null || n === undefined) return '—';
    return n.toFixed(3);
  }

  cwvPills(m: SnapshotMetrics): CwvPill[] {
    return [
      {
        key: 'lcp',
        label: 'LCP',
        rawValue: m.lcp_ms,
        formatted: this.formatMs(m.lcp_ms),
        tier: this.cwvTier(m.lcp_ms, 2500, 4000),
        budget: 4000,
        tooltip: 'Largest Contentful Paint. Good ≤2.5s · poor >4.0s.',
      },
      {
        key: 'cls',
        label: 'CLS',
        rawValue: m.cls,
        formatted: this.formatCls(m.cls),
        tier: this.cwvTier(m.cls, 0.1, 0.25),
        budget: 0.25,
        tooltip: 'Cumulative Layout Shift. Good ≤0.1 · poor >0.25.',
      },
      {
        key: 'inp',
        label: 'INP',
        rawValue: m.inp_ms,
        formatted: this.formatMs(m.inp_ms),
        tier: this.cwvTier(m.inp_ms, 200, 500),
        budget: 500,
        tooltip: 'Interaction to Next Paint. Good ≤200ms · poor >500ms.',
      },
      {
        key: 'tbt',
        label: 'TBT',
        rawValue: m.tbt_ms,
        formatted: this.formatMs(m.tbt_ms),
        tier: this.cwvTier(m.tbt_ms, 200, 600),
        budget: 600,
        tooltip: 'Total Blocking Time. Good ≤200ms · poor >600ms.',
      },
    ];
  }
}
