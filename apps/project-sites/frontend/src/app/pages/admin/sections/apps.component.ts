import {
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  ViewChild,
  computed,
  inject,
  signal,
  type AfterViewInit,
  type OnInit,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ApiService } from '../../../services/api.service';
import { EmptyStateComponent } from '../empty-state.component';
import { RevealDirective } from '../../../directives/reveal.directive';
import { RollingCounterComponent } from '../../../components/rolling-counter/rolling-counter.component';
import { HlmInputDirective, HlmTablistDirective } from '../../../ui';
import { BrnTooltipImports } from '@spartan-ng/brain/tooltip';
import {
  APP_CATEGORIES,
  APPS_CATALOG,
  isAppSupported,
  type AppCategory,
  type CatalogApp,
  type InfraDep,
} from './apps-catalog.data';

/** Lifecycle filter — Live=deployable today, soon=catalog-only placeholder. */
type LifecycleFilter = 'all' | 'live' | 'soon';

/**
 * Per-infra-dep glyph + display label for the card pill row. Matches the
 * task brief: 🐘 postgres / 🟥 redis / 🪣 s3 / 💾 sqlite / 📦 volume / 📬 mailrelay.
 */
const INFRA_META: Readonly<Record<InfraDep, { glyph: string; label: string }>> = {
  postgres: { glyph: '🐘', label: 'Postgres' },
  redis: { glyph: '🟥', label: 'Redis' },
  s3: { glyph: '🪣', label: 'R2 / S3' },
  sqlite: { glyph: '💾', label: 'SQLite' },
  volume: { glyph: '📦', label: 'Volume' },
  mailrelay: { glyph: '📬', label: 'Mail relay' },
  hyperdrive: { glyph: '⚡', label: 'Hyperdrive' },
} as const;

/**
 * Admin → Apps catalog.
 *
 * @remarks
 * Browses the curated self-hostable app catalog (grouped by category),
 * filtered live by category chip + fuzzy search. Click a card →
 * `/admin/apps/:id` detail. Cmd+/ focuses the search input.
 * Catalog structure (unique ids, valid categories, no dead chips,
 * supported-slug coherence) is locked by `apps-catalog.data.spec.ts`.
 */
