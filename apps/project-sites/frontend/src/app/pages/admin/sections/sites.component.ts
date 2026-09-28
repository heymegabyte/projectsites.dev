/**
 * Sites grid at `/admin/sites`.
 *
 * A filterable / sortable / searchable card grid of every site in the org.
 * Replaces the former `/admin/sites → ''` redirect (a natural URL guess that
 * only ever bounced to the dashboard). Reads the ALREADY-loaded, live-polled
 * `AdminStateService.sites()` (the shell calls `loadData()` + `startPolling()`
 * on init and refreshes every 30s, pausing on `document.hidden`), so there is
 * NO manual Refresh/Reconcile button here (per the real-time-data rule) — the
 * grid updates itself. Readiness grades come from the shared, batched
 * `ReadinessCacheService` via the reusable `<app-readiness-badge>`.
 *
 * A11y: exactly one `<h1>`; each card is a keyboard-navigable link — ↑↓/←→ move
 * focus across the grid, Home/End jump to ends, Enter/Space opens the site's
 * detail. Empty state is a launchpad matching the dashboard "Create Site" CTA.
 */
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';

import { AdminStateService } from '../admin-state.service';
import { RevealDirective } from '../../../directives/reveal.directive';
import { CmdGlyphComponent } from '../../../components/cmd-glyph/cmd-glyph.component';
import { ReadinessBadgeComponent } from './readiness-badge.component';
import type { Site } from '../../../services/api.service';

/** Status filter buckets — mirror `AdminStateService.getStatusClass` tones. */
type StatusFilter = 'all' | 'published' | 'building' | 'draft' | 'error';
/** Sort keys the grid supports. */
type SortKey = 'recent' | 'name' | 'status';

interface StatusPill {
  key: StatusFilter;
  label: string;
  count: number;
}

