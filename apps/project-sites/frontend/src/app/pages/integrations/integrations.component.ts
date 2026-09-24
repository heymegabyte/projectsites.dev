/**
 * @module pages/integrations
 *
 * @description
 * Public integrations catalog page rendered at `/integrations`. Renders a
 * category-grouped card grid backed by `GET /api/public/integrations`. Each
 * card shows the partner logo, name, status pill, MCP badge, and a short
 * description. Clicking the card opens the partner's documentation in a new
 * tab so the user never loses their place on projectsites.dev.
 *
 * @remarks
 * - Standalone, OnPush change detection, signals only.
 * - Brand tokens from `_polish.scss` — no hard-coded brand hex.
 * - Logo tile per `rules/logo-contrast.md`: white background, padding, rounded.
 */
import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';

import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { MetaService } from '../../services/meta.service';

/**
 * Mirrors the worker's `Integration` interface. Keep in sync with
 * `src/routes/public.ts`.
 */
interface Integration {
  readonly slug: string;
  readonly name: string;
  readonly category: string;
  readonly status: 'live' | 'beta' | 'planned';
  readonly description: string;
  readonly logo_url: string;
  readonly docs_url: string;
  readonly mcp_supported: boolean;
}

interface IntegrationsResponse {
  readonly integrations: readonly Integration[];
  readonly by_category: Readonly<Record<string, readonly Integration[]>>;
  readonly count: number;
  readonly mcp_supported_count: number;
}

/**
 * Categories appear in this order on the page. Categories returned by the API
 * but missing from this list still render — appended after the listed ones.
 */
const CATEGORY_ORDER: readonly string[] = [
  'Communication',
  'Payments',
  'Analytics',
  'AI',
  'Email',
  'CRM',
  'Calendar',
  'Maps',
  'Media',
  'Infrastructure',
  'Developer',
];

/**
 * Public integrations catalog page.
 *
 * @example
 * ```ts
 * // app.routes.ts
 * { path: 'integrations', loadComponent: () =>
 *   import('./pages/integrations/integrations.component').then((m) => m.IntegrationsComponent) }
 * ```
 */
