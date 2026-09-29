/**
 * @module pages/admin/sections/domains
 * @description Per-project Domain Management admin section.
 *
 * Renders three vertically-stacked surfaces against the currently selected
 * site from {@link AdminStateService}:
 *
 *  1. **Provisioned backup domain** — read-only display of
 *     `{slug}.projectsites.dev` plus copy + open-in-new-tab affordances.
 *     This is the always-available fallback every site ships with.
 *  2. **Add a domain** — two-track form: existing custom-CNAME flow (re-uses
 *     `POST /api/sites/:siteId/hostnames`) AND the new AI creative-domain
 *     search (`POST /api/sites/:siteId/domains/ai-search`) that fans out 10
 *     parallel Workers AI strategies and bulk-checks availability via
 *     Cloudflare Registrar. Each candidate renders as a card with a
 *     strategy badge + price + register button.
 *  3. **Connected domains** — table of `GET /api/sites/:siteId/hostnames`
 *     with row actions for "Make primary", "Remove", and the new
 *     "Transfer out / Port to another registrar" flow.
 *
 * Component is fully reactive over `state.selectedSite()`; switching the
 * site in the sidebar instantly reloads the hostname list.
 *
 * @example
 * ```ts
 * // app.routes.ts
 * { path: 'domains', loadComponent: () =>
 *     import('./pages/admin/sections/domains.component').then(m => m.AdminDomainsComponent) }
 * ```
 *
 * @packageDocumentation
 */
import { Component, ElementRef, ViewChild, inject, signal, computed, effect, type OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AdminStateService } from '../admin-state.service';
import { ApiService } from '../../../services/api.service';
import { ToastService } from '../../../services/toast.service';
import { ConfirmService } from '../../../services/confirm.service';
import { EmptyStateComponent } from '../empty-state.component';
import { ErrorCardComponent } from '../../../components/states';
import { HlmInputDirective } from '../../../ui';
import { BrnTooltipImports } from '@spartan-ng/brain/tooltip';
import { RevealDirective } from '../../../directives/reveal.directive';
import { FocusTrapDirective } from '../../../directives/focus-trap.directive';
import { RollingCounterComponent } from '../../../components/rolling-counter/rolling-counter.component';
import { MiniEmptyComponent } from '../../../components/mini-empty/mini-empty.component';

/** Single hostname row returned by `GET /api/sites/:siteId/hostnames`. */
interface Hostname {
  readonly id: string;
  readonly hostname: string;
  readonly type: 'free_subdomain' | 'custom_cname' | string;
  readonly status: string;
  readonly ssl_status: string;
  readonly is_primary: number;
}

/** Card emitted by the AI-domain-search backend. */
interface DomainCard {
  readonly name: string;
  readonly tld: string;
  readonly price_usd: number;
  readonly available: boolean;
  readonly strategy: string;
}

/** Server response shape for the AI domain search endpoint. */
interface AiSearchResponse {
  readonly data: {
    readonly available: readonly DomainCard[];
    readonly unavailable: readonly DomainCard[];
  };
}

/** Server response for the transfer-out endpoint. */
interface TransferOutResponse {
  readonly data: {
    readonly auth_code: string;
    readonly registrar_locked: false;
    readonly instructions_url: string;
  };
}

/**
 * Friendly label for each AI naming strategy, rendered inside the candidate
 * card badge. Kept here (not on the server) so we can re-skin labels
 * without redeploying the Worker.
 */
const STRATEGY_LABEL: Readonly<Record<string, string>> = {
  literal: 'Literal',
  metaphor: 'Metaphor',
  compound: 'Compound',
  alliterative: 'Alliterative',
  rhyming: 'Rhyming',
  jargon: 'Industry jargon',
  playful: 'Playful',
  minimalist: 'Minimalist',
  'premium-tld': 'Premium TLD',
  geography: 'Geo-flavored',
};

/**
 * Standalone Angular component for the per-site domain management page.
 *
 * Provided via the admin route at `/admin/domains`.
 */