@Component({
  selector: 'app-admin-apps',
  standalone: true,
  imports: [FormsModule, RouterLink, EmptyStateComponent, RevealDirective, RollingCounterComponent, HlmInputDirective, HlmTablistDirective, ...BrnTooltipImports],
  template: `
    <div class="p-7 flex-1 overflow-y-auto animate-fade-in max-md:p-4 space-y-6">

      <!-- ─────────────────── HERO HEADER ─────────────────── -->
      <header class="flex items-start justify-between gap-4 flex-wrap" appReveal>
        <div class="min-w-0">
          <div class="kicker">App store</div>
          <h1 class="section-h text-lg font-bold text-white m-0 mt-1 flex items-center gap-2">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="text-accent"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>
            Apps
            <span class="header-pill" aria-label="Catalog size" title="Apps in the catalog">
              <span class="header-pill-dot" aria-hidden="true"></span>
              <app-rolling-counter [value]="totalCount" />&nbsp;apps
            </span>
          </h1>
          <p class="text-[0.78rem] text-text-secondary m-0 mt-1 max-w-prose leading-relaxed">
            Self-hostable services launched on Cloudflare — edge Workers &amp; Containers — pick, configure, deploy in &lt;5 min.
          </p>
        </div>
        <div class="flex items-center gap-2">
          <a class="btn-ghost" routerLink="/admin/apps/instances" [brnTooltip]="'View deployed app instances'">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
            <span>My instances</span>
          </a>
        </div>
      </header>

      <!-- ─────────────────── SEARCH + CATEGORY CHIPS ─────────────────── -->
      <div class="space-y-3" appReveal>
        <label class="search-wrap" [class.is-focused]="searchFocused()">
          <svg class="search-glyph" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          <input
            #searchInput
            hlmInput
            [seamless]="true"
            type="search"
            class="flex-1 search-input"
            placeholder="Search apps by name, tagline, or tag…"
            aria-label="Search apps"
            data-testid="apps-search-input"
            [(ngModel)]="searchInputValue"
            (ngModelChange)="onSearchChange($event)"
            (focus)="searchFocused.set(true)"
            (blur)="searchFocused.set(false)"
            (keydown.escape)="clearSearch()" />
          <kbd class="search-kbd" aria-hidden="true">⌘/</kbd>
        </label>

        <!-- Lifecycle tab list + Categories filter on ONE inline row: Categories sits
             beside the strip with a left gap and stretches to the strip's height. -->
        <div class="lifecycle-row">
        <!-- Lifecycle pill row (Live vs Coming soon) -->
        <div class="lifecycle-strip" role="tablist" hlmTablist aria-label="App lifecycle">
          <button
            type="button"
            role="tab"
            class="lifecycle-pill"
            [class.active]="lifecycle() === 'all'"
            [attr.aria-selected]="lifecycle() === 'all'"
            data-testid="apps-lifecycle-all"
            (click)="setLifecycle('all')">
            <span>All</span>
            <span class="lifecycle-count" aria-hidden="true">{{ totalCount }}</span>
          </button>
          <button
            type="button"
            role="tab"
            class="lifecycle-pill lifecycle-pill--live"
            [class.active]="lifecycle() === 'live'"
            [attr.aria-selected]="lifecycle() === 'live'"
            data-testid="apps-lifecycle-live"
            (click)="setLifecycle('live')">
            <span class="lifecycle-dot" aria-hidden="true"></span>
            <span>Live</span>
            <span class="lifecycle-count" aria-hidden="true">{{ liveCount }}</span>
          </button>
          <button
            type="button"
            role="tab"
            class="lifecycle-pill lifecycle-pill--soon"
            [class.active]="lifecycle() === 'soon'"
            [attr.aria-selected]="lifecycle() === 'soon'"
            data-testid="apps-lifecycle-soon"
            (click)="setLifecycle('soon')">
            <span>Coming soon</span>
            <span class="lifecycle-count" aria-hidden="true">{{ soonCount }}</span>
          </button>
        </div>

        <!-- Category multi-select filter (brief #12) — sits beside the
             lifecycle strip; check any number of categories to union-filter. -->
        <div class="cat-filter" [class.open]="categoryMenuOpen()">
          <button
            type="button"
            class="cat-trigger"
            [class.active]="selectedCategoryCount() > 0 || categoryMenuOpen()"
            aria-haspopup="true"
            [attr.aria-expanded]="categoryMenuOpen()"
            data-testid="apps-category-filter"
            (click)="toggleCategoryMenu()">
            <span class="chip-glyph" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5h18l-7 8.2v5.3l-4 2V12.7z"/></svg></span>
            <span>Categories</span>
            @if (selectedCategoryCount() > 0) {
              <span class="cat-badge" aria-hidden="true">{{ selectedCategoryCount() }}</span>
            }
            <span class="cat-chevron" aria-hidden="true">▾</span>
          </button>

          @if (categoryMenuOpen()) {
            <button type="button" class="cat-backdrop" aria-label="Close category filter" (click)="closeCategoryMenu()"></button>
            <div class="cat-menu" role="group" aria-label="Filter by category" data-testid="apps-category-menu">
              <div class="cat-menu-head">
                <span class="cat-menu-title">Show categories</span>
                @if (selectedCategoryCount() > 0) {
                  <button type="button" class="cat-menu-clear" (click)="clearCategories()" data-testid="apps-category-clear">Clear ({{ selectedCategoryCount() }})</button>
                }
              </div>
              <ul class="cat-menu-list">
                @for (c of categories; track c.id) {
                  <li>
                    <label class="cat-opt" [class.checked]="isCategoryActive(c.id)">
                      <input type="checkbox" [checked]="isCategoryActive(c.id)" (change)="toggleCategory(c.id)" [attr.data-testid]="'apps-category-opt-' + c.id" />
                      <span class="cat-opt-glyph" aria-hidden="true">{{ c.glyph }}</span>
                      <span class="cat-opt-label">{{ c.label }}</span>
                      <span class="cat-opt-count" aria-hidden="true">{{ countByCategory(c.id) }}</span>
                    </label>
                  </li>
                }
              </ul>
            </div>
          }
        </div>
        </div>
      </div>

      <!-- Live-region result count — announces filter changes to screen readers
           AND gives sighted users a visible "N matches" cue above the grid. -->
      <div class="result-bar" appReveal>
        <span class="result-count" aria-hidden="true">
          <app-rolling-counter [value]="filteredApps().length" />
          <span class="result-label">{{ filteredApps().length === 1 ? 'match' : 'matches' }}</span>
        </span>
        @if (activeTag(); as t) {
          <button type="button" class="tag-filter-chip" (click)="clearTag()" data-testid="apps-tag-filter"
                  [attr.aria-label]="'Clear tag filter ' + t">
            <span class="tag-filter-k">Tag</span>
            <span class="tag-filter-v">{{ t }}</span>
            <span class="tag-filter-x" aria-hidden="true">✕</span>
          </button>
        }
        <span class="sr-only" role="status" aria-live="polite" data-testid="apps-result-status">{{ resultAnnouncement() }}</span>
      </div>


      <!-- ─────────────────── GRID ─────────────────── -->
      @if (filteredApps().length === 0) {
        <app-empty-state
          icon="🔭"
          [title]="emptyTitle()"
          body="Try a different category or relax the search query."
          primary="Clear filters"
          (primaryClick)="resetFilters()"
        />
      } @else {
        <div class="apps-grid" role="list" aria-label="App catalog">
          @for (app of filteredApps(); track app.id) {
            <!-- §17: NO appReveal on result cards — a from-hidden enter animation on a
                 live-filtered loop re-hides every matched card per keystroke ("list
                 disappears / waits on stale animations"). First-paint reveal stays on
                 the static header/result-bar above. -->
            <a
              role="listitem"
              class="app-card"
              [routerLink]="['/admin/apps', app.id]"
              [attr.data-testid]="'apps-card-' + app.id"
              [attr.aria-label]="app.name + ' — ' + app.tagline">
              <header class="app-card-head">
                <div class="app-glyph" aria-hidden="true">{{ app.glyph }}</div>
                <div class="min-w-0 flex-1">
                  <div class="app-name-row">
                    <div class="app-name">{{ app.name }}</div>
                    @if (isSupported(app.id)) {
                      <span
                        class="status-pill status-pill--live"
                        title="Deployable today — ships an upstream container"
                        aria-label="Live"
                        [attr.data-testid]="'apps-pill-live-' + app.id">
                        Live
                      </span>
                    } @else {
                      <span
                        class="status-pill status-pill--soon"
                        title="Catalog placeholder — runtime container ships in a future drop"
                        aria-label="Coming soon"
                        [attr.data-testid]="'apps-pill-soon-' + app.id">
                        Soon
                      </span>
                    }
                  </div>
                  <div class="app-tag">{{ app.tagline }}</div>
                </div>
              </header>

              @if (app.tags.length > 0) {
                <div class="tag-row">
                  @for (t of app.tags.slice(0, 3); track t) {
                    <span class="tag-pill">{{ t }}</span>
                  }
                  @if (app.tags.length > 3) {
                    <span class="tag-pill tag-pill--more" [title]="app.tags.slice(3).join(', ')">+{{ app.tags.length - 3 }} more</span>
                  }
                </div>
              }

              <div class="infra-row" aria-label="Infrastructure dependencies">
                @for (d of app.infra; track d) {
                  <span class="infra-pill" [title]="infraLabel(d)">
                    <span class="infra-glyph" aria-hidden="true">{{ infraGlyph(d) }}</span>
                    <span>{{ infraLabel(d) }}</span>
                  </span>
                }
                @if (app.infra.length === 0) {
                  <span class="infra-pill infra-pill--bare" title="Stateless container">
                    <span class="infra-glyph" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg></span>
                    <span>Stateless</span>
                  </span>
                }
              </div>

              <footer class="app-card-foot">
                <span class="mem-pill" title="RAM ceiling">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 6v12M11 6v12M15 6v12M19 6v12"/></svg>
                  {{ app.memoryMB }} MiB
                </span>
                <span class="cost-pill" [title]="'Estimated monthly cost — ' + app.name">
                  <span class="cost-currency" aria-hidden="true">$</span>
                  <app-rolling-counter [value]="app.estCostMonthly" />
                  <span class="cost-unit" aria-hidden="true">/mo</span>
                </span>
                @if (installCount(app.id); as n) {
                  <span
                    class="installs-pill"
                    [attr.data-testid]="'apps-installs-' + app.id"
                    [title]="n + ' org' + (n === 1 ? '' : 's') + ' running ' + app.name">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                    {{ n }} {{ n === 1 ? 'org' : 'orgs' }}
                  </span>
                }
              </footer>
            </a>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }

    .kicker {
      font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.62rem; font-weight: 700; letter-spacing: 0.14em;
      text-transform: uppercase; color: var(--ps-accent, #00E5FF); opacity: 0.85;
    }
    .section-h { font-family: 'Sora', system-ui, sans-serif; font-weight: 600; letter-spacing: -0.02em; }
    .text-accent { color: var(--ps-accent, #00E5FF); }

    .header-pill {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 3px 10px; border-radius: 999px;
      background: color-mix(in oklch, var(--ps-accent, #00E5FF) 10%, transparent);
      border: 1px solid color-mix(in oklch, var(--ps-accent, #00E5FF) 32%, transparent);
      color: var(--ps-accent, #00E5FF);
      font-family: 'Sora', system-ui, sans-serif;
      font-size: 0.65rem; font-weight: 600; letter-spacing: 0.02em;
    }
    .header-pill-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: var(--ps-accent, #00E5FF);
      box-shadow: 0 0 6px color-mix(in oklch, var(--ps-accent, #00E5FF) 60%, transparent);
    }

    /* ─── Search ─── */
    .search-wrap {
      position: relative;
      display: flex; align-items: center; gap: 8px;
      padding: 0.6rem 0.85rem;
      background: rgba(0, 0, 0, 0.32);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: var(--ps-radius-lg, 14px);
      transition: border-color 160ms ease, background 160ms ease;
    }
    /* Hover affordance lives on the WHOLE wrapper (icon + input + kbd), mirroring
       the focus treatment — never just the inner <input>. */
    .search-wrap:hover {
      border-color: color-mix(in oklch, var(--ps-accent, #00E5FF) 28%, transparent);
    }
    .search-wrap.is-focused {
      border-color: color-mix(in oklch, var(--ps-accent, #00E5FF) 45%, transparent);
      background: color-mix(in oklch, var(--ps-accent, #00E5FF) 4%, rgba(0, 0, 0, 0.32));
    }
    /* Focus affordance surrounds the WHOLE control (icon + input + kbd), not just
       the inner <input>: ring lives on the wrapper via :focus-within, and the
       inner control's own ring is suppressed so it isn't doubled / clipped. */
    .search-wrap:focus-within {
      outline: var(--ps-ring-focus, 2px solid #00E5FF);
      outline-offset: 2px;
      border-color: color-mix(in oklch, var(--ps-accent, #00E5FF) 45%, transparent);
    }
    .search-input:focus, .search-input:focus-visible { outline: none; box-shadow: none; }
    .search-glyph { color: var(--text-secondary, rgba(255,255,255,0.55)); flex-shrink: 0; }
    /* .search-input base/placeholder now Spartan hlmInput [seamless]; keep only the native search-cancel reset. */
    .search-input::-webkit-search-cancel-button { -webkit-appearance: none; }
    .search-kbd {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.62rem; padding: 2px 6px;
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 4px; color: rgba(255,255,255,0.55);
      flex-shrink: 0;
    }

    /* ─── Chip strip ─── */
    .chip-glyph { line-height: 1; display: inline-flex; }
    .chip-glyph svg { width: 0.92rem; height: 0.92rem; display: block; }

    /* ─── Category multi-select filter (brief #12) ─── */
    .cat-filter { position: relative; display: inline-flex; }
    .cat-trigger {
      display: inline-flex; align-items: center; gap: 7px;
      padding: 0.42rem 0.8rem;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
      color: rgba(255, 255, 255, 0.78);
      font-family: 'Sora', system-ui, sans-serif;
      font-size: 0.72rem; font-weight: 600;
      cursor: pointer;
      transition: background 160ms ease, color 160ms ease, border-color 160ms ease;
    }
    .cat-trigger:hover { background: rgba(255, 255, 255, 0.07); color: var(--ps-ink, #fff); border-color: rgba(255, 255, 255, 0.16); }
    .cat-trigger.active {
      background: color-mix(in oklch, var(--ps-accent, #00E5FF) 14%, transparent);
      border-color: color-mix(in oklch, var(--ps-accent, #00E5FF) 50%, transparent);
      color: var(--ps-accent, #00E5FF);
    }
    .cat-trigger:focus-visible { outline: var(--ps-ring-focus, 2px solid #00E5FF); outline-offset: 2px; }
    .cat-badge {
      min-width: 1.05rem; padding: 0 5px; height: 1.05rem;
      display: inline-flex; align-items: center; justify-content: center;
      font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.6rem; font-weight: 700;
      border-radius: 999px;
      background: var(--ps-accent, #00E5FF); color: #03070a;
    }
    .cat-chevron { font-size: 0.62rem; opacity: 0.7; transition: transform 200ms ease; }
    .cat-filter.open .cat-chevron { transform: rotate(180deg); }

    /* Full-viewport click-catcher so an outside click closes the popover. */
    .cat-backdrop {
      position: fixed; inset: 0; z-index: 40;
      background: transparent; border: 0; padding: 0; cursor: default;
    }
    .cat-menu {
      position: absolute; top: calc(100% + 8px); left: 0; z-index: 41;
      width: max(248px, 100%);
      max-height: min(60vh, 420px); overflow-y: auto;
      padding: 8px;
      border-radius: var(--ps-radius-lg, 16px);
      /* Opaque enough that bright page content never bleeds through (≥0.9). */
      background: color-mix(in oklch, var(--ps-bg, #060610) 97%, transparent);
      border: 1px solid color-mix(in oklch, var(--ps-accent, #00E5FF) 22%, transparent);
      box-shadow: var(--ps-shadow-modal, 0 24px 60px -20px rgba(0, 0, 0, 0.7));
      backdrop-filter: blur(10px);
      animation: cat-menu-in 200ms cubic-bezier(0.22, 0.9, 0.3, 1) both;
    }
    @keyframes cat-menu-in { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); } }
    @media (prefers-reduced-motion: reduce) { .cat-menu { animation: none; } }
    .cat-menu-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 4px 6px 8px;
    }
    .cat-menu-title {
      font-size: 0.62rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em;
      color: rgba(255, 255, 255, 0.5);
    }
    .cat-menu-clear {
      background: none; border: 0; cursor: pointer;
      font-family: 'Sora', system-ui, sans-serif; font-size: 0.66rem; font-weight: 600;
      color: var(--ps-accent, #00E5FF);
    }
    .cat-menu-clear:hover { text-decoration: underline; }
    .cat-menu-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
    .cat-opt {
      display: flex; align-items: center; gap: 9px;
      padding: 0.4rem 0.5rem; border-radius: 10px;
      cursor: pointer; color: rgba(255, 255, 255, 0.82);
      font-size: 0.74rem;
      transition: background 140ms ease;
    }
    .cat-opt:hover { background: rgba(255, 255, 255, 0.05); }
    .cat-opt.checked { background: color-mix(in oklch, var(--ps-accent, #00E5FF) 10%, transparent); color: var(--ps-ink, #fff); }
    .cat-opt input[type='checkbox'] { accent-color: var(--ps-accent, #00E5FF); width: 15px; height: 15px; cursor: pointer; }
    .cat-opt-glyph { line-height: 1; }
    .cat-opt-label { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .cat-opt-count {
      font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.58rem;
      opacity: 0.6; padding: 1px 6px; background: rgba(255, 255, 255, 0.06); border-radius: 999px;
    }

    /* ─── Result bar (count + live region) ─── */
    .result-bar { display: flex; align-items: center; gap: 0.7rem; flex-wrap: wrap; }
    /* Removable "Tag: X" filter chip (cross-find). */
    .tag-filter-chip {
      display: inline-flex; align-items: center; gap: 0.45rem;
      padding: 0.28rem 0.4rem 0.28rem 0.6rem;
      border-radius: 999px; cursor: pointer;
      background: color-mix(in oklch, var(--ps-accent, #00E5FF) 12%, transparent);
      border: 1px solid color-mix(in oklch, var(--ps-accent, #00E5FF) 40%, transparent);
      color: var(--ps-accent, #00E5FF);
      font-size: 0.7rem; line-height: 1;
      transition: background 0.333s ease, border-color 0.333s ease;
    }
    .tag-filter-chip:hover { background: color-mix(in oklch, var(--ps-accent, #00E5FF) 20%, transparent); }
    .tag-filter-chip:focus-visible { outline: 2px solid var(--ps-accent, #00E5FF); outline-offset: 2px; }
    .tag-filter-k { font-size: 0.56rem; text-transform: uppercase; letter-spacing: 0.08em; opacity: 0.7; font-weight: 700; }
    .tag-filter-v { font-family: 'JetBrains Mono', ui-monospace, monospace; font-weight: 600; }
    .tag-filter-x {
      display: inline-flex; align-items: center; justify-content: center;
      width: 1.05rem; height: 1.05rem; border-radius: 999px; font-size: 0.6rem;
      background: color-mix(in oklch, var(--ps-accent, #00E5FF) 22%, transparent);
    }
    .result-count {
      display: inline-flex; align-items: baseline; gap: 5px;
      font-family: 'Sora', system-ui, sans-serif;
      font-size: 0.8rem; font-weight: 700;
      color: var(--ps-accent, #00E5FF);
    }
    .result-label {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.62rem; font-weight: 600;
      letter-spacing: 0.08em; text-transform: uppercase;
      color: var(--text-secondary, rgba(255,255,255,0.55));
    }
    .sr-only {
      position: absolute; width: 1px; height: 1px;
      padding: 0; margin: -1px; overflow: hidden;
      clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
    }

    /* ─── Grid ─── */
    .apps-grid {
      display: grid; gap: 1rem;
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
    @media (max-width: 1100px) { .apps-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @media (max-width: 680px)  { .apps-grid { grid-template-columns: 1fr; } }

    /* ─── Card ─── */
    .app-card {
      display: flex; flex-direction: column; gap: 0.85rem;
      padding: 1.1rem;
      background: var(--ps-surface-1, rgba(13, 13, 40, 0.62));
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: var(--ps-radius-lg, 14px);
      color: inherit; text-decoration: none;
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.02);
      transition: transform 200ms ease, border-color 200ms ease, box-shadow 200ms ease;
      cursor: pointer;
      min-height: 200px;
    }
    .app-card:hover {
      transform: translateY(-2px);
      border-color: color-mix(in oklch, var(--ps-accent, #00E5FF) 28%, transparent);
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.04),
                  0 12px 32px -16px color-mix(in oklch, var(--ps-accent, #00E5FF) 35%, transparent),
                  0 0 0 1px color-mix(in oklch, var(--ps-accent, #00E5FF) 14%, transparent);
    }
    .app-card:focus-visible {
      outline: var(--ps-ring-focus, 2px solid #00E5FF);
      outline-offset: 3px;
    }
    @media (prefers-reduced-motion: reduce) {
      .app-card { transition: none; }
      .app-card:hover { transform: none; }
    }
    /* The inner title section (.app-card-head) + RAM/cost footer (.app-card-foot)
       both match the global [class*="-card"]:hover translateY lift (_polish.scss),
       so they raised independently on top of the card. Opt them out — only the
       card raises, as one unit. .app-card prefix wins the specificity battle. */
    /* …and opt out of the global [class*="-card"]:hover box-shadow inset ring too,
       so the inner head/foot don't render a SECOND nested outline over the card. */
    .app-card .app-card-head:hover, .app-card .app-card-foot:hover { transform: none; box-shadow: none; }
    .app-glyph {
      flex-shrink: 0;
      width: 44px; height: 44px;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 1.4rem; line-height: 1;
      background: color-mix(in oklch, var(--ps-accent, #00E5FF) 8%, transparent);
      border: 1px solid color-mix(in oklch, var(--ps-accent, #00E5FF) 18%, transparent);
      border-radius: var(--ps-radius-sm, 10px);
    }
    .app-name-row {
      display: flex; align-items: center; gap: 8px;
      min-width: 0; flex-wrap: wrap;
    }
    .app-name {
      font-family: 'Sora', system-ui, sans-serif;
      font-size: 0.95rem; font-weight: 700;
      color: var(--ps-ink, #fff);
      letter-spacing: -0.01em;
      min-width: 0;
    }
    .status-pill {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 1px 8px 2px;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.58rem; font-weight: 700;
      letter-spacing: 0.06em; text-transform: uppercase;
      border-radius: 999px;
      flex-shrink: 0;
    }
    .status-pill--live {
      color: var(--ps-accent, #00E5FF);
      background: color-mix(in oklch, var(--ps-accent, #00E5FF) 12%, transparent);
      border: 1px solid color-mix(in oklch, var(--ps-accent, #00E5FF) 40%, transparent);
    }
    .status-pill--soon {
      color: rgba(255,255,255,0.55);
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.09);
    }
    /* The single status dot is the GLOBAL .status-pill::before (color-blind
       safety, currentColor). We previously ALSO rendered an explicit
       <span class="status-dot"> → two dots on the Live badge. The span is gone;
       these rules just lend the live ::before its glow + pulse so the one dot
       keeps the cinematic effect. (brief: "two different dots … ensure only one") */
    .status-pill--live::before {
      box-shadow: 0 0 6px color-mix(in oklch, var(--ps-accent, #00E5FF) 60%, transparent);
      animation: status-pulse 2.4s ease-in-out infinite;
    }
    @keyframes status-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.55; }
    }
    @media (prefers-reduced-motion: reduce) {
      .status-pill--live::before { animation: none; }
    }

    /* Lifecycle tab list + Categories filter share ONE inline row — Categories sits
       beside the strip (12px left gap) and stretches to the SAME height as the strip
       (align-items:stretch → .cat-filter → .cat-trigger fill the row's cross-size).
       flex-wrap keeps it graceful when the viewport is narrow. */
    .lifecycle-row { display: flex; align-items: stretch; flex-wrap: wrap; gap: 12px; }

    /* Lifecycle pill row (above category chip strip) */
    .lifecycle-strip {
      display: inline-flex; gap: 4px; padding: 4px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.07);
      border-radius: 999px;
    }
    .lifecycle-pill {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 0.32rem 0.78rem;
      border-radius: 999px;
      background: transparent;
      border: 1px solid transparent;
      color: rgba(255, 255, 255, 0.66);
      font-family: 'Sora', system-ui, sans-serif;
      font-size: 0.7rem; font-weight: 600;
      cursor: pointer;
      transition: background 160ms ease, color 160ms ease, border-color 160ms ease;
    }
    .lifecycle-pill:hover {
      background: rgba(255, 255, 255, 0.05);
      color: var(--ps-ink, #fff);
    }
    .lifecycle-pill.active {
      background: rgba(255, 255, 255, 0.08);
      color: var(--ps-ink, #fff);
      border-color: rgba(255, 255, 255, 0.12);
    }
    .lifecycle-pill--live.active {
      background: color-mix(in oklch, var(--ps-accent, #00E5FF) 14%, transparent);
      border-color: color-mix(in oklch, var(--ps-accent, #00E5FF) 38%, transparent);
      color: var(--ps-accent, #00E5FF);
    }
    .lifecycle-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: var(--ps-accent, #00E5FF);
      box-shadow: 0 0 6px color-mix(in oklch, var(--ps-accent, #00E5FF) 60%, transparent);
    }
    .lifecycle-count {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.62rem;
      padding: 1px 6px;
      background: rgba(0, 0, 0, 0.28);
      border-radius: 6px;
      color: rgba(255, 255, 255, 0.6);
    }
    .lifecycle-pill.active .lifecycle-count {
      background: rgba(0, 0, 0, 0.42);
      color: var(--ps-ink, #fff);
    }

    .app-tag {
      font-size: 0.74rem; line-height: 1.4;
      color: var(--text-secondary, rgba(255,255,255,0.62));
      margin-top: 2px;
    }

    .tag-row { display: flex; flex-wrap: wrap; gap: 4px; }
    .tag-pill {
      padding: 2px 8px;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.62rem; font-weight: 600;
      color: rgba(255,255,255,0.65);
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.07);
      border-radius: 999px;
    }
    .tag-pill--more {
      color: var(--ps-accent, #00E5FF);
      border-color: color-mix(in oklch, var(--ps-accent, #00E5FF) 28%, transparent);
      cursor: help;
    }

    .infra-row { display: flex; flex-wrap: wrap; gap: 5px; }
    .infra-pill {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 3px 8px 3px 6px;
      font-size: 0.66rem; font-weight: 600;
      color: rgba(255,255,255,0.7);
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 6px;
    }
    .infra-pill--bare {
      color: var(--ps-accent, #00E5FF);
      border-color: color-mix(in oklch, var(--ps-accent, #00E5FF) 26%, transparent);
      background: color-mix(in oklch, var(--ps-accent, #00E5FF) 6%, transparent);
    }
    .infra-glyph { line-height: 1; display: inline-flex; }
    .infra-glyph svg { width: 0.82rem; height: 0.82rem; display: block; }

    .app-card-foot {
      display: flex; align-items: center; justify-content: space-between;
      gap: 10px; margin-top: auto;
      padding-top: 0.6rem;
      border-top: 1px solid rgba(255,255,255,0.05);
    }
    .mem-pill {
      display: inline-flex; align-items: center; gap: 5px;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.66rem; color: rgba(255,255,255,0.55);
    }
    .mem-pill svg { color: rgba(255,255,255,0.5); }
    .cost-pill {
      display: inline-flex; align-items: baseline; gap: 1px;
      font-family: 'Sora', system-ui, sans-serif;
      font-size: 0.92rem; font-weight: 700;
      color: var(--ps-ink, #fff);
    }
    .cost-currency { font-size: 0.7rem; color: var(--ps-accent, #00E5FF); margin-right: 1px; }
    .cost-unit { font-size: 0.62rem; color: var(--text-secondary, rgba(255,255,255,0.5)); font-weight: 500; margin-left: 2px; }
    .installs-pill {
      display: inline-flex; align-items: center; gap: 4px;
      margin-left: auto;
      font-size: 0.66rem; font-weight: 700;
      color: var(--ps-accent, #00E5FF);
    }
    .installs-pill svg { opacity: 0.85; }

    /* ─── Buttons (parity with sibling sections) ─── */
    .btn-ghost {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 0.5rem 0.85rem;
      border-radius: var(--ps-radius-sm, 8px);
      background: rgba(255, 255, 255, 0.04);
      color: rgba(255, 255, 255, 0.78);
      border: 1px solid rgba(255, 255, 255, 0.1);
      cursor: pointer;
      font-size: 0.74rem; font-weight: 600;
      text-decoration: none;
      transition: background 140ms ease, color 140ms ease, border-color 140ms ease;
    }
    .btn-ghost:hover { background: rgba(255, 255, 255, 0.08); color: #fff; border-color: rgba(255,255,255,0.16); }
    .btn-ghost:focus-visible { outline: var(--ps-ring-focus, 2px solid #00E5FF); outline-offset: 2px; }
  `],
})
export class AppsComponent implements AfterViewInit, OnInit {
  @ViewChild('searchInput') private searchInputRef?: ElementRef<HTMLInputElement>;

  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly api = inject(ApiService);

