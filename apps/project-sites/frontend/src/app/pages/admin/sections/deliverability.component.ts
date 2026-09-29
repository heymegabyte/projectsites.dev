/**
 * @component AdminDeliverabilityComponent
 * @description `/admin/deliverability` — Email Deliverability Wizard (#12) surface.
 *
 * Cyan/black compact cockpit. For the selected site, checks the sending
 * domain's SPF / DKIM / DMARC via `GET /api/sites/:siteId/deliverability` and
 * renders a 0-100 score (rolling counter), per-record status, and the concrete
 * DNS fixes. Read-only (live DNS lookups only — fires on an explicit button,
 * never auto-hammered). An optional domain override checks a different sending
 * domain than the site's primary hostname.
 *
 * Before a check runs (idle, `showPreview()`), a neutral 3-slot preview rail
 * (SPF · DKIM · DMARC, each "Not checked yet") fills the fold so the surface reads
 * as a dashboard of what it inspects — not one thin card in empty space. The rail
 * is `aria-hidden` (purely presentational); the real, announced score card replaces
 * it on the first result. (Polish pass AL-062, 2026-09-06.)
 *
 * Backend is flag-gated (`email_deliverability_wizard`); when off it 404s and
 * this surface shows a friendly "not available" error (never leaks existence).
 */