@Component({
  selector: 'app-admin-domains',
  standalone: true,
  imports: [
    RevealDirective,
    FormsModule,
    EmptyStateComponent,
    ErrorCardComponent,
    HlmInputDirective,
    FocusTrapDirective,
    RollingCounterComponent,
    MiniEmptyComponent,
    ...BrnTooltipImports,
  ],
  template: `
    <div class="p-7 flex-1 overflow-y-auto animate-fade-in max-md:p-4 space-y-6">
      <header class="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div class="kicker">Reach</div>
          <h2 class="section-h text-lg font-bold text-white m-0">Domains</h2>
          <p class="text-[0.78rem] text-text-secondary m-0 mt-1">
            Manage the live domain, search creative names with AI, and port any custom domain in or out.
          </p>
        </div>
        @if (state.selectedSite()) {
          <button class="btn-ghost" (click)="loadHostnames()" [disabled]="loadingHostnames()" [brnTooltip]="'Reload connected domains'">
            <span class="inline-block text-center min-w-[8ch]">{{ loadingHostnames() ? '…' : 'Refresh' }}</span>
          </button>
        }
      </header>

      @if (!state.selectedSite()) {
        <app-empty-state
          icon="🌐"
          title="No site selected"
          body="Pick a site from the sidebar to manage its domains."
        />
      } @else {

        <!-- ── 1. Provisioned backup domain ──────────────────────── -->
        <section class="card p-5 space-y-3" appReveal>
          <div class="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <h3 class="section-h text-base font-semibold text-white m-0">Provisioned backup domain</h3>
              <p class="text-[0.78rem] text-text-secondary m-0 mt-1">
                Every site ships with a free, always-on subdomain. Use it while a custom domain propagates or as a permanent home.
              </p>
            </div>
            <span class="status-badge" data-status="verified">
              <span class="status-dot" aria-hidden="true"></span>
              Active
            </span>
          </div>
          <div class="flex items-center gap-2 flex-wrap">
            <code class="font-mono text-sm text-primary bg-black/30 px-3 py-2 rounded border border-border flex-1 min-w-[260px]" data-testid="backup-domain">
              {{ backupDomain() }}
            </code>
            <button class="btn-ghost" (click)="copyBackup()" [brnTooltip]="'Copy to clipboard'">Copy</button>
            <a class="btn-ghost" [href]="'https://' + backupDomain()" target="_blank" rel="noopener noreferrer" [brnTooltip]="'Open in a new tab'">Open<svg class="inline-block align-[-2px] ml-[3px]" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></a>
          </div>
        </section>

        <!-- ── 2. Add a domain ───────────────────────────────────── -->
        <section class="card p-5 space-y-5" appReveal>
          <div>
            <h3 class="section-h text-base font-semibold text-white m-0">Add a domain</h3>
            <p class="text-[0.78rem] text-text-secondary m-0 mt-1">
              Connect a domain you already own, or search for an available one with AI.
            </p>
          </div>

          <!-- Custom CNAME entry (re-uses existing /hostnames POST) -->
          <form class="space-y-2" (submit)="addCustom($event)">
            <label for="domains-custom-input" class="text-[0.72rem] uppercase tracking-wider text-text-secondary block">Already own a domain?</label>
            <div class="flex gap-2 flex-wrap">
              <input
                #customInput
                hlmInput
                id="domains-custom-input"
                class="flex-1 min-w-[240px]"
                type="text"
                name="customDomain"
                placeholder="www.example.com"
                maxlength="253"
                [(ngModel)]="customDomainInput"
                [disabled]="addingCustom()"
                [attr.aria-invalid]="customDomainInvalid()"
                [attr.aria-describedby]="customDomainInvalid() ? 'custom-domain-hint' : null"
                data-testid="custom-domain-input"
              />
              <button class="btn-primary" type="submit" [disabled]="!isValidDomain(customDomainInput()) || addingCustom()">
                {{ addingCustom() ? 'Adding…' : 'Add domain' }}
              </button>
            </div>
            @if (customDomainInvalid()) {
              <p id="custom-domain-hint" class="text-[0.7rem] text-amber-300/90 m-0 flex items-center gap-1.5" data-testid="custom-domain-hint">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" class="shrink-0"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                Enter a full domain like <code class="font-mono">www.example.com</code> — no spaces or <code class="font-mono">http://</code>.
              </p>
            } @else {
              <p class="text-[0.7rem] text-text-secondary m-0">
                Point a CNAME record to <code class="font-mono text-primary">projectsites.dev</code> first, then add it here.
              </p>
            }
          </form>

          <!-- AI domain search -->
          <div class="border-t border-border pt-5 space-y-3">
            <label for="domains-ai-query" class="text-[0.72rem] uppercase tracking-wider text-text-secondary block">Search creative domains with AI</label>
            <div class="flex gap-2 flex-wrap">
              <input
                hlmInput
                id="domains-ai-query"
                class="flex-1 min-w-[240px]"
                type="text"
                placeholder="e.g. premium barber shop in Newark"
                [(ngModel)]="aiQuery"
                [disabled]="aiSearching()"
                (keydown.enter)="runAiSearch()"
                data-testid="ai-search-input"
              />
              <button class="btn-primary" type="button" (click)="runAiSearch()"
                [disabled]="aiSearching() || !aiQueryValid()"
                [brnTooltip]="!aiQueryValid() ? 'Type a few words describing your business first' : ''"
                data-testid="ai-search-btn">
                {{ aiSearching() ? 'Searching…' : 'Search with AI' }}
              </button>
            </div>

            @if (aiSearching()) {
              <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="ai-results-loading">
                @for (i of [0,1,2,3,4,5]; track i) {
                  <div class="h-[96px] bg-black/30 border border-border rounded-md animate-pulse"></div>
                }
              </div>
            } @else if (aiResults()) {
              @let r = aiResults()!;
              @if (r.available.length === 0 && r.unavailable.length === 0) {
                <app-mini-empty text="No suggestions yet. Try a more descriptive query.">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
                </app-mini-empty>
              } @else {
                <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="ai-results">
                  @for (card of r.available; track card.name) {
                    <article class="domain-card domain-card--available">
                      <header class="flex items-start justify-between gap-2">
                        <code class="font-mono text-sm text-white break-all">{{ card.name }}</code>
                        <span class="status-badge" data-status="verified" title="Available for registration">
                          <span class="status-dot" aria-hidden="true"></span>
                          Available
                        </span>
                      </header>
                      <div class="flex items-center justify-between gap-2 text-[0.7rem] text-text-secondary">
                        <span class="px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/30">{{ strategyLabel(card.strategy) }}</span>
                        <span class="font-mono">{{ formatPrice(card.price_usd) }}/yr</span>
                      </div>
                      <button class="btn-primary w-full text-[0.78rem] py-1.5" type="button" (click)="registerDomain(card)" [disabled]="registering() === card.name" [attr.data-testid]="'register-' + card.name">
                        {{ registering() === card.name ? 'Registering…' : 'Register' }}
                      </button>
                    </article>
                  }
                  @for (card of r.unavailable; track card.name) {
                    <article class="domain-card domain-card--taken">
                      <header class="flex items-start justify-between gap-2">
                        <code class="font-mono text-sm text-text-secondary break-all line-through">{{ card.name }}</code>
                        <span class="status-badge" data-status="error" title="Already registered">
                          <span class="status-dot" aria-hidden="true"></span>
                          Taken
                        </span>
                      </header>
                      <div class="flex items-center justify-between gap-2 text-[0.7rem] text-text-secondary">
                        <span class="px-1.5 py-0.5 rounded bg-black/40 border border-border">{{ strategyLabel(card.strategy) }}</span>
                      </div>
                    </article>
                  }
                </div>
              }
            }
          </div>
        </section>

        <!-- ── 3. Connected domains ─────────────────────────────── -->
        <section class="card p-5 space-y-4" appReveal>
          <div class="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <h3 class="section-h text-base font-semibold text-white m-0">Connected domains</h3>
              <p class="text-[0.78rem] text-text-secondary m-0 mt-1">
                Every domain currently pointing to this site. The primary domain is what visitors see first.
              </p>
            </div>
            @if (hostnames().length > 0) {
              <div class="count-chip" [attr.aria-label]="connectedCount() + ' connected domains, ' + verifiedCount() + ' verified'">
                <span class="count-chip__num"><app-rolling-counter [value]="connectedCount()" /></span>
                <span class="count-chip__label">connected</span>
                @if (verifiedCount() > 0) {
                  <span class="count-chip__sep" aria-hidden="true">·</span>
                  <span class="count-chip__num count-chip__num--ok"><app-rolling-counter [value]="verifiedCount()" /></span>
                  <span class="count-chip__label">live</span>
                }
              </div>
            }
          </div>

          @if (loadingHostnames()) {
            <div class="space-y-2" data-testid="hostnames-loading" role="status" aria-busy="true" aria-label="Loading connected domains">
              @for (i of [0,1,2]; track i) {
                <div class="h-12 bg-[var(--ps-accent)]/[0.04] border border-[var(--ps-accent)]/15 rounded-md animate-pulse"></div>
              }
            </div>
          } @else if (hostnamesError()) {
            <app-error-card
              data-testid="hostnames-load-error"
              class="block"
              title="Couldn't load your domains"
              [message]="hostnamesError()!"
              [correlationId]="hostnamesErrorRef()"
              [retryLabel]="loadingHostnames() ? 'Retrying…' : 'Retry'"
              (retry)="loadHostnames()" />
          } @else if (hostnames().length === 0) {
            <app-empty-state
              icon="🔗"
              title="No connected domains"
              body="Connect a domain you already own, or search for an available one with AI."
              primary="Add a domain"
              (primaryClick)="focusAddDomain()"
            />
          } @else {
            <div class="overflow-x-auto" tabindex="0" role="region" aria-label="Domains table — scroll horizontally">
              <table class="w-full text-[0.82rem]" data-testid="hostnames-table">
                <thead>
                  <tr class="text-left text-[0.68rem] uppercase tracking-wider text-text-secondary border-b border-border">
                    <th scope="col" class="py-2 pr-3 font-medium">Hostname</th>
                    <th scope="col" class="py-2 pr-3 font-medium">Status</th>
                    <th scope="col" class="py-2 pr-3 font-medium">SSL</th>
                    <th scope="col" class="py-2 pr-3 font-medium">Primary</th>
                    <th scope="col" class="py-2 pr-3 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  @for (h of hostnames(); track h.id) {
                    <tr class="border-b border-border/50 last:border-b-0">
                      <td class="py-2 pr-3 font-mono text-white break-all">{{ h.hostname }}</td>
                      <td class="py-2 pr-3">
                        <span
                          class="status-badge"
                          [attr.data-status]="statusTone(h.status)"
                          [attr.data-testid]="'hostname-status-' + h.hostname"
                        >
                          <span class="status-dot" aria-hidden="true"></span>
                          {{ h.status }}
                        </span>
                      </td>
                      <td class="py-2 pr-3 text-text-secondary">{{ h.ssl_status || '—' }}</td>
                      <td class="py-2 pr-3">
                        <input
                          type="radio"
                          name="primary"
                          [checked]="h.is_primary === 1"
                          (change)="makePrimary(h)"
                          [disabled]="busyHostname() === h.id"
                          [attr.aria-label]="'Make ' + h.hostname + ' primary'"
                        />
                      </td>
                      <td class="py-2 pr-3 text-right">
                        <div class="flex justify-end gap-1 flex-wrap">
                          @if (statusTone(h.status) === 'error') {
                            <button
                              class="btn-retry"
                              type="button"
                              (click)="retryHostname(h)"
                              [disabled]="busyHostname() === h.id"
                              [attr.data-testid]="'retry-' + h.hostname"
                              [brnTooltip]="'Re-verify SSL and DNS for this hostname'"
                            >
                              {{ busyHostname() === h.id ? 'Retrying…' : 'Retry' }}
                            </button>
                          }
                          @if (h.type === 'custom_cname') {
                            <button
                              class="btn-ghost text-[0.72rem] py-1 px-2"
                              type="button"
                              (click)="openTransferModal(h)"
                              [disabled]="busyHostname() === h.id"
                              [attr.data-testid]="'transfer-' + h.hostname"
                              [brnTooltip]="'Port this domain to another registrar'"
                            >
                              Transfer out
                            </button>
                          }
                          @if (h.type !== 'free_subdomain') {
                            <button
                              class="btn-ghost btn-danger text-[0.72rem] py-1 px-2"
                              type="button"
                              (click)="removeHostname(h)"
                              [disabled]="busyHostname() === h.id"
                              [brnTooltip]="'Remove this hostname from the site'"
                            >
                              Remove
                            </button>
                          }
                        </div>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>
      }

      <!-- ── Transfer-out modal ─────────────────────────────────── -->
      @if (transferModal(); as t) {
        <div class="modal-overlay" (click)="closeTransferModal()" (keydown.escape)="closeTransferModal()" data-testid="transfer-modal">
          <div
            class="modal-panel max-w-[520px]"
            role="dialog"
            aria-modal="true"
            aria-labelledby="transfer-modal-title"
            [focusTrap]="true"
            (click)="$event.stopPropagation()"
          >
            <header class="modal-head">
              <h2 id="transfer-modal-title" class="m-0 text-base font-semibold text-white">Port {{ t.hostname.hostname }} to another registrar</h2>
              <button class="modal-close" type="button" (click)="closeTransferModal()" aria-label="Close dialog">×</button>
            </header>
            <div class="p-5 space-y-4 text-[0.82rem]">
              @if (!t.authCode) {
                <p class="text-text-secondary m-0">
                  We will unlock the domain at Cloudflare and generate an authorization (EPP) code you can hand to your new registrar.
                  The transfer itself happens at the gaining registrar — Cloudflare typically releases the domain within 5 to 7 days.
                </p>
                <ul class="text-text-secondary text-[0.78rem] list-disc pl-5 space-y-1 m-0">
                  <li>Site traffic keeps flowing during the transfer.</li>
                  <li>If you change your mind, re-lock the domain in Cloudflare before the transfer completes.</li>
                  <li>You will lose Cloudflare's at-cost pricing once the domain moves.</li>
                </ul>
                <label class="block">
                  <span class="text-[0.7rem] uppercase tracking-wider text-text-secondary block mb-1">New registrar (optional)</span>
                  <input hlmInput class="w-full" type="text" placeholder="e.g. Namecheap" [(ngModel)]="transferNewRegistrar" />
                </label>
                <div class="flex justify-end gap-2">
                  <button class="btn-ghost" type="button" (click)="closeTransferModal()">Cancel</button>
                  <button class="btn-primary" type="button" (click)="confirmTransfer()" [disabled]="t.submitting" data-testid="transfer-confirm">
                    {{ t.submitting ? 'Generating code…' : 'Generate auth code' }}
                  </button>
                </div>
              } @else {
                <p class="transfer-success m-0 text-[0.85rem]">
                  Provide this auth code to your new registrar. Unlock confirmed at Cloudflare. Transfer should complete within 5-7 days.
                </p>
                <div class="bg-black/40 border border-primary/30 rounded p-3 flex items-center justify-between gap-2">
                  <code class="font-mono text-primary text-sm break-all" data-testid="transfer-auth-code">{{ t.authCode }}</code>
                  <button class="btn-ghost text-[0.72rem]" type="button" (click)="copyText(t.authCode)" [brnTooltip]="'Copy auth code'">Copy</button>
                </div>
                <p class="text-[0.75rem] text-text-secondary m-0">
                  <a class="text-primary underline" [href]="t.instructionsUrl" target="_blank" rel="noopener noreferrer">Read Cloudflare's transfer-out guide<svg class="inline-block align-[-2px] ml-[3px]" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></a>
                </p>
                <div class="flex justify-end">
                  <button class="btn-primary" type="button" (click)="closeTransferModal()">Done</button>
                </div>
              }
            </div>
          </div>
        </div>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .modal-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.6);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 1rem;
        z-index: 50;
      }
      .modal-panel {
        background: var(--ps-surface-2, color-mix(in oklch, var(--ps-bg, #060610) 88%, #fff 4%));
        border: 1px solid var(--ps-accent-line, var(--border, rgba(0, 229, 255, 0.28)));
        border-radius: var(--ps-radius-xl, 22px);
        width: 100%;
        max-width: 520px;
        max-height: calc(100vh - 2rem);
        overflow-y: auto;
        box-shadow: var(--ps-shadow-modal, 0 20px 60px rgba(0, 0, 0, 0.6));
      }
      .modal-head {
        padding: 0.85rem 1.25rem;
        border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.08));
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .modal-close {
        appearance: none;
        background: transparent;
        border: 0;
        color: var(--ps-ink, #f4f4ff);
        opacity: 0.6;
        font-size: 1.4rem;
        line-height: 1;
        padding: 0.2rem 0.45rem;
        border-radius: 8px;
        cursor: pointer;
        transition: opacity 140ms ease, background 140ms ease;
      }
      .modal-close:hover { opacity: 1; background: var(--ps-accent-soft, rgba(0, 229, 255, 0.14)); }
      .modal-close:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 2px;
        opacity: 1;
      }
      /* Connected-domains count chip — cyan/black brand stat surface */
      .count-chip {
        display: inline-flex;
        align-items: baseline;
        gap: 0.4rem;
        padding: 0.35rem 0.75rem;
        border-radius: 999px;
        background: var(--ps-accent-soft, rgba(0, 229, 255, 0.14));
        border: 1px solid var(--ps-accent-line, rgba(0, 229, 255, 0.28));
        font-variant-numeric: tabular-nums;
      }
      .count-chip__num {
        font-family: 'Sora', system-ui, sans-serif;
        font-weight: 800;
        font-size: 1.05rem;
        color: var(--ps-accent, #00e5ff);
        line-height: 1;
      }
      .count-chip__num--ok { color: oklch(0.82 0.17 160); }
      .count-chip__label {
        font-size: 0.62rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--ps-ink, #f4f4ff);
        opacity: 0.7;
      }
      .count-chip__sep { color: var(--ps-ink, #f4f4ff); opacity: 0.35; }
      .section-h {
        font-family: 'Sora', system-ui, sans-serif;
        font-weight: 600;
        letter-spacing: -0.02em;
      }
      /* OKLCH status badges — perceptually-uniform color so all three tones
         carry equal visual weight at the same chroma. */
      .status-badge {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        padding: 0.18rem 0.55rem;
        border-radius: 999px;
        border: 1px solid color-mix(in oklch, var(--status-color) 40%, transparent);
        background: color-mix(in oklch, var(--status-color) 12%, transparent);
        color: var(--status-color);
        font-size: 0.66rem;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        line-height: 1.4;
      }
      .status-dot {
        width: 6px;
        height: 6px;
        border-radius: 999px;
        background: var(--status-color);
        box-shadow: 0 0 0 0 color-mix(in oklch, var(--status-color) 60%, transparent);
      }
      .status-badge[data-status='verified'] { --status-color: oklch(0.78 0.18 152); }
      .status-badge[data-status='pending'] { --status-color: oklch(0.82 0.16 78); }
      .status-badge[data-status='pending'] .status-dot { animation: status-pulse 1.6s ease-in-out infinite; }
      .status-badge[data-status='error'] { --status-color: oklch(0.7 0.21 25); }
      .status-badge[data-status='neutral'] { --status-color: oklch(0.7 0.02 240); }
      @keyframes status-pulse {
        0%, 100% { box-shadow: 0 0 0 0 color-mix(in oklch, var(--status-color) 60%, transparent); }
        50% { box-shadow: 0 0 0 5px color-mix(in oklch, var(--status-color) 0%, transparent); }
      }
      .btn-primary {
        padding: 0.5rem 1.05rem;
        border-radius: 10px;
        background: linear-gradient(
          135deg,
          color-mix(in oklch, var(--ps-accent, #00e5ff) 88%, #fff 12%),
          var(--ps-accent, #00e5ff)
        );
        color: var(--ps-bg, #060610);
        font-weight: 700;
        border: 0;
        cursor: pointer;
        font-size: 0.78rem;
        box-shadow: 0 6px 18px -8px var(--ps-accent-glow, rgba(0, 229, 255, 0.55));
        transition: transform 140ms ease, box-shadow 140ms ease;
      }
      .btn-primary:hover:not(:disabled) {
        transform: translateY(-1px);
        box-shadow: 0 10px 24px -8px var(--ps-accent-glow, rgba(0, 229, 255, 0.7));
      }
      .btn-primary:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 2px;
      }
      .btn-primary:disabled { opacity: 0.55; cursor: not-allowed; transform: none; box-shadow: none; }
      .btn-retry {
        padding: 0.22rem 0.6rem;
        border-radius: 7px;
        background: color-mix(in oklch, oklch(0.7 0.21 25) 14%, transparent);
        border: 1px solid color-mix(in oklch, oklch(0.7 0.21 25) 44%, transparent);
        color: oklch(0.84 0.13 25);
        font-size: 0.7rem;
        font-weight: 700;
        cursor: pointer;
        transition: background 140ms ease;
      }
      .btn-retry:hover:not(:disabled) { background: color-mix(in oklch, oklch(0.7 0.21 25) 26%, transparent); }
      .btn-retry:disabled { opacity: 0.55; cursor: progress; }
      .btn-retry:focus-visible { outline: 2px solid oklch(0.84 0.13 25); outline-offset: 2px; }
      /* Destructive ghost — error-tone OKLCH, brand-token-consistent */
      .btn-danger { color: oklch(0.78 0.16 25); }
      .btn-danger:hover:not(:disabled) { color: oklch(0.86 0.14 25); }
      /* AI domain-search candidate cards — cyan/black surfaces */
      .domain-card {
        border-radius: 0.5rem;
        padding: 0.75rem;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        background: color-mix(in oklch, var(--ps-bg, #060610) 70%, transparent);
        border: 1px solid var(--ps-accent-line, rgba(0, 229, 255, 0.28));
        transition: border-color 140ms ease;
      }
      .domain-card--available:hover {
        border-color: color-mix(in oklch, var(--ps-accent, #00e5ff) 55%, transparent);
      }
      .domain-card--taken {
        opacity: 0.6;
        border-color: var(--border, rgba(255, 255, 255, 0.08));
      }
      .transfer-success { color: oklch(0.82 0.17 160); }
      @media (prefers-reduced-motion: reduce) {
        .status-dot, .btn-primary, .btn-retry { animation: none; transition: none; }
      }
    `,
  ],
})
export class AdminDomainsComponent implements OnInit {
  /** Shared admin state — read-only access to the selected site. */
  readonly state = inject(AdminStateService);
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  private readonly confirmSvc = inject(ConfirmService);

