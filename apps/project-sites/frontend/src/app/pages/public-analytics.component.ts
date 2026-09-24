import { Component, signal, inject, DestroyRef, type OnInit } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { ApiService } from '../services/api.service';

/** Aggregate (non-PII) owner summary returned by the public share endpoint. */
interface PublicSummary {
  readonly traffic?: {
    readonly pageviews?: number;
    /** Distinct per-day anonymous sessions = "Visits" (visitor-days), NOT unique people.
     *  The API (SiteAnalyticsSummary.traffic) provides `uniqueSessions` — reading the old
     *  `uniqueVisitors` key silently rendered 0 (key-mismatch lying-empty). */
    readonly uniqueSessions?: number;
  };
  readonly contacts?: { readonly total?: number };
  readonly formSubmissions?: { readonly total?: number };
  readonly newsletter?: { readonly confirmed?: number };
  readonly donations?: { readonly raisedCents?: number; readonly count?: number };
}
interface PublicResponse {
  readonly summary: PublicSummary;
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
        this.stats.set(this.toStats(r.summary));
        this.loading.set(false);
      },
      error: () => {
        this.error.set(true);
        this.loading.set(false);
      },
    });
  }

  private toStats(s: PublicSummary): ReadonlyArray<{ label: string; value: string }> {
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
    return out;
  }
}