import { Component, Input, computed, effect, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../../services/api.service';
import { ToastService } from '../../../services/toast.service';
import { AdminStateService } from '../admin-state.service';
import { RollingCounterComponent } from '../../../components/rolling-counter/rolling-counter.component';
import { RevealDirective } from '../../../directives/reveal.directive';
import { ErrorCardComponent } from '../../../components/states/error-card.component';
import { FlagGateNoticeComponent } from '../../../components/states/flag-gate-notice.component';
import { HlmButtonDirective, HlmInputDirective } from '../../../ui';

interface DeliverabilityReport {
  domain: string;
  spf: { present: boolean; record: string | null };
  dmarc: { present: boolean; record: string | null; policy: string | null };
  dkim: { present: boolean; selectorsChecked: string[]; foundSelectors: string[] };
  score: number;
  recommendations: string[];
}
interface DeliverabilityResponse {
  ok: boolean;
  /** null when the site has no sending domain configured (needsDomain) — a calm neutral state, not a result. */
  report: DeliverabilityReport | null;
  /** true when there's no sending domain to check (no custom domain + no ?domain=) — render the neutral prompt. */
  needsDomain?: boolean;
}

@Component({
  selector: 'app-admin-deliverability',
  standalone: true,
  imports: [CommonModule, FormsModule, RollingCounterComponent, RevealDirective, ErrorCardComponent, FlagGateNoticeComponent, HlmButtonDirective, HlmInputDirective],
  template: `
    <section class="max-w-3xl mx-auto px-5 py-7" appReveal>
      <header class="mb-6">
        <p class="flex items-center gap-2 font-mono uppercase tracking-wider text-[0.7rem] text-primary mb-1">
          <svg class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
            <path d="m9 12 2 2 4-4" />
          </svg>
          Inbox placement
        </p>
        @if (level === 'h2') {
          <h2 class="text-2xl font-semibold text-light" data-testid="deliv-heading">Email Deliverability</h2>
        } @else {
          <h1 class="text-2xl font-semibold text-light" data-testid="deliv-heading">Email Deliverability</h1>
        }
        <p class="text-text-secondary text-sm mt-1 max-w-prose">
          Check your sending domain's SPF, DKIM and DMARC records and get concrete fixes to stay out of spam.
        </p>
      </header>

      @if (!site()) {
        <div data-testid="deliverability-empty" class="rounded-xl border border-white/[0.08] bg-white/[0.02] p-6 text-center">
          <p class="text-text-secondary text-sm">Select a site from <strong class="text-light">Sites</strong> to check its deliverability.</p>
        </div>
      } @else {
        <div class="rounded-xl border border-white/[0.08] bg-white/[0.02] p-5 flex flex-col gap-4">
          <p class="text-sm text-text-secondary">
            Site: <strong class="text-light">{{ site()?.business_name || site()?.slug }}</strong>
          </p>
          <label class="flex flex-col gap-1.5" for="deliverability-domain">
            <span class="text-[0.72rem] uppercase tracking-wide text-text-secondary">Sending domain (optional — defaults to the site's custom domain)</span>
            <input
              hlmInput
              id="deliverability-domain"
              data-testid="deliverability-domain"
              placeholder="e.g. mail.example.com"
              autocomplete="off"
              spellcheck="false"
              class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-dark"
              [(ngModel)]="domainModel"
              [attr.aria-invalid]="domainInvalid() ? 'true' : null"
              [attr.aria-describedby]="domainInvalid() ? 'deliverability-domain-hint' : null"
            />
            @if (domainInvalid()) {
              <span id="deliverability-domain-hint" data-testid="deliverability-domain-hint" class="text-[0.7rem] text-red-300/90">
                Enter a bare domain like <code class="text-red-200">mail.example.com</code> — no <code class="text-red-200">https://</code>, paths, or spaces.
              </span>
            }
          </label>
          <div class="flex items-center gap-3">
            <button
              hlmBtn
              data-testid="deliverability-check-btn"
              class="min-h-[40px] bg-primary text-dark font-medium border-transparent hover:bg-primary/90 disabled:bg-white/10 disabled:text-white/60 disabled:border-white/15 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-dark"
              [disabled]="loading() || domainInvalid() || flagDisabled()"
              [attr.aria-busy]="loading()"
              (click)="check()"
            >
              {{ loading() ? 'Checking DNS…' : 'Check deliverability' }}
            </button>
            <span class="text-[0.72rem] text-text-secondary">Live DNS lookup — read-only.</span>
          </div>
        </div>
      }

      @if (showPreview()) {
        <!-- Idle/pre-check: a neutral 3-slot rail so the fold reads as a dashboard
             (what we check) instead of one thin card in a void. Purely presentational
             (aria-hidden) — the real, announced result replaces it after a check. -->
        <div data-testid="deliverability-preview" class="mt-6" aria-hidden="true">
          <div class="grid gap-2 sm:grid-cols-3">
            @for (rec of previewRecords; track rec.key) {
              <div class="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3.5">
                <p class="text-light text-sm font-medium">{{ rec.key }}</p>
                <p class="text-text-secondary text-[0.7rem] mt-0.5">{{ rec.label }}</p>
                <p class="mt-2 flex items-center gap-1.5 text-text-secondary text-[0.78rem]">
                  <span class="h-1.5 w-1.5 rounded-full bg-white/25"></span> Not checked yet
                </p>
              </div>
            }
          </div>
          <p class="mt-3 text-center text-[0.72rem] text-text-secondary">
            Run a check to score your SPF, DKIM and DMARC and get concrete DNS fixes.
          </p>
        </div>
      }

      @if (flagDisabled()) {
        <!-- Flag OFF (404) → calm cohesive cyan notice (NOT alarming red). Shared primitive. -->
        <app-flag-gate-notice feature="The deliverability wizard" flag="email_deliverability_wizard" testid="deliverability-flag-gate" margin="mt-5" />
      } @else if (noDomain()) {
        <!-- No sending domain configured (worker 200 { needsDomain }) → calm neutral
             cyan prompt, NOT a red error. The user types a domain in the input above
             (or connects a custom domain) and re-runs the check. -->
        <div
          data-testid="deliverability-no-domain"
          class="mt-5 rounded-xl border border-primary/20 bg-primary/[0.04] p-5"
        >
          <p class="text-sm font-medium text-light">No sending domain configured yet</p>
          <p class="mt-1 text-sm text-text-secondary">
            Enter a sending domain above (e.g. <code class="text-primary">mail.example.com</code>) to check its
            SPF, DKIM and DMARC — or connect a custom domain to this site and it'll be checked automatically.
          </p>
        </div>
      } @else if (error()) {
        <!-- TRANSIENT failure (network/5xx) → gold-standard error card: a real Retry
             that re-runs the DNS check (preserving the typed domain) + a copyable
             worker request_id for support. Parity with review-links / trust-center. -->
        <app-error-card
          data-testid="deliverability-error"
          class="block mt-5"
          title="Deliverability check failed"
          [message]="error() ?? ''"
          [correlationId]="loadErrorRef()"
          (retry)="check()"
        />
      }

      @if (report(); as r) {
        <div data-testid="deliverability-result" class="mt-6 rounded-xl border border-white/[0.08] bg-white/[0.02] p-5" appReveal>
          <div
            class="flex items-baseline gap-2"
            role="img"
            [attr.aria-label]="'Deliverability score ' + r.score + ' out of 100 for ' + r.domain"
          >
            <app-rolling-counter data-testid="deliverability-score" [value]="r.score" [class]="scoreClass(r.score)" />
            <span class="text-text-secondary text-sm">/ 100 deliverability for <strong class="text-light">{{ r.domain }}</strong></span>
          </div>

          <!-- Cyan score meter: visualizes 0-100 as a filled cyan rail. -->
          <div
            class="mt-3 h-2 w-full overflow-hidden rounded-full bg-white/[0.06]"
            role="progressbar"
            aria-label="Deliverability score meter"
            [attr.aria-valuenow]="r.score"
            aria-valuemin="0"
            aria-valuemax="100"
          >
            <div
              data-testid="deliverability-meter"
              class="h-full rounded-full bg-primary transition-[width] duration-700 ease-out motion-reduce:transition-none"
              [style.width.%]="r.score"
            ></div>
          </div>

          <div class="mt-4 grid gap-2">
            <div data-testid="deliverability-spf" class="flex items-center justify-between gap-3 text-sm rounded-lg bg-white/[0.03] px-3 py-2">
              <span class="text-light">SPF</span>
              <span class="inline-flex items-center gap-1.5" [class]="r.spf.present ? 'text-primary' : 'text-amber-300'">
                <span aria-hidden="true">{{ r.spf.present ? '✓' : '!' }}</span>{{ r.spf.present ? 'Configured' : 'Missing' }}
              </span>
            </div>
            <div data-testid="deliverability-dmarc" class="flex items-center justify-between gap-3 text-sm rounded-lg bg-white/[0.03] px-3 py-2">
              <span class="text-light">DMARC <span class="text-text-secondary text-[0.72rem]">{{ r.dmarc.policy ? '(p=' + r.dmarc.policy + ')' : '' }}</span></span>
              <span class="inline-flex items-center gap-1.5" [class]="r.dmarc.present ? 'text-primary' : 'text-amber-300'">
                <span aria-hidden="true">{{ r.dmarc.present ? '✓' : '!' }}</span>{{ r.dmarc.present ? 'Configured' : 'Missing' }}
              </span>
            </div>
            <div data-testid="deliverability-dkim" class="flex items-center justify-between gap-3 text-sm rounded-lg bg-white/[0.03] px-3 py-2">
              <span class="text-light">DKIM</span>
              <span class="inline-flex items-center gap-1.5" [class]="r.dkim.present ? 'text-primary' : 'text-amber-300'">
                <span aria-hidden="true">{{ r.dkim.present ? '✓' : '!' }}</span>{{ r.dkim.present ? 'Configured' : 'Not found' }}
              </span>
            </div>
          </div>

          @if (r.recommendations.length > 0) {
            <div class="mt-4">
              <p class="text-[0.72rem] uppercase tracking-wide text-text-secondary mb-2">Fixes ({{ r.recommendations.length }})</p>
              <ul class="flex flex-col gap-1.5">
                @for (rec of r.recommendations; track rec) {
                  <li data-testid="deliverability-rec-row" class="text-[0.82rem] text-text-secondary rounded-lg bg-white/[0.03] px-3 py-2">{{ rec }}</li>
                }
              </ul>
            </div>
          } @else {
            <p class="mt-3 text-sm text-primary">All set — SPF, DKIM and DMARC look good.</p>
          }
        </div>
      }
    </section>
  `,
})
export class AdminDeliverabilityComponent {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  private readonly state = inject(AdminStateService);

  /** 'h1' when standalone (/admin/deliverability); 'h2' when embedded in the
   * Settings → Email tab, which already owns the page <h1> (avoids a double-h1). */
  @Input() level: 'h1' | 'h2' = 'h1';

  readonly site = computed(() => this.state.selectedSite());
  readonly domainModel = signal('');

  /** The site whose result is currently shown — drives the cross-site clear. */
  private resultSiteId: string | null = null;

  constructor() {
    // Read-only result hygiene: when the operator switches sites, drop the prior
    // report + error + per-site domain override. Without this, site A's score
    // sits under site B's header until the next Check — a stale cross-site leak.
    effect(() => {
      const id = this.state.selectedSite()?.id ?? null;
      if (id !== this.resultSiteId) {
        this.resultSiteId = id;
        this.report.set(null);
        this.error.set(null);
        this.loadErrorRef.set('');
        this.flagDisabled.set(false);
        this.noDomain.set(false);
        this.domainModel.set('');
      }
    });
  }

  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  /** Worker request_id from a TRANSIENT check failure → copyable support reference on the error card. */
  readonly loadErrorRef = signal('');
  /** Flag OFF (check 404 = email_deliverability_wizard disabled) → calm cyan Feature-Flags notice, NOT a red error. */
  readonly flagDisabled = signal(false);
  /** No sending domain to check (site has no custom domain + no override typed) → calm neutral prompt, NOT a red error. */
  readonly noDomain = signal(false);
  readonly report = signal<DeliverabilityReport | null>(null);

  /** Static descriptors for the idle preview rail (what a check inspects). */
  readonly previewRecords = [
    { key: 'SPF', label: 'Authorizes your senders' },
    { key: 'DKIM', label: 'Signs your mail' },
    { key: 'DMARC', label: 'Sets the spoofing policy' },
  ] as const;

  /** Idle state: a site is selected but no result / error / gate / load is active →
   *  render the neutral 3-slot preview rail instead of empty space. */
  readonly showPreview = computed(
    () =>
      !!this.site() &&
      !this.report() &&
      !this.error() &&
      !this.noDomain() &&
      !this.flagDisabled() &&
      !this.loading(),
  );

  /** The domain override is OPTIONAL (empty → the site's own domain). When the
   *  operator DOES type something, validate the bare-hostname format client-side
   *  so junk (https://…, paths, spaces, single-label) gets instant feedback
   *  instead of a DNS-lookup round-trip → server error. */
  private isValidDomain(raw: string): boolean {
    // RFC-952 per-label: each label must START and END with an alphanumeric
    // (dashes only allowed in the interior), so junk like `mail.-.com` /
    // `lead-.com` / `-lead.com` (dash-only or dash-edged labels) is rejected —
    // the old `[a-z0-9-]+` label class accepted those. The trailing group is
    // `+` (not `*`) so a bare single label (`localhost`, `example`) still fails:
    // an override must be a real dotted hostname. Worker re-guards server-side.
    return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(raw);
  }
  readonly domainInvalid = computed(() => {
    const d = this.domainModel().trim();
    return d.length > 0 && !this.isValidDomain(d);
  });

  scoreClass(score: number): string {
    if (score >= 80) return 'text-primary';
    if (score >= 40) return 'text-amber-300';
    return 'text-red-400';
  }

  check(): void {
    const s = this.site();
    if (!s || this.loading()) return;
    if (this.domainInvalid()) {
      this.error.set('Enter a bare domain like mail.example.com — no https://, paths, or spaces.');
      return;
    }
    this.loading.set(true);
    this.error.set(null);
    this.loadErrorRef.set('');
    this.flagDisabled.set(false);
    this.noDomain.set(false);
    // Drop the prior report so a still-visible score can never sit under a fresh
    // failure (a stale-result lie). It re-renders on success.
    this.report.set(null);

    const domain = this.domainModel().trim();
    const params = domain ? { domain } : undefined;

    this.api.get<DeliverabilityResponse>(`/sites/${s.id}/deliverability`, params, { silent: true }).subscribe({
      next: (res) => {
        if (res.report) {
          // Real SPF/DKIM/DMARC result → render the score card.
          this.report.set(res.report);
        } else {
          // needsDomain: the site has no custom sending domain and no override was
          // typed → calm neutral "enter a domain" prompt, NOT a red error card.
          this.noDomain.set(true);
        }
        this.loading.set(false);
      },
      error: (err: { status?: number; error?: { error?: { message?: string } } }) => {
        // 404 = email_deliverability_wizard flag OFF (permanent → calm cyan
        // Feature-Flags notice, NOT alarming red; a worker SPA-fallthrough 200+HTML
        // is remapped to 404 by ApiService so it lands here as the calm gate too).
        if (err?.status === 404) {
          this.flagDisabled.set(true);
        } else if (err?.status === 400) {
          // Defensive: the worker now returns 200 { needsDomain } for the no-domain
          // case, but during the deploy-propagation window an older worker can still
          // 400 it — treat that as the SAME calm neutral prompt, never a red error.
          this.noDomain.set(true);
        } else {
          // Anything else = transient (network / 5xx). Honest, retryable failure via
          // the gold-standard <app-error-card>: a real Retry (re-runs check(), keeping
          // the typed domain) + the worker request_id captured as a copyable support
          // reference. The read is {silent} so the generic ApiService toast doesn't
          // double-fire on top of the card.
          this.error.set(err?.error?.error?.message ?? 'Live DNS lookup failed — please try again.');
          this.loadErrorRef.set(this.requestIdFrom(err));
        }
        this.loading.set(false);
      },
    });
  }

  /** Pull the worker request_id from a failed response (`{ error: { request_id } }`) for the support reference. */
  private requestIdFrom(e: { error?: unknown } | undefined): string {
    return (e?.error as { error?: { request_id?: string } } | undefined)?.error?.request_id ?? '';
  }
}
