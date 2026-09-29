/**
 * @component AdminWebhooksComponent
 * @description `/admin/webhooks` — Outbound Webhooks (#10) management for the
 * selected site. List subscribed endpoints, create a new one (subscribe an
 * https URL to site events; the signing secret is shown ONCE), and delete.
 *
 * Cyan/black cockpit. Backend (`/api/sites/:siteId/webhooks`) is flag-gated
 * (`outbound_webhooks`) — 404 when off → friendly "not available" error.
 */

import { Component, computed, effect, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../../services/api.service';
import { ToastService } from '../../../services/toast.service';
import { ConfirmService } from '../../../services/confirm.service';
import { AdminStateService } from '../admin-state.service';
import { RevealDirective } from '../../../directives/reveal.directive';
import { HlmButtonDirective, HlmInputDirective, HlmCheckboxDirective } from '../../../ui';
import { EmptyStateComponent, ErrorCardComponent, FlagGateNoticeComponent } from '../../../components/states';

/** Mirrors the worker's WEBHOOK_EVENT_TYPES allowlist. */
const EVENT_TYPES = ['site.published', 'form.submitted', 'payment.succeeded', 'review.received', 'build.failed', 'domain.active'];

interface Endpoint {
  id: string;
  url: string;
  eventTypes: string[];
  enabled: boolean;
}
interface Delivery {
  id: string;
  eventType: string;
  statusCode: number;
  ok: boolean;
  attempt: number;
  /** Worker's own failure reason for a failed attempt (timeout / 401 / DNS) — surfaced on hover. */
  error?: string | null;
  createdAt: string;
}

@Component({
  selector: 'app-admin-webhooks',
  standalone: true,
  imports: [CommonModule, FormsModule, RevealDirective, HlmButtonDirective, HlmInputDirective, HlmCheckboxDirective, EmptyStateComponent, ErrorCardComponent, FlagGateNoticeComponent],
  template: `
    <section class="max-w-3xl mx-auto px-5 py-7" appReveal>
      <header class="mb-6">
        <p class="font-mono uppercase tracking-wider text-[0.7rem] text-primary mb-1">Integrations</p>
        <h1 class="text-2xl font-semibold text-light">Outbound Webhooks</h1>
        <p class="text-text-secondary text-sm mt-1 max-w-prose">
          Send signed, retried event notifications to your own endpoints when things happen on your site.
        </p>
      </header>

      @if (!site()) {
        <div data-testid="webhooks-empty" class="rounded-xl border border-white/[0.08] bg-white/[0.02] p-6 text-center">
          <p class="text-text-secondary text-sm">Select a site from <strong class="text-light">Sites</strong> to manage its webhooks.</p>
        </div>
      } @else {
        @if (flagDisabled()) {
          <!-- Flag OFF (404) → calm cohesive notice ABOVE the form so the user learns it's
               disabled FIRST (mirrors the recipes gold-standard). Shared primitive; NOT red. -->
          <app-flag-gate-notice feature="Webhooks" flag="outbound_webhooks" [plural]="true" testid="webhooks-flag-gate" margin="mb-5" />
        }
        @if (createdSecret(); as s) {
          <div data-testid="webhooks-secret" role="status" class="mb-5 rounded-xl border border-primary/30 bg-primary/[0.06] p-4">
            <p class="text-sm text-light font-semibold mb-1">Signing secret — copy it now, it won't be shown again</p>
            <div class="flex items-center gap-2">
              <code class="flex-1 text-[0.8rem] text-primary break-all">{{ s }}</code>
              <button type="button" data-testid="webhooks-secret-copy"
                class="shrink-0 text-[0.72rem] font-semibold uppercase tracking-wide px-2.5 py-1 rounded-md border border-primary/40 text-primary hover:bg-primary/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                [attr.aria-label]="secretCopied() ? 'Signing secret copied' : 'Copy signing secret'"
                (click)="copySecret()">{{ secretCopied() ? 'Copied' : 'Copy' }}</button>
            </div>
          </div>
        }

        <!-- Create -->
        <div class="rounded-xl border border-white/[0.08] bg-white/[0.02] p-5 flex flex-col gap-4 mb-6 transition-opacity" [class.opacity-60]="flagDisabled()">
          <label class="flex flex-col gap-1.5">
            <span class="text-[0.72rem] uppercase tracking-wide text-text-secondary">Endpoint URL (https)</span>
            <input #urlInput hlmInput data-testid="webhooks-url" type="url" inputmode="url" placeholder="https://hooks.yourapp.com/projectsites"
              [disabled]="flagDisabled()"
              [ngModel]="urlModel()" (ngModelChange)="urlModel.set($event)"
              [attr.aria-invalid]="urlInvalid()"
              [attr.aria-describedby]="urlInvalid() ? 'webhooks-url-hint webhooks-url-ssrf-note' : 'webhooks-url-ssrf-note'"
              [class.ring-1]="urlInvalid()" [class.ring-red-500/60]="urlInvalid()" [class.border-red-500/50]="urlInvalid()" />
            @if (urlInvalid()) {
              <span id="webhooks-url-hint" data-testid="webhooks-url-hint" class="text-[0.7rem] text-[var(--ps-danger)]">
                Must be a valid <code class="text-[var(--ps-danger)] font-semibold">https://</code> URL with a public hostname.
              </span>
            }
            <!-- Always-present SSRF note (stable id, wired via aria-describedby):
                 the client only checks URL FORMAT + obvious private hosts; the
                 worker is the real boundary and rejects any domain that RESOLVES
                 to a private / loopback / metadata IP at send time (DNS rebinding
                 defence). Tells the operator WHY a public-looking URL can still fail. -->
            <span id="webhooks-url-ssrf-note" data-testid="webhooks-url-ssrf-note" class="text-[0.68rem] text-text-secondary">
              For your protection, the server rejects endpoints whose domain resolves to a private, loopback or internal IP address.
            </span>
          </label>
          <div>
            <span class="text-[0.72rem] uppercase tracking-wide text-text-secondary">Events</span>
            <div class="flex flex-wrap gap-3 mt-2">
              @for (ev of eventTypes; track ev) {
                <label class="inline-flex items-center gap-2 cursor-pointer text-sm text-light">
                  <input type="checkbox" hlmCheckbox [attr.data-testid]="'webhooks-event-' + ev"
                    [disabled]="flagDisabled()"
                    [checked]="selected().includes(ev)" (change)="toggleEvent(ev)" />
                  <span>{{ ev }}</span>
                </label>
              }
            </div>
          </div>
          <div class="flex items-center gap-3">
            <button hlmBtn data-testid="webhooks-create-btn" [disabled]="creating() || !canSubmit() || flagDisabled()" (click)="create()">
              {{ creating() ? 'Creating…' : 'Add endpoint' }}
            </button>
            <span class="text-[0.72rem] text-text-secondary" data-testid="webhooks-selected-count">{{ selected().length }} event{{ selected().length === 1 ? '' : 's' }} selected</span>
          </div>
        </div>

        @if (error()) {
          <app-error-card data-testid="webhooks-error" class="block mb-5"
            title="Couldn't load webhooks"
            message="Check your connection and retry."
            [correlationId]="loadErrorRef()"
            (retry)="load()" />
        }

        <!-- List -->
        @if (!error() && !flagDisabled() && endpoints().length === 0) {
          <app-empty-state icon="↪" title="No webhook endpoints"
            message="Create your first endpoint to start receiving signed event callbacks."
            ctaLabel="Add your first endpoint"
            (ctaClick)="focusUrlInput(urlInput)" />
        } @else if (endpoints().length > 0) {
          <ul class="flex flex-col gap-2">
            @for (e of endpoints(); track e.id) {
              <li data-testid="webhooks-row" class="flex items-center justify-between gap-3 rounded-lg bg-white/[0.03] px-3 py-2.5">
                <div class="min-w-0">
                  <code class="text-[0.82rem] text-light truncate block" [attr.title]="e.url">{{ e.url }}</code>
                  <span class="text-[0.7rem] text-text-secondary">{{ e.eventTypes.join(', ') }}</span>
                </div>
                <button hlmBtn variant="ghost" size="sm" data-testid="webhooks-delete" (click)="remove(e.id, e.url)">Delete</button>
              </li>
            }
          </ul>
        }

        <!-- Recent deliveries -->
        @if (deliveries().length > 0) {
          <div class="mt-7">
            <p class="text-[0.72rem] uppercase tracking-wide text-text-secondary mb-2">Recent deliveries</p>
            <ul class="flex flex-col gap-1.5">
              @for (d of deliveries(); track d.id) {
                <li data-testid="webhooks-delivery-row" class="flex items-center justify-between gap-3 text-[0.8rem] rounded-lg bg-white/[0.03] px-3 py-2">
                  <span class="text-text-secondary truncate min-w-0" [attr.title]="d.eventType + ' · attempt ' + d.attempt">
                    {{ d.eventType }} <span class="text-light/60">· attempt {{ d.attempt }}</span>
                    @if (!d.ok && d.error) {
                      <!-- The worker exposes a per-attempt failure reason (timeout / 401 / DNS).
                           Surface it as the operator's first debugging signal — no secret involved. -->
                      <span class="text-amber-300/70 italic" data-testid="webhooks-delivery-reason"> — {{ d.error }}</span>
                    }
                  </span>
                  <span data-testid="webhooks-delivery-status" [class]="d.ok ? 'text-primary' : 'text-amber-300/90'" class="shrink-0 tabular-nums"
                    [attr.title]="d.ok ? null : (d.error || ('Delivery failed (HTTP ' + (d.statusCode || 'no response') + ')'))">{{ d.statusCode || '—' }} {{ d.ok ? 'OK' : 'fail' }}</span>
                </li>
              }
            </ul>
          </div>
        }
      }
    </section>
  `,
})
export class AdminWebhooksComponent {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  private readonly confirmSvc = inject(ConfirmService);
  private readonly state = inject(AdminStateService);

  readonly eventTypes = EVENT_TYPES;
  readonly site = computed(() => this.state.selectedSite());

  readonly urlModel = signal('');
  readonly selected = signal<string[]>(['site.published']);

  /** True only when a non-empty value fails https-URL validation (drives the inline hint + red ring). */
  readonly urlInvalid = computed(() => {
    const v = this.urlModel().trim();
    return v.length > 0 && !this.isValidHttpsUrl(v);
  });
  /** Gate for the Add-endpoint button: a valid https URL + ≥1 event selected. */
  readonly canSubmit = computed(() => this.isValidHttpsUrl(this.urlModel().trim()) && this.selected().length > 0);
  readonly endpoints = signal<Endpoint[]>([]);
  readonly deliveries = signal<Delivery[]>([]);
  readonly loading = signal(false);
  readonly creating = signal(false);
  readonly error = signal<string | null>(null);
  /** Flag OFF (load 404 = outbound_webhooks disabled) → calm cyan Feature-Flags notice, NOT a red error. */
  readonly flagDisabled = signal(false);
  /** True when the load error is transient (not a 404 feature-gate) → show a Retry. */
  readonly errorRetryable = signal(false);
  /** Worker request_id from a failed load → the copyable support reference on the error card. */
  readonly loadErrorRef = signal('');
  readonly createdSecret = signal<string | null>(null);
  readonly secretCopied = signal(false);

  /** One-click copy of the one-time signing secret — the warning says "copy it
   *  now, it won't be shown again", so a copyable affordance is essential (the
   *  break-all <code> is still selectable if the clipboard API is unavailable). */
  async copySecret(): Promise<void> {
    const s = this.createdSecret();
    if (!s) return;
    try {
      await navigator.clipboard?.writeText(s);
      this.secretCopied.set(true);
      setTimeout(() => this.secretCopied.set(false), 1600);
    } catch {
      this.toast.error('Could not copy automatically — select the secret and copy it manually.');
      return; // copy failed → keep the secret visible so the operator can select it manually
    }
    // One-time-secret hygiene: once it's on the clipboard the contract ("copy it
    // now, it won't be shown again") is satisfied — drop it from component state so
    // it can never linger in the DOM after the copy (matches deliverability.component).
    this.createdSecret.set(null);
  }

  /** Empty-state launchpad → focus the URL field so "Add your first endpoint" lands
   *  the operator directly on the create action (first-result-action empty state). */
  focusUrlInput(el: HTMLInputElement): void {
    el.focus();
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  private loadedSiteId: string | null = null;

  constructor() {
    // Load when the selected site resolves (it may arrive after mount on deep-link)
    // and reload on site switch — guarded so we never re-load the same site.
    effect(() => {
      const id = this.site()?.id ?? null;
      if (id !== this.loadedSiteId) {
        // Switching sites (or clearing the selection) must wipe any lingering
        // one-time secret from the prior site — otherwise navigating away and
        // back still exposes site A's secret under site B (a cross-site leak).
        // Mirrors deliverability.component's site-change result hygiene.
        this.createdSecret.set(null);
        this.secretCopied.set(false);
        this.loadedSiteId = id;
        if (id) this.load();
      }
    });
  }

  toggleEvent(ev: string): void {
    this.selected.update((s) => (s.includes(ev) ? s.filter((x) => x !== ev) : [...s, ev]));
  }

  /**
   * A webhook target is called server-side, so we only accept a well-formed
   * https URL with a genuinely PUBLIC host — rejecting http://, junk, and every
   * loopback / private / link-local / metadata host (not just single-label
   * `localhost`) so the "public hostname" the hint promises is enforced. The
   * worker's own SSRF guard remains the real boundary; this is the UX layer.
   */
  private isValidHttpsUrl(raw: string): boolean {
    if (!raw) return false;
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return false;
    }
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
    if (!host.includes('.') || host.endsWith('.')) return false; // localhost, ::1, trailing-dot
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
    const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      if (a === 0 || a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254)) {
        return false;
      }
    }
    return true;
  }

  private siteId(): string | null {
    return this.site()?.id ?? null;
  }

  load(): void {
    const id = this.siteId();
    if (!id) return;
    this.loading.set(true);
    this.error.set(null);
    this.errorRetryable.set(false);
    this.flagDisabled.set(false);
    this.loadErrorRef.set('');
    // Silent: this component owns an accurate inline error (the gated vs
    // transient/retryable banner below) — the generic ApiService toast would
    // double-fire over it (the redundant-network-toast class).
    this.api.get<{ ok: boolean; endpoints: Endpoint[] }>(`/sites/${id}/webhooks`, undefined, { silent: true }).subscribe({
      next: (res) => {
        // Shape guard: a STALE worker route can return 200 + a body that parses
        // but lacks the endpoints array (a misroute, or an SPA-fallthrough that
        // happens to be valid JSON). `?? []` would mask that as a fake-empty
        // "No webhook endpoints" (or crash the @for on a non-array). Treat a
        // shapeless 200 as an honest, retryable error — never a silent empty.
        if (!res || !Array.isArray(res.endpoints)) {
          this.error.set("Couldn't load webhooks — the response was unexpected. Retry.");
          this.errorRetryable.set(true);
          this.endpoints.set([]);
          this.loading.set(false);
          return;
        }
        this.endpoints.set(res.endpoints);
        this.loading.set(false);
      },
      // Distinguish a genuine feature-gate (404 → retrying won't help) from a
      // transient failure (500/network → offer a Retry). Never read a transient
      // error as a permanent "not available for this site".
      error: (err: { status?: number; error?: unknown }) => {
        // 404 = outbound_webhooks flag OFF (permanent → calm cyan Feature-Flags
        // notice, NOT alarming red); anything else = transient (→ app-error-card
        // with Retry + request_id). A worker SPA-fallthrough (200+HTML) is remapped
        // to 404 by ApiService, so it lands here as the calm gate, not a red card.
        if (err?.status === 404) {
          this.flagDisabled.set(true);
        } else {
          this.error.set("Couldn't load webhooks — check your connection and retry.");
          this.errorRetryable.set(true);
          this.loadErrorRef.set(this.requestIdFrom(err));
        }
        this.loading.set(false);
      },
    });
    // Delivery history (best-effort — empty until the dispatcher runs). Silent:
    // a secondary best-effort read that intentionally empties on failure must
    // not toast (the main load's inline error already signals connectivity).
    this.api.get<{ ok: boolean; deliveries: Delivery[] }>(`/sites/${id}/webhooks/deliveries`, undefined, { silent: true }).subscribe({
      // Shape guard: deliveries is secondary/best-effort, so a missing OR non-array
      // body just stays empty (the main load's error already signals connectivity) —
      // but a non-array must NEVER reach the @for / .length (stale-route crash guard).
      next: (res) => this.deliveries.set(res && Array.isArray(res.deliveries) ? res.deliveries : []),
      error: () => this.deliveries.set([]),
    });
  }

  /** Pull the worker request_id from a failed response ({ error: { request_id } }) for the support reference. */
  private requestIdFrom(e: { error?: unknown } | undefined): string {
    return (e?.error as { error?: { request_id?: string } } | undefined)?.error?.request_id ?? '';
  }

  create(): void {
    const id = this.siteId();
    if (!id || this.creating()) return;
    const url = this.urlModel().trim();
    if (this.selected().length === 0) {
      this.toast.error('Pick at least one event for this endpoint.');
      return;
    }
    if (!this.isValidHttpsUrl(url)) {
      this.toast.error('Enter a valid https:// URL with a public hostname (e.g. https://hooks.yourapp.com/path).');
      return;
    }
    this.creating.set(true);
    this.createdSecret.set(null);
    this.api
      .post<{ ok: boolean; id: string; secret: string }>(`/sites/${id}/webhooks`, {
        url,
        eventTypes: this.selected(),
      })
      .subscribe({
        next: (res) => {
          this.createdSecret.set(res.secret);
          this.urlModel.set('');
          this.toast.success('Endpoint added.');
          this.creating.set(false);
          this.load();
        },
        error: (err: unknown) => {
          const msg =
            (err as { error?: { error?: { message?: string } } })?.error?.error?.message ?? 'Could not add the endpoint.';
          this.toast.error(msg);
          this.creating.set(false);
        },
      });
  }

  async remove(endpointId: string, url?: string): Promise<void> {
    const id = this.siteId();
    if (!id) return;
    const ok = await this.confirmSvc.confirm({
      title: 'Remove endpoint',
      message: `Remove ${url ? `the endpoint ${url}` : 'this webhook endpoint'}? Its signing secret is discarded — re-adding it issues a new secret you'll need to redistribute to the consumer.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    this.api.delete<{ ok: boolean }>(`/sites/${id}/webhooks/${endpointId}`, { silent: true }).subscribe({
      next: () => {
        this.toast.success('Endpoint removed.');
        this.load();
      },
      error: () => this.toast.error('Could not remove the endpoint.'),
    });
  }
}
