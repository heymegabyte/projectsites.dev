import { Component, signal, inject, DestroyRef, type OnInit } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { ApiService } from '../services/api.service';

/** One Core Web Vital's real-user field stat. */
type CwvMetric = { p75?: number; samples?: number } | null | undefined;

/** Google's CWV thresholds `[good-max, needs-max]` per core metric (LCP/INP ms; CLS unitless). */
const CWV_THRESHOLDS: Record<'lcp' | 'inp' | 'cls', readonly [number, number]> = {
  lcp: [2500, 4000],
  inp: [200, 500],
  cls: [0.1, 0.25],
};

/** One metric's rating from its p75, or null when it has no field samples/p75. */
function metricRating(key: 'lcp' | 'inp' | 'cls', stat: CwvMetric): 'good' | 'needs' | 'poor' | null {
  if (!stat || typeof stat.p75 !== 'number' || !(typeof stat.samples === 'number' && stat.samples > 0)) {
    return null;
  }
  const [good, needs] = CWV_THRESHOLDS[key];
  if (stat.p75 <= good) return 'good';
  if (stat.p75 <= needs) return 'needs';
  return 'poor';
}

/**
 * Overall "Page speed" verdict for the public share report from real-user Core Web Vitals p75s,
 * using Google's pass model: a site is "Good" only when EVERY measured core metric (LCP/INP/CLS)
 * is good; "Poor" if any measured metric is poor; else "Needs improvement". Returns null when NO
 * core metric has field samples yet — the tile is then OMITTED (never a fabricated rating). Pure.
 *
 * @example cwvOverallRating({ lcp: { p75: 1800, samples: 50 }, cls: { p75: 0.05, samples: 50 } }) // 'Good'
 * @example cwvOverallRating({ lcp: { p75: 5000, samples: 50 } }) // 'Poor'
 * @example cwvOverallRating(undefined) // null
 */
export function cwvOverallRating(
  webVitals: { lcp?: CwvMetric; inp?: CwvMetric; cls?: CwvMetric } | undefined,
): 'Good' | 'Needs improvement' | 'Poor' | null {
  if (!webVitals) return null;
  const ratings = [
    metricRating('lcp', webVitals.lcp),
    metricRating('inp', webVitals.inp),
    metricRating('cls', webVitals.cls),
  ].filter((r): r is 'good' | 'needs' | 'poor' => r !== null);
  if (ratings.length === 0) return null;
  if (ratings.some((r) => r === 'poor')) return 'Poor';
  if (ratings.some((r) => r === 'needs')) return 'Needs improvement';
  return 'Good';
}

/** Aggregate (non-PII) owner summary returned by the public share endpoint. */
interface PublicSummary {
  readonly traffic?: {
    readonly pageviews?: number;
    /** Distinct per-day anonymous sessions = "Visits" (visitor-days), NOT unique people.
     *  The API (SiteAnalyticsSummary.traffic) provides `uniqueSessions` — reading the old
     *  `uniqueVisitors` key silently rendered 0 (key-mismatch lying-empty). */
    readonly uniqueSessions?: number;
    /** First-party engagement — median dwell. Rendered only when `samples > 0` (never a fake 0). */
    readonly engagement?: { readonly medianMs?: number | null; readonly samples?: number };
    /** First-party scroll depth — median max-depth %. Rendered only when `samples > 0`. */
    readonly scrollDepth?: { readonly medianPercent?: number | null; readonly samples?: number };
    /** First-party page-load — median total load ms. Rendered only when `samples > 0`. */
    readonly navTiming?: { readonly total?: number | null; readonly samples?: number };
    /** Real-user Core Web Vitals p75 (LCP/INP/CLS). A metric is null when it has no field
     *  samples yet; the overall "Page speed" rating is shown only when ≥1 core metric has data. */
    readonly webVitals?: {
      readonly lcp?: { readonly p75?: number; readonly samples?: number } | null;
      readonly inp?: { readonly p75?: number; readonly samples?: number } | null;
      readonly cls?: { readonly p75?: number; readonly samples?: number } | null;
    };
  };
  readonly contacts?: { readonly total?: number };
  readonly formSubmissions?: { readonly total?: number };
  readonly newsletter?: { readonly confirmed?: number };
  readonly donations?: { readonly raisedCents?: number; readonly count?: number };
}
/** Cloudflare RUM (CF-measured, sampled) for the site's owned host — an INDEPENDENT second source
 *  to the first-party beacon. Each metric is `{p75, samples}` (+ a server rating we don't re-read).
 *  Null when CF has no data for the host (the report then omits the Cloudflare tiles). */
interface PublicCfRum {
  readonly webVitals?: {
    readonly lcp?: CwvMetric;
    readonly inp?: CwvMetric;
    readonly cls?: CwvMetric;
  };
  readonly navTiming?: { readonly ttfb?: { readonly p75?: number; readonly samples?: number } | null };
}
interface PublicResponse {
  readonly summary: PublicSummary;
  /** CF RUM for the owned host (independent of first-party) — null/absent when CF has no data. */
  readonly cloudflareRum?: PublicCfRum | null;
  readonly expiresAt: number;
}

/**
 * AN48 — PUBLIC read-only analytics view. Rendered for `/shared/analytics/:token`
 * with NO authentication: the HMAC-signed, expiring token in the URL is the
 * capability. Shows the same aggregate (non-PII) numbers the owner sees; an
 * invalid/expired token degrades to a friendly "link expired" message.
 */