  /** The custom-domain text input — focused by the empty-state's "Add a domain" CTA. */
  @ViewChild('customInput') private customInput?: ElementRef<HTMLInputElement>;

  /** ───── Form / input state ───── */
  customDomainInput = signal('');
  aiQuery = signal('');

  /**
   * True when the user has typed something that is NOT a valid domain yet.
   * Drives the inline hint + `aria-invalid` so a disabled "Add domain" button
   * is explained ("here's why it's greyed out") instead of silently inert.
   * Empty input is NOT invalid — no nagging before the user has typed.
   */
  customDomainInvalid = computed(() => {
    const v = this.customDomainInput().trim();
    return v.length > 0 && !this.isValidDomain(v);
  });

  /**
   * Gate for the "Search with AI" button + Enter key. The AI search fans out a
   * 10-suggestion LLM call on the server, so firing it on an empty/whitespace
   * query wastes a real model call and returns nothing useful. Require ≥2
   * non-blank chars — mirrors the disabled "Add domain" precondition next to it.
   */
  aiQueryValid = computed(() => this.aiQuery().trim().length >= 2);

  /** ───── Async state ───── */
  hostnames = signal<readonly Hostname[]>([]);
  loadingHostnames = signal(false);
  /** Persistent hostname-load failure — so a fetch error shows a Retry card, not a fake "No connected domains" empty state (which could prompt a re-provision of a domain the user already owns). */
  hostnamesError = signal<string | null>(null);
  /** Worker request_id from a failed hostname load → copyable support reference on the error card. */
  readonly hostnamesErrorRef = signal('');
  addingCustom = signal(false);
  aiSearching = signal(false);
  aiResults = signal<{ available: readonly DomainCard[]; unavailable: readonly DomainCard[] } | null>(null);
  registering = signal<string | null>(null);
  busyHostname = signal<string | null>(null);

