/**
 * @module pages/changelog
 *
 * @description
 * Public changelog page rendered at `/changelog`. Fetches entries from
 * `GET /changelog.json` (with an in-component fallback if the API is
 * unreachable), supports full-text search + tag-chip filtering, and exposes
 * a one-click "Copy RSS link" button so power users can subscribe in any feed
 * reader. The component also stamps a `<link rel="alternate" type="application/rss+xml">`
 * via the MetaService so feed-aware browsers + AI crawlers auto-discover it.
 */
import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { MetaService } from '../../services/meta.service';

/**
 * Shape returned by `GET /changelog.json`. Keep aligned with the worker's
 * `ChangelogEntry` interface so the two never drift.
 */
interface ChangelogEntry {
  readonly date: string;
  readonly version: string;
  readonly title: string;
  readonly body: string;
  readonly tags: readonly string[];
}

interface ChangelogResponse {
  readonly entries: readonly ChangelogEntry[];
  readonly count: number;
  readonly source: string;
}

/**
 * Inline fallback used only if the public API is unreachable. Keeps the page
 * useful for crawlers + first-load even when CACHE_KV is cold.
 */
const FALLBACK_ENTRIES: readonly ChangelogEntry[] = [
  {
    date: '2026-06-19',
    version: 'v1.8.0',
    title: 'Trust Center + installable PWA',
    body: 'New /trust page lays out our security posture honestly — generated sites are scanned so server-only keys never reach the browser, every build earns an A–F readiness grade, and connected credentials are encrypted at rest. Project Sites is now installable to your home screen on Android, desktop Chrome, and iOS Safari.',
    tags: ['feature', 'security', 'trust', 'pwa'],
  },
  {
    date: '2026-05-25',
    version: 'v1.7.0',
    title: 'Distribution flywheel — changelog, roadmap, integrations, RSS',
    body: 'Public RSS feed at /feed.xml. New /roadmap page. New /integrations catalog. Changelog gains search + tag filters.',
    tags: ['feature', 'marketing', 'rss'],
  },
  {
    date: '2026-05-24',
    version: 'v1.6.0',
    title: 'Cinematic landing + voice agent',
    body: 'New OKLCH-meshed homepage. AI Voice + SMS Agent ships with Twilio media-stream bridge.',
    tags: ['feature', 'voice', 'design'],
  },
];

/**
 * Public changelog page.
 *
 * @example
 * ```ts
 * // app.routes.ts
 * { path: 'changelog', loadComponent: () =>
 *   import('./pages/changelog/changelog.component').then((m) => m.ChangelogComponent) }
 * ```
 */
