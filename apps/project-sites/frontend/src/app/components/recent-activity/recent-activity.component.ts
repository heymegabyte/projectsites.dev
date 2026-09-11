import { ChangeDetectionStrategy, Component, computed, inject, signal, OnInit } from '@angular/core';
import { ApiService } from '../../services/api.service';
import { sanitizeAuditSummary } from '../../utils/sanitize-audit-summary';

/** One activity entry, mirrors the worker `ActivityEntry` schema. */
interface ActivityEntry {
  id: string;
  kind: string;
  summary: string;
  actorName: string | null;
  targetType: string | null;
  targetName: string | null;
  siteSlug: string | null;
  timestamp: string;
}

/** `GET /api/activity` response. */
interface ActivityFeedResponse {
  data: ActivityEntry[];
  cursor: string | null;
  hasMore: boolean;
}

/**
 * Recent-activity feed — the client for the `activity_feed` feature. Renders an
 * org-scoped timeline (build / publish / domain / member / billing / integration
 * events) as a compact card on the /admin getting-started hub.
 *
 * @remarks
 * The API IS the flag gate: `GET /api/activity` returns 404 when the
 * `activity_feed` flag is off → the widget renders nothing. It also self-hides
 * when the org has no activity yet (honest-empty), so a brand-new hub stays clean.
 *
 * @example
 * <app-recent-activity />
 */