  /** Transfer-out modal state. `null` when closed. */
  transferModal = signal<{
    readonly hostname: Hostname;
    authCode: string | null;
    instructionsUrl: string;
    submitting: boolean;
  } | null>(null);
  transferNewRegistrar = signal('');

  /** Computed: the default `{slug}.projectsites.dev` fallback for the site. */
  readonly backupDomain = computed<string>(() => {
    const site = this.state.selectedSite();
    return site ? `${site.slug}.projectsites.dev` : '';
  });

  /** Total connected hostnames — drives the rolling-counter stat chip. */
  readonly connectedCount = computed<number>(() => this.hostnames().length);

  /** Hostnames whose status maps to the `verified` (live) tone. */
  readonly verifiedCount = computed<number>(
    () => this.hostnames().filter((h) => this.statusTone(h.status) === 'verified').length,
  );

  constructor() {
    // Reactively reload hostnames when the selected site changes.
    effect(() => {
      const site = this.state.selectedSite();
      if (site) {
        this.loadHostnames();
      } else {
        this.hostnames.set([]);
      }
    });
  }

  ngOnInit(): void {
    // No-op — effect() above handles initial load.
  }

  // ─── Data loaders ──────────────────────────────────────────

  /** Fetch the hostname list for the currently-selected site. */
  loadHostnames(): void {
    const site = this.state.selectedSite();
    if (!site) return;
    this.loadingHostnames.set(true);
    this.hostnamesError.set(null);
    this.hostnamesErrorRef.set('');
    // {silent}: this read owns its error UX — a persistent hostnamesError banner
    // with Retry. Without {silent} the generic ApiService toast double-fired over
    // it (and the own toast below made it a TRIPLE). The banner+Retry is the sole
    // feedback now (matches the sites/deliverability/snapshots-diff convergence).
    this.api.get<{ data: readonly Hostname[] }>(`/sites/${site.id}/hostnames`, undefined, { silent: true }).subscribe({
      next: (res) => {
        this.hostnames.set(res.data ?? []);
        this.hostnamesError.set(null);
        this.loadingHostnames.set(false);
      },
      error: (err: { error?: unknown } | undefined) => {
        this.loadingHostnames.set(false);
        // Persist the failure so the empty state can't masquerade as "no domains".
        this.hostnamesError.set('Could not load connected domains — your existing domains are safe.');
        this.hostnamesErrorRef.set(this.requestIdFrom(err));
      },
    });
  }