@Component({
  selector: 'app-changelog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, RouterLink, DatePipe],
  template: `
    <section class="changelog-page">
      <div class="changelog-inner">
        <header class="changelog-header">
          <p class="eyebrow">Changelog</p>
          <h1>What we shipped, fixed, and improved</h1>
          <p class="subtitle">
            Every release. Every fix. Subscribe via RSS to get notified the moment we ship.
          </p>
          <div class="actions">
            <button type="button" class="action-btn primary" (click)="copyRssLink()">
              {{ copied() ? 'Copied!' : 'Copy RSS link' }}
            </button>
            <a
              class="action-btn"
              href="/feed.xml"
              target="_blank"
              rel="noopener noreferrer"
            >
              Open feed
            </a>
          </div>
        </header>

        <div class="filter-row">
          <input
            class="search-input"
            type="search"
            placeholder="Search releases…"
            [(ngModel)]="searchTerm"
            aria-label="Search the changelog"
          />
          @if (allTags().length > 0) {
            <div class="chip-row" role="group" aria-label="Filter by tag">
              <button
                type="button"
                class="tag-chip"
                [class.is-active]="activeTag() === null"
                (click)="setTag(null)"
              >
                All
              </button>
              @for (tag of allTags(); track tag) {
                <button
                  type="button"
                  class="tag-chip"
                  [class.is-active]="activeTag() === tag"
                  (click)="setTag(tag)"
                >
                  {{ tag }}
                </button>
              }
            </div>
          }
        </div>

        @if (loading()) {
          <p class="state-msg">Loading changelog…</p>
        } @else {
          <div class="timeline">
            @for (entry of visibleEntries(); track entry.version + entry.date) {
              <article class="timeline-entry">
                <div class="timeline-marker"></div>
                <div class="timeline-card">
                  <div class="entry-top">
                    <span class="entry-version">{{ entry.version }}</span>
                    @for (tag of entry.tags; track tag) {
                      <span class="entry-tag" [attr.data-tag]="tag">{{ tag }}</span>
                    }
                    <time class="entry-date" [attr.datetime]="entry.date">
                      {{ entry.date | date: 'MMM d, y' }}
                    </time>
                  </div>
                  <h2 class="entry-title">{{ entry.title }}</h2>
                  <p class="entry-desc">{{ entry.body }}</p>
                </div>
              </article>
            } @empty {
              <p class="state-msg">
                No releases match your filters.
                <button type="button" class="link-btn" (click)="clearFilters()">
                  Clear filters
                </button>
              </p>
            }
          </div>
        }
      </div>
    </section>

    <footer class="site-footer">
      <div class="footer-inner">
        <div class="footer-bottom">
          <span>
            &copy; 2026
            <a href="https://megabyte.space" target="_blank" rel="noopener noreferrer">
              Megabyte LLC
            </a>
          </span>
          <span>
            <a routerLink="/privacy">Privacy</a> |
            <a routerLink="/terms">Terms</a> |
            <a routerLink="/trust">Trust</a> |
            <a routerLink="/blog">Blog</a> |
            <a routerLink="/changelog">Changelog</a> |
            <a routerLink="/integrations">Integrations</a>
          </span>
        </div>
      </div>
    </footer>
  `,
  styles: [
    `
      :host {
        display: block;
        background: var(--ps-bg, #060610);
        color: var(--ps-ink, #f4f4ff);
      }

      .changelog-page {
        min-height: calc(100vh - 60px - 120px);
        padding: 48px 24px 80px;
      }

      .changelog-inner {
        max-width: 760px;
        margin: 0 auto;
      }

      .changelog-header {
        text-align: center;
        margin-bottom: 36px;
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
        margin: 0 0 12px;
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
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 60%, transparent);
        margin: 0 0 22px;
      }

      .actions {
        display: inline-flex;
        gap: 10px;
        flex-wrap: wrap;
        justify-content: center;
      }

      .action-btn {
        display: inline-flex;
        align-items: center;
        padding: 9px 18px;
        border-radius: 999px;
        font-size: 0.86rem;
        font-weight: 600;
        text-decoration: none;
        cursor: pointer;
        border: 1px solid color-mix(in oklch, var(--ps-ink, #f4f4ff) 18%, transparent);
        background: transparent;
        color: var(--ps-ink, #f4f4ff);
        transition: border-color 0.2s ease, transform 0.2s ease;
      }

      .action-btn:hover {
        border-color: var(--ps-accent, #00e5ff);
        color: var(--ps-accent, #00e5ff);
      }

      .action-btn.primary {
        background: var(--ps-accent, #00e5ff);
        color: var(--ps-bg, #060610);
        border-color: var(--ps-accent, #00e5ff);
      }

      .action-btn.primary:hover {
        color: var(--ps-bg, #060610);
        transform: translateY(-1px);
      }

      .filter-row {
        display: flex;
        flex-direction: column;
        gap: 12px;
        margin-bottom: 28px;
      }

      .search-input {
        padding: 10px 16px;
        border-radius: 999px;
        border: 1px solid color-mix(in oklch, var(--ps-ink, #f4f4ff) 18%, transparent);
        background: color-mix(in oklch, var(--ps-bg, #060610) 80%, var(--ps-ink, #f4f4ff));
        color: var(--ps-ink, #f4f4ff);
        font-size: 0.92rem;
        outline: none;
        transition: border-color 0.2s ease, box-shadow 0.2s ease;
      }

      .search-input:focus {
        border-color: var(--ps-accent, #00e5ff);
        box-shadow: 0 0 0 3px
          color-mix(in oklch, var(--ps-accent, #00e5ff) 25%, transparent);
      }

      .chip-row {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }

      .tag-chip {
        padding: 6px 12px;
        border-radius: 999px;
        border: 1px solid color-mix(in oklch, var(--ps-ink, #f4f4ff) 12%, transparent);
        background: transparent;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 70%, transparent);
        font-size: 0.74rem;
        font-weight: 600;
        cursor: pointer;
        text-transform: lowercase;
        transition: all 0.2s ease;
      }

      .tag-chip:hover {
        border-color: var(--ps-accent, #00e5ff);
        color: var(--ps-accent, #00e5ff);
      }

      .tag-chip.is-active {
        background: var(--ps-accent, #00e5ff);
        color: var(--ps-bg, #060610);
        border-color: var(--ps-accent, #00e5ff);
      }

      .state-msg {
        text-align: center;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 60%, transparent);
        padding: 30px 0;
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

      .timeline {
        position: relative;
        padding-left: 32px;
      }

      .timeline::before {
        content: '';
        position: absolute;
        left: 7px;
        top: 8px;
        bottom: 8px;
        width: 2px;
        background: linear-gradient(
          180deg,
          color-mix(in oklch, var(--ps-accent, #00e5ff) 40%, transparent),
          color-mix(in oklch, var(--ps-accent, #00e5ff) 5%, transparent)
        );
        border-radius: 2px;
      }

      .timeline-entry {
        position: relative;
        margin-bottom: 22px;
      }

      .timeline-marker {
        position: absolute;
        left: -28px;
        top: 20px;
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: var(--ps-accent, #00e5ff);
        border: 2px solid var(--ps-bg, #060610);
        box-shadow: 0 0 10px color-mix(in oklch, var(--ps-accent, #00e5ff) 40%, transparent);
      }

      .timeline-card {
        padding: 20px 22px;
        background: color-mix(in oklch, var(--ps-bg, #060610) 78%, var(--ps-ink, #f4f4ff));
        border: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 6%, transparent);
        border-radius: 14px;
        transition: border-color 0.3s ease, box-shadow 0.3s ease;
      }

      .timeline-card:hover {
        border-color: color-mix(in oklch, var(--ps-accent, #00e5ff) 18%, transparent);
        box-shadow: 0 8px 30px rgba(0, 0, 0, 0.3);
      }

      .entry-top {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 8px;
        margin-bottom: 10px;
      }

      .entry-version {
        font-size: 0.92rem;
        font-weight: 700;
        color: var(--ps-ink, #f4f4ff);
        font-family: 'JetBrains Mono', 'Fira Code', monospace;
      }

      .entry-tag {
        display: inline-block;
        font-size: 0.66rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        padding: 3px 9px;
        border-radius: 20px;
        color: var(--ps-accent, #00e5ff);
        background: color-mix(in oklch, var(--ps-accent, #00e5ff) 10%, transparent);
        border: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 22%, transparent);
      }

      .entry-tag[data-tag='launch'],
      .entry-tag[data-tag='feature'] {
        color: var(--ps-accent, #00e5ff);
      }

      .entry-tag[data-tag='fix'] {
        color: #fbbf24;
        background: rgba(245, 158, 11, 0.1);
        border-color: rgba(245, 158, 11, 0.25);
      }

      .entry-tag[data-tag='perf'],
      .entry-tag[data-tag='quality'] {
        color: #a78bfa;
        background: rgba(167, 139, 250, 0.1);
        border-color: rgba(167, 139, 250, 0.25);
      }

      .entry-date {
        font-size: 0.76rem;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 78%, var(--ps-bg, #060610));
        margin-left: auto;
        font-variant-numeric: tabular-nums;
      }

      .entry-title {
        font-size: 1.05rem;
        font-weight: 700;
        margin: 0 0 8px;
        color: var(--ps-ink, #f4f4ff);
        line-height: 1.35;
      }

      .entry-desc {
        font-size: 0.9rem;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 70%, transparent);
        line-height: 1.65;
        margin: 0;
      }

      .site-footer {
        padding: 36px 24px 28px;
        border-top: 1px solid color-mix(in oklch, var(--ps-ink, #f4f4ff) 6%, transparent);
      }

      .footer-inner {
        max-width: 760px;
        margin: 0 auto;
      }

      .footer-bottom {
        display: flex;
        justify-content: space-between;
        align-items: center;
        flex-wrap: wrap;
        gap: 12px;
        font-size: 0.8rem;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 78%, var(--ps-bg, #060610));
      }

      .footer-bottom a {
        color: inherit;
        text-decoration: none;
        transition: color 0.2s ease;
      }

      .footer-bottom a:hover {
        color: var(--ps-accent, #00e5ff);
      }

      @media (max-width: 640px) {
        .footer-bottom {
          flex-direction: column;
          text-align: center;
        }
      }
    `,
  ],
})
export class ChangelogComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly meta = inject(MetaService);

  /** Loading flag — true between component mount and the first fetch resolution. */
  protected readonly loading = signal<boolean>(true);
  /** All entries returned by the API (or the fallback). */
  protected readonly entries = signal<readonly ChangelogEntry[]>([]);
  /** Plain ngModel for the search input. Filtered in `visibleEntries`. */
  protected searchTerm = '';
  /** Active tag chip, or `null` for "show all". */
  protected readonly activeTag = signal<string | null>(null);
  /** Flips to `true` for two seconds after a successful clipboard copy. */
  protected readonly copied = signal<boolean>(false);

  /** Unique tag list extracted from every loaded entry. */
  protected readonly allTags = computed<readonly string[]>(() => {
    const tags = new Set<string>();
    for (const entry of this.entries()) {
      for (const tag of entry.tags) tags.add(tag);
    }
    return [...tags].sort();
  });

  /**
   * Entries that pass both the search-term filter and the active-tag filter.
   * Sorts newest first by ISO date string.
   */
  protected readonly visibleEntries = computed<readonly ChangelogEntry[]>(() => {
    const term = this.searchTerm.trim().toLowerCase();
    const tag = this.activeTag();
    return this.entries()
      .filter((e) => {
        if (tag && !e.tags.includes(tag)) return false;
        if (!term) return true;
        return (
          e.title.toLowerCase().includes(term) ||
          e.body.toLowerCase().includes(term) ||
          e.version.toLowerCase().includes(term)
        );
      })
      .slice()
      .sort((a, b) => b.date.localeCompare(a.date));
  });

  ngOnInit(): void {
    this.meta.init();
    this.ensureRssLinkTag();
    this.fetchEntries();
  }

  /** Update the active tag-chip filter. Pass `null` for the "All" chip. */
  protected setTag(tag: string | null): void {
    this.activeTag.set(tag);
  }

  /** Reset every filter to its default value. */
  protected clearFilters(): void {
    this.searchTerm = '';
    this.activeTag.set(null);
  }

  /**
   * Copy the public RSS URL to the clipboard. Falls back to selecting a
   * hidden textarea when the async clipboard API is blocked (Safari private,
   * older browsers, embedded webviews).
   */
  protected async copyRssLink(): Promise<void> {
    const url = 'https://projectsites.dev/feed.xml';
    try {
      await navigator.clipboard.writeText(url);
      this.flashCopied();
    } catch {
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        this.flashCopied();
      } catch (err) {
        console.warn('[changelog] clipboard copy failed:', err);
      } finally {
        document.body.removeChild(ta);
      }
    }
  }

  /** Briefly flip `copied` to `true` so the button text updates. */
  private flashCopied(): void {
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 2000);
  }

  /**
   * Ensure exactly one `<link rel="alternate" type="application/rss+xml">`
   * element is present in `<head>` pointing at the public RSS feed. Feed
   * readers, RSS-aware browsers, and AI search crawlers use this for
   * auto-discovery.
   */
  private ensureRssLinkTag(): void {
    if (typeof document === 'undefined') return;
    const existing = document.querySelector(
      'link[rel="alternate"][type="application/rss+xml"]',
    ) as HTMLLinkElement | null;
    if (existing) {
      existing.href = '/feed.xml';
      existing.title = 'ProjectSites Changelog';
      return;
    }
    const link = document.createElement('link');
    link.rel = 'alternate';
    link.type = 'application/rss+xml';
    link.title = 'ProjectSites Changelog';
    link.href = '/feed.xml';
    document.head.appendChild(link);
  }

  /**
   * Fetch the changelog from the public API. Falls back to the inline list
   * if the request fails so the page is never blank.
   */
  private fetchEntries(): void {
    this.http.get<ChangelogResponse>('/changelog.json').subscribe({
      next: (data) => {
        this.entries.set(data.entries ?? []);
        this.loading.set(false);
      },
      error: (err: unknown) => {
        const message = err instanceof Error ? err.message : 'changelog fetch failed';
        console.warn('[changelog] using fallback entries:', message);
        this.entries.set(FALLBACK_ENTRIES);
        this.loading.set(false);
      },
    });
  }
}