@Component({
  selector: 'app-recent-activity',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (loading()) {
      <!-- Reserve the card's height (mirrors the real header + 8 rows) while the feed
           fetches, so the section-guide groups below don't get shoved down when the
           populated card appears — this was the dominant /admin dashboard layout shift
           (CLS 0.23 → ≤0.05). aria-hidden: purely presentational; the real feed replaces
           it. An org with no activity collapses it (honest-empty) — a rare one-time shift. -->
      <section class="ra ra-skeleton" aria-hidden="true" data-testid="recent-activity-skeleton">
        <header class="ra-head"><span class="ra-skel ra-skel-title"></span></header>
        <ul class="ra-list">
          @for (i of skelRows; track i) {
            <li class="ra-item">
              <span class="ra-dot ra-skel-dot" aria-hidden="true"></span>
              <span class="ra-body">
                <span class="ra-skel ra-skel-l1"></span>
                <span class="ra-skel ra-skel-l2"></span>
              </span>
            </li>
          }
        </ul>
      </section>
    } @else if (visible()) {
      <section class="ra" role="region" aria-labelledby="ra-heading" data-testid="recent-activity">
        <header class="ra-head">
          <h2 id="ra-heading" class="ra-title">Recent activity</h2>
          <span class="ra-count" data-testid="recent-activity-count">{{ entries().length }}</span>
        </header>
        <ul class="ra-list" data-testid="recent-activity-list">
          @for (e of entries(); track e.id) {
            <li class="ra-item" data-testid="activity-entry" [attr.data-kind]="e.kind">
              <span class="ra-dot" [class]="'ra-dot--' + tone(e.kind)" aria-hidden="true"></span>
              <span class="ra-body">
                <span class="ra-summary">{{ clean(e.summary) }}</span>
                <span class="ra-meta">{{ label(e.kind) }}@if (e.actorName) { · {{ e.actorName }}} · {{ relTime(e.timestamp) }}</span>
              </span>
            </li>
          }
        </ul>
      </section>
    }
  `,
  styles: [`
    :host { display: block; }
    .ra {
      margin: 0 0 1.25rem; padding: 1.1rem 1.3rem;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: var(--ps-radius-xl, 22px);
      background: rgba(255,255,255,0.015);
    }
    .ra-head { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.8rem; }
    .ra-title { font-size: 0.92rem; font-weight: 700; margin: 0; color: var(--ps-ink, #f4f4ff); }
    .ra-count {
      font-size: 0.66rem; font-weight: 700; font-variant-numeric: tabular-nums;
      padding: 1px 8px; border-radius: 999px;
      color: var(--ps-accent, #00e5ff);
      background: color-mix(in oklch, var(--ps-accent, #00e5ff) 12%, transparent);
    }
    .ra-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .ra-item { display: flex; align-items: flex-start; gap: 0.7rem; padding: 0.5rem 0; min-width: 0; border-top: 1px solid rgba(255,255,255,0.04); }
    .ra-item:first-child { border-top: 0; }
    .ra-dot { flex-shrink: 0; width: 8px; height: 8px; border-radius: 999px; margin-top: 0.42rem; background: rgba(255,255,255,0.4); }
    .ra-dot--ok { background: #34d399; }
    .ra-dot--info { background: var(--ps-accent, #00e5ff); }
    .ra-dot--warn { background: #fbbf24; }
    .ra-dot--danger { background: #f87171; }
    .ra-body { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
    .ra-summary { font-size: 0.84rem; color: var(--ps-ink, #f4f4ff); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ra-meta { font-size: 0.68rem; color: var(--ps-text-muted, rgba(255,255,255,0.6)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* Loading skeleton — reuses .ra / .ra-head / .ra-item so its height matches the real
       card row-for-row (reserves space → no CLS when the feed lands). */
    .ra-skel { display: block; border-radius: 6px; background: rgba(255,255,255,0.06); animation: ra-pulse 1.4s ease-in-out infinite; }
    .ra-skel-title { width: 8rem; height: 0.92rem; }
    .ra-skel-dot { background: rgba(255,255,255,0.12); animation: ra-pulse 1.4s ease-in-out infinite; }
    .ra-skel-l1 { width: 70%; height: 0.84rem; margin-bottom: 3px; }
    .ra-skel-l2 { width: 45%; height: 0.68rem; }
    @keyframes ra-pulse { 0%, 100% { opacity: 0.55; } 50% { opacity: 0.9; } }
    @media (prefers-reduced-motion: reduce) { .ra-skel, .ra-skel-dot { animation: none; } }
  `],
})
export class RecentActivityComponent implements OnInit {
  private readonly api = inject(ApiService);

  private readonly data = signal<ActivityEntry[] | null>(null);

  readonly entries = computed(() => this.data() ?? []);
  /** Show only when the feed has real entries (flag on + non-empty). */
  readonly visible = computed(() => this.entries().length > 0);
  /** True until the feed fetch resolves (data still null) — drives the height-reserving
   *  skeleton so the populated card doesn't shift the groups below when it lands. */
  readonly loading = computed(() => this.data() === null);
  /** Skeleton row placeholders — mirrors the API's `limit: 8` so the reserved height
   *  matches a full feed (the common active-org case the CLS probe measures). */
  readonly skelRows = [0, 1, 2, 3, 4, 5, 6, 7];

  ngOnInit(): void {
    // `silent: true` — a 404 (flag off) is expected, never a user-facing toast.
    this.api
      .get<ActivityFeedResponse>('/activity', { limit: '8' }, { silent: true })
      .subscribe({
        next: (res) => this.data.set(res?.data ?? []),
        error: () => this.data.set([]),
      });
  }

  /** Colour tone for a kind's leading dot. */
  tone(kind: string): 'ok' | 'info' | 'warn' | 'danger' {
    if (kind.endsWith('.failed') || kind.endsWith('.payment_failed') || kind.endsWith('.deleted') || kind.endsWith('.removed')) return 'danger';
    if (kind.endsWith('.archived')) return 'warn';
    if (kind === 'site.published' || kind === 'build.completed' || kind === 'workflow.completed' || kind === 'integration.connected') return 'ok';
    return 'info';
  }

  /** Short human label for a kind. */
  label(kind: string): string {
    const map: Record<string, string> = {
      'build.started': 'Build started',
      'build.completed': 'Build',
      'build.failed': 'Build failed',
      'site.published': 'Published',
      'site.archived': 'Archived',
      'site.deleted': 'Deleted',
      'snapshot.created': 'Snapshot',
      'snapshot.deleted': 'Snapshot',
      'domain.added': 'Domain',
      'domain.removed': 'Domain removed',
      'billing.plan_changed': 'Billing',
      'billing.payment_failed': 'Payment failed',
      'member.invited': 'Team',
      'member.removed': 'Team',
      'workflow.started': 'Workflow',
      'workflow.completed': 'Workflow',
      'integration.connected': 'Integration',
      'integration.disconnected': 'Integration',
      'settings.updated': 'Settings',
      'data.query': 'Data',
    };
    return map[kind] ?? 'Activity';
  }

  /** Compact relative time ("2h ago", "3d ago") from an ISO/SQL timestamp. */
  relTime(ts: string): string {
    const then = new Date(ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z').getTime();
    if (Number.isNaN(then)) return '';
    const diff = Math.max(0, Date.now() - then);
    const m = Math.floor(diff / 60_000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
  }

  /**
   * Scrub a stray interpolated `undefined`/`null` from a stored summary before
   * render (e.g. the checkout writer's "for 'undefined' tier"). Delegates to the
   * shared {@link sanitizeAuditSummary} so this widget and the /admin/audit table
   * stay byte-identical — AL-139 de-duplicated what was an inline copy here.
   */
  clean(summary: string): string {
    return sanitizeAuditSummary(summary);
  }
}