  /** A5 — DISTINCT-org install counts per catalog app slug (marketplace social proof). */
  readonly installCounts = signal<Record<string, number>>({});
  /** Org-install count for a catalog app id (0 when unknown / none). */
  installCount(id: string): number {
    return this.installCounts()[id] ?? 0;
  }

  readonly categories = APP_CATEGORIES;
  readonly totalCount = APPS_CATALOG.length;
  readonly liveCount = APPS_CATALOG.filter((a) => isAppSupported(a.id)).length;
  readonly soonCount = APPS_CATALOG.length - this.liveCount;
  readonly infraMeta = INFRA_META;

  /** Multi-select category filter (brief #12) — empty Set = show every category. */
  activeCategories = signal<ReadonlySet<AppCategory>>(new Set<AppCategory>());
  /** Whether the category multi-select popover is open. */
  categoryMenuOpen = signal(false);
  /** How many categories are currently checked (drives the trigger badge). */
  selectedCategoryCount = computed<number>(() => this.activeCategories().size);
  /** Lifecycle filter — all|live|soon. Live = ships an upstream container today. */
  lifecycle = signal<LifecycleFilter>('all');
  searchQuery = signal<string>('');
  searchFocused = signal<boolean>(false);
  /** Exact-tag filter (cross-find): clicking a tag on an app links here with
   *  `?tag=<t>` so you can see every app sharing that tag. null = no tag filter. */
  activeTag = signal<string | null>(null);

