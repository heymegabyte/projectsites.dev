import { Component, DestroyRef, effect, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { AdminStateService } from '../admin-state.service';
import {
  ActivationAnalyticsService,
  aggregateClaimsBySource,
  aggregatePublishesBySource,
  type ActivationFunnelResponse,
  type ClaimChannel,
  type DeliveryMix,
} from '../../../services/activation-analytics.service';

/**
 * Activation Funnel — the operator view of the §9 revenue machine. Renders the
 * four-stage funnel (Discovered → Engaged → Delivered → Converted) as
 * width-proportional bars with per-stage drop-off + the overall discovered→
 * converted rate, read from `GET /api/admin/activation-funnel` via
 * {@link ActivationAnalyticsService}.
 *
 * The endpoint fail-soft degrades: when Tinybird is unconfigured/down it returns
 * a zero funnel with `degraded:true`, and this panel renders the four stage
 * shells at 0 plus an "analytics provisioning" note — never an error wall.
 */
@Component({
  selector: 'app-admin-activation-funnel',
  standalone: true,
  template: `
    <div class="px-6 pt-5 pb-8 max-md:px-4" data-testid="activation-funnel">
      <div class="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 class="text-[1.35rem] font-extrabold text-white tracking-tight m-0">Activation Funnel</h1>
          <p class="text-[0.82rem] text-text-secondary mt-1 mb-0">
            Discovered → Engaged → Delivered → Converted, last 30 days.
          </p>
        </div>
        @if (funnel(); as f) {
          <span
            class="px-3 py-1 rounded-full text-[0.78rem] font-semibold bg-[#00e5ff]/[0.10] text-[#00e5ff] tabular-nums"
            data-testid="funnel-overall"
          >
            {{ f.conversion.overallPct }}% overall
          </span>
        }
      </div>

      @if (adminOnly()) {
        <div
          class="mt-6 rounded-xl border border-[#00e5ff]/20 bg-[#00e5ff]/[0.05] px-4 py-3"
          data-testid="funnel-admin-only"
          role="status"
        >
          <p class="text-[0.85rem] text-[#9fe8f5] m-0">
            The activation funnel is a <strong class="text-white">platform-wide</strong> view for platform admins.
            Your own site's traffic, forms, and visitor journey are in the other Analytics tabs.
          </p>
        </div>
      } @else if (loading()) {
        <p class="text-[0.82rem] text-text-secondary mt-6" data-testid="funnel-loading">Loading funnel…</p>
      } @else if (loadError()) {
        <div class="mt-6 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] px-4 py-3" data-testid="funnel-error">
          <p class="text-[0.85rem] text-amber-200 m-0">Couldn't load the funnel.</p>
          <button
            class="mt-2 px-3 py-1 rounded-lg text-[0.78rem] font-semibold bg-white/[0.06] text-white hover:bg-white/[0.10]"
            (click)="load()"
          >
            Retry
          </button>
        </div>
      } @else if (funnel(); as f) {
        @if (f.degraded) {
          <div
            class="mt-5 rounded-xl border border-[#00e5ff]/20 bg-[#00e5ff]/[0.05] px-4 py-2.5"
            data-testid="funnel-degraded"
          >
            <p class="text-[0.8rem] text-[#9fe8f5] m-0">
              Analytics is provisioning — showing the funnel shape at zero until Tinybird is live.
            </p>
          </div>
        }

        <div class="mt-6 flex flex-col gap-3" data-testid="funnel-bars">
          @for (step of f.conversion.steps; track step.stage) {
            <div class="flex flex-col gap-1">
              <div class="flex items-baseline justify-between gap-3">
                <span class="text-[0.85rem] font-semibold text-white">{{ step.label }}</span>
                <span class="text-[0.8rem] text-text-secondary tabular-nums">
                  {{ step.sites }} site{{ step.sites === 1 ? '' : 's' }}
                  @if (step.fromPrevPct !== null) {
                    <span class="text-[#00e5ff] ml-2">{{ step.fromPrevPct }}% of prev</span>
                  }
                </span>
              </div>
              <div class="h-3 rounded-full bg-white/[0.05] overflow-hidden" role="img"
                   [attr.aria-label]="step.label + ': ' + step.sites + ' sites, ' + step.fromTopPct + '% of discovered'">
                <div
                  class="h-full rounded-full bg-gradient-to-r from-[#00e5ff] to-[#50aae3] transition-[width] duration-500"
                  [style.width.%]="step.fromTopPct"
                ></div>
              </div>
            </div>
          }
        </div>

        @if (deliveryMix().length > 0) {
          <div class="mt-8" data-testid="funnel-delivery">
            <h2 class="text-[0.95rem] font-bold text-white m-0">Delivery mix</h2>
            <p class="text-[0.78rem] text-text-secondary mt-0.5 mb-3">How Delivered sites went live, last 30 days.</p>
            <div class="flex flex-col gap-1.5">
              @for (d of deliveryMix(); track d.source) {
                <div class="flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-white/[0.03]">
                  <span class="text-[0.83rem] text-white truncate">{{ d.source }}</span>
                  <span class="text-[0.83rem] font-semibold text-[#50aae3] tabular-nums shrink-0">
                    {{ d.publishes }} publish{{ d.publishes === 1 ? '' : 'es' }}
                  </span>
                </div>
              }
            </div>
          </div>
        }

        @if (channels().length > 0) {
          <div class="mt-8" data-testid="funnel-channels">
            <h2 class="text-[0.95rem] font-bold text-white m-0">Top acquisition channels</h2>
            <p class="text-[0.78rem] text-text-secondary mt-0.5 mb-3">Claims by source · campaign, last 30 days.</p>
            <div class="flex flex-col gap-1.5">
              @for (ch of channels(); track ch.source + ch.campaign) {
                <div class="flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-white/[0.03]">
                  <span class="text-[0.83rem] text-white truncate">
                    {{ ch.source }}
                    <span class="text-text-secondary">· {{ ch.campaign }}</span>
                  </span>
                  <span class="text-[0.83rem] font-semibold text-[#00e5ff] tabular-nums shrink-0">
                    {{ ch.claims }} claim{{ ch.claims === 1 ? '' : 's' }}
                  </span>
                </div>
              }
            </div>
          </div>
        }
      }
    </div>
  `,
})
export class AdminActivationFunnelComponent implements OnInit {
  private analytics = inject(ActivationAnalyticsService);
  private destroyRef = inject(DestroyRef);
  private state = inject(AdminStateService);

  readonly funnel = signal<ActivationFunnelResponse | null>(null);
  readonly channels = signal<ClaimChannel[]>([]);
  readonly deliveryMix = signal<DeliveryMix[]>([]);
  readonly loading = signal(true);
  readonly loadError = signal(false);
  // The funnel reads `/api/admin/*` — PLATFORM analytics, super-admin only. A non-super-admin
  // (every real business owner) firing them gets 3× 403 console errors AND a misleading
  // "Couldn't load — Retry" error card (it's not transient — they're just not authorized).
  // Gate on the resolved super-admin flag: authorized → load; not → an honest admin-only state.
  readonly adminOnly = signal(false);
  private decided = false;

  constructor() {
    // Decide once the shell's getMe (→ isSuperAdmin) has resolved (`state.loading` flips false).
    // Deep-linking straight to this tab is handled — the effect re-runs when the flag settles.
    effect(() => {
      const settled = !this.state.loading();
      const superAdmin = this.state.isSuperAdmin();
      if (this.decided || !settled) return;
      this.decided = true;
      if (superAdmin) {
        this.load();
      } else {
        this.adminOnly.set(true);
        this.loading.set(false);
      }
    });
  }

  ngOnInit(): void {
    // Loading is driven by the super-admin effect above (fires once getMe resolves) — this avoids
    // firing the admin-only fetches before we know the caller's role (which would 403 + log errors).
  }

  /** Fetch the funnel (default 30-day window); fail-soft to an error card with Retry. */
  load(): void {
    this.loading.set(true);
    this.loadError.set(false);
    this.analytics
      .getActivationFunnel({ days: 30 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.funnel.set(r);
          this.loading.set(false);
        },
        error: () => {
          this.loadError.set(true);
          this.loading.set(false);
        },
      });
    // Acquisition channels are best-effort enrichment — a failure here never
    // affects the funnel itself; the section simply stays hidden.
    this.analytics
      .getClaimsBySource({ days: 30 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => this.channels.set(aggregateClaimsBySource(r.rows)),
        error: () => this.channels.set([]),
      });
    // Delivery mix (editor vs claim vs workflow) — best-effort; hidden on failure.
    this.analytics
      .getPublishesBySource({ days: 30 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => this.deliveryMix.set(aggregatePublishesBySource(r.rows)),
        error: () => this.deliveryMix.set([]),
      });
  }
}