@Component({
  selector: 'app-public-analytics',
  standalone: true,
  template: `
    <main class="min-h-screen bg-[#060610] text-[#f4f4ff] px-6 py-10 flex justify-center"
          data-testid="public-analytics">
      <div class="w-full max-w-2xl">
        <header class="mb-6">
          <p class="text-[0.72rem] font-mono uppercase tracking-[0.18em] text-[#00e5ff]">
            ProjectSites · Shared report
          </p>
          <h1 class="text-2xl font-extrabold tracking-tight mt-1 mb-0">Website analytics</h1>
          <p class="text-[0.82rem] text-white/50 mt-1">Read-only · last 30 days</p>
        </header>

        @if (loading()) {
          <div class="h-40 rounded-2xl border border-white/[0.06] bg-white/[0.02] animate-pulse"
               aria-hidden="true"></div>
        } @else if (error()) {
          <div class="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-8 text-center"
               data-testid="public-analytics-error">
            <p class="text-[0.95rem] font-semibold m-0">This share link is invalid or has expired.</p>
            <p class="text-[0.82rem] text-white/50 mt-2 mb-0">Ask the site owner for a fresh link.</p>
          </div>
        } @else {
          <ul class="grid grid-cols-2 gap-3 list-none p-0 m-0" data-testid="public-analytics-stats">
            @for (s of stats(); track s.label) {
              <li class="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4">
                <div class="text-2xl font-extrabold tabular-nums text-[#00e5ff]">{{ s.value }}</div>
                <div class="text-[0.78rem] text-white/55 mt-0.5">{{ s.label }}</div>
              </li>
            }
          </ul>
        }
      </div>
    </main>
  `,
})
export class PublicAnalyticsComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(ApiService);
  private readonly destroyRef = inject(DestroyRef);

  readonly loading = signal(true);
  readonly error = signal(false);
  readonly stats = signal<ReadonlyArray<{ label: string; value: string }>>([]);

  ngOnInit(): void {
    const token = this.route.snapshot.paramMap.get('token') ?? '';
    if (!token) {
      this.error.set(true);
      this.loading.set(false);
      return;
    }
    this.api.get<PublicResponse>(`/public/analytics/${token}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.stats.set(this.toStats(r.summary, r.cloudflareRum));
        this.loading.set(false);
      },
      error: () => {
        this.error.set(true);
        this.loading.set(false);
      },
    });
  }

  private toStats(
    s: PublicSummary,
    cfRum?: PublicCfRum | null,
  ): ReadonlyArray<{ label: string; value: string }> {
    const out: { label: string; value: string }[] = [
      { label: 'Pageviews', value: String(s.traffic?.pageviews ?? 0) },
      { label: 'Visits', value: String(s.traffic?.uniqueSessions ?? 0) },
      { label: 'Contacts', value: String(s.contacts?.total ?? 0) },
      { label: 'Form submissions', value: String(s.formSubmissions?.total ?? 0) },
      { label: 'Newsletter subscribers', value: String(s.newsletter?.confirmed ?? 0) },
    ];
    if ((s.donations?.count ?? 0) > 0) {
      out.push({
        label: 'Donations raised',
        value: `$${Math.round((s.donations?.raisedCents ?? 0) / 100).toLocaleString()}`,
      });
    }
    // First-party engagement + performance — rendered ONLY when the metric has real samples
    // AND a non-null median (never a fabricated 0; a fresh site with no visitors shows none of
    // these, honestly). Same source (traffic.*) as the owner dashboard, tenant-resolved from the
    // share token server-side.
    const eng = s.traffic?.engagement;
    if ((eng?.samples ?? 0) > 0 && typeof eng?.medianMs === 'number') {
      out.push({ label: 'Avg. time on page', value: this.fmtDwell(eng.medianMs) });
    }
    const scroll = s.traffic?.scrollDepth;
    if ((scroll?.samples ?? 0) > 0 && typeof scroll?.medianPercent === 'number') {
      out.push({ label: 'Median scroll depth', value: `${scroll.medianPercent}%` });
    }
    const nav = s.traffic?.navTiming;
    if ((nav?.samples ?? 0) > 0 && typeof nav?.total === 'number') {
      out.push({ label: 'Median page load', value: this.fmtLoad(nav.total) });
    }
    // Core Web Vitals verdict — the recognizable Google "is my site fast" signal, shown only
    // when a core metric has real field samples (never a fabricated rating).
    const speed = cwvOverallRating(s.traffic?.webVitals);
    if (speed) {
      out.push({ label: 'Page speed', value: speed });
    }
    // Cloudflare RUM — an INDEPENDENT, Cloudflare-measured (sampled) second source. Labelled
    // "· Cloudflare" so it never blurs with the first-party numbers above; shown only when CF has
    // real field samples (never a fabricated verdict/0). TTFB (server response) is NEW here — the
    // first-party report shows page-load but not TTFB.
    const cfSpeed = cwvOverallRating(cfRum?.webVitals);
    if (cfSpeed) {
      out.push({ label: 'Page speed · Cloudflare', value: cfSpeed });
    }
    const cfTtfb = cfRum?.navTiming?.ttfb;
    if ((cfTtfb?.samples ?? 0) > 0 && typeof cfTtfb?.p75 === 'number') {
      out.push({ label: 'Server response · Cloudflare', value: this.fmtLoad(cfTtfb.p75) });
    }
    return out;
  }

  /** Compact dwell: "8s" · "1m 20s" · "3m" (mirrors the owner dashboard's engagement card). */
  private fmtDwell(ms: number): string {
    const sec = Math.round(ms / 1000);
    if (sec < 60) {
      return `${sec}s`;
    }
    const m = Math.floor(sec / 60);
    const rem = sec % 60;
    return rem ? `${m}m ${rem}s` : `${m}m`;
  }

  /** Compact load time: "820ms" · "1.2s" (mirrors the owner dashboard's page-load card). */
  private fmtLoad(ms: number): string {
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
  }
}