@Component({
  selector: 'app-admin-sites',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, RevealDirective, CmdGlyphComponent, ReadinessBadgeComponent],
  template: `
    <section class="sites" aria-labelledby="sites-h1">
      <!-- Section chrome — H1 + breadcrumb + New Site, matching sibling admin sections. -->
      <header class="sites-head" appReveal>
        <div class="head-copy">
          <p class="crumb">
            <a routerLink="/admin">Admin</a> <span class="sep" aria-hidden="true">/</span>
            <span aria-current="page">Sites</span>
          </p>
          <h1 id="sites-h1" class="head-title">
            <app-cmd-glyph name="grid" aria-hidden="true" /> Sites
          </h1>
          <p class="head-sub">
            Every site in your account — search, filter, and open one to edit or manage it.
            <span class="live-dot" aria-hidden="true"></span>
            <span class="live-copy">Live · auto-refreshed every 30s</span>
          </p>
        </div>
        @if (hasSites()) {
          <button
            class="cta cta-primary"
            type="button"
            (click)="createSite()"
            data-testid="sites-new"
          >
            <app-cmd-glyph name="rocket" aria-hidden="true" /> New Site
          </button>
        }
      </header>

      @if (loading() && !hasSites()) {
        <!-- Loading: skeleton grid (height-neutral with the loaded card grid). -->
        <ul class="grid" aria-hidden="true" data-testid="sites-skeleton">
          @for (n of skeletonRows; track n) {
            <li class="skel-card"></li>
          }
        </ul>
        <p class="sr-only" role="status" aria-live="polite">Loading your sites…</p>
      } @else if (loadError()) {
        <!-- Error: coherent, actionable, never a dead-end. -->
        <div class="state-panel" role="alert" data-testid="sites-error">
          <span class="state-glyph state-glyph--err" aria-hidden="true"
            ><app-cmd-glyph name="shield"
          /></span>
          <p class="state-title">We couldn’t load your sites</p>
          <p class="state-sub">This is usually a brief network hiccup. Try again.</p>
          <button class="cta cta-primary" type="button" (click)="retry()" data-testid="sites-retry">
            Retry
          </button>
        </div>
      } @else if (!hasSites()) {
        <!-- Empty state = launchpad (matches the dashboard cyan "Create Site" CTA). -->
        <div class="state-panel" appReveal data-testid="sites-empty">
          <span class="state-glyph" aria-hidden="true"><app-cmd-glyph name="grid" /></span>
          <p class="state-title">No sites yet</p>
          <p class="state-sub">
            Search for a business and we’ll build a professional, hosted site — live in minutes.
          </p>
          <button
            class="cta cta-primary"
            type="button"
            (click)="createSite()"
            data-testid="sites-empty-cta"
          >
            <app-cmd-glyph name="rocket" aria-hidden="true" /> Create your first site
          </button>
        </div>
      } @else {
        <!-- ── Controls: search · sort ── -->
        <div class="controls" appReveal>
          <div class="search-wrap" role="search">
            <span class="search-ic" aria-hidden="true"><app-cmd-glyph name="search" /></span>
            <input
              class="search-input"
              type="search"
              [ngModel]="query()"
              (ngModelChange)="query.set($event)"
              placeholder="Search by name, slug, or domain…"
              aria-label="Search your sites"
              autocomplete="off"
              spellcheck="false"
              data-testid="sites-search"
            />
            @if (query()) {
              <button
                class="search-clear"
                type="button"
                (click)="query.set('')"
                aria-label="Clear search"
                data-testid="sites-search-clear"
              >
                ✕
              </button>
            }
          </div>

          <div class="sort-wrap">
            <label class="sort-label" for="sites-sort">Sort</label>
            <select
              id="sites-sort"
              class="sort-select"
              [ngModel]="sort()"
              (ngModelChange)="sort.set($event)"
              data-testid="sites-sort"
            >
              <option value="recent">Last build</option>
              <option value="name">Name</option>
              <option value="status">Status</option>
            </select>
          </div>
        </div>

        <!-- ── Status filter pills ── -->
        <div class="filters" role="tablist" aria-label="Filter by status">
          @for (pill of statusPills(); track pill.key) {
            <button
              class="pill"
              type="button"
              role="tab"
              [class.is-active]="statusFilter() === pill.key"
              [attr.aria-selected]="statusFilter() === pill.key"
              (click)="statusFilter.set(pill.key)"
              [attr.data-testid]="'sites-filter-' + pill.key"
            >
              <span class="pill-dot" [class]="'dot-' + pill.key" aria-hidden="true"></span>
              {{ pill.label }}
              <span class="pill-count">{{ pill.count }}</span>
            </button>
          }
        </div>

        <p class="sr-only" role="status" aria-live="polite">{{ resultAnnounce() }}</p>

        @if (visibleSites().length === 0) {
          <!-- Filtered-to-empty — a launchpad back, never a dead-end. -->
          <div class="state-panel state-panel--sm" data-testid="sites-no-match">
            <span class="state-glyph" aria-hidden="true"><app-cmd-glyph name="search" /></span>
            <p class="state-title">No sites match your filters</p>
            <p class="state-sub">Try a different search or clear the status filter.</p>
            <button class="cta cta-ghost" type="button" (click)="resetFilters()">
              Clear filters
            </button>
          </div>
        } @else {
          <ul
            class="grid"
            role="list"
            aria-label="Your sites"
            (keydown)="onGridKeydown($event)"
          >
            @for (site of visibleSites(); track site.id; let i = $index) {
              <li class="grid-cell" [style.animation-delay.ms]="i * 26">
                <a
                  class="site-card"
                  [class]="'tone-' + tone(site)"
                  [routerLink]="['/admin/sites', site.id]"
                  [attr.data-idx]="i"
                  [attr.data-testid]="'site-card-' + site.slug"
                  [attr.aria-label]="
                    site.business_name + ' — ' + statusLabel(site) + '. Open to edit or manage.'
                  "
                >
                  <span class="card-top">
                    <span
                      class="dot"
                      [class]="'dot-' + tone(site)"
                      [class.is-live]="isBuilding(site)"
                      aria-hidden="true"
                    ></span>
                    <span class="status-text" [class]="'st-' + tone(site)">{{
                      statusLabel(site)
                    }}</span>
                    <app-readiness-badge class="ml-auto" [siteId]="site.id" />
                  </span>

                  <strong class="card-name">{{ site.business_name }}</strong>
                  <span class="card-domain">
                    <app-cmd-glyph name="globe" aria-hidden="true" />
                    {{ displayDomain(site) }}
                  </span>

                  <span class="card-foot">
                    <span class="card-meta">
                      <app-cmd-glyph name="clock" aria-hidden="true" />
                      {{ lastBuildLabel(site) }}
                    </span>
                    <span class="card-open" aria-hidden="true">Open →</span>
                  </span>
                </a>
              </li>
            }
          </ul>
        }
      }
    </section>
  `,
  styles: [
    `
      :host {
        display: block;
        min-height: calc(100vh - 64px);
      }
      .sites {
        padding: 28px 24px 96px;
        max-width: 1180px;
        margin: 0 auto;
        color: var(--ps-ink, #f4f4ff);
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

      /* ── Section head ── */
      .sites-head {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        gap: 16px;
        flex-wrap: wrap;
        margin-bottom: 22px;
      }
      .crumb {
        margin: 0 0 6px;
        font-family: var(--ps-font-code, 'Fira Code', ui-monospace, monospace);
        font-size: 0.68rem;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        color: rgba(255, 255, 255, 0.6);
      }
      .crumb a {
        color: inherit;
        text-decoration: none;
        transition: color 0.333s ease;
      }
      .crumb a:hover {
        color: var(--ps-accent, #00e5ff);
      }
      .crumb a:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 2px;
        border-radius: 3px;
      }
      .crumb .sep {
        opacity: 0.4;
        margin: 0 4px;
      }
      .head-title {
        display: flex;
        align-items: center;
        gap: 10px;
        margin: 0;
        font-family: 'Sora', system-ui, sans-serif;
        font-size: 1.7rem;
        font-weight: 700;
        letter-spacing: -0.02em;
      }
      .head-title app-cmd-glyph {
        color: var(--ps-accent, #00e5ff);
        font-size: 1.4rem;
      }
      .head-sub {
        margin: 8px 0 0;
        font-size: 0.9rem;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 62%, transparent);
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .live-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--ps-success, #4dffb5);
        animation: pulse 2.4s ease-out infinite;
      }
      .live-copy {
        font-family: var(--ps-font-code, 'Fira Code', ui-monospace, monospace);
        font-size: 0.62rem;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: rgba(255, 255, 255, 0.66);
      }
      @keyframes pulse {
        0% {
          box-shadow: 0 0 0 0 rgba(77, 255, 181, 0.45);
        }
        70% {
          box-shadow: 0 0 0 6px rgba(77, 255, 181, 0);
        }
        100% {
          box-shadow: 0 0 0 0 rgba(77, 255, 181, 0);
        }
      }

      /* ── Controls ── */
      .controls {
        display: flex;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
        margin-bottom: 14px;
      }
      .search-wrap {
        flex: 1;
        min-width: 240px;
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 0 14px;
        height: 46px;
        border-radius: 14px;
        background: color-mix(in oklch, var(--ps-bg, #060610) 78%, transparent);
        border: 1px solid rgba(0, 229, 255, 0.22);
        transition:
          border-color 0.333s ease,
          box-shadow 0.333s ease;
      }
      .search-wrap:focus-within {
        border-color: var(--ps-accent, #00e5ff);
        box-shadow: 0 18px 48px -30px rgba(0, 229, 255, 0.6);
      }
      .search-ic {
        color: var(--ps-accent, #00e5ff);
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
        font-size: 0.95rem;
      }
      .search-input::placeholder {
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 45%, transparent);
      }
      .search-input::-webkit-search-cancel-button {
        display: none;
      }
      .search-clear {
        flex-shrink: 0;
        width: 26px;
        height: 26px;
        border-radius: 8px;
        border: 1px solid rgba(255, 255, 255, 0.1);
        background: rgba(255, 255, 255, 0.04);
        color: var(--ps-ink, #f4f4ff);
        cursor: pointer;
        transition:
          border-color 0.333s ease,
          transform 0.333s ease;
      }
      .search-clear:hover {
        border-color: rgba(0, 229, 255, 0.5);
        transform: translateY(-1px);
      }
      .search-clear:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 2px;
      }
      .sort-wrap {
        display: inline-flex;
        align-items: center;
        gap: 8px;
      }
      .sort-label {
        font-size: 0.78rem;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 60%, transparent);
      }
      .sort-select {
        height: 46px;
        padding: 0 12px;
        border-radius: 14px;
        background: color-mix(in oklch, var(--ps-bg, #060610) 78%, transparent);
        border: 1px solid rgba(255, 255, 255, 0.12);
        color: var(--ps-ink, #f4f4ff);
        font: inherit;
        font-size: 0.9rem;
        cursor: pointer;
        transition: border-color 0.333s ease;
      }
      .sort-select:hover {
        border-color: rgba(0, 229, 255, 0.4);
      }
      .sort-select:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 2px;
      }

      /* ── Filter pills ── */
      .filters {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-bottom: 20px;
      }
      .pill {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        min-height: 34px;
        padding: 0 13px;
        border-radius: 999px;
        background: rgba(8, 8, 32, 0.5);
        border: 1px solid rgba(255, 255, 255, 0.1);
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 78%, transparent);
        font: inherit;
        font-size: 0.82rem;
        font-weight: 500;
        cursor: pointer;
        transition:
          border-color 0.333s ease,
          background 0.333s ease,
          color 0.333s ease,
          transform 0.333s ease;
      }
      .pill:hover {
        transform: translateY(-1px);
        border-color: rgba(0, 229, 255, 0.45);
      }
      .pill.is-active {
        border-color: var(--ps-accent, #00e5ff);
        background: rgba(0, 229, 255, 0.08);
        color: var(--ps-ink, #f4f4ff);
      }
      .pill:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 2px;
      }
      .pill-count {
        font-variant-numeric: tabular-nums;
        font-size: 0.72rem;
        padding: 1px 6px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.08);
      }
      .pill-dot,
      .dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.4);
        flex-shrink: 0;
      }
      .dot-all {
        background: linear-gradient(135deg, #4dffb5, #00e5ff);
      }
      .dot-published {
        background: var(--ps-success, #4dffb5);
      }
      .dot-building {
        background: var(--ps-accent, #00e5ff);
      }
      .dot-draft {
        background: rgba(255, 255, 255, 0.4);
      }
      .dot-error {
        background: #ff4d6d;
      }

      /* ── Grid ── */
      .grid {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
        gap: 14px;
      }
      .grid-cell {
        animation: cardIn 0.333s cubic-bezier(0.16, 1, 0.3, 1) both;
      }
      @keyframes cardIn {
        from {
          opacity: 0;
          transform: translateY(12px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }
      .site-card {
        display: flex;
        flex-direction: column;
        gap: 10px;
        height: 100%;
        padding: 16px 17px;
        background: rgba(8, 8, 32, 0.45);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: var(--ps-radius-lg, 16px);
        text-decoration: none;
        color: inherit;
        transition:
          border-color 0.333s ease,
          transform 0.333s cubic-bezier(0.16, 1, 0.3, 1),
          background 0.333s ease,
          box-shadow 0.333s ease;
      }
      .site-card:hover {
        border-color: rgba(0, 229, 255, 0.5);
        background: rgba(0, 229, 255, 0.04);
        transform: translateY(-3px);
        box-shadow: 0 18px 46px -28px rgba(0, 229, 255, 0.6);
      }
      .site-card:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 3px;
      }
      .site-card.tone-error {
        border-color: color-mix(in oklch, #ff4d6d 26%, transparent);
      }
      .card-top {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .dot.is-live {
        animation: pulse 2.4s ease-out infinite;
      }
      .status-text {
        font-size: 0.72rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .st-published {
        color: var(--ps-success, #4dffb5);
      }
      .st-building {
        color: var(--ps-accent, #00e5ff);
      }
      .st-draft {
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 60%, transparent);
      }
      .st-error {
        color: #ff8095;
      }
      .ml-auto {
        margin-left: auto;
      }
      .card-name {
        font-family: 'Sora', system-ui, sans-serif;
        font-size: 1.06rem;
        font-weight: 600;
        letter-spacing: -0.01em;
        line-height: 1.25;
        text-wrap: balance;
      }
      .card-domain {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 0.82rem;
        font-family: var(--ps-font-code, 'Fira Code', ui-monospace, monospace);
        color: color-mix(in oklch, var(--ps-accent, #00e5ff) 82%, var(--ps-ink) 18%);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .card-domain app-cmd-glyph {
        font-size: 0.85rem;
        flex-shrink: 0;
        opacity: 0.8;
      }
      .card-foot {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-top: auto;
        padding-top: 4px;
      }
      .card-meta {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 0.74rem;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent);
      }
      .card-meta app-cmd-glyph {
        font-size: 0.82rem;
        opacity: 0.75;
      }
      .card-open {
        font-size: 0.78rem;
        font-weight: 600;
        color: var(--ps-accent, #00e5ff);
        opacity: 0;
        transform: translateX(-4px);
        transition:
          opacity 0.333s ease,
          transform 0.333s ease;
      }
      .site-card:hover .card-open,
      .site-card:focus-visible .card-open {
        opacity: 1;
        transform: translateX(0);
      }

      /* ── Skeleton ── */
      .skel-card {
        height: 148px;
        border-radius: var(--ps-radius-lg, 16px);
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(255, 255, 255, 0.06);
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

      /* ── State panels (empty / error / no-match) ── */
      .state-panel {
        text-align: center;
        padding: 64px 20px;
        max-width: 460px;
        margin: 24px auto;
      }
      .state-panel--sm {
        padding: 44px 20px;
      }
      .state-glyph {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 60px;
        height: 60px;
        border-radius: 18px;
        font-size: 1.6rem;
        color: var(--ps-accent, #00e5ff);
        background: rgba(0, 229, 255, 0.08);
        border: 1px solid rgba(0, 229, 255, 0.2);
        margin-bottom: 18px;
      }
      .state-glyph--err {
        color: #ff8095;
        background: rgba(255, 77, 109, 0.08);
        border-color: rgba(255, 77, 109, 0.28);
      }
      .state-title {
        font-family: 'Sora', system-ui, sans-serif;
        font-size: 1.2rem;
        font-weight: 600;
        margin: 0 0 8px;
      }
      .state-sub {
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 62%, transparent);
        font-size: 0.92rem;
        line-height: 1.5;
        margin: 0 0 20px;
        text-wrap: pretty;
      }

      /* ── CTAs ── */
      .cta {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        min-height: 44px;
        padding: 0 20px;
        border-radius: 999px;
        font: inherit;
        font-weight: 600;
        font-size: 0.92rem;
        cursor: pointer;
        text-decoration: none;
        border: 1px solid transparent;
        transition:
          transform 0.333s ease,
          border-color 0.333s ease,
          box-shadow 0.333s ease,
          background 0.333s ease;
      }
      .cta app-cmd-glyph {
        font-size: 1rem;
      }
      .cta-primary {
        background: linear-gradient(135deg, var(--ps-accent, #00e5ff), #50aae3);
        color: #041016;
        box-shadow: 0 16px 40px -22px rgba(0, 229, 255, 0.7);
      }
      .cta-primary:hover {
        transform: translateY(-2px);
        box-shadow: 0 22px 52px -20px rgba(0, 229, 255, 0.8);
      }
      .cta-ghost {
        background: rgba(0, 229, 255, 0.05);
        border-color: rgba(0, 229, 255, 0.22);
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

      @media (max-width: 720px) {
        .sites {
          padding: 18px 14px 72px;
        }
        .head-title {
          font-size: 1.4rem;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .grid-cell,
        .site-card,
        .card-open,
        .live-dot,
        .dot.is-live,
        .skel-card,
        .pill,
        .cta {
          animation: none !important;
          transition: none !important;
        }
      }
    `,
  ],
})
export class AdminSitesComponent {
  private readonly state = inject(AdminStateService);