@Component({
  selector: 'app-integrations',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <section class="integrations-page">
      <div class="integrations-inner">
        <header class="page-header">
          <p class="eyebrow">Integrations</p>
          <h1>Connect every tool you already use</h1>
          <p class="subtitle">
            {{ totalCount() }} integrations across {{ categoryCount() }} categories.
            {{ mcpCount() }} support the Model Context Protocol so your AI agents can use them
            directly.
          </p>
          <div class="filter-row">
            <input
              class="search-input"
              type="search"
              placeholder="Search integrations…"
              [(ngModel)]="searchTerm"
              aria-label="Search integrations"
            />
            <button
              type="button"
              class="filter-chip"
              [class.is-active]="showMcpOnly()"
              (click)="toggleMcpOnly()"
              aria-pressed="false"
              [attr.aria-pressed]="showMcpOnly() ? 'true' : 'false'"
            >
              MCP-ready only
            </button>
          </div>
        </header>

        @if (loading()) {
          <p class="state-msg">Loading catalog…</p>
        } @else if (error()) {
          <p class="state-msg state-error">{{ error() }}</p>
        } @else {
          @for (group of orderedGroups(); track group.category) {
            <section class="category-group">
              <header class="category-head">
                <h2>{{ group.category }}</h2>
                <span class="count-pill">{{ group.items.length }}</span>
              </header>
              <div class="card-grid">
                @for (it of group.items; track it.slug) {
                  <a
                    class="card"
                    [href]="it.docs_url"
                    target="_blank"
                    rel="noopener noreferrer"
                    [attr.aria-label]="it.name + ' — open documentation'"
                  >
                    <div class="card-top">
                      <div class="logo-tile">
                        <img
                          [src]="it.logo_url"
                          [alt]="it.name + ' logo'"
                          loading="lazy"
                          decoding="async"
                          width="40"
                          height="40"
                          (error)="onLogoError($event)"
                        />
                      </div>
                      <div class="badges">
                        <span class="status-pill" [attr.data-status]="it.status">
                          {{ it.status }}
                        </span>
                        @if (it.mcp_supported) {
                          <span class="mcp-pill" title="Supports the Model Context Protocol">
                            MCP
                          </span>
                        }
                      </div>
                    </div>
                    <h3 class="card-title">{{ it.name }}</h3>
                    <p class="card-desc">{{ it.description }}</p>
                    <span class="card-link">Open docs →</span>
                  </a>
                }
              </div>
            </section>
          } @empty {
            <p class="state-msg">
              No integrations match your filters.
              <button type="button" class="link-btn" (click)="clearFilters()">Clear filters</button>
            </p>
          }
        }
      </div>
    </section>
  `,
  styles: [
    `
      :host {
        display: block;
        background: var(--ps-bg, #060610);
        color: var(--ps-ink, #f4f4ff);
      }

      .integrations-page {
        min-height: calc(100vh - 60px);
        padding: 56px 24px 96px;
      }

      .integrations-inner {
        max-width: 1240px;
        margin: 0 auto;
      }

      .page-header {
        text-align: center;
        margin-bottom: 48px;
      }

      .eyebrow {
        font-size: 0.75rem;
        font-weight: 700;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        color: var(--ps-accent, #00e5ff);
        margin: 0 0 12px;
      }

      h1 {
        font-size: clamp(2rem, 5vw, 3rem);
        font-weight: 800;
        letter-spacing: -0.03em;
        margin: 0 0 14px;
        background: linear-gradient(
          135deg,
          var(--ps-ink, #f4f4ff) 0%,
          color-mix(in oklch, var(--ps-accent, #00e5ff) 70%, var(--ps-ink, #f4f4ff)) 100%
        );
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
      }

      .subtitle {
        font-size: 1.02rem;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 65%, transparent);
        max-width: 640px;
        margin: 0 auto 28px;
        line-height: 1.55;
      }

      .filter-row {
        display: inline-flex;
        gap: 10px;
        align-items: center;
        flex-wrap: wrap;
        justify-content: center;
      }

      .search-input {
        padding: 10px 16px;
        border-radius: 999px;
        border: 1px solid color-mix(in oklch, var(--ps-ink, #f4f4ff) 18%, transparent);
        background: color-mix(in oklch, var(--ps-bg, #060610) 80%, var(--ps-ink, #f4f4ff));
        color: var(--ps-ink, #f4f4ff);
        font-size: 0.92rem;
        min-width: 280px;
        outline: none;
        transition:
          border-color 0.2s ease,
          box-shadow 0.2s ease;
      }

      .search-input:focus {
        border-color: var(--ps-accent, #00e5ff);
        box-shadow: 0 0 0 3px color-mix(in oklch, var(--ps-accent, #00e5ff) 25%, transparent);
      }

      .filter-chip {
        padding: 10px 18px;
        border-radius: 999px;
        border: 1px solid color-mix(in oklch, var(--ps-ink, #f4f4ff) 18%, transparent);
        background: transparent;
        color: var(--ps-ink, #f4f4ff);
        font-size: 0.85rem;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.2s ease;
      }

      .filter-chip.is-active {
        background: var(--ps-accent, #00e5ff);
        color: var(--ps-bg, #060610);
        border-color: var(--ps-accent, #00e5ff);
      }

      .filter-chip:hover:not(.is-active) {
        border-color: var(--ps-accent, #00e5ff);
      }

      .state-msg {
        text-align: center;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 60%, transparent);
        padding: 60px 0;
      }

      .state-error {
        color: #f87171;
      }

      .link-btn {
        background: none;
        border: none;
        color: var(--ps-accent, #00e5ff);
        cursor: pointer;
        font-size: inherit;
        padding: 0 4px;
        text-decoration: underline;
      }

      .category-group {
        margin-bottom: 48px;
      }

      .category-head {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 18px;
        padding-bottom: 10px;
        border-bottom: 1px solid color-mix(in oklch, var(--ps-ink, #f4f4ff) 10%, transparent);
      }

      .category-head h2 {
        font-size: 1.1rem;
        font-weight: 700;
        margin: 0;
        letter-spacing: -0.01em;
        color: var(--ps-ink, #f4f4ff);
      }

      .count-pill {
        font-size: 0.7rem;
        font-weight: 700;
        padding: 3px 9px;
        border-radius: 999px;
        background: color-mix(in oklch, var(--ps-accent, #00e5ff) 12%, transparent);
        color: var(--ps-accent, #00e5ff);
        font-variant-numeric: tabular-nums;
      }

      .card-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
        gap: 16px;
      }

      .card {
        display: flex;
        flex-direction: column;
        padding: 18px 18px 20px;
        background: color-mix(in oklch, var(--ps-bg, #060610) 78%, var(--ps-ink, #f4f4ff));
        border: 1px solid color-mix(in oklch, var(--ps-ink, #f4f4ff) 8%, transparent);
        border-radius: var(--ps-radius-xl, 16px);
        text-decoration: none;
        color: inherit;
        transition:
          transform 0.2s ease,
          border-color 0.2s ease,
          box-shadow 0.2s ease;
      }

      .card:hover {
        transform: translateY(-3px);
        border-color: color-mix(in oklch, var(--ps-accent, #00e5ff) 35%, transparent);
        box-shadow: 0 10px 32px color-mix(in oklch, var(--ps-accent, #00e5ff) 12%, transparent);
      }

      .card:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 2px;
      }

      .card-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 14px;
        gap: 12px;
      }

      /* Per rules/logo-contrast.md — opaque white tile, padding, rounded so
         dark / colored marks always render against a contrast-safe surface. */
      .logo-tile {
        width: 48px;
        height: 48px;
        padding: 6px;
        border-radius: 12px;
        background: #ffffff;
        box-shadow:
          0 1px 2px rgba(0, 0, 0, 0.18),
          inset 0 0 0 1px rgba(0, 0, 0, 0.04);
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }

      .logo-tile img {
        width: 100%;
        height: 100%;
        object-fit: contain;
      }

      .badges {
        display: flex;
        gap: 6px;
        align-items: center;
        flex-wrap: wrap;
        justify-content: flex-end;
      }

      .status-pill {
        font-size: 0.65rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        padding: 3px 8px;
        border-radius: 999px;
      }

      .status-pill[data-status='live'] {
        background: rgba(34, 197, 94, 0.14);
        color: #4ade80;
        border: 1px solid rgba(34, 197, 94, 0.35);
      }

      .status-pill[data-status='beta'] {
        background: rgba(245, 158, 11, 0.14);
        color: #fbbf24;
        border: 1px solid rgba(245, 158, 11, 0.35);
      }

      .status-pill[data-status='planned'] {
        background: rgba(148, 163, 184, 0.14);
        color: #cbd5e1;
        border: 1px solid rgba(148, 163, 184, 0.35);
      }

      .mcp-pill {
        font-size: 0.65rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        padding: 3px 8px;
        border-radius: 999px;
        background: color-mix(in oklch, var(--ps-accent, #00e5ff) 18%, transparent);
        color: var(--ps-accent, #00e5ff);
        border: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 35%, transparent);
      }

      .card-title {
        font-size: 1rem;
        font-weight: 700;
        margin: 0 0 6px;
        color: var(--ps-ink, #f4f4ff);
      }

      .card-desc {
        font-size: 0.83rem;
        line-height: 1.5;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 70%, transparent);
        margin: 0 0 14px;
        flex-grow: 1;
      }

      .card-link {
        font-size: 0.78rem;
        font-weight: 600;
        color: var(--ps-accent, #00e5ff);
        letter-spacing: 0.02em;
      }

      @media (prefers-reduced-motion: reduce) {
        .card {
          transition: none;
        }
      }
    `,
  ],
})
export class IntegrationsComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly meta = inject(MetaService);

  /** Loading flag — true between component mount and the first fetch resolution. */
  protected readonly loading = signal<boolean>(true);
  /** Populated when the HTTP fetch fails so the template can render the error state. */
  protected readonly error = signal<string | null>(null);
  /** Raw API response. Drives every downstream computed signal. */
  protected readonly response = signal<IntegrationsResponse | null>(null);

  /** Plain ngModel binding for the search input. Trimmed inside the computed filter. */
  protected searchTerm = '';
  /** When true, hide every integration whose `mcp_supported` flag is false. */
  protected readonly showMcpOnly = signal<boolean>(false);

  /** Total count for the header copy. Defaults to a dash before load. */
  protected readonly totalCount = computed(() => this.response()?.count ?? 0);
  /** MCP-ready count for the header copy. */
  protected readonly mcpCount = computed(() => this.response()?.mcp_supported_count ?? 0);
  /** Number of unique categories rendered. */
  protected readonly categoryCount = computed(
    () => Object.keys(this.response()?.by_category ?? {}).length,
  );

  /**
   * Filtered + grouped integrations in the order declared by
   * {@link CATEGORY_ORDER}. Categories with zero matching items are dropped
   * so the page never renders an empty header.
   */
  protected readonly orderedGroups = computed<
    readonly { category: string; items: readonly Integration[] }[]
  >(() => {
    const data = this.response();
    if (!data) return [];
    const term = this.searchTerm.trim().toLowerCase();
    const mcpOnly = this.showMcpOnly();
    const matches = (it: Integration): boolean => {
      if (mcpOnly && !it.mcp_supported) return false;
      if (!term) return true;
      return (
        it.name.toLowerCase().includes(term) ||
        it.description.toLowerCase().includes(term) ||
        it.category.toLowerCase().includes(term)
      );
    };
    const groups: { category: string; items: Integration[] }[] = [];
    const seen = new Set<string>();
    const allCategories = Object.keys(data.by_category);
    const ordered = [
      ...CATEGORY_ORDER.filter((c) => allCategories.includes(c)),
      ...allCategories.filter((c) => !CATEGORY_ORDER.includes(c)),
    ];
    for (const cat of ordered) {
      if (seen.has(cat)) continue;
      seen.add(cat);
      const items = (data.by_category[cat] ?? []).filter(matches);
      if (items.length > 0) groups.push({ category: cat, items });
    }
    return groups;
  });

  ngOnInit(): void {
    this.meta.init();
    this.fetchIntegrations();
  }

  /** Toggle the MCP-only filter chip. */
  protected toggleMcpOnly(): void {
    this.showMcpOnly.update((v) => !v);
  }

  /** Reset every filter to its default value. Triggered from the empty state. */
  protected clearFilters(): void {
    this.searchTerm = '';
    this.showMcpOnly.set(false);
  }

  /**
   * Soft-handle broken logo URLs by replacing the source with the first
   * letter rendered as an inline SVG so the layout never collapses.
   */
  protected onLogoError(event: Event): void {
    const target = event.target as HTMLImageElement;
    const alt = target.alt || '?';
    const letter = alt.charAt(0).toUpperCase();
    const fallback =
      `data:image/svg+xml;utf8,` +
      encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">` +
          `<rect width="40" height="40" rx="8" fill="#0f172a"/>` +
          `<text x="20" y="26" font-family="sans-serif" font-size="20" font-weight="700" fill="#00e5ff" text-anchor="middle">${letter}</text>` +
          `</svg>`,
      );
    target.src = fallback;
  }

  /**
   * Fetch the integration catalog from the public API. Errors surface via
   * the `error` signal rather than thrown so the user sees a recoverable state.
   */
  /**
   * Rewrite dead `logo.clearbit.com/{domain}` URLs (Clearbit's free Logo API
   * was shut down by HubSpot in Dec 2024 → ERR_NAME_NOT_RESOLVED on every load)
   * to Google's favicon service, which is reliable, key-free, CSP-allowed
   * (img-src *), and returns a real PNG. `onLogoError` still covers any miss
   * with a monogram. Non-clearbit URLs pass through untouched.
   */
  private reliableLogoUrl(url: string): string {
    const m = /^https?:\/\/logo\.clearbit\.com\/([^/?#]+)/.exec(url ?? '');
    return m ? `https://www.google.com/s2/favicons?domain=${m[1]}&sz=128` : url;
  }

  private fetchIntegrations(): void {
    this.http.get<IntegrationsResponse>('/api/public/integrations').subscribe({
      next: (data) => {
        const fix = (it: Integration): Integration => ({ ...it, logo_url: this.reliableLogoUrl(it.logo_url) });
        // The card grid renders from `by_category` (see orderedGroups), so both
        // the flat list AND the grouped map must be rewritten.
        const by_category: Record<string, Integration[]> = {};
        for (const [cat, items] of Object.entries(data.by_category ?? {})) {
          by_category[cat] = (items ?? []).map(fix);
        }
        this.response.set({
          ...data,
          integrations: (data.integrations ?? []).map(fix),
          by_category,
        });
        this.loading.set(false);
      },
      error: (err: unknown) => {
        const message = err instanceof Error ? err.message : 'Failed to load integrations';
        console.warn('[integrations] fetch failed:', message);
        this.error.set('Could not load the catalog. Please refresh.');
        this.loading.set(false);
      },
    });
  }
}