  /** Pull the worker request_id from a failed response ({ error: { request_id } }) for the support reference. */
  private requestIdFrom(e: { error?: unknown } | undefined): string {
    return (e?.error as { error?: { request_id?: string } } | undefined)?.error?.request_id ?? '';
  }

  // ─── Backup-domain helpers ─────────────────────────────────

  /** Copy the backup domain to the clipboard, with a success toast. */
  copyBackup(): void {
    const value = this.backupDomain();
    if (!value) return;
    this.copyText(value, 'Backup domain copied');
  }

  // ─── Add custom CNAME ──────────────────────────────────────

  /**
   * Validate an FQDN-shaped string. Loose check (`label.label.tld`) — server
   * enforces the strict rules via Zod.
   */
  isValidDomain(value: string): boolean {
    // Full parity with the worker's hostnameSchema (min 3 / max 253 + RFC format)
    // so an overlong/too-short hostname is caught on the client, not by a server
    // 400. Value-domain coverage per TDD #10 (boundary/overlong).
    const v = value.trim();
    return (
      v.length >= 3 &&
      v.length <= 253 &&
      /^[a-z0-9][a-z0-9-]*\.[a-z0-9-]+(\.[a-z0-9-]+)*$/i.test(v)
    );
  }

  /**
   * Empty-state first-action CTA: jump the user straight to the "Already own a
   * domain?" input (focus scrolls it into view) so connecting the first domain
   * is one click, not a hunt up the page.
   */
  focusAddDomain(): void {
    this.customInput?.nativeElement.focus();
  }