  /** 8 skeleton cells while the first load is in flight. */
  readonly skeletonRows = Array.from({ length: 8 }, (_, i) => i);

  /** Live, visibility-aware-polled sites list from the shared shell state. */
  readonly sites = this.state.sites;
  readonly loading = this.state.loading;
  readonly hasSites = computed(() => this.sites().length > 0);

  /**
   * Error surfaces only when the initial load settled empty (the shell owns the
   * fetch + its own retry toast; this mirrors that state for THIS surface). We
   * treat "loading finished AND still zero sites" as ambiguous between honest-
   * empty and load-failure — so this is a launchpad-first UX: an empty account
   * gets the "No sites yet" launchpad (the common case), and the explicit error
   * panel is reached via {@link retry}. Kept as its own signal so a future
   * shell-level error flag can drive it without touching the template.
   */
  readonly loadError = signal(false);

  readonly query = signal('');
  readonly statusFilter = signal<StatusFilter>('all');
  readonly sort = signal<SortKey>('recent');

  /** Per-status counts across ALL sites (unfiltered) for the filter pills. */
  readonly statusPills = computed<StatusPill[]>(() => {
    const counts: Record<StatusFilter, number> = {
      all: 0,
      published: 0,
      building: 0,
      draft: 0,
      error: 0,
    };
    for (const s of this.sites()) {
      counts.all++;
      counts[this.tone(s)]++;
    }
    return [
      { key: 'all' as const, label: 'All', count: counts.all },
      { key: 'published' as const, label: 'Live', count: counts.published },
      { key: 'building' as const, label: 'Building', count: counts.building },
      { key: 'draft' as const, label: 'Draft', count: counts.draft },
      { key: 'error' as const, label: 'Needs attention', count: counts.error },
    ].filter((p) => p.key === 'all' || p.count > 0);
  });

