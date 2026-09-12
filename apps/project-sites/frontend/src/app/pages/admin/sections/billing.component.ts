import { Component, inject, signal, computed, effect, viewChild, ElementRef, type OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { isValidEmail } from '../../../utils/validators/email';
import { DatePipe, CurrencyPipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AdminStateService } from '../admin-state.service';
import { UsageGaugesComponent } from '../../../components/usage-gauges/usage-gauges.component';
import { CreditsWidgetComponent } from '../../../components/credits-widget/credits-widget.component';
import { ApiService, type CostForecastV2 } from '../../../services/api.service';
import { StripeService } from '../../../services/stripe.service';
import { ToastService } from '../../../services/toast.service';
import { ConfirmService } from '../../../services/confirm.service';
import { TelemetryService } from '../../../services/telemetry.service';
import { DialogShellComponent } from '../../../components/dialog-shell/dialog-shell.component';
import { HlmCheckboxDirective, HlmInputDirective, HlmSelectDirective, HlmTablistDirective } from '../../../ui';
import { RollingCounterComponent } from '../../../components/rolling-counter/rolling-counter.component';
import { AiSparkComponent } from '../../../components/ai-spark/ai-spark.component';
import { RevealDirective } from '../../../directives/reveal.directive';

interface Bundle { credits: number; usd: number; price_id: string; }
interface CreditState { balance: number; bundles: Record<string, Bundle>; ledger: { delta: number; reason: string; stripe_session_id: string | null; created_at: string }[]; }
interface Alert { id: string; name: string; threshold_credits: number; trigger_type: string; email: string; channels_json?: string; last_fired_at?: string | null; fire_count?: number; }

/** Single row of the `/sites/:id/mcp/connections` response — only the fields
 *  this component needs (provider name + ok flag). Kept narrow so we don't
 *  drift if the worker adds metadata. */
interface McpConnectionLite { provider: string; ok?: boolean; }

/**
 * Local-storage key for the per-site credit-caps offline fallback used by
 * the "Set credit caps" modal. Holds `{ [siteId]: number | null }` so a
 * draft cap survives a page reload until the per-site PUT settles (or the
 * worker route catches up). Read by `loadAll()` to seed `capDraft` and by
 * `saveBulkCaps()` to persist failed-to-save rows.
 */
const LOCAL_CAPS_KEY = 'ps_billing_caps_local';
interface CostRow {
  site_id: string;
  slug: string;
  business_name: string | null;
  ai_calls: number;
  ai_credits: number;
  estimated_cost_micro_usd: number;
  bandwidth_bytes: number;
  storage_bytes: number;
  /** Optional extended fields — surfaced when present, otherwise rendered as "—". */
  plan?: string | null;
  last_invocation_at?: string | null;
}

/** Cost forecast shape returned by `GET /api/admin/forecast/cost`. */
interface CostForecastState {
  current_month_estimate_usd: number;
  next_month_forecast_usd: number;
  by_category: { workers: number; ai: number; r2: number; d1: number; email: number };
  biggest_driver: string;
  savings_tip: string;
}

/** Renderable bar in the inline-SVG chart. */
interface ForecastBar {
  label: string;
  usd: number;
  height: number;
  color: string;
}

@Component({
  selector: 'app-admin-billing',
  standalone: true,
  imports: [FormsModule, DatePipe, CurrencyPipe, DecimalPipe, DialogShellComponent, RollingCounterComponent, AiSparkComponent, RevealDirective, HlmCheckboxDirective, HlmInputDirective, HlmSelectDirective, HlmTablistDirective, UsageGaugesComponent, CreditsWidgetComponent],
  template: `
    <div class="p-7 flex-1 overflow-y-auto animate-fade-in max-md:p-4 space-y-6">
      <header appReveal>
        <div class="kicker">Plan &amp; usage</div>
        <h1 class="section-h text-lg font-bold text-white m-0 mt-1 flex items-center gap-2">
          Billing
          <span class="header-pill" [class.is-pro]="plan() === 'paid'" aria-label="Current plan">
            <span class="header-pill-dot" aria-hidden="true"></span>
            {{ planLabel() }}
          </span>
        </h1>
        <p class="text-[0.78rem] text-text-secondary m-0 mt-1 max-w-prose leading-relaxed">
          AI credits power form routing, chat, and your custom AI endpoints. Per-site cost breakdown + spend alerts below.
        </p>
      </header>

      <!-- ─────────────────── BILLING TABS (BILL-01..BILL-17) ─────────────────── -->
      <nav class="billing-tabs-nav" role="tablist" hlmTablist aria-label="Billing sections">
        @for (tab of billingTabs; track tab.id) {
          <button
            type="button"
            role="tab"
            [id]="'billing-tab-' + tab.id"
            [attr.aria-selected]="activeTab() === tab.id"
            [attr.aria-controls]="'billing-tab-panel-' + tab.id"
            [attr.data-testid]="'billing-tab-' + tab.id"
            class="billing-tab-btn"
            [class.is-active]="activeTab() === tab.id"
            (click)="setTab(tab.id)">
            {{ tab.label }}
          </button>
        }
      </nav>

      <!-- ── Tab: Subscription ── -->
      @if (activeTab() === 'subscription') {
        <div role="tabpanel" id="billing-tab-panel-subscription" aria-labelledby="billing-tab-subscription" class="space-y-4">

          <!-- Subscription status panel (BILL-03, BILL-12, BILL-13) -->
          @if (subStatusError()) {
            <div class="card" role="status" data-testid="substatus-error">
              <p class="text-[0.72rem] text-amber-300/90 m-0">Couldn't load your subscription right now. <button type="button" class="underline hover:text-white" (click)="retryTabData()">Retry</button></p>
            </div>
          }
          @if (subStatus(); as sub) {
            @if (sub.status === 'past_due') {
              <div class="billing-warning-banner" data-testid="billing-warning-banner" role="alert">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                Payment failed — your plan is past due. Please update your payment method to avoid service interruption.
              </div>
            }
            @if (sub.status === 'canceled' && sub.cancel_at) {
              <div class="grace-period-banner" data-testid="grace-period-banner" role="status">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                Your subscription is canceled. Access continues until {{ sub.cancel_at | date:'MMMM d, yyyy' }}.
              </div>
            }
          }

          <div class="card" data-testid="subscription-card">
            <div class="flex items-start justify-between gap-3 flex-wrap mb-3">
              <div>
                <h2 class="m-0 text-base font-semibold text-white">Subscription</h2>
                <p class="text-[0.7rem] text-text-secondary m-0 mt-1">Your current plan and billing cycle.</p>
              </div>
              <div class="flex gap-2">
                <span class="subscription-status-badge"
                      data-testid="subscription-status"
                      [attr.data-status]="subStatus()?.status ?? 'none'">
                  {{ subStatus()?.status ?? 'none' }}
                </span>
              </div>
            </div>

            <div class="grid sm:grid-cols-2 gap-3 text-[0.78rem]">
              <div class="rounded-lg border border-white/8 bg-black/20 px-3 py-2">
                <div class="text-[0.6rem] uppercase tracking-wider text-text-secondary font-bold">Plan</div>
                <div class="text-white font-bold" data-testid="subscription-plan">{{ planLabel() }}</div>
              </div>
              <div class="rounded-lg border border-white/8 bg-black/20 px-3 py-2">
                <div class="text-[0.6rem] uppercase tracking-wider text-text-secondary font-bold">{{ periodLabel() }}</div>
                <div class="text-white font-bold" data-testid="subscription-period-end">
                  {{ subStatus()?.current_period_end ?? 'No renewal' }}
                </div>
              </div>
              @if (subStatus()?.last_webhook) {
                <div class="col-span-2 rounded-lg border border-white/8 bg-black/20 px-3 py-2">
                  <div class="text-[0.6rem] uppercase tracking-wider text-text-secondary font-bold">Last webhook</div>
                  <div class="text-white font-mono text-[0.7rem]" data-testid="last-webhook">{{ subStatus()!.last_webhook }}</div>
                </div>
              }
            </div>

            <!-- Entitlements (BILL-04) -->
            @if (entitlements(); as ent) {
              <div class="mt-4">
                <div class="text-[0.7rem] text-text-secondary uppercase tracking-wider font-bold mb-2">Entitlements</div>
                <div class="grid sm:grid-cols-3 gap-2 text-[0.78rem]">
                  <div class="rounded-lg border border-white/8 bg-black/20 px-3 py-2">
                    <div class="text-[0.6rem] uppercase tracking-wider text-text-secondary">Custom domains</div>
                    <div class="text-white font-bold" data-testid="entitlement-custom_domains"><app-rolling-counter [value]="ent.maxCustomDomains" [duration]="800" /></div>
                  </div>
                  <div class="rounded-lg border border-white/8 bg-black/20 px-3 py-2">
                    <div class="text-[0.6rem] uppercase tracking-wider text-text-secondary">Team seats</div>
                    <div class="text-white font-bold" data-testid="entitlement-seats"><app-rolling-counter [value]="ent.maxTeamSeats" [duration]="800" /></div>
                  </div>
                  <div class="rounded-lg border border-white/8 bg-black/20 px-3 py-2">
                    <div class="text-[0.6rem] uppercase tracking-wider text-text-secondary">Analytics</div>
                    <div class="text-white font-bold" data-testid="entitlement-analytics">{{ ent.analyticsEnabled ? 'Included' : '—' }}</div>
                  </div>
                </div>
              </div>
            }

            <div class="mt-4 flex flex-wrap gap-2">
              @if (plan() === 'free') {
                <button type="button" class="btn-primary" (click)="upgrade()">
                  Upgrade to Pro — $50/mo
                </button>
                <button type="button" class="btn-ghost" (click)="openEmbeddedCheckout()">
                  Embedded checkout
                </button>
              } @else {
                <button type="button" class="btn-ghost" (click)="manage()">Manage billing / Billing portal</button>
                @if (subStatus()?.status !== 'canceled') {
                  <button type="button" class="btn-danger-ghost" (click)="confirmCancel()">Cancel subscription</button>
                }
              }
            </div>
          </div>

          <!-- Plan-usage gauges (feature: usage_gauges) — usage vs limits; self-hides
               when the flag is off (API 404). -->
          <app-usage-gauges />

          <!-- Credit wallet (feature: credit_wallet_rollover) — AI-credit balance +
               ledger; self-hides when the flag is off (API 404). -->
          <app-credits-widget />

          <!-- Cancel confirmation dialog -->
          @if (cancelConfirmOpen()) {
            <app-dialog-shell (closed)="cancelConfirmOpen.set(false)">
              <span dialogTitle>Cancel subscription?</span>
              <div class="p-5 text-[0.78rem] text-text-secondary">
                Your access continues until the end of the current billing period. You won't be charged again.
              </div>
              <div dialogFooter class="px-5 py-4 border-t border-white/[0.06] flex items-center justify-end gap-2">
                <button class="btn-ghost" (click)="cancelConfirmOpen.set(false)">Keep subscription</button>
                <button class="btn-danger-ghost" data-testid="cancel-confirm-btn" [disabled]="cancelingSubscription()" (click)="cancelSubscription()">
                  {{ cancelingSubscription() ? 'Canceling…' : 'Confirm cancel' }}
                </button>
              </div>
            </app-dialog-shell>
          }

          <!-- Real Stripe.js embedded checkout — Stripe mounts its own secure iframe into
               #embeddedMount via initEmbeddedCheckout(clientSecret) (BILL-02). -->
          @if (embeddedCheckoutOpen()) {
            <div class="card mt-2">
              <div class="flex items-center justify-between mb-3">
                <h2 class="m-0 text-base font-semibold text-white text-sm">Stripe Checkout</h2>
                <button class="btn-ghost" (click)="closeEmbeddedCheckout()">Close</button>
              </div>
              <div #embeddedMount data-testid="stripe-embedded-iframe" class="billing-embedded-frame min-h-96 w-full rounded-lg bg-white/5" aria-label="Stripe embedded checkout"></div>
            </div>
          }
        </div>
      }

      <!-- ── Tab: Add-ons ── -->
      @if (activeTab() === 'addons') {
        <div role="tabpanel" id="billing-tab-panel-addons" aria-labelledby="billing-tab-addons" class="space-y-4">
          <h2 class="m-0 text-base font-semibold text-white">Add-ons</h2>
          <p class="text-[0.7rem] text-text-secondary m-0">Expand your plan with recurring monthly add-ons.</p>

          <div class="grid sm:grid-cols-2 gap-3">
            @for (addon of addonCatalog; track addon.id) {
              <div class="card-light p-4" [attr.data-testid]="'addon-card-' + addon.id">
                <div class="flex items-start justify-between mb-2">
                  <div>
                    <div class="text-white font-semibold text-[0.88rem]">{{ addon.name }}</div>
                    <div class="text-text-secondary text-[0.7rem] mt-0.5">{{ addon.description }}</div>
                  </div>
                  <div class="text-right">
                    <div class="text-white font-bold">{{ '$' + addon.price_monthly }}<span class="text-text-secondary text-[0.7rem]">/mo</span></div>
                  </div>
                </div>
                <button
                  type="button"
                  class="btn-primary w-full mt-2"
                  [disabled]="purchasingAddon() === addon.id"
                  (click)="purchaseAddon(addon.id)">
                  {{ purchasingAddon() === addon.id ? 'Opening checkout…' : 'Purchase' }}
                </button>
              </div>
            }
          </div>
        </div>
      }

      <!-- ── Tab: Wallet ── -->
      @if (activeTab() === 'wallet') {
        <div role="tabpanel" id="billing-tab-panel-wallet" aria-labelledby="billing-tab-wallet" class="space-y-4">
          <h2 class="m-0 text-base font-semibold text-white">Wallet</h2>

          <div class="card">
            <div class="flex items-center justify-between mb-3">
              <div>
                <div class="text-[0.6rem] uppercase tracking-wider text-text-secondary font-bold">Balance</div>
                <div class="text-3xl font-bold text-white tabular-nums" data-testid="wallet-balance">
                  @if (walletBalanceCents() !== null) {
                    <app-rolling-counter [value]="walletBalance()" prefix="$" [decimals]="2" [duration]="900" />
                  } @else {
                    <span class="text-text-secondary">—</span>
                    @if (walletError()) {
                      <button class="btn-ghost text-xs ml-2 align-middle" type="button" (click)="loadWallet()" data-testid="wallet-retry">Retry</button>
                    }
                  }
                </div>
              </div>
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="text-cyan-300" aria-hidden="true"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 3H5a2 2 0 0 0-2 2v2h20V5a2 2 0 0 0-2-2h-2"/><circle cx="16" cy="14" r="1"/></svg>
            </div>

            <div class="mt-3 space-y-2">
              <label class="block">
                <div class="muted-h mb-1">Top-up amount (USD)</div>
                <input
                  type="number"
                  min="5"
                  max="1000"
                  step="5"
                  placeholder="e.g. 25"
                  hlmInput class="w-full"
                  data-testid="topup-amount"
                  [ngModel]="topupAmount()"
                  (ngModelChange)="topupAmount.set($event)" />
              </label>
              <button
                type="button"
                class="btn-primary w-full"
                [disabled]="toppingUp()"
                (click)="topupWallet()">
                {{ toppingUp() ? 'Redirecting to Stripe…' : 'Add credit' }}
              </button>
              @if (topupRedirecting()) {
                <div class="text-center text-[0.78rem] text-cyan-300 mt-2">Redirecting to Stripe…</div>
              }
            </div>
          </div>
        </div>
      }

      <!-- ── Tab: Usage / Metering ── -->
      @if (activeTab() === 'usage') {
        <div role="tabpanel" id="billing-tab-panel-usage" aria-labelledby="billing-tab-usage" class="space-y-4">
          <h2 class="m-0 text-base font-semibold text-white">Usage &amp; Metering</h2>
          <p class="text-[0.7rem] text-text-secondary m-0">Per-site usage events posted to Stripe Meters. Usage charges appear on your next invoice.</p>

          <!-- Upcoming invoice lines (BILL-09) -->
          @if (invoiceError()) {
            <div class="card" role="status" data-testid="invoice-error">
              <p class="text-[0.72rem] text-amber-300/90 m-0">Couldn't load your upcoming invoice right now. <button type="button" class="underline hover:text-white" (click)="retryTabData()">Retry</button></p>
            </div>
          }
          @if (upcomingInvoice(); as inv) {
            <div class="card">
              <div class="text-[0.7rem] text-text-secondary uppercase tracking-wider font-bold mb-2">Upcoming invoice</div>
              @for (line of inv.lines; track line.description) {
                <div class="flex items-center justify-between py-2 border-b border-white/[0.04] text-[0.78rem]"
                     [attr.data-testid]="'usage-line-' + slugify(line.description)">
                  <span class="text-text-secondary">{{ line.description }}</span>
                  <span class="text-white font-mono">
                    @if (line.quantity !== undefined) {
                      {{ line.quantity | number }} ·&nbsp;
                    }
                    {{ (line.amount_cents / 100) | currency:'USD':'symbol':'1.2-2' }}
                  </span>
                </div>
              }
            </div>
          }

          <!-- Manual sample event trigger for E2E testing (BILL-08) -->
          <div class="card">
            <div class="text-[0.7rem] text-text-secondary uppercase tracking-wider font-bold mb-2">Meter events</div>
            <p class="text-[0.7rem] text-text-secondary m-0 mb-3">Send a sample usage event to the Stripe Meters API to validate metering is wired correctly.</p>
            <button
              type="button"
              class="btn-ghost"
              [disabled]="reportingUsage()"
              (click)="reportSampleUsage()">
              {{ reportingUsage() ? 'Sending…' : 'Report sample event' }}
            </button>
            @if (lastMeterEvent(); as evt) {
              <div class="mt-3 p-3 rounded-lg border border-cyan-500/30 bg-cyan-500/[0.06] text-[0.72rem] font-mono text-cyan-200">
                Event ID: {{ evt.event_id }} · Meter: {{ evt.meter }} · Value: {{ evt.value }}
              </div>
            }
          </div>
        </div>
      }

      <!-- ── Tab: Agency / Connect ── -->
      @if (activeTab() === 'agency') {
        <div role="tabpanel" id="billing-tab-panel-agency" aria-labelledby="billing-tab-agency" class="space-y-4">
          <h2 class="m-0 text-base font-semibold text-white">Agency &amp; Stripe Connect</h2>
          <p class="text-[0.7rem] text-text-secondary m-0">Connect your Stripe account to enable payouts to child orgs.</p>

          <div class="card">
            <div class="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <div class="text-white font-semibold mb-1">Stripe Connect Express</div>
                <div class="text-text-secondary text-[0.74rem] max-w-prose">
                  Enable revenue sharing and direct payouts to your sub-agencies. Requires the Agency tier add-on.
                </div>
              </div>
              <button
                type="button"
                class="btn-primary"
                [disabled]="onboardingConnect()"
                (click)="onboardStripeConnect()">
                {{ onboardingConnect() ? 'Redirecting to Stripe Connect…' : 'Onboard Stripe Connect' }}
              </button>
            </div>
            @if (connectOnboardingMsg()) {
              <div class="mt-3 text-[0.78rem] text-cyan-300">{{ connectOnboardingMsg() }}</div>
            }
          </div>
        </div>
      }

      <!-- ── Tab: Affiliates ── -->
      @if (activeTab() === 'affiliates') {
        <div role="tabpanel" id="billing-tab-panel-affiliates" aria-labelledby="billing-tab-affiliates" class="space-y-4">
          <h2 class="m-0 text-base font-semibold text-white">Affiliate Payouts</h2>
          <p class="text-[0.7rem] text-text-secondary m-0">Pending payout splits for your referrals.</p>

          <div class="card">
            @if (payoutsError()) {
              <div class="empty-state-pretty-compact" role="status" data-testid="payouts-error">
                <h3 class="empty-h">Couldn't load payouts</h3>
                <p class="empty-p">A temporary problem stopped us fetching your referral payouts — this is not "you have none". <button type="button" class="underline hover:text-white" (click)="retryTabData()">Retry</button></p>
              </div>
            } @else if (affiliatePayouts().length === 0) {
              <div class="empty-state-pretty-compact" role="status">
                <div class="empty-glyph-sm" aria-hidden="true">
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M14.6 9.4a2.6 2 0 0 0-2.6-1.4c-1.4 0-2.6.7-2.6 1.8 0 2.4 5.2 1.2 5.2 3.6 0 1.1-1.2 1.8-2.6 1.8a2.6 2 0 0 1-2.6-1.4"/><path d="M12 6.4v1.6M12 16v1.6"/></svg>
                </div>
                <h3 class="empty-h">No payouts yet</h3>
                <p class="empty-p">Your referral payouts will appear here when they're processed.</p>
              </div>
            } @else {
              @for (p of affiliatePayouts(); track p.affiliate_id) {
                <div class="flex items-center justify-between py-2 border-b border-white/[0.04] text-[0.78rem]"
                     data-testid="affiliate-payout-row">
                  <div>
                    <div class="text-white font-mono text-[0.7rem]">{{ p.affiliate_id }}</div>
                    <div class="text-text-secondary text-[0.66rem]">{{ p.status }}</div>
                  </div>
                  <div class="text-white font-bold tabular-nums">
                    {{ (p.amount_cents / 100) | currency:'USD':'symbol':'1.2-2' }}
                  </div>
                </div>
              }
            }
          </div>
        </div>
      }

      <!-- Plan tiers — scoped to the Subscription tab (was always-rendered) -->
      @if (activeTab() === 'subscription') {
      <!-- ─────────────────── PLAN TIERS ─────────────────── -->
      <section class="card" id="plan" appReveal>
        <div class="flex items-center justify-between mb-3 gap-3 flex-wrap">
          <div>
            <h2 class="m-0 text-base font-semibold text-white">Plan</h2>
            <p class="text-[0.7rem] text-text-secondary m-0 mt-0.5">Currently on <strong class="text-white">{{ planLabel() }}</strong>. Cancel any time.</p>
          </div>
          @if (plan() === 'paid') {
            <button class="btn-ghost" type="button" (click)="manage()" aria-label="Open Stripe billing portal" title="Open Stripe billing portal">Manage subscription</button>
          }
        </div>
        <div class="grid sm:grid-cols-2 gap-3">
          <!-- Free tier (informational) -->
          <div class="card-light p-4" [class.tier-active]="plan() === 'free'">
            <div class="flex items-baseline justify-between">
              <div class="text-base font-bold text-white">Free</div>
              <div class="text-lg font-bold text-white">$0<span class="text-[0.7rem] text-text-secondary">/mo</span></div>
            </div>
            <ul class="list-none p-0 mt-3 space-y-1.5 text-[0.74rem] text-text-secondary">
              <li>· 1 project</li>
              <li>· 100 AI credits / month</li>
              <li>· Free projectsites.dev subdomain</li>
              <li>· Community support</li>
              <li>· projectsites.dev branding</li>
            </ul>
          </div>

          <!-- Pro tier — entire card is clickable when on free. Uses a button element
               so keyboard activation is native + role/focus semantics are correct. -->
          @if (plan() === 'free') {
            <button
              type="button"
              class="plan-card-button card-light p-4 text-left"
              [class.is-upgrading]="upgrading()"
              [disabled]="upgrading()"
              data-testid="billing-pro-card"
              [attr.aria-label]="'Upgrade to Pro — $50 per month, opens checkout in a new tab'"
              (mousedown)="triggerRipple($event)"
              (click)="upgrade()">
              <div class="flex items-baseline justify-between">
                <div class="text-base font-bold text-white">Pro</div>
                <div class="text-lg font-bold text-white">$50<span class="text-[0.7rem] text-text-secondary">/mo</span></div>
              </div>
              <ul class="list-none p-0 mt-3 space-y-1.5 text-[0.74rem] text-text-secondary">
                <li>· Unlimited projects</li>
                <li>· 5,000 AI credits / month</li>
                <li>· Unlimited custom domains</li>
                <li>· Priority support · Audit log export</li>
                <li>· No projectsites.dev branding</li>
              </ul>
              <div class="plan-card-cta">
                <span class="plan-card-cta-text">{{ upgrading() ? 'Opening checkout…' : 'Upgrade to Pro' }}</span>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
                </svg>
              </div>
            </button>
          } @else {
            <div class="card-light p-4" [class.tier-active]="plan() === 'paid'">
              <div class="flex items-baseline justify-between">
                <div class="text-base font-bold text-white">Pro</div>
                <div class="text-lg font-bold text-white">$50<span class="text-[0.7rem] text-text-secondary">/mo</span></div>
              </div>
              <ul class="list-none p-0 mt-3 space-y-1.5 text-[0.74rem] text-text-secondary">
                <li>· Unlimited projects</li>
                <li>· 5,000 AI credits / month</li>
                <li>· Unlimited custom domains</li>
                <li>· Priority support · Audit log export</li>
                <li>· No projectsites.dev branding</li>
              </ul>
            </div>
          }
        </div>
      </section>
      }

      <!-- Usage/metering sections — scoped to the Usage tab (was always-rendered) -->
      @if (activeTab() === 'usage') {
      <!-- ─────────────────── PER-PROJECT CREDIT CAPS ─────────────────── -->
      <!-- id="caps" anchor so other admin surfaces can deep-link to this
           section via #caps (it lives under the Usage tab). Bulk modal handles
           cross-site editing; inline rows handle single-site adjustments. -->
      <section class="card" id="caps" appReveal [revealDelay]="60">
        <div class="flex items-start justify-between gap-3 mb-1 flex-wrap">
          <div>
            <h2 class="m-0 text-base font-semibold text-white">Per-project AI credit caps</h2>
            <p class="text-[0.7rem] text-text-secondary m-0 mt-1 mb-2">
              Stop runaway spend on a single site. Cap takes effect on the 1st of every month. Empty = no cap.
            </p>
          </div>
          @if (siteCosts().length > 0) {
            <button type="button"
                    class="btn-ghost"
                    data-testid="billing-caps-modal-open"
                    title="Set caps across many projects at once"
                    (click)="openCapsModal()">+ Set credit caps</button>
          }
        </div>
        @if (loadingCosts() && siteCosts().length === 0) {
          <div class="space-y-2" aria-busy="true" aria-label="Loading sites">
            @for (i of [1,2,3]; track i) {
              <div class="flex items-center gap-3">
                <div class="flex-1 space-y-1.5">
                  <div class="skeleton h-4 w-40"></div>
                  <div class="skeleton h-3 w-28"></div>
                </div>
                <div class="skeleton h-9 w-28 rounded-md"></div>
              </div>
            }
          </div>
        } @else if (siteCosts().length === 0) {
          <div class="empty-state-pretty-compact" role="status" data-testid="billing-caps-empty">
            <div class="empty-glyph-sm" aria-hidden="true">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            </div>
            <h3 class="empty-h">No projects yet</h3>
            <p class="empty-p">Create your first site to set per-project AI credit caps.</p>
            <!-- Opens the bulk caps modal (Turn 4). When the user has zero
                 sites the modal's own empty-state surfaces a "Create your
                 first project →" hint instead of forcing a router navigation.
                 Keeps the user in Billing context and gives them a single
                 entry point for cap management. -->
            <button type="button"
                    class="btn-primary"
                    data-testid="billing-caps-link"
                    title="Open the per-project AI credit caps modal"
                    aria-label="Open the per-project AI credit caps modal"
                    (click)="openCapsModal()">+ Set credit caps</button>
          </div>
        } @else {
          <div class="space-y-2">
            @for (r of siteCosts(); track r.site_id) {
              <div class="flex items-center gap-3">
                <div class="flex-1 min-w-0">
                  <div class="text-[0.78rem] text-white truncate" [attr.title]="r.business_name || r.slug">{{ r.business_name || r.slug }}</div>
                  <div class="text-[0.66rem] text-text-secondary font-mono">{{ formatCredits(r.ai_credits) }} credits used · 30d</div>
                </div>
                <input hlmInput type="number" min="0" step="50" placeholder="no cap"
                       [attr.aria-label]="'Monthly spend cap for ' + (r.business_name || r.slug)"
                       class="w-28 text-right" [(ngModel)]="capDraft[r.site_id]" />
                <button class="btn-ghost" (click)="saveCap(r.site_id)" [disabled]="savingCap() === r.site_id">
                  {{ savingCap() === r.site_id ? '…' : 'Save' }}
                </button>
              </div>
            }
          </div>
        }
      </section>

      <!-- ─────────────────── 30-DAY COST FORECAST (#95) ─────────────────── -->
      <section class="card border border-violet-500/40" data-testid="forecast-card" appReveal [revealDelay]="120">
        <div class="flex items-center justify-between mb-3">
          <div>
            <h2 class="m-0 text-base font-semibold text-white">30-day forecast</h2>
            <p class="text-[0.7rem] text-text-secondary m-0 mt-0.5">
              Projected Cloudflare spend based on the last 30 days of usage.
            </p>
          </div>
          @if (forecast(); as f) {
            <div class="text-right">
              <div class="text-2xl font-bold text-white"><app-rolling-counter [value]="f.next_month_forecast_usd" prefix="$" [decimals]="2" [duration]="1100" /></div>
              <div class="text-[0.62rem] uppercase tracking-wider text-text-secondary">next 30 days</div>
            </div>
          }
        </div>

        @if (forecastLoading() && !forecast()) {
          <div class="p-6 text-center text-text-secondary text-sm">Computing forecast…</div>
        } @else if (forecast()) {
          @let f = forecast()!;
          <div class="grid sm:grid-cols-2 gap-4 mt-2">
            <!-- Bar chart (inline SVG, no chart lib) -->
            <svg viewBox="0 0 320 140" class="w-full h-32" role="img" aria-label="Cost by category">
              @for (b of forecastBars(); track b.label; let i = $index) {
                <g>
                  <rect
                    [attr.x]="i * 62 + 10"
                    [attr.y]="120 - b.height"
                    width="44"
                    [attr.height]="b.height"
                    rx="4"
                    [attr.fill]="b.color"
                    opacity="0.85" />
                  <text
                    [attr.x]="i * 62 + 32"
                    y="135"
                    text-anchor="middle"
                    fill="rgba(255,255,255,0.55)"
                    font-size="9"
                    font-family="ui-sans-serif, system-ui">{{ b.label }}</text>
                  <text
                    [attr.x]="i * 62 + 32"
                    [attr.y]="120 - b.height - 4"
                    text-anchor="middle"
                    fill="#fff"
                    font-size="9"
                    font-weight="700"
                    font-family="ui-sans-serif, system-ui">{{ b.usd | currency:'USD':'symbol':'1.0-2' }}</text>
                </g>
              }
            </svg>

            <div class="text-[0.78rem] space-y-2">
              <div class="flex items-baseline gap-2">
                <span class="text-text-secondary">Current month:</span>
                <strong class="text-white">{{ f.current_month_estimate_usd | currency:'USD':'symbol':'1.2-2' }}</strong>
              </div>
              <div class="flex items-baseline gap-2">
                <span class="text-text-secondary">Biggest driver:</span>
                <strong class="text-violet-300">{{ f.biggest_driver }}</strong>
              </div>
              <div class="mt-3 p-3 rounded-lg border border-violet-500/30 bg-violet-500/[0.06]">
                <div class="text-[0.6rem] uppercase tracking-wider text-violet-300 font-bold mb-1 inline-flex items-center gap-1"><app-ai-spark /> Savings tip</div>
                <div class="text-text-secondary text-[0.72rem] leading-relaxed">{{ f.savings_tip }}</div>
              </div>
            </div>
          </div>
        } @else {
          <div class="p-6 text-center text-text-secondary text-sm">Forecast unavailable.</div>
        }
      </section>

      <!-- ─── 30-DAY ROLLING FORECAST v2 (Bundle B finish, 2026-05-24) ─── -->
      <section class="card border border-cyan-500/40" data-testid="forecast-v2-card" appReveal [revealDelay]="180">
        <div class="flex items-start justify-between mb-3 gap-3 flex-wrap">
          <div class="min-w-0">
            <h2 class="m-0 text-base font-semibold text-white flex items-center gap-2">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="text-cyan-300"><path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/></svg>
              Rolling 30-day forecast
            </h2>
            <p class="text-[0.7rem] text-text-secondary m-0 mt-0.5">
              Projected from your last 7 days of usage. Updates every refresh.
            </p>
          </div>
          @if (forecastV2(); as fv) {
            <div class="text-right">
              <div class="text-2xl font-bold text-white tabular-nums flex items-baseline gap-1 justify-end">
                <span class="text-base font-mono text-cyan-300">$</span>
                <app-rolling-counter [value]="fv.projected_usd" />
              </div>
              <div class="text-[0.62rem] uppercase tracking-wider text-text-secondary">projected · next 30 days</div>
            </div>
          }
        </div>

        @if (loadingForecastV2() && !forecastV2()) {
          <div class="p-6 text-center text-text-secondary text-sm">Computing rolling forecast…</div>
        } @else if (forecastV2()) {
          @let fv = forecastV2()!;
          <!-- Sparkline (inline SVG, no chart lib) -->
          <svg viewBox="0 0 320 70" preserveAspectRatio="none" class="w-full h-16 mt-1" role="img" [attr.aria-label]="'30-day daily spend sparkline, projected total ' + fv.projected_usd + ' USD'">
            <defs>
              <linearGradient id="forecast-v2-grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#00E5FF" stop-opacity="0.42"/>
                <stop offset="100%" stop-color="#00E5FF" stop-opacity="0"/>
              </linearGradient>
            </defs>
            <path [attr.d]="forecastV2Area()" fill="url(#forecast-v2-grad)" />
            <path [attr.d]="forecastV2Line()" fill="none" stroke="#00E5FF" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round"/>
          </svg>

          <!-- Tabular summary row -->
          <div class="grid sm:grid-cols-3 gap-3 mt-3 text-[0.78rem]">
            <div class="rounded-lg border border-white/8 bg-black/20 px-3 py-2">
              <div class="text-[0.6rem] uppercase tracking-wider text-text-secondary font-bold">This period</div>
              <div class="text-white font-bold tabular-nums">{{ fv.current_period_usd | currency:'USD':'symbol':'1.2-2' }}</div>
            </div>
            <div class="rounded-lg border border-white/8 bg-black/20 px-3 py-2">
              <div class="text-[0.6rem] uppercase tracking-wider text-text-secondary font-bold">Daily avg</div>
              <div class="text-white font-bold tabular-nums">{{ fv.rolling_daily_avg | currency:'USD':'symbol':'1.4-4' }}</div>
            </div>
            <div class="rounded-lg border border-white/8 bg-black/20 px-3 py-2">
              <div class="text-[0.6rem] uppercase tracking-wider text-text-secondary font-bold">Days until cap</div>
              <div class="text-white font-bold tabular-nums">
                @if (fv.days_until_cap_hit !== null) {
                  {{ fv.days_until_cap_hit }}d
                } @else {
                  —
                }
              </div>
            </div>
          </div>

          @if (fv.plan_cap_usd && fv.plan_cap_usd > 0) {
            <!-- Cap progress meter -->
            <div class="mt-3">
              <div class="flex items-baseline justify-between mb-1">
                <span class="text-[0.7rem] text-text-secondary">Cap progress</span>
                <span class="text-[0.7rem] tabular-nums"
                      [class.text-amber-300]="fv.percent_of_cap >= 80 && fv.percent_of_cap < 100"
                      [class.text-red-400]="fv.percent_of_cap >= 100"
                      [class.text-text-secondary]="fv.percent_of_cap < 80">
                  {{ fv.percent_of_cap }}% of {{ fv.plan_cap_usd | currency:'USD':'symbol':'1.0-0' }}/mo
                </span>
              </div>
              <div class="h-1.5 rounded-full overflow-hidden bg-white/8"
                   role="progressbar"
                   [attr.aria-label]="'Usage ' + fv.percent_of_cap + '% of monthly cap'"
                   [attr.aria-valuenow]="fv.percent_of_cap"
                   aria-valuemin="0"
                   aria-valuemax="100">
                <div class="h-full transition-all duration-700"
                     [class.bg-cyan-400]="fv.percent_of_cap < 80"
                     [class.bg-amber-400]="fv.percent_of_cap >= 80 && fv.percent_of_cap < 100"
                     [class.bg-red-500]="fv.percent_of_cap >= 100"
                     [style.width.%]="forecastCapPct()">
                </div>
              </div>
              @if (fv.percent_of_cap >= 80 && fv.percent_of_cap < 100) {
                <div class="mt-2 rounded-md border border-amber-500/40 bg-amber-500/[0.08] px-3 py-2 text-[0.72rem] text-amber-200 flex items-start gap-2"
                     data-testid="forecast-v2-warn">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="mt-0.5 flex-shrink-0"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                  <span>You're projected to use <strong class="text-white">{{ fv.percent_of_cap }}%</strong> of your monthly cap. Raise it from the plan settings or trim AI workloads.</span>
                </div>
              }
            </div>
          }
        } @else {
          <div class="p-6 text-center text-text-secondary text-sm">Rolling forecast unavailable.</div>
        }
      </section>
      }

      <!-- AI Credits — scoped to the Wallet tab (was always-rendered) -->
      @if (activeTab() === 'wallet') {
      <!-- ─────────────────── AI CREDITS ─────────────────── -->
      <section class="card border border-primary/30" appReveal [revealDelay]="240">
        <div class="flex items-center justify-between mb-3">
          <h2 class="m-0 text-base font-semibold text-white">AI Credits</h2>
          <span class="text-[0.7rem] text-text-secondary">1 credit ≈ 1 AI call</span>
        </div>
        @if (loadingCredits() && !credits()) {
          <div class="skeleton h-10 w-32 mb-1"></div>
          <div class="skeleton h-3 w-24 mb-4"></div>
        } @else {
          <div class="text-4xl font-bold text-white mb-1"><app-rolling-counter [value]="credits()?.balance ?? 0" [duration]="1100" /></div>
          <div class="text-[0.78rem] text-text-secondary mb-4">credits remaining</div>
        }

        <!-- Four tiles: 500 · 2,000 · 5,000 · Custom.
             The 5,000 tier price is proportional to the existing tiers: with
             500=$5 (≈$0.010/credit) and 2,000=$15 (≈$0.0075/credit), the 5,000
             pack defaults to $30 (=$0.006/credit) — bulk discount preserved.
             The Custom tier reuses the cheapest per-credit rate so larger
             purchases never feel punished. -->
        <div class="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <!-- Existing API-driven bundles (500 + 2,000 today). -->
          @for (key of bundleKeys; track key) {
            <button
              type="button"
              class="tier-card text-left p-4"
              [attr.data-testid]="'billing-tier-' + bundleCredits(key)"
              [attr.aria-label]="'Buy ' + bundleCredits(key) + ' credits for $' + bundleUsd(key)"
              [disabled]="buying() === key"
              (mousedown)="triggerRipple($event)"
              (click)="topup(key)">
              <div class="text-[0.62rem] uppercase tracking-wider text-text-secondary/70 font-bold">{{ key }}</div>
              <div class="text-2xl font-bold text-white mt-1">{{ formatCredits(bundleCredits(key)) }}</div>
              <div class="text-[0.78rem] text-text-secondary">credits · &dollar;{{ bundleUsd(key) }}</div>
              <div class="text-[0.66rem] text-primary mt-2">{{ buying() === key ? 'Opening checkout…' : 'Buy →' }}</div>
            </button>
          }

          <!-- New static 5,000 tile - proxies through the existing topup() route
               using the 5000 bundle key. The worker should expose a matching
               bundle; if it does not yet, the API call surfaces a normal toast
               and no double-charge can occur (idempotency-keyed server-side). -->
          <button
            type="button"
            class="tier-card text-left p-4"
            data-testid="billing-tier-5000"
            aria-label="Buy 5,000 credits for $30"
            [disabled]="buying() === '5000'"
            (mousedown)="triggerRipple($event)"
            (click)="topup('5000')">
            <div class="text-[0.62rem] uppercase tracking-wider text-text-secondary/70 font-bold">Bulk</div>
            <div class="text-2xl font-bold text-white mt-1">{{ formatCredits(5000) }}</div>
            <div class="text-[0.78rem] text-text-secondary">credits · &dollar;{{ tier5000Usd }}</div>
            <div class="text-[0.66rem] text-emerald-400 mt-2">{{ buying() === '5000' ? 'Opening checkout…' : 'Best value · Buy →' }}</div>
          </button>

          <!-- Custom amount tile — number input + computed price + validation. -->
          <div class="tier-card p-4 cursor-default" [class.is-invalid]="customAmount() !== null && !customValid()">
            <div class="text-[0.62rem] uppercase tracking-wider text-text-secondary/70 font-bold">Custom</div>
            <label class="block mt-1">
              <span class="sr-only">Credits</span>
              <input
                type="number"
                min="100"
                max="100000"
                step="100"
                placeholder="e.g. 12,500"
                hlmInput class="w-full text-right"
                data-testid="billing-custom-amount-input"
                [ngModel]="customAmount()"
                (ngModelChange)="customAmount.set($event)"
                [attr.aria-invalid]="customAmount() !== null && !customValid()"
                aria-describedby="custom-amount-help" />
            </label>
            <div id="custom-amount-help" class="text-[0.7rem] mt-1.5"
                 [class.text-text-secondary]="customValid() || customAmount() === null"
                 [class.text-red-400]="customAmount() !== null && !customValid()">
              @if (customAmount() === null || customAmount() === 0) {
                100 – 100,000 credits · &dollar;{{ customRate.toFixed(3) }} ea
              } @else if (!customValid()) {
                Enter between 100 and 100,000
              } @else {
                {{ formatCredits(customAmount()!) }} credits · {{ customPrice() | currency:'USD':'symbol':'1.2-2' }}
              }
            </div>
            <button
              type="button"
              class="custom-buy-btn mt-2 w-full"
              data-testid="billing-tier-custom"
              [disabled]="!customValid() || buying() === 'custom'"
              (mousedown)="triggerRipple($event)"
              (click)="topupCustom()">
              {{ buying() === 'custom' ? 'Opening checkout…' : 'Buy →' }}
            </button>
          </div>
        </div>

        <!-- 14-day spend sparkline -->
        @if (spend14d().length > 0) {
          <div class="mt-4">
            <div class="flex items-center justify-between mb-2">
              <span class="muted-h">Spend · last 14 days</span>
              <span class="text-[0.7rem] text-text-secondary">{{ formatCredits(spend14dTotal()) }} credits · projection {{ formatCredits(projectedMonth()) }}/mo</span>
            </div>
            <svg viewBox="0 0 280 60" preserveAspectRatio="none" class="w-full h-12">
              <defs>
                <linearGradient id="spgrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="#7C3AED" stop-opacity="0.45"/>
                  <stop offset="100%" stop-color="#7C3AED" stop-opacity="0"/>
                </linearGradient>
              </defs>
              <path [attr.d]="sparkArea()" fill="url(#spgrad)" />
              <path [attr.d]="sparkLine()" fill="none" stroke="#7C3AED" stroke-width="2" />
            </svg>
          </div>
        }

        @if (credits()?.ledger?.length) {
          <details class="mt-4">
            <summary class="cursor-pointer text-[0.74rem] text-text-secondary">Recent activity</summary>
            <ul class="mt-2 space-y-1 text-[0.7rem] list-none p-0">
              @for (l of credits()!.ledger.slice(0, 20); track l.created_at) {
                <li class="flex items-center justify-between border-b border-white/[0.04] py-1">
                  <span class="text-text-secondary">{{ l.created_at | date:'short' }} · {{ l.reason }}</span>
                  <span [class.text-emerald-400]="l.delta > 0" [class.text-red-400]="l.delta < 0">{{ l.delta > 0 ? '+' : '' }}{{ l.delta }}</span>
                </li>
              }
            </ul>
          </details>
        }
      </section>
      }

      <!-- Per-site cost + spend alerts — scoped to the Usage tab -->
      @if (activeTab() === 'usage') {
      <!-- ─────────────────── PER-SITE COST BREAKDOWN ─────────────────── -->
      <section class="card" appReveal [revealDelay]="300">
        <h2 class="m-0 text-base font-semibold text-white mb-1">Per-site cost breakdown</h2>
        <p class="text-[0.7rem] text-text-secondary m-0 mb-3">Rolling 30-day window. AI credits convert to estimated USD at $0.04/credit.</p>
        @if (loadingCosts() && siteCosts().length === 0) {
          <div class="space-y-2" aria-busy="true">
            @for (i of [1,2,3]; track i) {
              <div class="flex items-center gap-3 py-2 border-b border-white/[0.04]">
                <div class="flex-1 space-y-1.5"><div class="skeleton h-4 w-44"></div><div class="skeleton h-3 w-24"></div></div>
                <div class="skeleton h-4 w-12"></div>
                <div class="skeleton h-4 w-14"></div>
                <div class="skeleton h-4 w-16"></div>
                <div class="skeleton h-4 w-16"></div>
              </div>
            }
          </div>
        } @else if (siteCosts().length === 0) {
          <div class="empty-state-pretty-compact" role="status" data-testid="billing-costs-empty">
            <div class="empty-glyph-sm" aria-hidden="true">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-6"/></svg>
            </div>
            <h3 class="empty-h">No usage yet</h3>
            <p class="empty-p">Once your sites start serving traffic and AI calls, you'll see the breakdown here.</p>
          </div>
        } @else {
          <div class="overflow-x-auto" tabindex="0" role="region" aria-label="Usage table — scroll horizontally">
            <table class="w-full text-[0.78rem]">
              <thead class="text-text-secondary/70 uppercase text-[0.6rem] tracking-wider">
                <tr class="border-b border-white/[0.06]">
                  <th scope="col" class="text-left p-2">Site</th>
                  <th scope="col" class="text-left p-2">Plan</th>
                  <th scope="col" class="text-right p-2">AI calls</th>
                  <th scope="col" class="text-right p-2">$ spent</th>
                  <th scope="col" class="text-right p-2">% of org</th>
                  <th scope="col" class="text-right p-2">Last call</th>
                </tr>
              </thead>
              <tbody>
                @for (r of siteCosts(); track r.site_id) {
                  <tr class="border-b border-white/[0.04]">
                    <td class="p-2">
                      <div class="font-semibold text-white">{{ r.business_name || r.slug }}</div>
                      <div class="text-text-secondary text-[0.66rem] font-mono">{{ r.slug }}</div>
                    </td>
                    <td class="p-2 text-text-secondary capitalize">{{ r.plan || '—' }}</td>
                    <td class="p-2 text-right">{{ formatCredits(r.ai_calls) }}</td>
                    <td class="p-2 text-right font-mono">{{ formatUsd(r.estimated_cost_micro_usd / 1000000) }}</td>
                    <td class="p-2 text-right text-text-secondary">{{ pctOfOrg(r) }}</td>
                    <td class="p-2 text-right text-text-secondary text-[0.7rem]">{{ formatLastCall(r.last_invocation_at) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>

      <!-- ─────────────────── SPEND ALERTS ─────────────────── -->
      <section class="card" appReveal [revealDelay]="360">
        <div class="flex items-center justify-between mb-3">
          <h2 class="m-0 text-base font-semibold text-white">Spend alerts</h2>
          <button
            type="button"
            class="btn-primary"
            data-testid="billing-spend-alert-create"
            (click)="openAlertModal()">+ Create alert</button>
        </div>
        <p class="text-[0.7rem] text-text-secondary m-0 mb-3">Get emailed when your balance drops below a threshold or daily burn spikes.</p>

        @if (alerts().length === 0) {
          <!-- Empty state intentionally omits a CTA — the single "+ Create alert"
               button sits in the section toolbar above so there is exactly one
               entry point. Avoids the duplicate-button pattern users flagged. -->
          <div class="empty-state-pretty-compact" data-testid="billing-alerts-empty">
            <div class="empty-glyph-sm" aria-hidden="true">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
            </div>
            <h3 class="empty-h">No spend alerts yet</h3>
            <p class="empty-p">Get notified when your balance drops or daily burn spikes. Use “+ Create alert” above to set your first one.</p>
          </div>
        } @else {
          @for (a of alerts(); track a.id) {
            <div class="flex items-center justify-between py-2 border-b border-white/[0.04] text-[0.78rem]">
              <div>
                <div class="font-semibold text-white">{{ a.name }}</div>
                <div class="text-text-secondary text-[0.7rem]">{{ a.trigger_type === 'balance_below' ? 'When balance <' : 'When spend/burn >' }} {{ formatCredits(a.threshold_credits) }} credits → {{ a.email }}</div>
              </div>
              <button type="button"
                      class="btn-danger-ghost"
                      data-testid="billing-alert-remove"
                      [attr.aria-label]="'Remove alert ' + a.name"
                      title="Remove this alert"
                      (click)="removeAlert(a)">Remove</button>
            </div>
          }
        }
      </section>
      }

      <!-- ─────────────────── SPEND ALERT MODAL ─────────────────── -->
      @if (alertModalOpen()) {
        <app-dialog-shell (closed)="closeAlertModal()">
          <span dialogIcon>
            <svg class="text-primary" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
          </span>
          <span dialogTitle>Create spend alert</span>

          <div class="p-5 flex flex-col gap-4">
            <label class="block">
              <div class="flex items-baseline justify-between mb-1">
                <span class="muted-h">Alert name</span>
                <span class="char-counter" [class.char-counter--full]="alertNameLen() >= 80">{{ alertNameLen() }}/80</span>
              </div>
              <input
                type="text"
                placeholder="e.g. Balance low warning"
                hlmInput class="w-full"
                maxlength="80"
                data-testid="billing-spend-alert-name"
                [attr.aria-invalid]="!!alertNameError()"
                aria-describedby="alert-name-error"
                [ngModel]="alertDraft.name"
                (ngModelChange)="alertDraft.name = $event"
                autofocus />
              @if (alertNameError(); as err) {
                <p id="alert-name-error" class="snap-error" role="alert" aria-live="polite">{{ err }}</p>
              }
            </label>

            <label class="block">
              <div class="muted-h mb-1">Trigger</div>
              <select
                hlmSelect class="w-full"
                data-testid="billing-spend-alert-trigger"
                [ngModel]="alertDraft.alert_kind"
                (ngModelChange)="alertDraft.alert_kind = $event">
                <option value="balance_below">Balance dropped below</option>
                <option value="rate_spike">Daily burn exceeded</option>
              </select>
            </label>

            <label class="block">
              <div class="muted-h mb-1">Threshold (USD)</div>
              <input
                type="number"
                min="1"
                max="100000"
                step="1"
                placeholder="10000"
                hlmInput class="w-full"
                data-testid="billing-spend-alert-threshold"
                [attr.aria-invalid]="!!alertThresholdError()"
                aria-describedby="alert-threshold-error"
                [ngModel]="alertDraft.threshold_credits"
                (ngModelChange)="alertDraft.threshold_credits = $event" />
              @if (alertThresholdError(); as err) {
                <p id="alert-threshold-error" class="snap-error" role="alert" aria-live="polite">{{ err }}</p>
              }
            </label>

            <label class="block">
              <div class="muted-h mb-1">Notify email</div>
              <input
                type="email"
                placeholder="alerts@yourdomain.com"
                hlmInput class="w-full"
                [attr.aria-invalid]="!!alertEmailError()"
                aria-describedby="alert-email-error"
                [ngModel]="alertDraft.notify_email"
                (ngModelChange)="alertDraft.notify_email = $event" />
              @if (alertEmailError(); as err) {
                <p id="alert-email-error" class="snap-error" role="alert" aria-live="polite">{{ err }}</p>
              }
            </label>

            <fieldset class="block">
              <legend class="muted-h mb-1">Channels</legend>
              <label class="flex items-center gap-2 text-[0.78rem] text-text-secondary">
                <input hlmCheckbox type="checkbox"
                       [ngModel]="alertDraft.notify_via_email"
                       (ngModelChange)="alertDraft.notify_via_email = $event" />
                <span>Email</span>
              </label>
              <!-- Slack checkbox: enabled-by-presence. When the org has no
                   Slack MCP connection, the input is disabled + the label
                   carries a tooltip pointing users at Settings -> MCP. The
                   preference is persisted regardless of delivery wiring so
                   the alert "remembers" the intent when Slack is added later.
                   Opacity dims the row instead of toggling a Tailwind class
                   that contains a slash character (Angular property binding
                   chokes on [class.text-white-slash-40]). -->
              <label class="flex items-center gap-2 text-[0.78rem] text-text-secondary mt-1"
                     [style.opacity]="slackConnected() ? 1 : 0.55"
                     [attr.title]="slackConnected() ? null : 'Connect Slack in Settings → MCP to enable'">
                <input hlmCheckbox type="checkbox"
                       data-testid="billing-spend-alert-slack"
                       [disabled]="!slackConnected()"
                       [ngModel]="alertDraft.notify_via_slack"
                       (ngModelChange)="alertDraft.notify_via_slack = $event" />
                <span>Notify via Slack{{ slackConnected() ? '' : ' (not connected)' }}</span>
              </label>
            </fieldset>
          </div>

          <div dialogFooter class="px-5 py-4 border-t border-white/[0.06] flex items-center justify-end gap-2">
            <button class="btn-ghost" type="button" (click)="closeAlertModal()" [disabled]="savingAlert()">Cancel</button>
            <button
              class="btn-primary"
              type="button"
              data-testid="billing-spend-alert-submit"
              [disabled]="savingAlert() || !canSaveAlert()"
              (click)="saveAlert()">
              {{ savingAlert() ? 'Creating…' : 'Create alert' }}
            </button>
          </div>
        </app-dialog-shell>
      }

      <!-- ─────────────────── BULK CREDIT-CAPS MODAL (Turn 4) ─────────────────── -->
      @if (capsModalOpen()) {
        <app-dialog-shell (closed)="closeCapsModal()">
          <span dialogIcon>
            <svg class="text-primary" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M2 12h20"/></svg>
          </span>
          <span dialogTitle>Set credit caps</span>

          <div class="p-5 flex flex-col gap-3">
            <p class="text-[0.74rem] text-text-secondary m-0">
              Cap monthly AI credits per project. Empty = no cap. Saves apply on the 1st of next month and take effect immediately for new builds.
            </p>

            @if (state.sites().length === 0) {
              <div class="empty-state-pretty-compact">
                <div class="empty-glyph-sm" aria-hidden="true">
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                </div>
                <h3 class="empty-h">No projects yet</h3>
                <p class="empty-p">Create your first site to set per-project AI credit caps.</p>
              </div>
            } @else {
              <ul class="list-none p-0 m-0 space-y-2 max-h-[50vh] overflow-y-auto pr-1">
                @for (s of state.sites(); track s.id) {
                  <li class="flex items-center gap-3 p-2 rounded-lg border border-white/[0.05]">
                    <div class="flex-1 min-w-0">
                      <div class="text-[0.78rem] text-white truncate" [attr.title]="s.business_name || s.slug">{{ s.business_name || s.slug }}</div>
                      <div class="text-[0.66rem] text-text-secondary font-mono">{{ s.slug }}</div>
                    </div>
                    <input
                      type="number"
                      min="0"
                      step="50"
                      placeholder="no cap"
                      hlmInput class="w-28 text-right"
                      [attr.aria-label]="'Monthly spend cap for ' + (s.business_name || s.slug)"
                      [attr.data-testid]="'billing-caps-modal-input-' + s.id"
                      [(ngModel)]="capsModalDraft[s.id]" />
                  </li>
                }
              </ul>
              @if (capsModalError(); as err) {
                <p class="snap-error" role="alert" aria-live="polite" data-testid="billing-caps-modal-error">{{ err }}</p>
              }
            }
          </div>

          <div dialogFooter class="px-5 py-4 border-t border-white/[0.06] flex items-center justify-end gap-2">
            <button class="btn-ghost" type="button" (click)="closeCapsModal()" [disabled]="savingCapsBulk()">Cancel</button>
            <button
              class="btn-primary"
              type="button"
              data-testid="billing-caps-modal-save"
              [disabled]="savingCapsBulk() || state.sites().length === 0"
              (click)="saveBulkCaps()">
              {{ savingCapsBulk() ? 'Saving…' : 'Save caps' }}
            </button>
          </div>
        </app-dialog-shell>
      }
    </div>
  `,
  styles: [`
    :host { display: block; --accent: var(--ps-accent, #00E5FF); }

    /* ─────── Billing tabs nav ─────── */
    .billing-tabs-nav {
      display: flex; gap: 0.25rem; flex-wrap: wrap;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      padding-bottom: 0;
    }
    .billing-tab-btn {
      padding: 0.55rem 1.1rem;
      border-radius: 8px 8px 0 0;
      background: transparent;
      color: rgba(255,255,255,0.6);
      border: none;
      border-bottom: 2px solid transparent;
      cursor: pointer;
      font-size: 0.78rem; font-weight: 600;
      font-family: 'Sora', system-ui, sans-serif;
      transition: color 160ms ease, border-color 160ms ease, background 160ms ease;
    }
    .billing-tab-btn:hover { color: rgba(255,255,255,0.85); background: rgba(255,255,255,0.04); }
    .billing-tab-btn.is-active {
      color: var(--ps-accent, #00E5FF);
      border-bottom-color: var(--ps-accent, #00E5FF);
      background: rgba(0,229,255,0.06);
    }
    .billing-tab-btn:focus-visible { outline: var(--ps-ring-focus, 2px solid #00E5FF); outline-offset: 2px; }

    /* ─────── Subscription status badge ─────── */
    .subscription-status-badge {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 3px 10px; border-radius: 999px;
      font-size: 0.65rem; font-weight: 700; text-transform: capitalize;
      background: rgba(148,163,184,0.1); color: #94a3b8;
      border: 1px solid rgba(148,163,184,0.25);
    }
    .subscription-status-badge[data-status="active"] { background: rgba(52,211,153,0.1); color: #6ee7b7; border-color: rgba(52,211,153,0.3); }
    .subscription-status-badge[data-status="past_due"] { background: rgba(251,191,36,0.1); color: #fbbf24; border-color: rgba(251,191,36,0.3); }
    .subscription-status-badge[data-status="canceled"] { background: rgba(248,113,113,0.1); color: #fca5a5; border-color: rgba(248,113,113,0.25); }
    /* Stripe passes subscription.status through verbatim — cover the rest of the
       vocabulary so a trial reads as active (not the neutral slate fallback) + the
       dunning states warn. active=green · past_due/incomplete=amber · canceled/unpaid=red. */
    .subscription-status-badge[data-status="trialing"] { background: rgba(0,229,255,0.1); color: #67e8f9; border-color: rgba(0,229,255,0.3); }
    .subscription-status-badge[data-status="incomplete"] { background: rgba(251,191,36,0.1); color: #fbbf24; border-color: rgba(251,191,36,0.3); }
    .subscription-status-badge[data-status="unpaid"] { background: rgba(248,113,113,0.1); color: #fca5a5; border-color: rgba(248,113,113,0.3); }

    /* ─────── Billing warning / grace-period banners ─────── */
    .billing-warning-banner {
      display: flex; align-items: flex-start; gap: 0.75rem;
      padding: 0.75rem 1rem; border-radius: 10px;
      background: rgba(251,191,36,0.08); border: 1px solid rgba(251,191,36,0.3);
      color: #fbbf24; font-size: 0.78rem; line-height: 1.45;
    }
    .grace-period-banner {
      display: flex; align-items: flex-start; gap: 0.75rem;
      padding: 0.75rem 1rem; border-radius: 10px;
      background: rgba(96,165,250,0.08); border: 1px solid rgba(96,165,250,0.3);
      color: #93c5fd; font-size: 0.78rem; line-height: 1.45;
    }

    /* ─────── Embedded checkout frame ─────── */
    .billing-embedded-frame {
      min-height: 24rem; border-radius: 12px; overflow: hidden;
      border: 1px solid rgba(255,255,255,0.08);
    }
    h2, h3 { font-family: 'Sora', system-ui, sans-serif; font-weight: 600; letter-spacing: -0.02em; }
    .section-h { font-family: 'Sora', system-ui, sans-serif; font-weight: 600; letter-spacing: -0.02em; }
    .kicker {
      font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.62rem; font-weight: 700; letter-spacing: 0.14em;
      text-transform: uppercase; color: var(--ps-accent, #00E5FF); opacity: 0.85;
    }
    .header-pill {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 3px 10px; border-radius: 999px;
      background: rgba(148, 163, 184, 0.10);
      border: 1px solid rgba(148, 163, 184, 0.32);
      color: #cbd5e1;
      font-family: 'Sora', system-ui, sans-serif;
      font-size: 0.65rem; font-weight: 600; letter-spacing: 0.02em;
    }
    .header-pill-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: #94a3b8;
    }
    .header-pill.is-pro {
      background: rgba(52, 211, 153, 0.10);
      border-color: rgba(52, 211, 153, 0.32);
      color: #6ee7b7;
    }
    .header-pill.is-pro .header-pill-dot {
      background: #34d399; box-shadow: 0 0 6px rgba(52, 211, 153, 0.7);
    }
    /* Compact cinematic empty-state mirrors the editor.component.ts pattern
       (empty-state-pretty + empty-glyph + glow-h-grad) but tuned for
       in-card density so multiple sections can stack without dominating. */
    .empty-state-pretty-compact {
      display: flex; flex-direction: column; align-items: center; gap: 0.75rem;
      padding: 2rem 1.4rem;
      text-align: center;
      background: radial-gradient(circle at center top, rgba(0,229,255,0.05), transparent 65%);
      border: 1px dashed rgba(0,229,255,0.16);
      border-radius: var(--ps-radius-md, 12px);
    }
    .empty-glyph-sm {
      width: 56px; height: 56px;
      display: inline-flex; align-items: center; justify-content: center;
      border-radius: 16px;
      background: linear-gradient(135deg, rgba(0,229,255,0.10), rgba(124,58,237,0.08));
      border: 1px solid rgba(0,229,255,0.22);
      color: rgba(0,229,255,0.78);
      box-shadow: 0 12px 28px -18px rgba(0,229,255,0.4);
    }
    .empty-h {
      margin: 0;
      font-family: 'Sora', system-ui, sans-serif; font-weight: 600;
      color: #fff;
      font-size: 0.92rem; letter-spacing: -0.01em;
      background: linear-gradient(90deg, #fff, #00E5FF 60%, #7C3AED);
      -webkit-background-clip: text; background-clip: text;
      color: transparent;
      text-wrap: balance;
    }
    .empty-p {
      margin: 0;
      font-size: 0.76rem; color: rgba(255,255,255,0.62);
      max-width: 38ch; line-height: 1.5;
    }
    .btn-danger-ghost {
      padding: 0.32rem 0.7rem; min-height: 24px;
      border-radius: var(--ps-radius-sm, 8px);
      background: transparent;
      color: #fca5a5;
      border: 1px solid rgba(248,113,113,0.28);
      cursor: pointer;
      font-size: 0.7rem;
      font-weight: 600;
      transition: background var(--ps-dur-fast, 140ms) ease, color var(--ps-dur-fast, 140ms) ease, border-color var(--ps-dur-fast, 140ms) ease;
    }
    .btn-danger-ghost:hover { background: rgba(248,113,113,0.14); color: #fecaca; border-color: rgba(248,113,113,0.5); }
    .btn-danger-ghost:focus-visible { outline: 2px solid #fca5a5; outline-offset: 2px; }
    .card { background: rgba(255,255,255,0.02); border: 1px solid color-mix(in oklch, var(--accent) 14%, transparent); border-radius: 14px; padding: 1.4rem; box-shadow: inset 0 0 0 1px rgba(255,255,255,0.02); transition: transform 200ms ease, border-color 200ms ease, box-shadow 200ms ease; }
    .card:hover { transform: translateY(-1px); border-color: color-mix(in oklch, var(--accent) 28%, transparent); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.04), 0 8px 24px -16px rgba(0,229,255,0.18); }
    .card-light { background: rgba(255,255,255,0.025); border: 1px solid color-mix(in oklch, var(--accent) 16%, transparent); border-radius: 12px; transition: transform 200ms ease, border-color 200ms ease; }
    .card-light:hover { transform: translateY(-1px); border-color: color-mix(in oklch, var(--accent) 30%, transparent); }
    /* Inputs use Spartan hlmInput (chrome + focus ring). Keep only the
       invalid-state border tint for the spend-alert fields (they bind
       [attr.aria-invalid]); hlmInput's own border is overridden here. */
    [hlmInput][aria-invalid="true"] { border-color: oklch(0.78 0.18 25 / 0.75) !important; }
    .btn-primary { padding: 0.5rem 1rem; border-radius: var(--ps-radius-sm, 8px); background: linear-gradient(135deg, var(--ps-accent, #00E5FF), color-mix(in oklch, var(--ps-accent, #00E5FF) 70%, #50AAE3)); color: var(--ps-bg, #060610); font-weight: 700; border: 1px solid color-mix(in oklch, var(--ps-accent, #00E5FF) 40%, transparent); cursor: pointer; font-size: 0.78rem; transition: transform 200ms ease, box-shadow 200ms ease; }
    .btn-primary:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 8px 24px -10px rgba(0,229,255,0.45); }
    .btn-primary:disabled { opacity: 0.55; cursor: not-allowed; }
    .btn-primary:focus-visible { outline: var(--ps-ring-focus, 2px solid #00E5FF); outline-offset: var(--ps-ring-focus-offset, 2px); }
    .btn-ghost { padding: 0.45rem 0.95rem; border-radius: var(--ps-radius-sm, 8px); background: transparent; color: rgba(255,255,255,0.7); border: 1px solid rgba(255,255,255,0.1); cursor: pointer; font-size: 0.74rem; transition: transform 200ms ease, border-color 200ms ease; }
    .btn-ghost:hover { transform: translateY(-1px); border-color: color-mix(in oklch, var(--accent) 30%, transparent); }
    .btn-ghost:focus-visible { outline: var(--ps-ring-focus, 2px solid #00E5FF); outline-offset: var(--ps-ring-focus-offset, 2px); }
    .tier-active { border-color: rgba(0,229,255,0.55); background: rgba(0,229,255,0.06); box-shadow: 0 0 0 3px rgba(0,229,255,0.08); }

    /* ─────── Plan-card-button (whole card clickable) ─────── */
    .plan-card-button {
      position: relative;
      overflow: hidden;
      isolation: isolate;
      width: 100%;
      cursor: pointer;
      background: rgba(255,255,255,0.025);
      border: 1px solid color-mix(in oklch, var(--accent) 28%, transparent);
      border-radius: var(--ps-radius-md, 12px);
      color: inherit;
      font: inherit;
      transition:
        transform var(--ps-dur-base, 220ms) var(--ps-ease-emphasized, cubic-bezier(0.16, 1, 0.3, 1)),
        border-color var(--ps-dur-base, 220ms) ease,
        box-shadow var(--ps-dur-base, 220ms) ease;
    }
    .plan-card-button:hover:not(:disabled) {
      transform: translateY(-2px);
      border-color: color-mix(in oklch, var(--accent) 55%, transparent);
      box-shadow: var(--ps-shadow-md, 0 6px 18px -8px rgba(0,0,0,0.42)), 0 12px 32px -16px rgba(0,229,255,0.35);
    }
    .plan-card-button:focus-visible {
      outline: var(--ps-ring-focus, 2px solid #00E5FF);
      outline-offset: var(--ps-ring-focus-offset, 2px);
    }
    .plan-card-button:disabled { opacity: 0.7; cursor: progress; }
    .plan-card-button.is-upgrading .plan-card-cta-text::after {
      content: '';
      display: inline-block;
      width: 8px; height: 8px;
      margin-left: 6px;
      border-radius: 999px;
      background: currentColor;
      animation: pulse-dot 1s ease-in-out infinite;
    }
    .plan-card-cta {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      margin-top: 0.85rem;
      padding: 0.45rem 0.75rem;
      border-radius: 8px;
      background: linear-gradient(135deg, rgba(0,229,255,0.18), rgba(80,170,227,0.18));
      color: var(--ps-accent, #00E5FF);
      border: 1px solid rgba(0,229,255,0.4);
      font-size: 0.74rem;
      font-weight: 700;
      letter-spacing: 0.01em;
    }
    @keyframes pulse-dot {
      0%, 100% { opacity: 0.4; transform: scale(0.9); }
      50%      { opacity: 1; transform: scale(1.15); }
    }

    /* ─────── Ripple effect (shared across all clickable cards) ─────── */
    .ripple {
      position: absolute;
      border-radius: 999px;
      pointer-events: none;
      background: radial-gradient(circle, rgba(0,229,255,0.45) 0%, rgba(0,229,255,0) 70%);
      transform: translate(-50%, -50%) scale(0);
      animation: ripple-out var(--ps-dur-slow, 380ms) var(--ps-ease-out, cubic-bezier(0,0,0.2,1)) forwards;
      z-index: 0;
    }
    @keyframes ripple-out {
      to {
        transform: translate(-50%, -50%) scale(6);
        opacity: 0;
      }
    }

    /* ─────── Tier card (AI credit purchase tiles) ─────── */
    .tier-card {
      position: relative;
      overflow: hidden;
      isolation: isolate;
      width: 100%;
      background: rgba(255,255,255,0.025);
      border: 1px solid color-mix(in oklch, var(--accent) 16%, transparent);
      border-radius: 12px;
      color: inherit;
      font: inherit;
      cursor: pointer;
      transition: transform 200ms ease, border-color 200ms ease, box-shadow 200ms ease;
    }
    .tier-card:hover:not(:disabled):not(.cursor-default) {
      transform: translateY(-1px);
      border-color: color-mix(in oklch, var(--accent) 50%, transparent);
      box-shadow: 0 8px 24px -10px rgba(0,229,255,0.35);
    }
    .tier-card:focus-visible {
      outline: var(--ps-ring-focus, 2px solid #00E5FF);
      outline-offset: var(--ps-ring-focus-offset, 2px);
    }
    .tier-card:disabled { opacity: 0.7; cursor: progress; }
    .tier-card.is-invalid { border-color: oklch(0.78 0.18 25 / 0.55); }

    .custom-buy-btn {
      padding: 0.45rem 0.85rem;
      border-radius: 8px;
      background: linear-gradient(135deg, var(--ps-accent, #00E5FF), color-mix(in oklch, var(--ps-accent, #00E5FF) 70%, #50AAE3));
      color: var(--ps-bg, #060610);
      font-weight: 700;
      font-size: 0.74rem;
      border: 1px solid color-mix(in oklch, var(--ps-accent, #00E5FF) 40%, transparent);
      cursor: pointer;
      transition: transform 200ms ease, box-shadow 200ms ease, opacity 200ms ease;
      position: relative;
      overflow: hidden;
      isolation: isolate;
    }
    .custom-buy-btn:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 8px 24px -10px rgba(0,229,255,0.45); }
    .custom-buy-btn:disabled { opacity: 0.45; cursor: not-allowed; }
    .custom-buy-btn:focus-visible {
      outline: var(--ps-ring-focus, 2px solid #00E5FF);
      outline-offset: var(--ps-ring-focus-offset, 2px);
    }

    .empty-state { display: flex; flex-direction: column; align-items: center; gap: 0.6rem; padding: 2rem 1rem; text-align: center; }
    .empty-state .icon { width: 36px; height: 36px; opacity: 0.45; }
    .empty-state h3 { margin: 0; font-family: 'Sora', system-ui, sans-serif; font-weight: 600; color: rgba(255,255,255,0.85); font-size: 0.86rem; letter-spacing: -0.01em; }
    .empty-state p { margin: 0; font-size: 0.74rem; color: rgba(255,255,255,0.5); max-width: 28ch; }
    .skeleton { background: linear-gradient(90deg, rgba(255,255,255,0.04), rgba(255,255,255,0.08), rgba(255,255,255,0.04)); background-size: 200% 100%; animation: shimmer 1.4s linear infinite; border-radius: 8px; }

    .muted-h { font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.08em; color: rgba(255,255,255,0.5); font-weight: 700; }
    .char-counter { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.65rem; color: rgba(255,255,255,0.5); letter-spacing: 0.02em; }
    .char-counter--full { color: oklch(0.78 0.18 25); }
    .snap-error { margin: 6px 0 0; font-size: 0.72rem; color: oklch(0.78 0.18 25); line-height: 1.35; }

    @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
    @media (prefers-reduced-motion: reduce) {
      .card, .card-light, .btn-primary, .btn-ghost, .plan-card-button, .tier-card, .custom-buy-btn { transition: none; }
      .card:hover, .card-light:hover, .btn-primary:hover, .btn-ghost:hover, .plan-card-button:hover, .tier-card:hover, .custom-buy-btn:hover { transform: none; box-shadow: none; }
      .skeleton { animation: none; background: rgba(255,255,255,0.06); }
      .ripple { animation-duration: 0ms !important; display: none; }
      .plan-card-button.is-upgrading .plan-card-cta-text::after { animation: none; }
    }
    @media (max-width: 640px) {
      .btn-primary, .btn-ghost { width: 100%; }
    }
  `],
})
export class AdminBillingComponent implements OnInit {
  state = inject(AdminStateService);
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private confirmSvc = inject(ConfirmService);
  private telemetry = inject(TelemetryService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  credits = signal<CreditState | null>(null);

  /** 30-day forecast loaded from `/admin/forecast/cost`. */
  forecast = signal<CostForecastState | null>(null);
  forecastLoading = signal(false);

  /**
   * Rolling 30-day cost forecast, backed by `GET /api/billing/cost-forecast?days=30`.
   * Loaded in `loadAll()` alongside the legacy `/admin/forecast/cost`.
   * Drives the Forecast card sparkline + rolling-counter + 80% warning.
   */
  forecastV2 = signal<CostForecastV2 | null>(null);
  loadingForecastV2 = signal(false);
  /** Toast-dedup flag — surfaces the 80% warning at most once per session. */
  private forecastWarnedThisSession = false;

  readonly billingTabs: ReadonlyArray<{ id: string; label: string }> = [
    { id: 'subscription', label: 'Subscription' },
    { id: 'addons',       label: 'Add-ons' },
    { id: 'wallet',       label: 'Wallet' },
    { id: 'usage',        label: 'Usage / Metering' },
    { id: 'agency',       label: 'Agency / Connect' },
    { id: 'affiliates',   label: 'Affiliates' },
  ];

  activeTab = signal<string>('subscription');

  setTab(id: string): void {
    this.activeTab.set(id);
    // Deep-linkable / bookmarkable billing tabs (e.g. share a link straight to
    // Usage or Affiliates). replaceUrl = no back-button spam; merge = keep other
    // params. SPA nav, never a reload.
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab: id },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  // ── Subscription tab signals ──

  /** Shape returned by GET /api/billing/subscription. */
  subStatus = signal<{
    status: string;
    plan: string;
    current_period_end?: string;
    last_webhook?: string;
    cancel_at?: string;
  } | null>(null);

  /** Shape returned by GET /api/billing/entitlements. */
  entitlements = signal<{ maxCustomDomains: number; maxTeamSeats: number; analyticsEnabled: boolean } | null>(null);

  cancelConfirmOpen = signal(false);
  cancelingSubscription = signal(false);

  embeddedCheckoutOpen = signal(false);
  /** The Stripe embedded-session `client_secret` from POST /billing/embedded-checkout —
   *  handed to Stripe.js `initEmbeddedCheckout()` (NOT an iframe URL; Stripe blocks framing
   *  checkout.stripe.com directly, which is why the old placeholder iframe never rendered). */
  embeddedClientSecret = signal<string | null>(null);
  /** The Stripe.js embedded-checkout host element (only present while the panel is open). */
  private readonly embeddedMount = viewChild<ElementRef<HTMLElement>>('embeddedMount');
  /** The mounted checkout handle — kept so we can tear it down on close. */
  private embeddedCheckout: { unmount(): void; destroy(): void } | null = null;
  private embeddedMounting = false;
  private readonly stripe = inject(StripeService);

  /**
   * Mount the REAL Stripe embedded checkout once the panel's host element renders
   * AND we have a client_secret — replaces the former placeholder iframe. Runs in an
   * effect so the conditionally-rendered `#embeddedMount` div is available before mount.
   */
  private readonly _embeddedMountFx = effect(() => {
    const host = this.embeddedMount()?.nativeElement;
    const secret = this.embeddedClientSecret();
    if (!this.embeddedCheckoutOpen() || !host || !secret || this.embeddedCheckout || this.embeddedMounting) return;
    this.embeddedMounting = true;
    this.stripe
      .mountEmbeddedCheckout(secret, host)
      .then((handle) => {
        this.embeddedMounting = false;
        if (handle) this.embeddedCheckout = handle as { unmount(): void; destroy(): void };
        else this.toast.error('Secure checkout could not load — please try again.');
      })
      .catch(() => {
        this.embeddedMounting = false;
        this.toast.error('Secure checkout could not load — please try again.');
      });
  });

  // ── Add-ons tab ──

  readonly addonCatalog: ReadonlyArray<{
    id: string;
    name: string;
    description: string;
    price_monthly: number;
  }> = [
    { id: 'extra-sites',   name: 'Extra Sites',      description: '5 additional published sites.',    price_monthly: 10 },
    { id: 'extra-storage', name: 'Extra Storage',     description: '50 GB additional R2 storage.',    price_monthly: 5  },
    { id: 'extra-seats',   name: 'Extra Team Seats',  description: '3 additional collaborator seats.', price_monthly: 15 },
    { id: 'ai-boost',      name: 'AI Boost',          description: '10,000 extra AI credits/month.',  price_monthly: 20 },
  ];

  purchasingAddon = signal<string | null>(null);

  // ── Wallet tab ──

  // null = not-yet-loaded or load-failed → render "—", NEVER a fake "$0.00"
  // (a money figure that lies on a transient blip is worse than an honest dash).
  walletBalanceCents = signal<number | null>(null);
  walletError = signal<boolean>(false);
  walletBalance = computed<number>(() => (this.walletBalanceCents() ?? 0) / 100);

  topupAmount = signal<number | null>(null);
  toppingUp = signal(false);
  topupRedirecting = signal(false);

  // ── Usage / Metering tab ──

  upcomingInvoice = signal<{
    lines: Array<{ description: string; quantity?: number; amount_cents: number }>;
    total_cents: number;
    currency: string;
  } | null>(null);

  reportingUsage = signal(false);
  lastMeterEvent = signal<{ event_id: string; meter: string; value: number } | null>(null);

  // ── Agency tab ──

  onboardingConnect = signal(false);
  connectOnboardingMsg = signal<string | null>(null);

  // ── Affiliates tab ──

  affiliatePayouts = signal<Array<{
    affiliate_id: string;
    amount_cents: number;
    status: string;
    created_at?: string;
  }>>([]);

  /** Per-panel load-error flags. A transient fetch failure must degrade gracefully (a
   * "couldn't load — retry" affordance), NOT silently blank the panel or — worse for
   * payouts — render the EMPTY state ("No payouts yet") as if the user genuinely has none.
   * Mirrors the entitlements graceful-fallback precedent in loadTabData. (AL-433, facet-5.) */
  subStatusError = signal(false);
  invoiceError = signal(false);
  payoutsError = signal(false);

  /** Slugify a description string for data-testid (e.g. "Site renders" → "site_renders"). */
  slugify(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }

  // ─────────────────── Tab-specific methods ───────────────────

  confirmCancel(): void { this.cancelConfirmOpen.set(true); }

  cancelSubscription(): void {
    if (this.cancelingSubscription()) return;
    this.cancelingSubscription.set(true);
    this.api.post<{ status: string; cancel_at: string | null }>('/billing/subscription/cancel', {}).subscribe({
      next: (r) => {
        this.cancelingSubscription.set(false);
        this.cancelConfirmOpen.set(false);
        const body = (r as unknown as { data?: { status: string; cancel_at: string | null } }).data ?? (r as { status: string; cancel_at: string | null });
        this.subStatus.set({
          status: body.status ?? 'canceled',
          plan: this.subStatus()?.plan ?? '—',
          cancel_at: body.cancel_at ?? undefined,
        });
        this.toast.success('Subscription canceled. Access continues until the end of the billing period.');
      },
      error: () => { this.cancelingSubscription.set(false); },
    });
  }

  openEmbeddedCheckout(): void {
    // Fetch a REAL Stripe embedded-session client_secret and hand it to Stripe.js
    // (the `_embeddedMountFx` effect mounts it once the host div renders). This
    // replaces the old placeholder that iframed checkout.stripe.com directly —
    // which Stripe blocks from framing, so the widget never actually loaded.
    // The endpoint REQUIRES return_url (createEmbeddedCheckoutSession → Stripe embedded
    // session return_url); posting only {plan} was the pre-existing 400 that (together
    // with the placeholder iframe) meant the embedded checkout never actually opened.
    const returnUrl = `${window.location.origin}/admin/billing?checkout=complete`;
    this.api.post<{ client_secret: string }>('/billing/embedded-checkout', { plan: 'pro', return_url: returnUrl }).subscribe({
      next: (r) => {
        const secret = (r as unknown as { data?: { client_secret: string } }).data?.client_secret ?? (r as { client_secret?: string }).client_secret ?? '';
        if (!secret) { this.toast.error('Could not start checkout — please try again.'); return; }
        this.embeddedClientSecret.set(secret);
        this.embeddedCheckoutOpen.set(true);
      },
      error: () => { /* api.service already toasted */ },
    });
  }

  /** Tear down the mounted Stripe embedded checkout + close the panel. */
  closeEmbeddedCheckout(): void {
    try {
      this.embeddedCheckout?.destroy();
    } catch { /* already torn down */ }
    this.embeddedCheckout = null;
    this.embeddedMounting = false;
    this.embeddedClientSecret.set(null);
    this.embeddedCheckoutOpen.set(false);
  }

  /** Return a redirect URL only when it is https on a stripe.com host (checkout/billing/connect)
   *  — a non-https / non-stripe value (e.g. a manipulated `javascript:` URL, which executes
   *  when assigned to location.href) must never drive a navigation on the money flow. */
  protected safeStripeUrl(url: string | undefined | null): string | null {
    if (!url) return null;
    try {
      const u = new URL(url);
      if (u.protocol === 'https:' && /(^|\.)stripe\.com$/.test(u.hostname)) return url;
    } catch { /* malformed → reject */ }
    return null;
  }

  /** Open a Stripe checkout/portal URL safely: validate, open in a new tab (noopener) with a
   *  same-tab fallback, toast on an INVALID url. No-url → silent false (the caller messages). */
  protected openStripeUrl(rawUrl: string | undefined | null): boolean {
    if (!rawUrl) return false;
    const url = this.safeStripeUrl(rawUrl);
    if (!url) { this.toast.error('That checkout link looked invalid — please retry.'); return false; }
    const win = window.open(url, '_blank', 'noopener,noreferrer');
    if (!win) window.location.href = url;
    return true;
  }

  purchaseAddon(addonId: string): void {
    if (this.purchasingAddon()) return;
    this.purchasingAddon.set(addonId);
    this.api.post<{ checkout_url: string }>('/billing/addons/purchase', { addon: addonId, billing: 'monthly' }).subscribe({
      next: (r) => {
        this.purchasingAddon.set(null);
        const url = (r as unknown as { data?: { checkout_url: string } }).data?.checkout_url ?? (r as { checkout_url?: string }).checkout_url;
        this.openStripeUrl(url);
      },
      error: () => { this.purchasingAddon.set(null); },
    });
  }

  /** Load (or retry) the wallet balance. {silent} — a failed load shows an inline "—" + Retry, not a fake $0.00. */
  loadWallet(): void {
    this.walletError.set(false);
    this.api.get<{ data?: { balance_cents?: number } }>('/wallet', undefined, { silent: true }).subscribe({
      next: (r) => {
        const d = r.data ?? (r as { balance_cents?: number });
        this.walletBalanceCents.set(d.balance_cents ?? 0);
        this.walletError.set(false);
      },
      error: () => { this.walletBalanceCents.set(null); this.walletError.set(true); },
    });
  }

  topupWallet(): void {
    if (this.toppingUp()) return;
    const amount = this.topupAmount();
    if (!amount || amount <= 0) { this.toast.error('Enter an amount to top up.'); return; }
    this.toppingUp.set(true);
    this.api.post<{ checkout_url: string }>('/billing/checkout/topup', { amount_cents: Math.round(amount * 100) }).subscribe({
      next: (r) => {
        this.toppingUp.set(false);
        const url = (r as unknown as { data?: { checkout_url: string } }).data?.checkout_url ?? (r as { checkout_url?: string }).checkout_url;
        if (this.openStripeUrl(url)) this.topupRedirecting.set(true);
      },
      error: () => { this.toppingUp.set(false); },
    });
  }

  reportSampleUsage(): void {
    if (this.reportingUsage()) return;
    this.reportingUsage.set(true);
    this.api.post<{ event_id: string; meter: string; value: number }>('/billing/usage/report', { meter: 'site_renders', value: 1 }).subscribe({
      next: (r) => {
        this.reportingUsage.set(false);
        const body = (r as unknown as { data?: { event_id: string; meter: string; value: number } }).data ?? (r as { event_id?: string; meter?: string; value?: number });
        this.lastMeterEvent.set({ event_id: body.event_id ?? '', meter: body.meter ?? 'site_renders', value: body.value ?? 1 });
        this.toast.success('Usage event sent.');
      },
      error: () => { this.reportingUsage.set(false); },
    });
  }

  onboardStripeConnect(): void {
    if (this.onboardingConnect()) return;
    this.onboardingConnect.set(true);
    // {silent}: ApiService's generic toast maps a 403 to "You don't have
    // permission" — unhelpful on an UPSELL surface. Surface the server's
    // specific message (or a clear upgrade hint) instead.
    this.api.post<{ onboarding_url: string }>('/agency/stripe-connect/onboard', {}, { silent: true }).subscribe({
      next: (r) => {
        this.onboardingConnect.set(false);
        const url = (r as unknown as { data?: { onboarding_url: string } }).data?.onboarding_url ?? (r as { onboarding_url?: string }).onboarding_url;
        if (this.openStripeUrl(url)) this.connectOnboardingMsg.set('Redirecting to Stripe Connect…');
      },
      error: (err: { error?: { error?: { message?: string } } }) => {
        this.onboardingConnect.set(false);
        const msg = err?.error?.error?.message
          ?? 'Stripe Connect onboarding needs the Agency-tier add-on — upgrade to enable direct payouts.';
        this.toast.error(msg);
      },
    });
  }

  /** Re-fetch the billing tab's data (subscription / upcoming invoice / affiliate payouts).
   * Wired to the per-panel "Retry" affordance so a transient load failure is recoverable
   * in place, without a full-page reload. */
  retryTabData(): void {
    this.loadTabData();
  }

  private loadTabData(): void {
    // A retry (or tab re-entry) clears stale per-panel error flags before re-fetching.
    this.subStatusError.set(false);
    this.invoiceError.set(false);
    this.payoutsError.set(false);
    // Subscription status + entitlements (BILL-03, BILL-04, BILL-12, BILL-13)
    type SubResp = { status?: string; plan?: string; current_period_end?: string; last_webhook?: string; cancel_at?: string; };
    this.api.get<{ data?: SubResp }>('/billing/subscription').subscribe({
      next: (r) => {
        const d = r.data ?? null;
        // A real subscription must carry a status or plan. No row / empty object
        // (free user) → leave subStatus null so the card falls back to planLabel()
        // ('Free') instead of fabricating an uninformative '—' plan.
        const hasSub = !!(d && (d.status || d.plan));
        this.subStatus.set(
          hasSub
            ? {
                status: d!.status ?? 'none',
                plan: d!.plan ?? '—',
                current_period_end: d!.current_period_end,
                last_webhook: d!.last_webhook,
                cancel_at: d!.cancel_at,
              }
            : null,
        );
      },
      error: () => {
        // Don't silently blank the subscription card on a transient failure — flag it so
        // the panel shows a "couldn't load — retry" affordance instead of vanishing.
        this.subStatusError.set(true);
        console.warn(JSON.stringify({ level: 'warn', msg: 'billing.subscription load failed' }));
      },
    });
    this.api
      .get<{ data?: { maxCustomDomains?: number; maxTeamSeats?: number; analyticsEnabled?: boolean } }>(
        '/billing/entitlements',
      )
      .subscribe({
        // The entitlements payload is the resolver's shape (maxCustomDomains /
        // maxTeamSeats / analyticsEnabled), NOT sites/storage/seats — reading the latter
        // pinned every entitlement to 0. Show what the plan actually grants.
        next: (r) => {
          const d = r.data ?? {};
          this.entitlements.set({
            maxCustomDomains: d.maxCustomDomains ?? 0,
            maxTeamSeats: d.maxTeamSeats ?? 0,
            analyticsEnabled: !!d.analyticsEnabled,
          });
        },
        // Don't silently swallow a transient failure — that left the Entitlements panel
        // blank (`@if (entitlements())` renders nothing). Entitlements are a deterministic
        // function of the plan, so derive them from the loaded plan as a safe fallback.
        error: () => {
          const paid = this.plan() === 'paid';
          this.entitlements.set({
            maxCustomDomains: paid ? 10 : 0,
            maxTeamSeats: paid ? 10 : 1,
            analyticsEnabled: paid,
          });
        },
      });

    // Wallet balance (BILL-16)
    this.loadWallet();

    // Upcoming invoice (BILL-09)
    this.api.get<{
      data?: { lines?: Array<{ description: string; quantity?: number; amount_cents: number }>; total_cents?: number; currency?: string };
    }>('/billing/invoices/upcoming').subscribe({
      next: (r) => {
        const d = r.data ?? (r as { lines?: unknown[]; total_cents?: number; currency?: string });
        this.upcomingInvoice.set({
          lines: (d.lines ?? []) as Array<{ description: string; quantity?: number; amount_cents: number }>,
          total_cents: d.total_cents ?? 0,
          currency: d.currency ?? 'usd',
        });
      },
      error: () => {
        this.invoiceError.set(true);
        console.warn(JSON.stringify({ level: 'warn', msg: 'billing.upcoming_invoice load failed' }));
      },
    });

    // Affiliate payouts (BILL-15)
    this.api.get<{ data?: { payouts?: Array<{ affiliate_id: string; amount_cents: number; status: string; created_at?: string }> } }>('/affiliates/payouts').subscribe({
      next: (r) => {
        const d = r.data ?? (r as { payouts?: unknown[] });
        this.affiliatePayouts.set((d.payouts ?? []) as Array<{ affiliate_id: string; amount_cents: number; status: string; created_at?: string }>);
      },
      error: () => {
        // Critical: without this, a failed fetch leaves affiliatePayouts=[] → the template
        // renders "No payouts yet" — a LYING-EMPTY (an error masquerading as "you have none").
        this.payoutsError.set(true);
        console.warn(JSON.stringify({ level: 'warn', msg: 'billing.affiliate_payouts load failed' }));
      },
    });
  }

  /** Clamped percent-of-cap for the meter bar (server can report >100%). */
  forecastCapPct = computed<number>(() => {
    const fv = this.forecastV2();
    if (!fv) return 0;
    return Math.max(0, Math.min(100, fv.percent_of_cap));
  });

  /**
   * SVG path `d` string for the sparkline polyline. Scales to a 320×70
   * viewport with 4px top/bottom padding. Returns `M0,0` when there's no
   * data so Angular doesn't render an invalid path attribute.
   */
  forecastV2Line = computed<string>(() => {
    const fv = this.forecastV2();
    if (!fv || fv.breakdown.length === 0) return 'M0,0';
    return this.buildSparklinePath(fv.breakdown, false);
  });

  /** Same as `forecastV2Line` but closed to the baseline for the fill. */
  forecastV2Area = computed<string>(() => {
    const fv = this.forecastV2();
    if (!fv || fv.breakdown.length === 0) return 'M0,0';
    return this.buildSparklinePath(fv.breakdown, true);
  });

  /**
   * Build the sparkline path from a daily breakdown. When `area` is true,
   * the path closes back to the baseline so the gradient fills correctly.
   *
   * @internal
   */
  private buildSparklinePath(
    pts: ReadonlyArray<{ usd: number }>,
    area: boolean,
  ): string {
    const W = 320;
    const H = 70;
    const PAD = 4;
    const max = Math.max(0.0001, ...pts.map((p) => p.usd));
    const stepX = pts.length > 1 ? (W - PAD * 2) / (pts.length - 1) : 0;
    const coords = pts.map((p, i) => {
      const x = PAD + i * stepX;
      const y = H - PAD - (p.usd / max) * (H - PAD * 2);
      return [x, y] as const;
    });
    const line = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
    if (!area) return line;
    const last = coords[coords.length - 1];
    return `${line} L${last[0].toFixed(2)},${(H - PAD).toFixed(2)} L${PAD.toFixed(2)},${(H - PAD).toFixed(2)} Z`;
  }

  /**
   * Static price for the new 5,000-credit bulk pack. Derived as the
   * cheapest-per-credit rate of the existing tiers (500=$5 / 2000=$15 →
   * implied $0.006/credit at 5k). Kept as a constant rather than fetched
   * from the worker so the UI ships even if the server bundle list lags.
   */
  readonly tier5000Usd = 30;

  /** Per-credit price used by the Custom tier — mirrors the 5,000 bulk rate
   *  so customers never pay more than the cheapest bundled tier. */
  readonly customRate = 0.006;

  /** Custom amount state — null = empty input, 0+ = entered. */
  customAmount = signal<number | null>(null);
  customValid = computed(() => {
    const v = this.customAmount();
    return typeof v === 'number' && Number.isFinite(v) && v >= 100 && v <= 100000;
  });
  customPrice = computed(() => {
    const v = this.customAmount() ?? 0;
    return v * this.customRate;
  });

  /**
   * Render-ready bars for the inline-SVG chart. Heights normalize to the
   * largest category and clamp at 92px so the chart always sits inside the
   * 140-tall viewBox. Colors carry brand semantics.
   *
   * @remarks
   * Defensive reads on `f.by_category` and each numeric sub-field: the worker
   * route `/admin/forecast/cost` can return a partial payload (sometimes
   * `{ current_month_estimate_usd, next_month_forecast_usd }` with NO
   * `by_category` block) on cold accounts. Accessing `cats.workers` on
   * `undefined` threw `Cannot read properties of undefined (reading 'workers')`
   * during render — Angular surfaced this as a blank Billing section because
   * the computed re-runs on every signal change downstream. Any missing piece
   * coerces to 0 via `numOr0()` so the chart degrades gracefully.
   */
  forecastBars = computed<ForecastBar[]>(() => {
    const f = this.forecast();
    if (!f) return [];
    const cats = f.by_category ?? {} as Partial<CostForecastState['by_category']>;
    const numOr0 = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? n : 0);
    const entries: ForecastBar[] = [
      { label: 'workers', usd: numOr0(cats.workers), height: 0, color: '#00E5FF' },
      { label: 'ai',      usd: numOr0(cats.ai),      height: 0, color: '#7C3AED' },
      { label: 'r2',      usd: numOr0(cats.r2),      height: 0, color: '#50AAE3' },
      { label: 'd1',      usd: numOr0(cats.d1),      height: 0, color: '#10b981' },
      { label: 'email',   usd: numOr0(cats.email),   height: 0, color: '#f59e0b' },
    ];
    const peak = Math.max(0.01, ...entries.map((e) => e.usd));
    for (const e of entries) e.height = Math.max(4, Math.min(92, (e.usd / peak) * 92));
    return entries;
  });

  // 14-day spend roll-up from the credits ledger.
  spend14d = computed<{ day: string; spend: number }[]>(() => {
    const ledger = this.credits()?.ledger ?? [];
    const out: Record<string, number> = {};
    const today = new Date();
    for (let i = 13; i >= 0; i--) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      out[d.toISOString().slice(0, 10)] = 0;
    }
    for (const e of ledger) {
      if (e.delta >= 0) continue;
      const day = e.created_at.slice(0, 10);
      if (day in out) out[day]! += -e.delta;
    }
    return Object.entries(out).map(([day, spend]) => ({ day, spend }));
  });
  spend14dTotal = computed(() => this.spend14d().reduce((a, r) => a + r.spend, 0));
  projectedMonth = computed(() => Math.round((this.spend14dTotal() / 14) * 30));
  sparkPoints = computed<{ x: number; y: number }[]>(() => {
    const days = this.spend14d();
    if (!days.length) return [];
    const peak = Math.max(1, ...days.map((d) => d.spend));
    const step = days.length > 1 ? 280 / (days.length - 1) : 0;
    return days.map((d, i) => ({ x: i * step, y: 55 - (d.spend / peak) * 50 }));
  });
  sparkLine = computed(() => this.sparkPoints().map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' '));
  sparkArea = computed(() => {
    const pts = this.sparkPoints(); if (!pts.length) return '';
    const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
    return `${line} L ${pts[pts.length - 1]!.x.toFixed(1)} 60 L ${pts[0]!.x.toFixed(1)} 60 Z`;
  });
  alerts = signal<Alert[]>([]);
  /** True when ANY of the user's sites has an active Slack MCP connection.
   *  Drives the "Notify via Slack" checkbox enabled-state in the alert modal.
   *  Computed via `loadAll()` after fetching per-site mcp/connections. */
  slackConnected = signal<boolean>(false);
  siteCosts = signal<CostRow[]>([]);
  buying = signal<string | null>(null);
  plan = signal<'free' | 'paid'>('free');
  upgrading = signal(false);
  savingCap = signal<string | null>(null);
  loadingCredits = signal(false);
  loadingCosts = signal(false);
  capDraft: Record<string, number | ''> = {};
  planLabel = computed(() => (this.plan() === 'paid' ? 'Pro · $50/mo' : 'Free'));

  /**
   * Honest renew-vs-end label for the period-end date. An active/trialing sub
   * AUTO-RENEWS on that date (so "Period ends" misleads — it renews); a sub with
   * `cancel_at` set will CANCEL then; anything else genuinely ends. Truthful copy.
   */
  periodLabel = computed(() => {
    const s = this.subStatus();
    if (!s) return 'Period ends';
    if (s.cancel_at) return 'Cancels';
    return s.status === 'active' || s.status === 'trialing' ? 'Renews' : 'Period ends';
  });

  /** Locale-aware credit/count formatter (`Intl.NumberFormat`). */
  private readonly numberFormatter = new Intl.NumberFormat(undefined);
  /** USD currency formatter — 2 fraction digits, locale-aware. */
  private readonly usdFormatter = new Intl.NumberFormat(undefined, {
    style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  /** Percentage formatter — 1 fraction digit. */
  private readonly pctFormatter = new Intl.NumberFormat(undefined, {
    style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1,
  });
  /** Relative time formatter for "Last call" column (e.g. "3 hours ago"). */
  private readonly relTimeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

  formatCredits(n: number | null | undefined): string {
    return this.numberFormatter.format(typeof n === 'number' && Number.isFinite(n) ? n : 0);
  }
  formatUsd(n: number | null | undefined): string {
    return this.usdFormatter.format(typeof n === 'number' && Number.isFinite(n) ? n : 0);
  }
  /**
   * Compute this row's share of total org spend across all sites in the
   * current 30-day window. Returns "—" when the denominator is zero so
   * users don't see a misleading "0.0%" on brand-new accounts.
   */
  pctOfOrg(r: CostRow): string {
    const total = this.siteCosts().reduce((a, x) => a + (x.estimated_cost_micro_usd || 0), 0);
    if (total <= 0) return '—';
    return this.pctFormatter.format((r.estimated_cost_micro_usd || 0) / total);
  }
  /**
   * Render the `last_invocation_at` timestamp as a human-friendly relative
   * string ("3 hours ago", "yesterday"). Falls back to an em-dash when the
   * server hasn't populated the field yet.
   */
  formatLastCall(iso: string | null | undefined): string {
    if (!iso) return '—';
    const ts = Date.parse(iso);
    if (!Number.isFinite(ts)) return '—';
    const diffMs = ts - Date.now();
    const diffMin = Math.round(diffMs / 60000);
    const absMin = Math.abs(diffMin);
    if (absMin < 60) return this.relTimeFormatter.format(diffMin, 'minute');
    const diffHr = Math.round(diffMin / 60);
    if (Math.abs(diffHr) < 24) return this.relTimeFormatter.format(diffHr, 'hour');
    const diffDay = Math.round(diffHr / 24);
    if (Math.abs(diffDay) < 30) return this.relTimeFormatter.format(diffDay, 'day');
    const diffMonth = Math.round(diffDay / 30);
    return this.relTimeFormatter.format(diffMonth, 'month');
  }

  /** ─────── Bulk credit-caps modal state ─────── */
  capsModalOpen = signal(false);
  savingCapsBulk = signal(false);
  capsModalError = signal<string | null>(null);
  /** Per-site draft inputs inside the bulk caps modal — keyed by site.id. */
  capsModalDraft: Record<string, number | ''> = {};

  /** ─────── Spend alert modal state ─────── */
  alertModalOpen = signal(false);
  savingAlert = signal(false);
  alertDraft: {
    name: string;
    alert_kind: string;
    threshold_credits: number | null;
    notify_email: string;
    notify_via_email: boolean;
    notify_via_slack: boolean;
  } = {
    // Default threshold = $10,000 — a sensible runaway-spend ceiling out of the
    // box. Field is USD; saveAlert() converts to credits via the $0.04/credit
    // rate. User can override before submit.
    name: '', alert_kind: 'balance_below', threshold_credits: 10000, notify_email: '',
    notify_via_email: true, notify_via_slack: false,
  };

  alertNameLen(): number { return (this.alertDraft.name ?? '').length; }

  /** Inline validators — return null when valid, else a user-safe message. */
  alertNameError(): string | null {
    const raw = (this.alertDraft.name ?? '').trim();
    if (raw.length === 0) return null;
    if (raw.length > 80) return 'Name must be 80 characters or fewer.';
    return null;
  }
  alertThresholdError(): string | null {
    const v = this.alertDraft.threshold_credits;
    if (v === null || v === undefined) return null;
    if (!Number.isFinite(v) || v <= 0) return 'Threshold must be a positive number.';
    // Cap at $100,000 — the default is $10,000 and operators running large
    // workloads need headroom above the previous 10K ceiling.
    if (v > 100000) return 'Threshold must be 100,000 or less.';
    return null;
  }
  alertEmailError(): string | null {
    const raw = (this.alertDraft.notify_email ?? '').trim();
    if (raw.length === 0) return null;
    // SSOT validator — a local regex here caused FE/BE parity drift (see sign-in).
    if (!isValidEmail(raw)) return 'Enter a valid email address.';
    return null;
  }
  canSaveAlert(): boolean {
    const name = (this.alertDraft.name ?? '').trim();
    const email = (this.alertDraft.notify_email ?? '').trim();
    const threshold = this.alertDraft.threshold_credits;
    return (
      name.length > 0 &&
      this.alertNameError() === null &&
      threshold !== null && threshold !== undefined &&
      this.alertThresholdError() === null &&
      email.length > 0 &&
      this.alertEmailError() === null
    );
  }

  openAlertModal(): void {
    // Threshold defaults to $10,000 so the modal always opens with a working
    // number rather than an empty input — most operators want a high
    // runaway-spend ceiling, not a zero-from-scratch decision.
    this.alertDraft = {
      name: '', alert_kind: 'balance_below', threshold_credits: 10000, notify_email: '',
      notify_via_email: true, notify_via_slack: false,
    };
    this.alertModalOpen.set(true);
  }
  closeAlertModal(): void {
    if (this.savingAlert()) return;
    this.alertModalOpen.set(false);
  }

  get bundleKeys(): string[] { return Object.keys(this.credits()?.bundles ?? {}); }
  bundleCredits(key: string): number {
    const v = this.credits()?.bundles?.[key]?.credits;
    return typeof v === 'number' ? v : Number(v) || 0;
  }
  bundleUsd(key: string): number {
    const v = this.credits()?.bundles?.[key]?.usd;
    return typeof v === 'number' ? v : Number(v) || 0;
  }

  ngOnInit(): void {
    // Open the tab named in ?tab= (validated against billingTabs; unknown →
    // default 'subscription') BEFORE loading so the right tab's data loads first.
    const t = this.route.snapshot.queryParamMap.get('tab');
    if (t && this.billingTabs.some((x) => x.id === t)) this.activeTab.set(t);
    this.loadAll();
    this.loadTabData();
  }

  /**
   * Insert a ripple span at the click coordinates and remove it when the
   * animation finishes. Shared by every clickable card on the page so the
   * interaction language stays consistent (Pro card, tier tiles, custom-buy
   * button). Respects prefers-reduced-motion (CSS short-circuits the keyframes
   * and hides the element, so no visible ripple is emitted).
   */
  triggerRipple(event: MouseEvent): void {
    const host = event.currentTarget as HTMLElement | null;
    if (!host) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const rect = host.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const ripple = document.createElement('span');
    ripple.className = 'ripple';
    ripple.style.width = `${size}px`;
    ripple.style.height = `${size}px`;
    ripple.style.left = `${event.clientX - rect.left}px`;
    ripple.style.top = `${event.clientY - rect.top}px`;
    host.appendChild(ripple);
    const cleanup = (): void => { ripple.remove(); };
    ripple.addEventListener('animationend', cleanup, { once: true });
    // Safety net — guarantees cleanup if animationend never fires.
    window.setTimeout(cleanup, 800);
  }

  /**
   * Build a zero-usage CostRow array from the currently-loaded sites in
   * AdminStateService. Used when /billing/site-costs returns [] (cold
   * account or pre-usage state) OR errors out — keeps the per-site cost
   * table populated with the operator's real site list rather than
   * collapsing to an empty state. Plan is read from `site.plan` when the
   * API has it; otherwise we default to 'free'.
   */
  private zeroFillFromSites(): CostRow[] {
    return this.state.sites().map((site) => ({
      site_id: site.id,
      slug: site.slug,
      business_name: site.business_name ?? null,
      ai_calls: 0,
      ai_credits: 0,
      estimated_cost_micro_usd: 0,
      bandwidth_bytes: 0,
      storage_bytes: 0,
      plan: site.plan ?? 'free',
      last_invocation_at: null,
    }));
  }

  loadAll(): void {
    this.loadingCredits.set(true);
    this.loadingCosts.set(true);
    this.api.get<{ data: CreditState }>('/billing/credits').subscribe({
      next: (r) => { this.credits.set(r.data); this.loadingCredits.set(false); },
      error: () => { this.loadingCredits.set(false); /* api.service already toasted */ },
    });
    this.api.get<{ data: Alert[] }>('/billing/spend-alerts').subscribe({
      // Guard against a non-array payload — `?? []` keeps a truthy `{}`, which
      // then crashes the @for with "not iterable". Array.isArray is the real fix.
      next: (r) => this.alerts.set(Array.isArray(r.data) ? r.data : []),
      error: () => { /* api.service already toasted */ },
    });
    // Slack-connection probe: walks the user's sites and asks each one for
    // its mcp connections list. First site that reports a `slack` provider
    // flips the checkbox to enabled. We bail after the first match to keep
    // network noise low. Site list comes from AdminStateService which the
    // dashboard shell hydrates before this section ever mounts.
    this.refreshSlackConnected();
    this.api.get<{ data: { rows: CostRow[] } }>('/billing/site-costs').subscribe({
      next: (r) => {
        const rows = r.data?.rows ?? [];
        // Zero-fill fallback: when the worker returns an empty rows
        // array (cold account, usage table not yet populated, or the
        // /billing/site-costs route returns 200 with [] before any AI calls
        // have been recorded), surface one row per site from AdminStateService
        // with all metrics set to zero so the operator sees their entire site
        // roster instead of an empty-state. Real rows from the worker always
        // win — we only synthesize when the API itself returns nothing.
        const effective = rows.length > 0 ? rows : this.zeroFillFromSites();
        this.siteCosts.set(effective);
        this.loadingCosts.set(false);
        for (const row of effective) {
          this.api.get<{ data: { monthly_credit_cap: number | null } }>(`/sites/${row.site_id}/credit-cap`).subscribe({
            next: (cap) => { this.capDraft[row.site_id] = cap.data?.monthly_credit_cap ?? ''; },
            error: () => { /* api.service already toasted */ },
          });
        }
      },
      error: () => {
        // Error fallback: still surface the user's sites with zero usage so
        // the table never appears empty when the worker is unreachable.
        this.siteCosts.set(this.zeroFillFromSites());
        this.loadingCosts.set(false);
        /* api.service already toasted */
      },
    });
    this.api.get<{ data?: { plan?: string; status?: string } | null }>('/billing/subscription').subscribe({
      // The /billing/subscription payload is FLAT (`{ data: { plan, status } }`) and the
      // paid plan value is 'paid' (matches the D1 CHECK + entitlement resolver), NOT
      // 'pro'. Reading a nested `data.subscription.status` (never present) pinned the
      // header badge + Plan section to "Free" on every paid account.
      //
      // The paid-eligible gate MUST mirror the server SSOT `resolveActiveOrgPlan`
      // (`status IN ('active', 'trialing')`). A prior `status === 'active'` check
      // EXCLUDED trialing → a paying trial user saw the "Free" plan label while the
      // (server-resolved) entitlement chips showed paid grants (10 domains, analytics
      // Included) — a visible lying-UI divergence. `past_due`/`canceled` still → free.
      next: (r) =>
        this.plan.set(
          r.data?.plan === 'paid' && (r.data?.status === 'active' || r.data?.status === 'trialing')
            ? 'paid'
            : 'free',
        ),
      error: () => this.plan.set('free'),
    });
    // Rolling 30-day forecast v2 — separate route, separate UI from the legacy forecast.
    this.loadingForecastV2.set(true);
    this.api.getCostForecast(30).subscribe({
      next: (r) => {
        this.forecastV2.set(r.data);
        this.loadingForecastV2.set(false);
        // 80% threshold toast — one per session even though the server dedups
        // by (org, period) on its own KV side.
        if (
          !this.forecastWarnedThisSession &&
          r.data.plan_cap_usd &&
          r.data.plan_cap_usd > 0 &&
          r.data.percent_of_cap >= 80 &&
          r.data.percent_of_cap < 100
        ) {
          this.forecastWarnedThisSession = true;
          this.toast.warning(
            `Projected to use ${r.data.percent_of_cap}% of your $${r.data.plan_cap_usd}/mo cap. Review the Forecast card to plan ahead.`,
          );
          this.telemetry.track('billing.forecast_cap_warning', {
            percent_of_cap: r.data.percent_of_cap,
            projected_usd: r.data.projected_usd,
            plan_cap_usd: r.data.plan_cap_usd,
          });
        }
      },
      error: () => {
        this.forecastV2.set(null);
        this.loadingForecastV2.set(false);
      },
    });
    this.forecastLoading.set(true);
    this.api.get<{ data: CostForecastState }>('/admin/forecast/cost').subscribe({
      next: (r) => {
        // Normalize the worker payload BEFORE storing it so downstream computed
        // signals + template `currency` pipes never see `undefined`. Partial
        // JSON from `/admin/forecast/cost` on cold accounts makes the `currency`
        // pipe throw `InvalidPipeArgument` on undefined, blanking the entire
        // Billing section because Angular halts the change-detection cycle.
        this.forecast.set(this.sanitizeForecast(r.data));
        this.forecastLoading.set(false);
      },
      error: () => { this.forecast.set(null); this.forecastLoading.set(false); },
    });
    // Seed local credit-cap drafts BEFORE the per-site GETs land so the user
    // sees their previously-typed (but worker-failed) caps immediately.
    try {
      const localCaps = JSON.parse(localStorage.getItem(LOCAL_CAPS_KEY) ?? '{}') as Record<string, number | null>;
      for (const [siteId, val] of Object.entries(localCaps)) {
        if (this.capDraft[siteId] == null || this.capDraft[siteId] === '') {
          this.capDraft[siteId] = val == null ? '' : val;
        }
      }
    } catch { /* malformed cache — ignore */ }
  }

  /**
   * Coerce the worker's forecast payload into a fully-populated
   * {@link CostForecastState}, replacing any missing numeric field with 0
   * and any missing string with a sensible default. Prevents `currency`
   * pipe crashes when the route ships a partial body.
   */
  private sanitizeForecast(raw: unknown): CostForecastState | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Partial<CostForecastState>;
    const numOr0 = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? n : 0);
    const cats = (r.by_category ?? {}) as Partial<CostForecastState['by_category']>;
    return {
      current_month_estimate_usd: numOr0(r.current_month_estimate_usd),
      next_month_forecast_usd:    numOr0(r.next_month_forecast_usd),
      by_category: {
        workers: numOr0(cats.workers),
        ai:      numOr0(cats.ai),
        r2:      numOr0(cats.r2),
        d1:      numOr0(cats.d1),
        email:   numOr0(cats.email),
      },
      biggest_driver: typeof r.biggest_driver === 'string' && r.biggest_driver ? r.biggest_driver : '—',
      savings_tip:    typeof r.savings_tip    === 'string' && r.savings_tip    ? r.savings_tip    : 'Forecast unavailable yet — check back after 24 hours of usage.',
    };
  }

  /**
   * Open the Stripe checkout flow in a NEW TAB so the admin context is
   * preserved (the user can keep tweaking caps / alerts while checkout
   * loads). Falls back to a same-tab redirect if the popup is blocked.
   */
  upgrade(): void {
    if (this.upgrading()) return;
    this.upgrading.set(true);
    this.telemetry.track('billing.upgrade_clicked', { plan: 'pro' });
    // The checkout endpoint REQUIRES success_url + cancel_url (createCheckoutSessionSchema
    // in @project-sites/shared). Posting only { plan: 'pro' } fails Zod validation → 400
    // ("Could not start checkout"), so "Upgrade to Pro" was dead for every user. Send Stripe
    // the return URLs (origin works on prod + localhost); the webhook — not the return URL —
    // actually flips the plan to paid.
    const origin = window.location.origin;
    // {silent}: the error callback shows its own specific checkout message —
    // suppress the generic ApiService toast so a failure shows ONE, not two.
    this.api.post<{ data: { checkout_url?: string } }>('/billing/checkout', { success_url: `${origin}/admin/billing?checkout=success`, cancel_url: `${origin}/admin/billing?checkout=cancel` }, { silent: true }).subscribe({
      next: (r) => {
        this.upgrading.set(false);
        // Handler returns { data: { checkout_url } } (matches topup/addons); reading the
        // old r.data?.url key left url undefined → the "Checkout opened" toast fired but
        // the Stripe page never opened.
        const url = r.data?.checkout_url;
        if (url) {
          // Validated new-tab open with a same-tab fallback when the popup is blocked.
          this.openStripeUrl(url);
        } else {
          this.toast.info('Checkout opened');
        }
      },
      error: () => { this.upgrading.set(false); this.toast.error('Could not start checkout — retry, or contact hey@megabyte.space'); },
    });
  }
  manage(): void {
    // Handler returns { data: { portal_url } } — reading the old r.data?.url key always
    // missed it → "Portal opened" toast but no redirect. Also return the user to the
    // billing tab (not the marketing-homepage default) after the portal.
    const origin = window.location.origin;
    this.api.post<{ data: { portal_url?: string } }>('/billing/portal', { return_url: `${origin}/admin/billing` }).subscribe({
      next: (r) => {
        const safe = this.safeStripeUrl(r.data?.portal_url);
        if (safe) window.location.href = safe;
        else if (r.data?.portal_url) this.toast.error('That billing-portal link looked invalid — please retry.');
        else this.toast.info('Portal opened');
      },
      error: () => { /* api.service already toasted */ },
    });
  }
  saveCap(siteId: string): void {
    this.savingCap.set(siteId);
    const raw = this.capDraft[siteId];
    const cap = raw === '' || raw == null ? null : Math.max(0, Number(raw));
    this.api.put(`/sites/${siteId}/credit-cap`, { monthly_credit_cap: cap }).subscribe({
      next: () => { this.savingCap.set(null); this.toast.success(cap == null ? 'Cap removed' : `Saved — cap set to ${this.formatCredits(cap)} credits/mo`); },
      error: () => { this.savingCap.set(null); /* api.service already toasted */ },
    });
  }
  topup(bundle: string): void {
    // Double-submit guard (money-moving): a rapid second click before Angular
    // re-renders `[disabled]="buying() === key"` would otherwise open a SECOND
    // Stripe checkout session (or, in the non-stripe `mode`, double-grant
    // credits). Early-return on the busy signal — never trust the [disabled]
    // attribute alone. Mirrors topupCustom()'s guard. Cleared in next/error so a
    // failed attempt stays retryable.
    if (this.buying()) return;
    this.buying.set(bundle);
    const credits = this.bundleCredits(bundle);
    const usd = this.bundleUsd(bundle);
    this.api.post<{ data: { mode: string; url?: string; balance?: number } }>('/billing/credits/topup', { bundle }).subscribe({
      next: (r) => {
        this.buying.set(null);
        const url = r.data?.url;
        if (r.data?.mode === 'stripe' && url) {
          this.openStripeUrl(url);
        } else {
          this.toast.success(`Credits added — balance ${this.formatCredits(r.data?.balance ?? 0)}`);
          // Fires GA4 `purchase` via the conversion alias in TelemetryService.
          this.telemetry.track('billing.tier_purchased', {
            bundle, credits, value: usd, currency: 'USD',
          });
          this.loadAll();
        }
      },
      error: () => { this.buying.set(null); /* api.service already toasted */ },
    });
  }
  /**
   * Custom-amount top-up. Pipes the validated amount through the same
   * `/billing/credits/topup` endpoint with a `custom` bundle key + the
   * `credits` count; the worker is expected to compute price using the
   * same per-credit rate displayed in the UI. If the worker doesn't yet
   * accept `custom`, the API error toast surfaces the gap to the user.
   */
  topupCustom(): void {
    if (!this.customValid() || this.buying() === 'custom') return;
    const credits = this.customAmount()!;
    const usd = this.customPrice();
    this.buying.set('custom');
    this.api.post<{ data: { mode: string; url?: string; balance?: number } }>('/billing/credits/topup', { bundle: 'custom', credits }).subscribe({
      next: (r) => {
        this.buying.set(null);
        const url = r.data?.url;
        if (r.data?.mode === 'stripe' && url) {
          this.openStripeUrl(url);
        } else {
          this.toast.success(`Credits added — balance ${this.formatCredits(r.data?.balance ?? 0)}`);
          // Fires GA4 `purchase` via the conversion alias in TelemetryService.
          this.telemetry.track('billing.tier_purchased', {
            bundle: 'custom', credits, value: usd, currency: 'USD',
          });
          this.customAmount.set(null);
          this.loadAll();
        }
      },
      error: () => { this.buying.set(null); /* api.service already toasted */ },
    });
  }

  /**
   * Persist the spend alert. Translates the modal's USD threshold input
   * into the credit-based threshold the worker stores (1 credit = $0.04
   * matches the rate shown in the per-site breakdown header). Posts to the
   * live `POST /api/billing/spend-alerts` worker route; errors surface via
   * the shared api.service toast.
   */
  saveAlert(): void {
    if (!this.canSaveAlert() || this.savingAlert()) return;
    this.savingAlert.set(true);
    const usdThreshold = this.alertDraft.threshold_credits ?? 0;
    const creditsThreshold = Math.max(1, Math.round(usdThreshold / 0.04));
    // Align to the worker createSpendAlertSchema: { trigger (enum) + email + channels[] }.
    // The select values ARE the worker enum (balance_below / rate_spike); the notify
    // toggles build the channels array (never empty — the schema requires min 1).
    const channels: ('email' | 'slack')[] = [];
    if (this.alertDraft.notify_via_email) channels.push('email');
    if (this.alertDraft.notify_via_slack) channels.push('slack');
    if (channels.length === 0) channels.push('email');
    const payload = {
      name: this.alertDraft.name.trim(),
      trigger: this.alertDraft.alert_kind,
      threshold_credits: creditsThreshold,
      email: this.alertDraft.notify_email.trim(),
      channels,
    };
    this.api.post('/billing/spend-alerts', payload).subscribe({
      next: () => {
        this.savingAlert.set(false);
        this.toast.success('Saved — alert created');
        this.telemetry.track('billing.alert_created', {
          alert_kind: this.alertDraft.alert_kind,
          threshold_credits: creditsThreshold,
          via_email: this.alertDraft.notify_via_email,
          via_slack: this.alertDraft.notify_via_slack,
        });
        this.alertModalOpen.set(false);
        this.loadAll();
      },
      error: () => {
        this.savingAlert.set(false);
        /* api.service already toasted the error */
      },
    });
  }

  /**
   * Probe the user's sites for a connected Slack MCP. Stops at the first
   * positive hit to keep network noise low. Silently treats every error as
   * "not connected" so a transient 5xx never blocks the alert modal.
   */
  private refreshSlackConnected(): void {
    const sites = this.state.sites();
    if (!sites || sites.length === 0) {
      this.slackConnected.set(false);
      return;
    }
    let answered = 0;
    let found = false;
    const finalize = (): void => {
      answered += 1;
      if (found) this.slackConnected.set(true);
      else if (answered === sites.length) this.slackConnected.set(false);
    };
    for (const s of sites) {
      this.api
        .get<{ data: McpConnectionLite[] | { connections?: McpConnectionLite[] } }>(`/sites/${s.id}/mcp/connections`)
        .subscribe({
          next: (r) => {
            // The worker returns `{ data: { providers, connections } }` — an
            // object, NOT an array. `?? []` only guards null/undefined, so a
            // truthy object slipped through and crashed `.some` (taking the
            // whole Billing section down via the error boundary). Read the
            // `connections` array; tolerate a bare-array shape too.
            const d = r?.data as unknown;
            const list: McpConnectionLite[] = Array.isArray(d)
              ? d
              : ((d as { connections?: McpConnectionLite[] })?.connections ?? []);
            if (list.some((c) => c.provider === 'slack')) {
              found = true;
              this.slackConnected.set(true);
            }
            finalize();
          },
          error: () => finalize(),
        });
    }
  }
  async removeAlert(a: Alert): Promise<void> {
    const ok = await this.confirmSvc.confirm({
      title: 'Remove spend alert',
      message: `Remove the "${a.name}" alert? You'll stop being notified at ${this.formatCredits(a.threshold_credits)} credits — a spend threshold could be crossed without warning.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    this.api.delete(`/billing/spend-alerts/${a.id}`).subscribe({
      next: () => { this.toast.success('Alert removed — no more notifications for this threshold'); this.loadAll(); },
      error: () => { /* api.service already toasted */ },
    });
  }
  bytes(n: number): string { if (n < 1024) return `${n} B`; if (n < 1024 * 1024) return `${(n/1024).toFixed(1)} KB`; if (n < Math.pow(1024, 3)) return `${(n/Math.pow(1024,2)).toFixed(1)} MB`; return `${(n/Math.pow(1024,3)).toFixed(2)} GB`; }

  /**
   * Open the bulk credit-caps modal. Seeds the per-site draft inputs from
   * (a) any already-loaded cap on `capDraft` (set by `loadAll`), then
   * (b) any locally-stashed draft under `ps_billing_caps_local`. The user's
   * most recent intent wins.
   */
  openCapsModal(): void {
    this.capsModalError.set(null);
    this.capsModalDraft = {};
    let localCaps: Record<string, number | null> = {};
    try { localCaps = JSON.parse(localStorage.getItem(LOCAL_CAPS_KEY) ?? '{}') as Record<string, number | null>; } catch { /* malformed */ }
    for (const s of this.state.sites()) {
      const live = this.capDraft[s.id];
      if (live !== undefined && live !== '') {
        this.capsModalDraft[s.id] = live as number | '';
      } else if (localCaps[s.id] != null) {
        this.capsModalDraft[s.id] = localCaps[s.id] as number;
      } else {
        this.capsModalDraft[s.id] = '';
      }
    }
    this.capsModalOpen.set(true);
  }

  closeCapsModal(): void {
    if (this.savingCapsBulk()) return;
    this.capsModalOpen.set(false);
    this.capsModalError.set(null);
  }

  /**
   * Persist the bulk caps. Issues one PUT `/sites/:id/credit-cap` per
   * dirty row in parallel (existing per-site worker route — see
   * src/routes/ai_admin.ts:1628). Any row that fails the API call is
   * stashed under `LOCAL_CAPS_KEY` so the user's intent survives until
   * a future deploy of the bulk endpoint catches up. Refresh runs
   * after every batch so the caps table updates in real time without
   * a page reload. On full success: modal closes + toast.success. On
   * any failure: modal stays open + inline aria-live error + toast.info
   * documenting the local fallback.
   */
  saveBulkCaps(): void {
    if (this.savingCapsBulk()) return;
    const sites = this.state.sites();
    if (sites.length === 0) {
      this.toast.info('Create a project first to set credit caps');
      return;
    }
    // Validate every draft is non-negative finite or empty.
    for (const s of sites) {
      const v = this.capsModalDraft[s.id];
      if (v !== '' && v != null) {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) {
          this.capsModalError.set(`Cap for "${s.business_name || s.slug}" must be a non-negative number.`);
          return;
        }
      }
    }
    this.capsModalError.set(null);
    this.savingCapsBulk.set(true);
    const failed: Record<string, number | null> = {};
    let answered = 0;
    let allOk = true;
    const finalize = (): void => {
      answered += 1;
      if (answered < sites.length) return;
      this.savingCapsBulk.set(false);
      // Stash failed rows locally so the user doesn't lose their work even
      // if the worker is partially down. Successful rows clear from local.
      try {
        const prior = JSON.parse(localStorage.getItem(LOCAL_CAPS_KEY) ?? '{}') as Record<string, number | null>;
        for (const s of sites) {
          if (s.id in failed) prior[s.id] = failed[s.id]!;
          else delete prior[s.id];
        }
        localStorage.setItem(LOCAL_CAPS_KEY, JSON.stringify(prior));
      } catch { /* private mode / quota — ignore */ }

      if (allOk) {
        this.toast.success('Saved — credit caps updated');
        this.capsModalOpen.set(false);
        this.telemetry.track('billing.caps_saved_bulk', { count: sites.length });
      } else {
        const failedCount = Object.keys(failed).length;
        this.capsModalError.set(`${failedCount} project${failedCount === 1 ? '' : 's'} could not save — kept locally and will retry on next visit.`);
        this.toast.info('Credit caps API partially saved — drafts kept locally');
      }
      // Refresh the live caps table regardless so successful rows surface
      // immediately without a page reload (req: real-time refresh).
      this.loadAll();
    };
    for (const s of sites) {
      const raw = this.capsModalDraft[s.id];
      const cap: number | null = raw === '' || raw == null ? null : Math.max(0, Number(raw));
      this.api.put(`/sites/${s.id}/credit-cap`, { monthly_credit_cap: cap }).subscribe({
        next: () => {
          // Mirror the saved value into the inline capDraft so the table
          // shows the new cap without waiting for the next loadAll() to fire.
          this.capDraft[s.id] = cap == null ? '' : cap;
          finalize();
        },
        error: () => {
          allOk = false;
          failed[s.id] = cap;
          finalize();
        },
      });
    }
  }
}