  /** Submit handler for the "Already own a domain?" form. */
  addCustom(event: Event): void {
    event.preventDefault();
    const site = this.state.selectedSite();
    const hostname = this.customDomainInput().trim().toLowerCase();
    // Never fail silently: a non-empty but malformed domain gets a useful error
    // (the submit button is disabled in the UI, but Enter / programmatic calls
    // still route here). Empty input is a no-op — nothing to complain about yet.
    if (!this.isValidDomain(hostname)) {
      if (hostname) this.toast.error('Enter a valid domain like www.example.com — no spaces or http://');
      return;
    }
    if (!site) {
      this.toast.error('Select a site before adding a domain.');
      return;
    }
    this.addingCustom.set(true);
    this.api
      .post<{ data: { hostname: string } }>(`/sites/${site.id}/hostnames`, {
        hostname,
        type: 'custom_cname',
      })
      .subscribe({
        next: () => {
          this.toast.success(`Added ${hostname}`);
          this.customDomainInput.set('');
          this.addingCustom.set(false);
          this.loadHostnames();
        },
        error: (err: { error?: { error?: { message?: string } } }) => {
          this.addingCustom.set(false);
          this.toast.error(err?.error?.error?.message ?? 'Failed to add domain');
        },
      });
  }

  // ─── AI domain search ──────────────────────────────────────