  /** Search + status-filter + sort applied to the live sites list. */
  readonly visibleSites = computed<Site[]>(() => {
    const q = this.query().trim().toLowerCase();
    const filter = this.statusFilter();
    const sortKey = this.sort();

    const list = this.sites().filter((s) => {
      if (filter !== 'all' && this.tone(s) !== filter) return false;
      if (!q) return true;
      const hay = `${s.business_name} ${s.slug} ${this.displayDomain(s)}`.toLowerCase();
      return hay.includes(q);
    });

    return [...list].sort((a, b) => {
      if (sortKey === 'name') return a.business_name.localeCompare(b.business_name);
      if (sortKey === 'status') return this.tone(a).localeCompare(this.tone(b));
      // 'recent' — newest build/update first.
      return this.buildTime(b) - this.buildTime(a);
    });
  });

  readonly resultAnnounce = computed(() => {
    const n = this.visibleSites().length;
    const total = this.sites().length;
    if (n === total) return `${total} ${total === 1 ? 'site' : 'sites'}`;
    return `${n} of ${total} ${total === 1 ? 'site' : 'sites'} shown`;
  });

  /**
   * Map raw status → filter/tone bucket (mirrors AdminStateService.getStatusClass),
   * but a 'published' site with no build serves a 503 → count it as needs-attention
   * (same lying-published guard as the dashboard status strip).
   */
  tone(site: Site): StatusFilter {
    let cls = this.state.getStatusClass(site.status) as StatusFilter;
    if (cls === 'published' && !site.current_build_version) cls = 'error';
    return cls;
  }