  /** Template-bound mirror so `[(ngModel)]` doesn't need a signal-aware bridge. */
  searchInputValue = '';

  /** Live-filtered catalog driven by category + fuzzy query + lifecycle pill. */
  filteredApps = computed<readonly CatalogApp[]>(() => {
    const cats = this.activeCategories();
    const lc = this.lifecycle();
    const tag = this.activeTag();
    const q = this.searchQuery().trim().toLowerCase();
    return APPS_CATALOG.filter((app) => {
      if (cats.size && !cats.has(app.category)) return false;
      if (tag && !app.tags.includes(tag)) return false;
      if (lc === 'live' && !isAppSupported(app.id)) return false;
      if (lc === 'soon' && isAppSupported(app.id)) return false;
      if (!q) return true;
      if (app.name.toLowerCase().includes(q)) return true;
      if (app.tagline.toLowerCase().includes(q)) return true;
      if (app.id.toLowerCase().includes(q)) return true;
      return app.tags.some((t) => t.toLowerCase().includes(q));
    });
  });

  emptyTitle = computed<string>(() => {
    const q = this.searchQuery().trim();
    if (q) return `Nothing matches "${q}"`;
    return this.selectedCategoryCount() > 1 ? 'No apps in these categories' : 'No apps in this category';
  });