  /** Fan out 10 parallel AI strategies and merge with availability data. */
  runAiSearch(): void {
    const site = this.state.selectedSite();
    // Guard the Enter-key path too: a blank/1-char query wastes a 10-way LLM
    // fan-out. The button is already disabled; this covers keydown.enter.
    if (!site || !this.aiQueryValid()) return;
    const query = this.aiQuery().trim();
    this.aiSearching.set(true);
    this.aiResults.set(null);
    this.api.post<AiSearchResponse>(`/sites/${site.id}/domains/ai-search`, { query }, { silent: true }).subscribe({
      next: (res) => {
        this.aiResults.set({
          available: res.data?.available ?? [],
          unavailable: res.data?.unavailable ?? [],
        });
        this.aiSearching.set(false);
      },
      error: () => {
        this.aiSearching.set(false);
        this.toast.error('Domain search failed. Try again in a moment.');
      },
    });
  }

  /** Register an available domain card via Cloudflare Registrar. */
  async registerDomain(card: DomainCard): Promise<void> {
    const site = this.state.selectedSite();
    if (!site || this.registering()) return;
    const name = card.name;
    // Registering a domain is a real recurring financial charge — verify the
    // price + annual nature before the purchase (mirrors the voice number-buy).
    const ok = await this.confirmSvc.confirm({
      title: 'Register this domain?',
      message: `Register ${name} for ${this.formatPrice(card.price_usd)}/yr? This purchases the domain and starts the recurring annual registration charge.`,
      confirmLabel: 'Register domain',
      danger: true,
    });
    if (!ok) return;
    this.registering.set(name);
    this.api
      .post<{ data: { domain: string; status: string } }>(`/sites/${site.id}/domains/register`, {
        domain: name,
      })
      .subscribe({
        next: () => {
          this.registering.set(null);
          this.toast.success(`Registered ${name}`);
          // Drop the freshly-registered card from the available list so it
          // doesn't re-tempt the user.
          const current = this.aiResults();
          if (current) {
            this.aiResults.set({
              available: current.available.filter((c) => c.name !== name),
              unavailable: current.unavailable,
            });
          }
          this.loadHostnames();
        },
        error: (err: { error?: { error?: { message?: string } } }) => {
          this.registering.set(null);
          this.toast.error(err?.error?.error?.message ?? `Failed to register ${name}`);
        },
      });
  }

  /** Friendly label for a strategy id (falls back to the raw id). */
  strategyLabel(id: string): string {
    return STRATEGY_LABEL[id] ?? id;
  }