  statusLabel(site: Site): string {
    if (this.tone(site) === 'error' && this.state.getStatusClass(site.status) === 'published') {
      return 'Needs attention';
    }
    return this.state.getStatusLabel(site.status);
  }

  isBuilding(site: Site): boolean {
    return this.state.isBuilding(site);
  }

  /** Prefer the custom hostname; fall back to the default subdomain. */
  displayDomain(site: Site): string {
    return site.primary_hostname || `${site.slug}.projectsites.dev`;
  }

  private buildTime(site: Site): number {
    const iso = site.updated_at || site.created_at;
    const t = iso ? new Date(iso).getTime() : 0;
    return Number.isNaN(t) ? 0 : t;
  }

  lastBuildLabel(site: Site): string {
    const iso = site.updated_at || site.created_at;
    if (!iso) return 'No builds yet';
    return this.state.formatRelativeTime(iso);
  }

  createSite(): void {
    this.state.newSite();
  }

  resetFilters(): void {
    this.query.set('');
    this.statusFilter.set('all');
  }

  retry(): void {
    this.loadError.set(false);
    this.state.loadData();
  }

  /**
   * Roving keyboard nav across the card grid. ↑↓ move by a row (measured from the
   * live column count), ←→ move by one card, Home/End jump to the ends. Enter/Space
   * activate the focused card (the anchor's native behavior). Focus is moved to the
   * target card's anchor so it stays visible + announced.
   */
  onGridKeydown(ev: KeyboardEvent): void {
    const keys = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(ev.key)) return;

    const grid = ev.currentTarget as HTMLElement;
    const cards = Array.from(grid.querySelectorAll<HTMLAnchorElement>('a.site-card'));
    if (cards.length === 0) return;

    const active = document.activeElement as HTMLElement | null;
    const current = cards.findIndex((c) => c === active);
    // Columns = how many cards share the top row (their offsetTop matches the first).
    const firstTop = cards[0].offsetTop;
    const cols = Math.max(1, cards.filter((c) => c.offsetTop === firstTop).length);

    let next = current < 0 ? 0 : current;
    switch (ev.key) {
      case 'ArrowRight':
        next = Math.min(cards.length - 1, current + 1);
        break;
      case 'ArrowLeft':
        next = Math.max(0, current - 1);
        break;
      case 'ArrowDown':
        next = Math.min(cards.length - 1, current + cols);
        break;
      case 'ArrowUp':
        next = current < 0 ? 0 : Math.max(0, current - cols);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = cards.length - 1;
        break;
    }
    ev.preventDefault();
    cards[next]?.focus();
  }
}