  /**
   * Polite live-region copy announcing the current filtered result count.
   * Fires on every category / lifecycle / search change so screen-reader
   * users hear the grid update instead of silently re-rendering cards.
   */
  resultAnnouncement = computed<string>(() => {
    const n = this.filteredApps().length;
    const q = this.searchQuery().trim();
    const noun = n === 1 ? 'app' : 'apps';
    return q ? `${n} ${noun} match "${q}"` : `Showing ${n} ${noun}`;
  });

  ngAfterViewInit(): void {
    // No autofocus on mount — would steal focus from sibling routes.
  }

  /**
   * Honour `?category=ai|vector-db|...` deep links so external links can
   * filter the catalog on load (e.g. AI launchpad → `/admin/apps?category=ai`).
   * Unknown values fall back to the default "all" view.
   */
  ngOnInit(): void {
    // A5 — fetch install counts (silent: a failure just hides the social-proof badge).
    this.api
      .get<{ counts: Record<string, number> }>('/apps/install-counts', undefined, { silent: true })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => this.installCounts.set(res?.counts ?? {}),
        error: () => this.installCounts.set({}),
      });

    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      // `?category=ai` (single) or `?category=ai,vector-db` (multi) deep links.
      const raw = params.get('category');
      if (raw) {
        const valid = new Set(APP_CATEGORIES.map((c) => c.id) as readonly string[]);
        const picked = raw.split(',').map((s) => s.trim()).filter((s) => valid.has(s)) as AppCategory[];
        if (picked.length) this.activeCategories.set(new Set(picked));
      }
      // `?tag=<t>` cross-find deep link — set/clear the exact-tag filter to match.
      this.activeTag.set(params.get('tag'));
    });
  }

  /** Clear the active tag filter (the removable "Tag: X" chip). */
  clearTag(): void {
    this.activeTag.set(null);
  }

  /** Cmd+/ (Ctrl+/) focuses the search input. Matches the global mandate. */
  @HostListener('window:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key === '/') {
      event.preventDefault();
      this.focusSearch();
    }
    if (event.key === 'Escape' && this.categoryMenuOpen()) {
      this.categoryMenuOpen.set(false);
    }
  }

  focusSearch(): void {
    requestAnimationFrame(() => this.searchInputRef?.nativeElement.focus({ preventScroll: true }));
  }

  /** Add/remove a category from the multi-select (brief #12). */
  toggleCategory(id: AppCategory): void {
    const next = new Set(this.activeCategories());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.activeCategories.set(next);
  }

  isCategoryActive(id: AppCategory): boolean {
    return this.activeCategories().has(id);
  }

  clearCategories(): void {
    this.activeCategories.set(new Set<AppCategory>());
  }

  toggleCategoryMenu(): void {
    this.categoryMenuOpen.update((open) => !open);
  }

  closeCategoryMenu(): void {
    this.categoryMenuOpen.set(false);
  }

  /** Toggle the lifecycle pill row — All / Live / Coming soon. */
  setLifecycle(value: LifecycleFilter): void {
    this.lifecycle.set(value);
  }

  /** True when the catalog slug is wired to an upstream container today. */
  isSupported(id: string): boolean {
    return isAppSupported(id);
  }

  onSearchChange(value: string): void {
    this.searchQuery.set(value);
  }

  clearSearch(): void {
    this.searchInputValue = '';
    this.searchQuery.set('');
  }

  resetFilters(): void {
    this.activeCategories.set(new Set<AppCategory>());
    this.categoryMenuOpen.set(false);
    this.activeTag.set(null);
    this.clearSearch();
  }

  countByCategory(id: AppCategory): number {
    return APPS_CATALOG.filter((a) => a.category === id).length;
  }

  infraGlyph(d: InfraDep): string {
    return INFRA_META[d].glyph;
  }

  infraLabel(d: InfraDep): string {
    return INFRA_META[d].label;
  }
}