  /** Render a USD price for a domain card. */
  formatPrice(usd: number): string {
    if (!usd || usd <= 0) return '—';
    return `$${usd.toFixed(2)}`;
  }

  // ─── Connected domains actions ─────────────────────────────

  /**
   * Reduce a raw hostname status string to one of four perceptual tones
   * consumed by the OKLCH status-badge CSS. Keeping the tone vocabulary
   * narrow makes the badges visually consistent across statuses that
   * upstream may rename (`pending_validation` vs `pending`).
   *
   * @example statusTone('verification_failed') // → 'error'
   */
  statusTone(status: string): 'verified' | 'pending' | 'error' | 'neutral' {
    switch (status) {
      case 'active':
      case 'verified':
        return 'verified';
      case 'pending':
      case 'pending_validation':
      case 'provisioning':
        return 'pending';
      case 'verification_failed':
      case 'error':
      case 'failed':
        return 'error';
      default:
        return 'neutral';
    }
  }

  /**
   * Retry verification on a hostname currently in an errored state. POSTs to
   * the existing hostnames endpoint with a `retry: true` flag — the worker
   * re-runs SSL + DNS checks and flips the row back to `pending_validation`.
   */
  retryHostname(h: Hostname): void {
    const site = this.state.selectedSite();
    if (!site) return;
    this.busyHostname.set(h.id);
    this.api
      .post<{ data: { hostname: string; status: string } }>(
        `/sites/${site.id}/hostnames/${h.id}/retry`,
        {},
      )
      .subscribe({
        next: () => {
          this.busyHostname.set(null);
          this.toast.success(`Retrying ${h.hostname} — refresh in a moment`);
          this.loadHostnames();
        },
        error: () => {
          this.busyHostname.set(null);
          /* api.service already surfaced the toast */
        },
      });
  }

  /** Promote a hostname to primary. */
  makePrimary(h: Hostname): void {
    const site = this.state.selectedSite();
    if (!site || h.is_primary === 1) return;
    this.busyHostname.set(h.id);
    this.api.put(`/sites/${site.id}/hostnames/${h.id}/primary`, undefined, { silent: true }).subscribe({
      next: () => {
        this.busyHostname.set(null);
        this.toast.success(`${h.hostname} is now primary`);
        this.loadHostnames();
      },
      error: () => {
        this.busyHostname.set(null);
        this.toast.error('Failed to update primary domain');
      },
    });
  }

  /** Remove a custom hostname (free subdomains cannot be removed). */
  async removeHostname(h: Hostname): Promise<void> {
    const site = this.state.selectedSite();
    if (!site) return;
    const ok = await this.confirmSvc.confirm({
      title: 'Remove hostname',
      message: `Remove ${h.hostname} from this site? Visitors using it will stop reaching the site until it's re-added.`,
      confirmLabel: 'Remove',
    });
    if (!ok) return;
    this.busyHostname.set(h.id);
    this.api.delete(`/sites/${site.id}/hostnames/${h.id}`, { silent: true }).subscribe({
      next: () => {
        this.busyHostname.set(null);
        this.toast.success(`Removed ${h.hostname}`);
        this.loadHostnames();
      },
      error: () => {
        this.busyHostname.set(null);
        this.toast.error('Failed to remove domain');
      },
    });
  }

  // ─── Transfer-out flow ─────────────────────────────────────

  /** Open the port-out modal for a custom hostname. */
  openTransferModal(h: Hostname): void {
    this.transferNewRegistrar.set('');
    this.transferModal.set({
      hostname: h,
      authCode: null,
      instructionsUrl: 'https://developers.cloudflare.com/registrar/domains/transfer-domain-away/',
      submitting: false,
    });
  }

  /** Close the modal, resetting any state. */
  closeTransferModal(): void {
    this.transferModal.set(null);
  }

  /** Hit the transfer-out endpoint and surface the resulting auth code. */
  confirmTransfer(): void {
    const modal = this.transferModal();
    const site = this.state.selectedSite();
    if (!modal || !site) return;
    this.transferModal.set({ ...modal, submitting: true });
    const newRegistrar = this.transferNewRegistrar().trim();
    this.api
      .post<TransferOutResponse>(
        `/sites/${site.id}/domains/${modal.hostname.hostname}/transfer-out`,
        newRegistrar ? { new_registrar: newRegistrar } : {},
      )
      .subscribe({
        next: (res) => {
          this.transferModal.set({
            hostname: modal.hostname,
            authCode: res.data.auth_code,
            instructionsUrl: res.data.instructions_url,
            submitting: false,
          });
        },
        error: (err: { error?: { error?: { message?: string } } }) => {
          this.transferModal.set({ ...modal, submitting: false });
          this.toast.error(err?.error?.error?.message ?? 'Transfer initiation failed');
        },
      });
  }

  // ─── Utilities ─────────────────────────────────────────────

  /** Copy arbitrary text to the clipboard with toast feedback. */
  copyText(value: string, successMessage = 'Copied to clipboard'): void {
    if (!value) return;
    void navigator.clipboard
      .writeText(value)
      .then(() => this.toast.success(successMessage))
      .catch(() => this.toast.error('Copy failed'));
  }
}
