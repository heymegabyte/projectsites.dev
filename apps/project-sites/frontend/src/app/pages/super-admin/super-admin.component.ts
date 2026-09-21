import {
  Component,
  ChangeDetectionStrategy,
  HostListener,
  OnInit,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../services/api.service';
import { ToastService } from '../../services/toast.service';
import { AdminStateService } from '../admin/admin-state.service';
import { RollingCounterComponent } from '../../components/rolling-counter/rolling-counter.component';
import { RevealDirective } from '../../directives/reveal.directive';

/**
 * Cost category row — single source of truth for every billable action.
 * `markup_factor` is what the super-admin tunes; the worker uses it on every
 * `wallet.chargeWallet({category, quantity, base_cost_cents})` call to debit
 * `base_cost_cents * quantity * markup_factor` from the user's wallet.
 */
interface CostCategory {
  slug: string;
  label: string;
  unit: string;
  base_cost_cents: number;
  markup_factor: number;
  min_charge_cents: number;
  billable: number;
  description: string | null;
  updated_by: string | null;
  updated_at: string;
}

interface OrgWalletRow {
  org_id: string;
  org_name: string;
  balance_cents: number;
  subscription_status: string;
  last_topup_at: string | null;
  // Optional — the /super-admin/wallets endpoint doesn't currently SELECT this;
  // formatCents renders it as $0.00 (honest for empty wallets). Worker follow-up:
  // add a 30d-debit SUM subquery so it shows real spend for active wallets.
  total_charged_30d_cents?: number;
}

interface SuperAdminStats {
  orgs_total: number;
  active_subscriptions: number;
  monthly_revenue_cents: number;
  spend_30d_cents: number;
  topups_today_cents: number;
  margin_30d_cents: number;
}

/**
 * The RAW shape `GET /api/super-admin/stats` actually returns — NESTED totals +
 * per-category + daily rows. The stats tiles read the FLAT {@link SuperAdminStats};
 * `loadStats` maps + derives between the two. (Before the 2026-08-02 fix the
 * component stored this object directly, so every flat `s.*` read was undefined →
 * `<app-rolling-counter [value]="undefined">` threw → the whole section crashed.)
 */
interface WorkerStatsResponse {
  totals?: {
    total_orgs?: number;
    active_subs?: number;
    total_balance_cents?: number;
    monthly_revenue_cents?: number;
    topups_today?: number;
  };
  by_category?: Array<{ gross_charged_cents?: number; net_margin_cents?: number }>;
  daily?: Array<{ day?: string; topup_credits_cents?: number }>;
}

/** `GET /api/super-admin/credits` — provider balance/quota rollup (DeepSeek etc.). */
interface CreditProvider {
  id: string;
  label: string;
  category: string;
  kind: 'balance' | 'quota' | 'availability' | 'console';
  configured: boolean;
  status: 'healthy' | 'low' | 'depleted' | 'unknown' | 'unconfigured';
  balanceUsd: number | null;
  currency: string | null;
  quota: { used: number; limit: number; unit: string } | null;
  detail: string;
  topUpUrl: string;
}
interface CreditsResponse {
  providers: CreditProvider[];
  checkedAt: number;
  summary: { healthy: number; low: number; depleted: number; unknown: number; unconfigured: number };
  cached: boolean;
}

/** `GET /api/super-admin/fleet-health` — site status rollup + recent build errors. */
interface FleetErrorRow {
  slug: string;
  business_name: string;
  updated_at: string;
}
interface FleetHealthResponse {
  byStatus: Array<{ status: string; n: number }>;
  total: number;
  recentErrors: FleetErrorRow[];
  successRate7d: number | null;
}

/** `GET /api/super-admin/growth` — 24h/7d/30d deltas. -1 = that query failed. */
interface GrowthBucket {
  d1: number;
  d7: number;
  d30: number;
}
interface GrowthResponse {
  orgs: GrowthBucket;
  users: GrowthBucket;
  sitesPublished: GrowthBucket;
  sitesCreated: GrowthBucket;
}

/** `GET /api/super-admin/deliverability` — SES suppression backlog. */
interface DeliverabilityResponse {
  suppressionCount: number | null;
  recent: Array<Record<string, unknown>>;
  error?: string;
}

/**
 * `/super-admin` — single-page surface for tuning the cost × markup_factor
 * model that drives every wallet debit. Gated server-side on
 * `users.is_super_admin = 1`; non-super-admin requests get a 403.
 *
 * Sections:
 *  - Stats hero (6 rolling-counter tiles)
 *  - Cost categories table (inline-editable `markup_factor` per row)
 *  - Org wallets list (search + status + last-topup)
 *  - Recent transactions feed (last 100 org-wide)
 *
 * Pairs with worker routes in `apps/project-sites/src/routes/super_admin.ts`.
 */
/** One row of the platform-wide Site Operations list (GET /api/super-admin/ops/sites). */
interface OpsSiteRow {
  id: string;
  slug: string;
  business_name: string;
  status: string;
  org_name: string | null;
  created_at: string;
}

/** One row of the platform-wide account list (GET /api/super-admin/ops/users). Never carries secrets. */
interface OpsUserRow {
  id: string;
  email: string;
  display_name: string | null;
  is_super_admin: number;
  created_at: string;
  updated_at: string;
}

/** Site-360 drawer payload (GET /api/super-admin/ops/sites/:id). */
interface SiteDetail {
  site: {
    id: string;
    slug: string;
    business_name: string;
    business_address: string | null;
    business_phone: string | null;
    business_email: string | null;
    business_category: string | null;
    status: string;
    org_id: string;
    org_name: string | null;
    current_build_version: string | null;
    budget_tier: string | null;
    created_at: string;
    updated_at: string;
  };
  owner: { email: string; display_name: string | null } | null;
}

/** Account-360 drawer payload (GET /api/super-admin/ops/users/:id). */
interface UserDetail {
  user: {
    id: string;
    email: string;
    display_name: string | null;
    is_super_admin: number;
    created_at: string;
    updated_at: string;
  };
  orgs: ReadonlyArray<{ org_id: string; org_name: string | null; role: string }>;
  sites_count: number;
}

@Component({
  selector: 'app-super-admin',
  standalone: true,
  imports: [FormsModule, RollingCounterComponent, RevealDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="sa-root">
      <header class="sa-head" appReveal>
        <div class="sa-kicker">Operator console</div>
        <h1 class="sa-h1">Super admin</h1>
        <p class="sa-sub">Tune the cost × factor model. Every change writes an audit row.</p>
      </header>

      @if (forbidden()) {
        <div class="sa-forbidden" appReveal>
          <div class="sa-forbidden-glyph">⛔</div>
          <h2>Restricted</h2>
          <p>This surface requires <code>users.is_super_admin = 1</code>.</p>
        </div>
      } @else {
        <!-- 6 KPI tiles -->
        <section class="sa-stats" appReveal>
          @if (stats(); as s) {
            <div class="sa-tile">
              <div class="sa-tile-k">Orgs</div>
              <div class="sa-tile-v"><app-rolling-counter [value]="s.orgs_total" /></div>
            </div>
            <div class="sa-tile">
              <div class="sa-tile-k">Active subs</div>
              <div class="sa-tile-v"><app-rolling-counter [value]="s.active_subscriptions" /></div>
            </div>
            <div class="sa-tile">
              <div class="sa-tile-k">Monthly revenue</div>
              <div class="sa-tile-v">
                <span class="sa-cur">$</span>
                <app-rolling-counter [value]="s.monthly_revenue_cents / 100" [decimals]="0" />
              </div>
            </div>
            <div class="sa-tile">
              <div class="sa-tile-k">Spend 30d</div>
              <div class="sa-tile-v">
                <span class="sa-cur">$</span>
                <app-rolling-counter [value]="s.spend_30d_cents / 100" [decimals]="0" />
              </div>
            </div>
            <div class="sa-tile">
              <div class="sa-tile-k">Topups today</div>
              <div class="sa-tile-v">
                <span class="sa-cur">$</span>
                <app-rolling-counter [value]="s.topups_today_cents / 100" [decimals]="0" />
              </div>
            </div>
            <div class="sa-tile sa-tile-accent">
              <div class="sa-tile-k">Margin 30d</div>
              <div class="sa-tile-v">
                <span class="sa-cur">$</span>
                <app-rolling-counter [value]="s.margin_30d_cents / 100" [decimals]="0" />
              </div>
            </div>
          }
        </section>

        <!-- Cost categories table -->
        <section class="sa-card" appReveal>
          <header class="sa-card-head">
            <h2>Cost categories</h2>
            <p>Inline-edit <code>markup_factor</code> per row. Saved on blur or Enter.</p>
          </header>
          <table class="sa-tbl">
            <thead>
              <tr>
                <th>Slug</th>
                <th>Label</th>
                <th>Unit</th>
                <th class="num">Base cost</th>
                <th class="num">× Factor</th>
                <th class="num">Effective</th>
                <th class="num">Min</th>
                <th>Billable</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              @for (c of categories(); track c.slug) {
                <tr class="sa-row" [class.sa-row-edited]="dirty().has(c.slug)">
                  <td><code class="sa-mono">{{ c.slug }}</code></td>
                  <td>{{ c.label }}</td>
                  <td class="muted">{{ c.unit }}</td>
                  <td class="num">{{ formatCents(c.base_cost_cents) }}</td>
                  <td class="num">
                    <input
                      type="number"
                      class="sa-factor-input"
                      [(ngModel)]="c.markup_factor"
                      (blur)="saveFactor(c)"
                      (keydown.enter)="saveFactor(c); $event.preventDefault()"
                      (ngModelChange)="markDirty(c.slug)"
                      step="0.05"
                      min="0.5"
                      max="10"
                      [attr.aria-label]="'Markup factor for ' + c.label"
                    />
                  </td>
                  <td class="num cyan">{{ formatCents(Math.round(c.base_cost_cents * c.markup_factor)) }}</td>
                  <td class="num muted">{{ formatCents(c.min_charge_cents) }}</td>
                  <td>
                    <button
                      type="button"
                      class="sa-toggle"
                      [class.is-on]="c.billable === 1"
                      (click)="toggleBillable(c)"
                      [attr.aria-pressed]="c.billable === 1"
                      [attr.aria-label]="(c.billable === 1 ? 'Disable' : 'Enable') + ' billing for ' + c.label"
                    >{{ c.billable === 1 ? 'on' : 'off' }}</button>
                  </td>
                  <td class="muted small">{{ formatRelative(c.updated_at) }}</td>
                </tr>
              }
              @if (categories().length === 0 && !categoriesLoading()) {
                <tr><td colspan="9" class="muted center">No cost categories seeded yet.</td></tr>
              }
            </tbody>
          </table>
        </section>

        <!-- Wallets -->
        <section class="sa-card" appReveal>
          <header class="sa-card-head">
            <h2>Wallets</h2>
            <input
              type="search"
              class="sa-search"
              placeholder="Search by org name or email…"
              [(ngModel)]="walletsQuery"
              (ngModelChange)="onWalletsQueryChange()"
              aria-label="Search wallets"
            />
          </header>
          <table class="sa-tbl">
            <thead>
              <tr>
                <th>Org</th>
                <th>Balance</th>
                <th>Subscription</th>
                <th>Last top-up</th>
                <th class="num">Spend 30d</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              @for (w of wallets(); track w.org_id) {
                <tr>
                  <td>{{ w.org_name }}</td>
                  <td class="num cyan">{{ formatCents(w.balance_cents) }}</td>
                  <td>
                    <span class="sa-pill" [attr.data-status]="w.subscription_status">{{ w.subscription_status }}</span>
                  </td>
                  <td class="muted small">{{ w.last_topup_at ? formatRelative(w.last_topup_at) : '—' }}</td>
                  <td class="num muted">{{ formatCents(w.total_charged_30d_cents) }}</td>
                  <td>
                    <button type="button" class="sa-btn-ghost" (click)="openAdjust(w)">Adjust</button>
                  </td>
                </tr>
              }
              @if (wallets().length === 0) {
                <tr><td colspan="6" class="muted center">No wallets match.</td></tr>
              }
            </tbody>
          </table>
        </section>

        <!-- Ops console: 4 read-only monitoring widgets -->
        <section class="sa-ops-grid">
          <!-- 1. Cloudflare Unified Billing — the SOLE AI-spend rail (EPIC B). Only the CF UB
               balance is listed; per-provider balances (DeepSeek/OpenAI/Anthropic/etc.) are
               filtered out because all AI now routes through Cloudflare AI Gateway Unified Billing. -->
          <div class="sa-card sa-ops-card" data-testid="sa-credits" appReveal>
            <header class="sa-card-head">
              <h2>Cloudflare Unified Billing</h2>
              @if (credits(); as c) {
                <p class="sa-ops-summary" data-testid="sa-credits-summary">{{ ubSummary(c.providers) }}</p>
              }
            </header>
            @if (creditsLoading()) {
              <p class="muted small sa-ops-msg">Loading…</p>
            } @else if (creditsError()) {
              <p class="sa-ops-err small" role="alert">Couldn't load: {{ creditsError() }}</p>
            } @else if (credits(); as c) {
              @if (ubProviders(c.providers).length === 0) {
                <p class="muted small sa-ops-msg" data-testid="sa-credits-ub-missing">Cloudflare Unified Billing not configured yet.</p>
              } @else {
                <ul class="sa-ops-list">
                  @for (p of ubProviders(c.providers); track p.id) {
                    <li class="sa-cred-row" [attr.data-testid]="'sa-credits-' + p.id">
                      <span class="sa-dot" [attr.data-status]="p.status"
                            [attr.aria-label]="'Status: ' + p.status"></span>
                      <div class="sa-cred-body">
                        <div class="sa-cred-top">
                          <span class="sa-cred-label">{{ p.label }}</span>
                          <a class="sa-cred-topup" [href]="p.topUpUrl" target="_blank"
                             rel="noopener" [attr.aria-label]="'Top up ' + p.label">Top up ↗</a>
                        </div>
                        <div class="sa-cred-detail muted small">{{ p.detail }}</div>
                      </div>
                    </li>
                  }
                </ul>
              }
            }
          </div>

          <!-- 2. Fleet Health -->
          <div class="sa-card sa-ops-card" data-testid="sa-fleet" appReveal>
            <header class="sa-card-head">
              <h2>Fleet Health</h2>
              @if (fleet(); as f) {
                <p class="sa-ops-summary">
                  @if (f.successRate7d !== null) {
                    <span class="cyan">{{ f.successRate7d }}%</span> build success · 7d
                  } @else {
                    <span class="muted">Success rate n/a</span>
                  }
                </p>
              }
            </header>
            @if (fleetLoading()) {
              <p class="muted small sa-ops-msg">Loading…</p>
            } @else if (fleetError()) {
              <p class="sa-ops-err small" role="alert">Couldn't load: {{ fleetError() }}</p>
            } @else if (fleet(); as f) {
              <div class="sa-chips" data-testid="sa-fleet-chips">
                @for (s of f.byStatus; track s.status) {
                  <span class="sa-chip" [attr.data-status]="s.status">
                    {{ s.status }} <b>{{ s.n }}</b>
                  </span>
                }
                @if (f.byStatus.length === 0) {
                  <span class="muted small">No sites yet.</span>
                }
              </div>
              @if (f.recentErrors.length > 0) {
                <div class="sa-fleet-errs" data-testid="sa-fleet-errors">
                  <div class="sa-ops-subhead">Recent build errors</div>
                  <ul class="sa-ops-list">
                    @for (e of f.recentErrors; track e.slug) {
                      <li class="sa-err-row">
                        <a class="sa-err-link" [href]="'https://' + e.slug + '.projectsites.dev'"
                           target="_blank" rel="noopener">{{ e.business_name || e.slug }}</a>
                        <span class="sa-err-slug muted small">{{ e.slug }}</span>
                      </li>
                    }
                  </ul>
                </div>
              } @else {
                <p class="sa-ops-ok small" data-testid="sa-fleet-noerrors">✓ No build errors</p>
              }
            }
          </div>

          <!-- 3. Growth Pulse -->
          <div class="sa-card sa-ops-card" data-testid="sa-growth" appReveal>
            <header class="sa-card-head">
              <h2>Growth Pulse</h2>
              <p>New orgs, users &amp; sites over time.</p>
            </header>
            @if (growthLoading()) {
              <p class="muted small sa-ops-msg">Loading…</p>
            } @else if (growthError()) {
              <p class="sa-ops-err small" role="alert">Couldn't load: {{ growthError() }}</p>
            } @else if (growth(); as g) {
              <table class="sa-growth-tbl">
                <thead>
                  <tr><th></th><th class="num">24h</th><th class="num">7d</th><th class="num">30d</th></tr>
                </thead>
                <tbody>
                  @for (row of growthRows(g); track row.label) {
                    <tr [attr.data-testid]="'sa-growth-' + row.key">
                      <td class="sa-growth-lbl">{{ row.label }}</td>
                      <td class="num cyan">{{ growthCell(row.d1) }}</td>
                      <td class="num">{{ growthCell(row.d7) }}</td>
                      <td class="num">{{ growthCell(row.d30) }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            }
          </div>

          <!-- 4. Email Deliverability -->
          <div class="sa-card sa-ops-card" data-testid="sa-deliverability" appReveal>
            <header class="sa-card-head">
              <h2>Email Deliverability</h2>
              <p>SES suppression backlog.</p>
            </header>
            @if (deliverLoading()) {
              <p class="muted small sa-ops-msg">Loading…</p>
            } @else if (deliverError()) {
              <p class="sa-ops-err small" role="alert">Couldn't load: {{ deliverError() }}</p>
            } @else if (deliver(); as d) {
              @if (d.error) {
                <p class="sa-ops-err small" role="alert">{{ d.error }}</p>
              } @else if (d.suppressionCount === 0) {
                <p class="sa-ops-ok" data-testid="sa-deliverability-clean">✓ Clean — no suppressions</p>
              } @else {
                <div class="sa-big-num" data-testid="sa-deliverability-count">
                  {{ d.suppressionCount ?? '—' }}
                  <span class="sa-big-num-unit">suppressed</span>
                </div>
                @if (d.recent.length > 0) {
                  <ul class="sa-ops-list">
                    @for (r of d.recent; track $index) {
                      <li class="sa-suppress-row muted small">{{ suppressedAddr(r) }}</li>
                    }
                  </ul>
                }
              }
            }
          </div>
        </section>

        <!-- Site Operations — every site across every org, searchable + sortable +
             paginated server-side (scales to 1M). Backed by GET /api/super-admin/ops/sites. -->
        <section class="sa-card" appReveal data-testid="sa-ops-sites">
          <header class="sa-card-head">
            <div>
              <h2>Site operations</h2>
              <p>Every site across the platform — search, sort, open the live site.</p>
            </div>
            <input
              type="search"
              class="sa-search"
              placeholder="Search sites, slugs, owners…"
              [(ngModel)]="opsQuery"
              (ngModelChange)="onOpsQueryChange()"
              aria-label="Search all sites"
              data-testid="sa-ops-search"
            />
          </header>
          <table class="sa-tbl">
            <thead>
              <tr>
                <th>
                  <button type="button" class="sa-sort" (click)="sortOps('business_name')"
                          [attr.aria-sort]="opsAriaSort('business_name')">Business</button>
                </th>
                <th>Slug</th>
                <th>Owner org</th>
                <th>
                  <button type="button" class="sa-sort" (click)="sortOps('status')"
                          [attr.aria-sort]="opsAriaSort('status')">Status</button>
                </th>
                <th>
                  <button type="button" class="sa-sort" (click)="sortOps('created_at')"
                          [attr.aria-sort]="opsAriaSort('created_at')">Created</button>
                </th>
                <th class="num">Open</th>
              </tr>
            </thead>
            <tbody>
              @if (opsLoading()) {
                <tr><td colspan="6" class="muted center">Loading sites…</td></tr>
              } @else if (opsSites().length === 0) {
                <tr><td colspan="6" class="muted center" data-testid="sa-ops-empty">
                  {{ opsQuery.trim() ? 'No sites match your search.' : 'No sites yet.' }}
                </td></tr>
              } @else {
                @for (s of opsSites(); track s.id) {
                  <tr class="sa-row sa-clickable" (click)="openSiteDrawer(s)"
                      (keydown.enter)="openSiteDrawer(s)"
                      (keydown.space)="$event.preventDefault(); openSiteDrawer(s)"
                      tabindex="0" role="button"
                      [attr.aria-label]="'View details for ' + (s.business_name || s.slug)"
                      [attr.data-testid]="'sa-ops-row-' + s.id">
                    <td>{{ s.business_name || '—' }}</td>
                    <td><code class="sa-mono">{{ s.slug }}</code></td>
                    <td class="muted">{{ s.org_name || '—' }}</td>
                    <td><span class="sa-pill" [attr.data-status]="s.status">{{ s.status }}</span></td>
                    <td class="muted small">{{ s.created_at ? s.created_at.slice(0, 10) : '—' }}</td>
                    <td class="num">
                      <a class="sa-btn-ghost sa-ops-open" [href]="opsSiteUrl(s.slug)"
                         (click)="$event.stopPropagation()"
                         target="_blank" rel="noopener noreferrer"
                         [attr.aria-label]="'Open ' + (s.business_name || s.slug) + ' in a new tab'">Open ↗</a>
                    </td>
                  </tr>
                }
              }
            </tbody>
          </table>
          <footer class="sa-ops-foot">
            <span class="muted small" data-testid="sa-ops-total">
              {{ opsTotal() }} site{{ opsTotal() === 1 ? '' : 's' }} · page {{ opsPage() }} of {{ opsPages() }}
            </span>
            <div class="sa-ops-pager">
              <button type="button" class="sa-btn-ghost" (click)="exportSitesCsv()" [disabled]="opsSites().length === 0" data-testid="sa-ops-export" aria-label="Export the sites on this page to CSV">Export CSV</button>
              <button type="button" class="sa-btn-ghost" (click)="opsPrev()" [disabled]="opsPage() <= 1">Prev</button>
              <button type="button" class="sa-btn-ghost" (click)="opsNext()" [disabled]="opsPage() >= opsPages()">Next</button>
            </div>
          </footer>
        </section>

        <!-- Account operations — every user account across every org, searchable +
             sortable + paginated server-side (scales to 1M). Backed by
             GET /api/super-admin/ops/users (never returns password/session columns). -->
        <section class="sa-card" appReveal data-testid="sa-ops-users">
          <header class="sa-card-head">
            <div>
              <h2>Account operations</h2>
              <p>Every user account on the platform — search, sort, review each account's status.</p>
            </div>
            <input
              type="search"
              class="sa-search"
              placeholder="Search accounts by email or name…"
              [(ngModel)]="usersQuery"
              (ngModelChange)="onUsersQueryChange()"
              aria-label="Search all user accounts"
              data-testid="sa-users-search"
            />
          </header>
          <table class="sa-tbl">
            <thead>
              <tr>
                <th>
                  <button type="button" class="sa-sort" (click)="sortUsers('email')"
                          [attr.aria-sort]="usersAriaSort('email')">Email</button>
                </th>
                <th>Name</th>
                <th>Role</th>
                <th>
                  <button type="button" class="sa-sort" (click)="sortUsers('created_at')"
                          [attr.aria-sort]="usersAriaSort('created_at')">Joined</button>
                </th>
              </tr>
            </thead>
            <tbody>
              @if (usersLoading()) {
                <tr><td colspan="4" class="muted center">Loading accounts…</td></tr>
              } @else if (usersRows().length === 0) {
                <tr><td colspan="4" class="muted center" data-testid="sa-users-empty">
                  {{ usersQuery.trim() ? 'No accounts match your search.' : 'No accounts yet.' }}
                </td></tr>
              } @else {
                @for (u of usersRows(); track u.id) {
                  <tr class="sa-row sa-clickable" (click)="openUserDrawer(u)"
                      (keydown.enter)="openUserDrawer(u)"
                      (keydown.space)="$event.preventDefault(); openUserDrawer(u)"
                      tabindex="0" role="button"
                      [attr.aria-label]="'View account ' + u.email"
                      [attr.data-testid]="'sa-users-row-' + u.id">
                    <td><code class="sa-mono">{{ u.email }}</code></td>
                    <td>{{ u.display_name || '—' }}</td>
                    <td>
                      @if (u.is_super_admin) {
                        <span class="sa-pill" data-status="super" data-testid="sa-users-super">super-admin</span>
                      } @else {
                        <span class="muted small">member</span>
                      }
                    </td>
                    <td class="muted small">{{ u.created_at ? u.created_at.slice(0, 10) : '—' }}</td>
                  </tr>
                }
              }
            </tbody>
          </table>
          <footer class="sa-ops-foot">
            <span class="muted small" data-testid="sa-users-total">
              {{ usersTotal() }} account{{ usersTotal() === 1 ? '' : 's' }} · page {{ usersPage() }} of {{ usersPages() }}
            </span>
            <div class="sa-ops-pager">
              <button type="button" class="sa-btn-ghost" (click)="exportUsersCsv()" [disabled]="usersRows().length === 0" data-testid="sa-users-export" aria-label="Export the accounts on this page to CSV">Export CSV</button>
              <button type="button" class="sa-btn-ghost" (click)="usersPrev()" [disabled]="usersPage() <= 1">Prev</button>
              <button type="button" class="sa-btn-ghost" (click)="usersNext()" [disabled]="usersPage() >= usersPages()">Next</button>
            </div>
          </footer>
        </section>
      }

      @if (adjustOpen(); as w) {
        <div class="sa-modal-bg" (click)="closeAdjust()">
          <div class="sa-modal" (click)="$event.stopPropagation()" role="dialog" aria-label="Manual wallet adjustment">
            <h3>Adjust {{ w.org_name }}</h3>
            <p class="muted small">Current balance: <span class="cyan">{{ formatCents(w.balance_cents) }}</span></p>
            <label>
              Amount in cents (negative to debit)
              <input type="number" step="1" [(ngModel)]="adjustCents" autofocus
                     [attr.aria-invalid]="adjustError() ? 'true' : null" />
            </label>
            <label>
              Reason
              <input type="text" maxlength="500" [(ngModel)]="adjustReason"
                     placeholder="why this adjustment? (3–500 chars)"
                     [attr.aria-invalid]="adjustError() ? 'true' : null" />
            </label>
            <!-- FE↔BE parity: mirror adjustmentSchema (non-zero integer cents + reason
                 3–500 chars) so bad input is caught instantly, not by a server 400. -->
            @if (adjustError(); as e) {
              <p class="sa-adjust-err" role="alert" data-testid="sa-adjust-error">{{ e }}</p>
            }
            <div class="sa-modal-actions">
              <button type="button" class="sa-btn-ghost" (click)="closeAdjust()">Cancel</button>
              <button type="button" class="sa-btn-primary" (click)="submitAdjust()"
                      data-testid="sa-adjust-apply" [disabled]="!adjustValid()">
                Apply
              </button>
            </div>
          </div>
        </div>
      }

      <!-- Site-360 / Account-360 slide-out drawer — click any ops row to inspect + act. -->
      @if (drawerKind(); as kind) {
        <div class="sa-drawer-scrim" (click)="closeDrawer()" data-testid="sa-drawer-scrim"></div>
        <aside class="sa-drawer" role="dialog" aria-modal="true" tabindex="-1"
               [attr.aria-label]="kind === 'site' ? 'Site details' : 'Account details'"
               data-testid="sa-drawer">
          <button type="button" class="sa-drawer-x" (click)="closeDrawer()" aria-label="Close details">✕</button>

          @if (drawerLoading()) {
            <div class="sa-drawer-load" aria-busy="true">
              <div class="sa-shimmer sa-shimmer-title"></div>
              <div class="sa-shimmer"></div><div class="sa-shimmer"></div>
              <div class="sa-shimmer" style="width:60%"></div>
            </div>
          } @else if (kind === 'site' && siteDetail(); as d) {
            <div class="sa-drawer-hero" [attr.data-status]="d.site.status">
              <span class="sa-drawer-kicker">Site operations · 360°</span>
              <h2 class="sa-drawer-title" data-testid="sa-drawer-title">{{ d.site.business_name || d.site.slug }}</h2>
              <div class="sa-drawer-badges">
                <span class="sa-pill" [attr.data-status]="d.site.status">{{ d.site.status }}</span>
                @if (d.site.budget_tier) { <span class="sa-chip">{{ d.site.budget_tier }}</span> }
              </div>
            </div>
            <dl class="sa-dl">
              <div><dt>Slug</dt><dd><code class="sa-mono">{{ d.site.slug }}</code></dd></div>
              <div><dt>Owner org</dt><dd>{{ d.site.org_name || '—' }}</dd></div>
              <div><dt>Owner</dt><dd>{{ d.owner?.display_name || '—' }} @if (d.owner?.email) { <span class="muted small">· {{ d.owner!.email }}</span> }</dd></div>
              @if (d.site.business_category) { <div><dt>Category</dt><dd>{{ d.site.business_category }}</dd></div> }
              @if (d.site.business_address) { <div><dt>Address</dt><dd>{{ d.site.business_address }}</dd></div> }
              @if (d.site.business_phone) { <div><dt>Phone</dt><dd>{{ d.site.business_phone }}</dd></div> }
              @if (d.site.business_email) { <div><dt>Business email</dt><dd>{{ d.site.business_email }}</dd></div> }
              <div><dt>Build</dt><dd><code class="sa-mono">{{ d.site.current_build_version || '—' }}</code></dd></div>
              <div><dt>Created</dt><dd>{{ d.site.created_at ? d.site.created_at.slice(0, 10) : '—' }}</dd></div>
              <div><dt>Updated</dt><dd>{{ d.site.updated_at ? d.site.updated_at.slice(0, 10) : '—' }}</dd></div>
            </dl>
            <div class="sa-drawer-actions">
              <a class="sa-btn-primary" [href]="opsSiteUrl(d.site.slug)" target="_blank" rel="noopener noreferrer">Open live site ↗</a>
              <button type="button" class="sa-btn-ghost" (click)="copyText(d.site.slug, 'Slug')">Copy slug</button>
              @if (d.owner?.email) {
                <button type="button" class="sa-btn-ghost" (click)="copyText(d.owner!.email, 'Owner email')">Copy owner email</button>
              }
            </div>
          } @else if (kind === 'user' && userDetail(); as d) {
            <div class="sa-drawer-hero">
              <span class="sa-drawer-kicker">Account operations · 360°</span>
              <h2 class="sa-drawer-title" data-testid="sa-drawer-title">{{ d.user.display_name || d.user.email }}</h2>
              <div class="sa-drawer-badges">
                @if (d.user.is_super_admin) { <span class="sa-pill" data-status="super">super-admin</span> } @else { <span class="sa-chip">member</span> }
                <span class="sa-chip">{{ d.sites_count }} site{{ d.sites_count === 1 ? '' : 's' }}</span>
              </div>
            </div>
            <dl class="sa-dl">
              <div><dt>Email</dt><dd><code class="sa-mono">{{ d.user.email }}</code></dd></div>
              <div><dt>Account ID</dt><dd><code class="sa-mono">{{ d.user.id }}</code></dd></div>
              <div><dt>Joined</dt><dd>{{ d.user.created_at ? d.user.created_at.slice(0, 10) : '—' }}</dd></div>
            </dl>
            <div class="sa-drawer-subhead">Organizations · {{ d.orgs.length }}</div>
            @if (d.orgs.length) {
              <ul class="sa-drawer-orgs">
                @for (o of d.orgs; track o.org_id) {
                  <li><span class="sa-drawer-org-name">{{ o.org_name || o.org_id }}</span><span class="sa-chip">{{ o.role }}</span></li>
                }
              </ul>
            } @else {
              <p class="muted small">No organizations.</p>
            }
            <div class="sa-drawer-actions">
              <button type="button" class="sa-btn-primary" (click)="copyText(d.user.email, 'Email')">Copy email</button>
              <button type="button" class="sa-btn-ghost" (click)="copyText(d.user.id, 'Account ID')">Copy ID</button>
            </div>
          }
        </aside>
      }
    </section>
  `,
  styles: [`
    :host { display: block; color: var(--ps-ink, #f4f4ff); }
    .sa-root { padding: 32px; max-width: 1400px; margin: 0 auto; }
    .sa-head { margin-bottom: 28px; }
    .sa-kicker { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.14em; color: var(--ps-accent, #00E5FF); opacity: 0.85; margin-bottom: 8px; }
    .sa-h1 { font-family: 'Sora', system-ui, sans-serif; font-weight: 700; font-size: clamp(1.6rem, 3vw, 2.4rem); letter-spacing: -0.02em; margin: 0; background: linear-gradient(120deg, var(--ps-ink, #f4f4ff), color-mix(in oklch, var(--ps-ink, #f4f4ff) 70%, transparent)); background-clip: text; -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .sa-sub { color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 60%, transparent); margin: 6px 0 0; font-size: 0.9rem; }
    .sa-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; margin-bottom: 28px; }
    .sa-tile { background: rgba(255,255,255,0.02); border: 1px solid rgba(0,229,255,0.08); border-radius: 14px; padding: 14px 16px; }
    .sa-tile-accent { border-color: rgba(0,229,255,0.30); background: linear-gradient(135deg, rgba(0,229,255,0.06), rgba(124,58,237,0.04)); }
    .sa-tile-k { font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.1em; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 50%, transparent); }
    .sa-tile-v { font-family: 'Sora', sans-serif; font-weight: 700; font-size: 1.6rem; margin-top: 4px; font-variant-numeric: tabular-nums; }
    .sa-cur { color: var(--ps-accent, #00E5FF); font-size: 0.95rem; margin-right: 2px; }
    .sa-card { background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06); border-radius: 16px; padding: 22px; margin-bottom: 20px; }
    .sa-card-head { display: flex; justify-content: space-between; align-items: flex-end; flex-wrap: wrap; gap: 10px; margin-bottom: 14px; }
    .sa-card-head h2 { font-family: 'Sora', sans-serif; font-weight: 600; font-size: 1.1rem; margin: 0; letter-spacing: -0.01em; }
    .sa-card-head p { color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); font-size: 0.78rem; margin: 4px 0 0; }
    .sa-search { background: rgba(0,0,0,0.32); border: 1px solid rgba(255,255,255,0.08); color: var(--ps-ink); padding: 8px 12px; border-radius: 8px; min-width: 280px; font-family: inherit; }
    .sa-search:focus { outline: none; border-color: rgba(0,229,255,0.35); }
    .sa-sort { background: none; border: 0; padding: 0; margin: 0; font: inherit; color: inherit; text-transform: inherit; letter-spacing: inherit; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; }
    .sa-sort:hover { color: var(--ps-accent, #00E5FF); }
    .sa-sort[aria-sort="ascending"]::after { content: '↑'; color: var(--ps-accent, #00E5FF); }
    .sa-sort[aria-sort="descending"]::after { content: '↓'; color: var(--ps-accent, #00E5FF); }
    .sa-sort:focus-visible { outline: 2px solid var(--ps-accent, #00E5FF); outline-offset: 2px; border-radius: 4px; }
    .sa-ops-open { padding: 4px 10px; font-size: 0.72rem; white-space: nowrap; text-decoration: none; display: inline-block; }
    .sa-ops-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 14px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.05); }
    .sa-ops-pager { display: flex; gap: 8px; }
    .sa-ops-pager .sa-btn-ghost:disabled { opacity: 0.4; cursor: not-allowed; }
    .sa-tbl { width: 100%; border-collapse: collapse; font-size: 0.84rem; }
    .sa-tbl thead { font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.08em; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); }
    .sa-tbl th, .sa-tbl td { padding: 10px 12px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.04); }
    .sa-tbl th.num, .sa-tbl td.num { text-align: right; font-variant-numeric: tabular-nums; font-family: 'JetBrains Mono', monospace; }
    .sa-tbl .center { text-align: center; padding: 32px 0; }
    .sa-mono { font-family: 'JetBrains Mono', monospace; font-size: 0.78rem; color: var(--ps-accent, #00E5FF); }
    .muted { color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 50%, transparent); }
    .cyan { color: var(--ps-accent, #00E5FF); }
    .small { font-size: 0.72rem; }
    .sa-row-edited { background: rgba(0,229,255,0.04); }
    .sa-factor-input { width: 70px; background: rgba(0,0,0,0.32); border: 1px solid rgba(0,229,255,0.16); color: var(--ps-accent, #00E5FF); padding: 4px 6px; border-radius: 6px; font-family: 'JetBrains Mono', monospace; text-align: right; font-variant-numeric: tabular-nums; }
    .sa-factor-input:focus { outline: none; border-color: rgba(0,229,255,0.55); box-shadow: 0 0 0 3px rgba(0,229,255,0.18); }
    .sa-toggle { padding: 3px 12px; border-radius: 999px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.10); color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 60%, transparent); cursor: pointer; font-family: inherit; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; }
    .sa-toggle.is-on { background: rgba(0,229,255,0.14); border-color: rgba(0,229,255,0.45); color: var(--ps-accent, #00E5FF); }
    .sa-pill { padding: 2px 9px; border-radius: 999px; font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; }
    .sa-pill[data-status="active"] { background: rgba(52,211,153,0.12); color: #6ee7b7; border: 1px solid rgba(52,211,153,0.32); }
    .sa-pill[data-status="past_due"], .sa-pill[data-status="canceled"], .sa-pill[data-status="inactive"] { background: rgba(248,113,113,0.10); color: #fca5a5; border: 1px solid rgba(248,113,113,0.22); }
    .sa-btn-ghost { padding: 6px 12px; border-radius: 8px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); color: var(--ps-ink); font-family: inherit; font-size: 0.78rem; cursor: pointer; }
    .sa-btn-ghost:hover { background: rgba(0,229,255,0.08); border-color: rgba(0,229,255,0.22); }
    .sa-btn-primary { padding: 8px 14px; border-radius: 8px; background: linear-gradient(135deg, var(--ps-accent, #00E5FF), color-mix(in oklch, var(--ps-accent, #00E5FF) 65%, #7C3AED)); border: none; color: #06121A; font-family: 'Sora', sans-serif; font-weight: 600; cursor: pointer; }
    .sa-btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .sa-modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.6); backdrop-filter: blur(8px); display: flex; align-items: center; justify-content: center; z-index: 9999; }
    .sa-modal { background: linear-gradient(180deg, rgba(20,20,42,0.96), rgba(10,10,28,0.98)); border: 1px solid rgba(0,229,255,0.20); border-radius: 14px; padding: 24px; min-width: 420px; max-width: 92vw; }
    .sa-modal h3 { font-family: 'Sora', sans-serif; font-weight: 600; margin: 0 0 6px; }
    .sa-modal label { display: block; font-size: 0.78rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 65%, transparent); margin-top: 14px; }
    .sa-modal input { display: block; width: 100%; margin-top: 4px; background: rgba(0,0,0,0.32); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; padding: 8px 10px; color: var(--ps-ink); font-family: inherit; }
    .sa-modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
    .sa-forbidden { text-align: center; padding: 80px 20px; }
    .sa-forbidden-glyph { font-size: 3rem; margin-bottom: 10px; }
    .sa-forbidden h2 { font-family: 'Sora', sans-serif; font-weight: 700; }
    .sa-forbidden code { background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 4px; font-family: 'JetBrains Mono', monospace; font-size: 0.85rem; }
    /* Ops console — 4 read-only monitoring widgets */
    .sa-ops-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 20px; margin-bottom: 20px; }
    .sa-ops-card { margin-bottom: 0; }
    .sa-ops-summary { font-size: 0.78rem; margin: 4px 0 0; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 70%, transparent); font-variant-numeric: tabular-nums; }
    .sa-ops-msg { padding: 8px 0; }
    .sa-ops-err { color: #fca5a5; padding: 6px 0; }
    .sa-ops-ok { color: #6ee7b7; font-weight: 600; font-size: 0.82rem; padding: 6px 0; }
    .sa-ops-subhead, .sa-ops-list + .sa-ops-subhead { font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.09em; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 45%, transparent); margin: 12px 0 6px; }
    .sa-ops-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
    .sa-dot { width: 10px; height: 10px; border-radius: 999px; flex: 0 0 10px; margin-top: 5px; background: #64748b; box-shadow: 0 0 0 3px rgba(100,116,139,0.14); }
    .sa-dot[data-status="healthy"] { background: #22c55e; box-shadow: 0 0 0 3px rgba(34,197,94,0.18); }
    .sa-dot[data-status="low"] { background: #f59e0b; box-shadow: 0 0 0 3px rgba(245,158,11,0.18); }
    .sa-dot[data-status="depleted"] { background: #ef4444; box-shadow: 0 0 0 3px rgba(239,68,68,0.22); }
    .sa-dot[data-status="unknown"] { background: #64748b; box-shadow: 0 0 0 3px rgba(100,116,139,0.14); }
    .sa-dot[data-status="unconfigured"] { background: rgba(148,163,184,0.4); box-shadow: none; }
    .sa-cred-row { display: flex; gap: 10px; align-items: flex-start; }
    .sa-cred-body { flex: 1 1 auto; min-width: 0; }
    .sa-cred-top { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
    .sa-cred-label { font-weight: 600; font-size: 0.86rem; }
    .sa-cred-topup { font-size: 0.7rem; color: var(--ps-accent, #00E5FF); text-decoration: none; white-space: nowrap; opacity: 0.85; }
    .sa-cred-topup:hover { opacity: 1; text-decoration: underline; }
    .sa-cred-detail { margin-top: 2px; overflow-wrap: anywhere; }
    .sa-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 4px; }
    .sa-chip { padding: 4px 10px; border-radius: 999px; font-size: 0.7rem; text-transform: capitalize; letter-spacing: 0.02em; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.09); color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 70%, transparent); }
    .sa-chip b { color: var(--ps-ink, #f4f4ff); font-variant-numeric: tabular-nums; margin-left: 2px; }
    .sa-chip[data-status="published"] { background: rgba(34,197,94,0.10); border-color: rgba(34,197,94,0.30); color: #6ee7b7; }
    .sa-chip[data-status="generating"], .sa-chip[data-status="imaging"], .sa-chip[data-status="collecting"] { background: rgba(0,229,255,0.10); border-color: rgba(0,229,255,0.30); color: var(--ps-accent, #00E5FF); }
    .sa-chip[data-status="error"] { background: rgba(239,68,68,0.10); border-color: rgba(239,68,68,0.30); color: #fca5a5; }
    .sa-err-row { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
    .sa-err-link { color: var(--ps-ink, #f4f4ff); text-decoration: none; font-size: 0.82rem; }
    .sa-err-link:hover { color: var(--ps-accent, #00E5FF); text-decoration: underline; }
    .sa-err-slug { font-family: 'JetBrains Mono', monospace; white-space: nowrap; }
    .sa-growth-tbl { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
    .sa-growth-tbl th { font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.08em; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 50%, transparent); padding: 4px 8px; text-align: left; }
    .sa-growth-tbl th.num, .sa-growth-tbl td.num { text-align: right; font-variant-numeric: tabular-nums; font-family: 'JetBrains Mono', monospace; }
    .sa-growth-tbl td { padding: 7px 8px; border-bottom: 1px solid rgba(255,255,255,0.04); }
    .sa-growth-lbl { color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 75%, transparent); }
    .sa-big-num { font-family: 'Sora', sans-serif; font-weight: 700; font-size: 2.4rem; line-height: 1.1; font-variant-numeric: tabular-nums; color: #fca5a5; }
    .sa-big-num-unit { display: block; font-size: 0.68rem; font-weight: 500; text-transform: uppercase; letter-spacing: 0.08em; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 50%, transparent); font-family: inherit; margin-top: 2px; }
    .sa-suppress-row { font-family: 'JetBrains Mono', monospace; overflow-wrap: anywhere; }
    /* ── Cinematic layer ─────────────────────────────────────────────────── */
    .sa-root { position: relative; }
    .sa-root::before {
      content: ''; position: fixed; inset: 0; z-index: -1; pointer-events: none;
      background:
        radial-gradient(60% 50% at 12% -5%, rgba(0,229,255,0.10), transparent 60%),
        radial-gradient(55% 45% at 92% 8%, rgba(124,58,237,0.11), transparent 62%),
        radial-gradient(45% 40% at 50% 108%, rgba(0,229,255,0.055), transparent 72%);
      animation: sa-aurora 24s ease-in-out infinite alternate;
    }
    @keyframes sa-aurora { 0% { opacity: 0.65; transform: translateY(0); } 100% { opacity: 1; transform: translateY(-14px); } }
    .sa-h1 { text-shadow: 0 0 40px rgba(0,229,255,0.18); }
    .sa-card { position: relative; overflow: hidden; backdrop-filter: blur(7px); transition: border-color 0.35s ease, box-shadow 0.35s ease; }
    .sa-card::before { content: ''; position: absolute; inset: 0 0 auto 0; height: 1px; background: linear-gradient(90deg, transparent, rgba(0,229,255,0.45), transparent); opacity: 0.55; }
    .sa-card:hover { border-color: rgba(0,229,255,0.16); box-shadow: 0 20px 60px -30px rgba(0,229,255,0.30); }
    .sa-tile { transition: border-color 0.3s ease, transform 0.3s ease, box-shadow 0.3s ease; }
    .sa-tile:hover { transform: translateY(-2px); border-color: rgba(0,229,255,0.30); box-shadow: 0 14px 40px -26px rgba(0,229,255,0.5); }
    /* Clickable ops rows → open the 360° drawer */
    .sa-clickable { cursor: pointer; transition: background 0.18s ease; }
    .sa-clickable:hover td { background: rgba(0,229,255,0.055); }
    .sa-clickable:hover td:first-child { box-shadow: inset 3px 0 0 var(--ps-accent, #00E5FF); }
    .sa-clickable:focus-visible { outline: 2px solid var(--ps-accent, #00E5FF); outline-offset: -2px; }
    .sa-clickable td { transition: background 0.18s ease, box-shadow 0.18s ease; }
    /* Site-status + super-admin pill palettes */
    .sa-pill[data-status="published"] { background: rgba(52,211,153,0.12); color: #6ee7b7; border: 1px solid rgba(52,211,153,0.32); }
    .sa-pill[data-status="generating"], .sa-pill[data-status="imaging"], .sa-pill[data-status="collecting"], .sa-pill[data-status="draft"] { background: rgba(0,229,255,0.10); color: var(--ps-accent, #00E5FF); border: 1px solid rgba(0,229,255,0.28); }
    .sa-pill[data-status="error"] { background: rgba(248,113,113,0.10); color: #fca5a5; border: 1px solid rgba(248,113,113,0.24); }
    .sa-pill[data-status="archived"] { background: rgba(148,163,184,0.10); color: #cbd5e1; border: 1px solid rgba(148,163,184,0.24); }
    .sa-pill[data-status="super"] { background: rgba(124,58,237,0.16); color: #c4b5fd; border: 1px solid rgba(124,58,237,0.42); }
    /* ── 360° drawer ─────────────────────────────────────────────────────── */
    .sa-drawer-scrim { position: fixed; inset: 0; background: rgba(3,6,16,0.55); backdrop-filter: blur(6px); z-index: 100000; animation: sa-fade 0.25s ease; }
    /* top padding 66 = 26 base + 40 so the drawer hero + close button clear the fixed admin top navbar (WCAG 2.4.11 focus-not-obscured); the close button is absolute so its own top offset is bumped +40 too */
    .sa-drawer { position: fixed; top: 0; right: 0; height: 100dvh; width: min(468px, 94vw); z-index: 100001; overflow-y: auto; padding: 66px 26px 44px; background: linear-gradient(180deg, rgba(16,17,34,0.98), rgba(8,9,22,0.99)); border-left: 1px solid rgba(0,229,255,0.22); box-shadow: -44px 0 100px -34px rgba(0,229,255,0.32); animation: sa-slide-in 0.34s cubic-bezier(0.22,1,0.36,1); }
    .sa-drawer:focus { outline: none; }
    @keyframes sa-slide-in { from { transform: translateX(44px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
    @keyframes sa-fade { from { opacity: 0; } to { opacity: 1; } }
    .sa-drawer-x { position: absolute; top: 56px; right: 16px; width: 34px; height: 34px; border-radius: 10px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.10); color: var(--ps-ink); cursor: pointer; font-size: 0.9rem; line-height: 1; }
    .sa-drawer-x:hover { background: rgba(248,113,113,0.14); border-color: rgba(248,113,113,0.4); color: #fca5a5; }
    .sa-drawer-x:focus-visible { outline: 2px solid var(--ps-accent, #00E5FF); outline-offset: 2px; }
    .sa-drawer-hero { padding: 6px 40px 18px 0; border-bottom: 1px solid rgba(255,255,255,0.06); margin-bottom: 16px; }
    .sa-drawer-kicker { font-family: 'JetBrains Mono', monospace; font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.14em; color: var(--ps-accent, #00E5FF); }
    .sa-drawer-title { font-family: 'Sora', sans-serif; font-weight: 700; font-size: clamp(1.3rem, 3.5vw, 1.7rem); letter-spacing: -0.02em; margin: 8px 0 12px; line-height: 1.15; text-wrap: balance; }
    .sa-drawer-badges { display: flex; flex-wrap: wrap; gap: 8px; }
    .sa-dl { margin: 0 0 18px; }
    .sa-dl > div { display: grid; grid-template-columns: 118px 1fr; gap: 12px; padding: 9px 0; border-bottom: 1px solid rgba(255,255,255,0.04); }
    .sa-dl dt { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.07em; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 45%, transparent); margin: 0; padding-top: 2px; }
    .sa-dl dd { margin: 0; font-size: 0.86rem; overflow-wrap: anywhere; }
    .sa-drawer-subhead { font-size: 0.64rem; text-transform: uppercase; letter-spacing: 0.1em; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 45%, transparent); margin: 4px 0 8px; }
    .sa-drawer-orgs { list-style: none; margin: 0 0 18px; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .sa-drawer-orgs li { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 12px; border-radius: 10px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.05); }
    .sa-drawer-org-name { overflow-wrap: anywhere; font-size: 0.84rem; }
    .sa-drawer-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
    .sa-drawer-actions .sa-btn-primary { text-decoration: none; display: inline-flex; align-items: center; }
    .sa-drawer-load { display: flex; flex-direction: column; gap: 12px; padding-top: 30px; }
    .sa-shimmer { height: 14px; border-radius: 6px; background: linear-gradient(90deg, rgba(255,255,255,0.04), rgba(255,255,255,0.11), rgba(255,255,255,0.04)); background-size: 200% 100%; animation: sa-shimmer 1.3s ease-in-out infinite; }
    .sa-shimmer-title { height: 26px; width: 70%; }
    @keyframes sa-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { transition: none !important; animation: none !important; }
    }
  `],
})
export class SuperAdminComponent implements OnInit {
  protected readonly Math = Math;
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  private readonly state = inject(AdminStateService);
  /** One-shot guard so the gate decision runs exactly once. */
  private gated = false;

  forbidden = signal(false);
  categoriesLoading = signal(true);
  categories = signal<CostCategory[]>([]);
  wallets = signal<OrgWalletRow[]>([]);
  stats = signal<SuperAdminStats | null>(null);
  dirty = signal<Set<string>>(new Set());

  // Ops console widgets — each fetched independently on init so one failing
  // widget never blanks the others (fail-soft per widget).
  credits = signal<CreditsResponse | null>(null);
  creditsLoading = signal(true);
  creditsError = signal<string | null>(null);

  fleet = signal<FleetHealthResponse | null>(null);
  fleetLoading = signal(true);
  fleetError = signal<string | null>(null);

  growth = signal<GrowthResponse | null>(null);
  growthLoading = signal(true);
  growthError = signal<string | null>(null);

  deliver = signal<DeliverabilityResponse | null>(null);
  deliverLoading = signal(true);
  deliverError = signal<string | null>(null);

  walletsQuery = '';
  adjustOpen = signal<OrgWalletRow | null>(null);
  adjustCents = 0;
  adjustReason = '';

  // Site Operations — platform-wide sites list (server-side search + sort + paginate,
  // scales to 1M; GET /api/super-admin/ops/sites). Sibling of the wallets table.
  opsSites = signal<OpsSiteRow[]>([]);
  opsTotal = signal(0);
  opsPage = signal(1);
  opsPages = signal(1);
  opsSort = signal<'created_at' | 'updated_at' | 'business_name' | 'status'>('created_at');
  opsDir = signal<'asc' | 'desc'>('desc');
  opsLoading = signal(true);
  opsQuery = '';
  private opsDebounce: ReturnType<typeof setTimeout> | null = null;

  // Account Operations — platform-wide user list (server-side search + sort + paginate,
  // scales to 1M; GET /api/super-admin/ops/users). Sibling of the sites table.
  usersRows = signal<OpsUserRow[]>([]);
  usersTotal = signal(0);
  usersPage = signal(1);
  usersPages = signal(1);
  usersSort = signal<'created_at' | 'email'>('created_at');
  usersDir = signal<'asc' | 'desc'>('desc');
  usersLoading = signal(true);
  usersQuery = '';
  private usersDebounce: ReturnType<typeof setTimeout> | null = null;

  // Site-360 / Account-360 drawer — click any ops row to inspect + act.
  drawerKind = signal<'site' | 'user' | null>(null);
  drawerLoading = signal(false);
  siteDetail = signal<SiteDetail | null>(null);
  userDetail = signal<UserDetail | null>(null);

  private walletsDebounce: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // Gate the super-admin-only fetches on the client is_super_admin flag (hydrated
    // from /api/auth/me once state.loading() resolves). A non-super-admin must NOT
    // fire the 3 doomed /api/super-admin/* requests (each 403s) — show Restricted
    // directly. Mirrors feature-flags.component's isSuperAdmin() gate.
    effect(() => {
      if (this.state.loading()) return; // wait for /me to resolve
      if (this.gated) return; // decide once
      this.gated = true;
      if (this.state.isSuperAdmin()) this.loadAll();
      else this.forbidden.set(true);
    });
  }

  ngOnInit(): void {
    // Fetch gating is handled reactively in the constructor effect above.
  }

  private loadAll(): void {
    Promise.all([
      this.loadStats(),
      this.loadCategories(),
      this.loadWallets(''),
      this.loadOpsSites(),
      this.loadUsers(),
    ]).catch((e) => {
      if (this.is403(e)) this.forbidden.set(true);
    });
    // Ops widgets fire in parallel + isolated — each captures its own error so a
    // single failure never blanks the page or the sibling widgets.
    void this.loadCredits();
    void this.loadFleet();
    void this.loadGrowth();
    void this.loadDeliverability();
  }

  private async loadCredits(): Promise<void> {
    try {
      this.creditsLoading.set(true);
      this.creditsError.set(null);
      const res = await this.api
        .get<CreditsResponse>('/super-admin/credits', undefined, { silent: true })
        .toPromise();
      this.credits.set(res ?? null);
    } catch (e) {
      if (this.is403(e)) this.forbidden.set(true);
      this.creditsError.set(this.errMsg(e));
    } finally {
      this.creditsLoading.set(false);
    }
  }

  private async loadFleet(): Promise<void> {
    try {
      this.fleetLoading.set(true);
      this.fleetError.set(null);
      const res = await this.api
        .get<FleetHealthResponse>('/super-admin/fleet-health', undefined, { silent: true })
        .toPromise();
      this.fleet.set(res ?? null);
    } catch (e) {
      if (this.is403(e)) this.forbidden.set(true);
      this.fleetError.set(this.errMsg(e));
    } finally {
      this.fleetLoading.set(false);
    }
  }

  private async loadGrowth(): Promise<void> {
    try {
      this.growthLoading.set(true);
      this.growthError.set(null);
      const res = await this.api
        .get<GrowthResponse>('/super-admin/growth', undefined, { silent: true })
        .toPromise();
      this.growth.set(res ?? null);
    } catch (e) {
      if (this.is403(e)) this.forbidden.set(true);
      this.growthError.set(this.errMsg(e));
    } finally {
      this.growthLoading.set(false);
    }
  }

  private async loadDeliverability(): Promise<void> {
    try {
      this.deliverLoading.set(true);
      this.deliverError.set(null);
      const res = await this.api
        .get<DeliverabilityResponse>('/super-admin/deliverability', undefined, { silent: true })
        .toPromise();
      this.deliver.set(res ?? null);
    } catch (e) {
      if (this.is403(e)) this.forbidden.set(true);
      this.deliverError.set(this.errMsg(e));
    } finally {
      this.deliverLoading.set(false);
    }
  }

  private async loadStats(): Promise<void> {
    try {
      // Map the worker's NESTED response → the flat SuperAdminStats the tiles read,
      // DERIVING spend/margin from by_category + topups from today's daily row. Every
      // field is coerced to a real number so no <app-rolling-counter [value]> is ever
      // undefined (which throws → crashes the section). See WorkerStatsResponse.
      const raw = await this.api
        .get<WorkerStatsResponse>('/super-admin/stats?days=30', undefined, { silent: true })
        .toPromise();
      if (!raw?.totals) return;
      const byCat = raw.by_category ?? [];
      const sumCat = (k: 'gross_charged_cents' | 'net_margin_cents'): number =>
        byCat.reduce((acc, row) => acc + (Number(row?.[k]) || 0), 0);
      const today = (raw.daily ?? []).at(-1);
      this.stats.set({
        orgs_total: Number(raw.totals.total_orgs) || 0,
        active_subscriptions: Number(raw.totals.active_subs) || 0,
        monthly_revenue_cents: Number(raw.totals.monthly_revenue_cents) || 0,
        spend_30d_cents: sumCat('gross_charged_cents'),
        topups_today_cents: Number(today?.topup_credits_cents) || 0,
        margin_30d_cents: sumCat('net_margin_cents'),
      });
    } catch (e) {
      // 403 → the on-page "Restricted" gate is the single, truthful feedback, so
      // the calls pass { silent: true } to suppress ApiService's generic toast
      // (which double-fires with the gate, and — when a CF bot-challenge makes the
      // XHR opaque status-0 — even lies "Can't reach the server"). A genuine
      // non-403 failure still surfaces one explicit, truthful message.
      if (this.is403(e)) this.forbidden.set(true);
      else this.toast.error('Could not load super-admin stats — try again');
    }
  }

  private async loadCategories(): Promise<void> {
    try {
      this.categoriesLoading.set(true);
      const res = await this.api
        .get<{ categories: CostCategory[] }>('/super-admin/cost-categories', undefined, { silent: true })
        .toPromise();
      this.categories.set(res?.categories || []);
    } catch (e) {
      if (this.is403(e)) this.forbidden.set(true);
      else this.toast.error('Could not load cost categories — try again');
    } finally {
      this.categoriesLoading.set(false);
    }
  }

  private async loadWallets(q: string): Promise<void> {
    try {
      const url = q ? `/super-admin/wallets?q=${encodeURIComponent(q)}&limit=100` : '/super-admin/wallets?limit=100';
      const res = await this.api
        .get<{ wallets: OrgWalletRow[] }>(url, undefined, { silent: true })
        .toPromise();
      this.wallets.set(res?.wallets || []);
    } catch (e) {
      if (this.is403(e)) this.forbidden.set(true);
      else this.toast.error('Could not load wallets — try again');
    }
  }

  markDirty(slug: string): void {
    const next = new Set(this.dirty());
    next.add(slug);
    this.dirty.set(next);
  }

  async saveFactor(c: CostCategory): Promise<void> {
    // Value-domain parity with the worker's `patchCategorySchema.markup_factor`
    // (`z.number().min(0.5).max(5)`). Guard on the FE so an out-of-range value
    // surfaces a specific 0.5–5 hint instead of a generic "try again" after a
    // server 400 (zod-everywhere FE↔BE parity on a money-tuning input).
    const factor = Number(c.markup_factor);
    if (!Number.isFinite(factor) || factor < 0.5 || factor > 5) {
      this.toast.error(`Markup factor for ${c.label} must be between 0.5 and 5`);
      return;
    }
    try {
      await this.api.patch(`/super-admin/cost-categories/${c.slug}`, { markup_factor: factor }, { silent: true }).toPromise();
      const next = new Set(this.dirty()); next.delete(c.slug); this.dirty.set(next);
      this.toast.success(`Factor saved for ${c.label}`);
    } catch (e) {
      console.warn('[super-admin] saveFactor failed', e);
      this.toast.error(`Could not save factor — try again`);
    }
  }

  async toggleBillable(c: CostCategory): Promise<void> {
    const next = c.billable === 1 ? 0 : 1;
    try {
      // Worker `patchCategorySchema.billable` is `z.boolean()` — sending the raw
      // 0|1 NUMBER got Zod-rejected (400) on every toggle click (dead control).
      // Send a boolean; the worker coerces it back to 1|0 for storage.
      await this.api.patch(`/super-admin/cost-categories/${c.slug}`, { billable: next === 1 }, { silent: true }).toPromise();
      c.billable = next;
      this.toast.success(`${c.label} ${next === 1 ? 'enabled' : 'disabled'}`);
    } catch (e) {
      console.warn('[super-admin] toggleBillable failed', e);
      this.toast.error('Could not toggle billable');
    }
  }

  onWalletsQueryChange(): void {
    if (this.walletsDebounce) clearTimeout(this.walletsDebounce);
    this.walletsDebounce = setTimeout(() => this.loadWallets(this.walletsQuery.trim()), 280);
  }

  /** Fetch one page of the platform-wide sites list (server does search/sort/paginate). */
  private async loadOpsSites(): Promise<void> {
    try {
      this.opsLoading.set(true);
      const p = new URLSearchParams({
        sort: this.opsSort(),
        dir: this.opsDir(),
        page: String(this.opsPage()),
        limit: '25',
      });
      const q = this.opsQuery.trim();
      if (q) p.set('q', q);
      const res = await this.api
        .get<{ rows: OpsSiteRow[]; total: number; page: number; pages: number }>(
          `/super-admin/ops/sites?${p.toString()}`,
          undefined,
          { silent: true },
        )
        .toPromise();
      this.opsSites.set(res?.rows ?? []);
      this.opsTotal.set(res?.total ?? 0);
      this.opsPages.set(Math.max(1, res?.pages ?? 1));
    } catch (e) {
      if (this.is403(e)) this.forbidden.set(true);
      else this.toast.error('Could not load sites — try again');
    } finally {
      this.opsLoading.set(false);
    }
  }

  /** Debounced search — resets to page 1 so the first matches are always shown. */
  onOpsQueryChange(): void {
    if (this.opsDebounce) clearTimeout(this.opsDebounce);
    this.opsDebounce = setTimeout(() => {
      this.opsPage.set(1);
      void this.loadOpsSites();
    }, 280);
  }

  /** Click a column header: toggle direction if already sorting by it, else switch column. */
  sortOps(col: 'created_at' | 'updated_at' | 'business_name' | 'status'): void {
    if (this.opsSort() === col) {
      this.opsDir.set(this.opsDir() === 'asc' ? 'desc' : 'asc');
    } else {
      this.opsSort.set(col);
      // text columns read best A→Z; time columns newest-first
      this.opsDir.set(col === 'business_name' || col === 'status' ? 'asc' : 'desc');
    }
    this.opsPage.set(1);
    void this.loadOpsSites();
  }

  opsAriaSort(col: 'created_at' | 'updated_at' | 'business_name' | 'status'): string | null {
    if (this.opsSort() !== col) return null;
    return this.opsDir() === 'asc' ? 'ascending' : 'descending';
  }

  opsPrev(): void {
    if (this.opsPage() > 1) {
      this.opsPage.update((p) => p - 1);
      void this.loadOpsSites();
    }
  }

  opsNext(): void {
    if (this.opsPage() < this.opsPages()) {
      this.opsPage.update((p) => p + 1);
      void this.loadOpsSites();
    }
  }

  opsSiteUrl(slug: string): string {
    return `https://${slug}.projectsites.dev/`;
  }

  /** Open the Site-360 drawer for a row and hydrate full detail from the worker. */
  openSiteDrawer(s: OpsSiteRow): void {
    this.siteDetail.set(null);
    this.userDetail.set(null);
    this.drawerKind.set('site');
    this.drawerLoading.set(true);
    this.focusDrawerSoon();
    this.api
      .get<SiteDetail>(`/super-admin/ops/sites/${encodeURIComponent(s.id)}`, undefined, { silent: true })
      .toPromise()
      .then((d) => this.siteDetail.set(d ?? null))
      .catch((e) => {
        if (this.is403(e)) this.forbidden.set(true);
        else this.toast.error('Could not load site details — try again');
        this.closeDrawer();
      })
      .finally(() => this.drawerLoading.set(false));
  }

  /** Open the Account-360 drawer for a row and hydrate full detail from the worker. */
  openUserDrawer(u: OpsUserRow): void {
    this.siteDetail.set(null);
    this.userDetail.set(null);
    this.drawerKind.set('user');
    this.drawerLoading.set(true);
    this.focusDrawerSoon();
    this.api
      .get<UserDetail>(`/super-admin/ops/users/${encodeURIComponent(u.id)}`, undefined, { silent: true })
      .toPromise()
      .then((d) => this.userDetail.set(d ?? null))
      .catch((e) => {
        if (this.is403(e)) this.forbidden.set(true);
        else this.toast.error('Could not load account details — try again');
        this.closeDrawer();
      })
      .finally(() => this.drawerLoading.set(false));
  }

  closeDrawer(): void {
    this.drawerKind.set(null);
  }

  /** Esc closes the drawer (WCAG 2.1.2 — keyboard escape from a modal surface). */
  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.drawerKind()) this.closeDrawer();
  }

  /** Move focus into the drawer once it renders (WCAG 2.4.3 focus order). */
  private focusDrawerSoon(): void {
    setTimeout(() => {
      const el = document.querySelector<HTMLElement>('[data-testid="sa-drawer"]');
      el?.focus();
    }, 60);
  }

  /** Copy a value to the clipboard with a labelled confirmation toast. */
  copyText(value: string, label: string): void {
    void navigator.clipboard
      ?.writeText(value)
      .then(() => this.toast.success(`${label} copied`))
      .catch(() => this.toast.error('Copy failed'));
  }

  /**
   * Serialize rows to a CSV string + trigger a client-side download — no backend,
   * no new endpoint. RFC-4180 quoting (every field quoted, inner `"` doubled) and a
   * UTF-8 BOM so Excel opens accented business names cleanly. Runs only on a user
   * click, so `document` is always available (never SSR).
   */
  private downloadCsv(filename: string, headers: string[], rows: string[][]): void {
    const esc = (v: string): string => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = '﻿' + [headers, ...rows].map((cols) => cols.map(esc).join(',')).join('\r\n');
    try {
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      this.toast.success(`Exported ${rows.length} row${rows.length === 1 ? '' : 's'} → ${filename}`);
    } catch {
      this.toast.error('Export failed');
    }
  }

  /** Export the sites currently loaded (this page) to CSV. Server-side paginated, so this is the visible page. */
  exportSitesCsv(): void {
    const rows = this.opsSites().map((s) => [
      s.business_name ?? '',
      s.slug,
      s.org_name ?? '',
      s.status,
      s.created_at ?? '',
      this.opsSiteUrl(s.slug),
    ]);
    if (rows.length === 0) {
      this.toast.error('No sites to export');
      return;
    }
    this.downloadCsv(
      `projectsites-sites-page-${this.opsPage()}.csv`,
      ['Business', 'Slug', 'Owner org', 'Status', 'Created', 'URL'],
      rows,
    );
  }

  /** Export the accounts currently loaded (this page) to CSV. Never includes passwords/session columns. */
  exportUsersCsv(): void {
    const rows = this.usersRows().map((u) => [
      u.email,
      u.display_name ?? '',
      u.is_super_admin ? 'super-admin' : 'member',
      u.created_at ?? '',
    ]);
    if (rows.length === 0) {
      this.toast.error('No accounts to export');
      return;
    }
    this.downloadCsv(
      `projectsites-accounts-page-${this.usersPage()}.csv`,
      ['Email', 'Name', 'Role', 'Joined'],
      rows,
    );
  }

  private async loadUsers(): Promise<void> {
    try {
      this.usersLoading.set(true);
      const p = new URLSearchParams({
        sort: this.usersSort(),
        dir: this.usersDir(),
        page: String(this.usersPage()),
        limit: '25',
      });
      const q = this.usersQuery.trim();
      if (q) p.set('q', q);
      const res = await this.api
        .get<{ rows: OpsUserRow[]; total: number; page: number; pages: number }>(
          `/super-admin/ops/users?${p.toString()}`,
          undefined,
          { silent: true },
        )
        .toPromise();
      this.usersRows.set(res?.rows ?? []);
      this.usersTotal.set(res?.total ?? 0);
      this.usersPages.set(Math.max(1, res?.pages ?? 1));
    } catch (e) {
      if (this.is403(e)) this.forbidden.set(true);
      else this.toast.error('Could not load accounts — try again');
    } finally {
      this.usersLoading.set(false);
    }
  }

  /** Debounced account search — resets to page 1 so the first matches are always shown. */
  onUsersQueryChange(): void {
    if (this.usersDebounce) clearTimeout(this.usersDebounce);
    this.usersDebounce = setTimeout(() => {
      this.usersPage.set(1);
      void this.loadUsers();
    }, 280);
  }

  /** Click a column header: toggle direction if already sorting by it, else switch column. */
  sortUsers(col: 'created_at' | 'email'): void {
    if (this.usersSort() === col) {
      this.usersDir.set(this.usersDir() === 'asc' ? 'desc' : 'asc');
    } else {
      this.usersSort.set(col);
      // email reads best A→Z; joined-date newest-first
      this.usersDir.set(col === 'email' ? 'asc' : 'desc');
    }
    this.usersPage.set(1);
    void this.loadUsers();
  }

  usersAriaSort(col: 'created_at' | 'email'): string | null {
    if (this.usersSort() !== col) return null;
    return this.usersDir() === 'asc' ? 'ascending' : 'descending';
  }

  usersPrev(): void {
    if (this.usersPage() > 1) {
      this.usersPage.update((p) => p - 1);
      void this.loadUsers();
    }
  }

  usersNext(): void {
    if (this.usersPage() < this.usersPages()) {
      this.usersPage.update((p) => p + 1);
      void this.loadUsers();
    }
  }

  openAdjust(w: OrgWalletRow): void {
    this.adjustOpen.set(w);
    this.adjustCents = 0;
    this.adjustReason = '';
  }
  closeAdjust(): void { this.adjustOpen.set(null); }

  /**
   * FE mirror of the worker's `adjustmentSchema` (super_admin.ts): a manual wallet
   * adjustment needs a NON-ZERO INTEGER cent amount + a 3–500 char reason. Enforced
   * on the FE so bad input never reaches a server 400 (zod-everywhere FE↔BE parity;
   * value-domain coverage per TDD #10 on a money-mutating form).
   */
  adjustValid(): boolean {
    return this.adjustError() === null && this.adjustReason.trim().length > 0;
  }

  /** Human message for the first value-domain violation, or null when valid. */
  adjustError(): string | null {
    const cents = Number(this.adjustCents);
    if (!Number.isFinite(cents) || !Number.isInteger(cents)) return 'Amount must be a whole number of cents.';
    if (cents === 0) return 'Amount cannot be zero.';
    const reason = this.adjustReason.trim();
    if (reason.length > 0 && reason.length < 3) return 'Reason must be at least 3 characters.';
    if (reason.length > 500) return 'Reason must be 500 characters or fewer.';
    return null;
  }

  async submitAdjust(): Promise<void> {
    const w = this.adjustOpen();
    if (!w || !this.adjustValid()) return;
    try {
      await this.api.post('/super-admin/manual-adjustment', { org_id: w.org_id, amount_cents: Number(this.adjustCents), reason: this.adjustReason.trim() }, { silent: true }).toPromise();
      this.toast.success(`Adjusted ${w.org_name} by ${this.formatCents(Number(this.adjustCents))}`);
      this.closeAdjust();
      this.loadWallets(this.walletsQuery);
      this.loadStats();
    } catch (e) {
      console.warn('[super-admin] submitAdjust failed', e);
      this.toast.error('Adjustment failed');
    }
  }

  formatCents(cents: number | undefined | null): string {
    // Never render "$NaN" — a missing field (e.g. the wallets endpoint doesn't
    // return total_charged_30d_cents) coerces to 0, which is the honest value for
    // an empty wallet. Caught by the super-admin AI-vision pass 2026-08-02.
    const n = Number.isFinite(cents as number) ? (cents as number) : 0;
    const sign = n < 0 ? '-' : '';
    const abs = Math.abs(n);
    return `${sign}$${(abs / 100).toFixed(2)}`;
  }

  formatRelative(iso: string): string {
    const t = Date.parse(iso); if (!Number.isFinite(t)) return '—';
    const delta = Math.max(0, Date.now() - t);
    const s = Math.floor(delta / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  /** Extract a short human message from a thrown ApiService/HTTP error. */
  private errMsg(e: unknown): string {
    if (typeof e === 'object' && e !== null) {
      const rec = e as Record<string, unknown>;
      if (typeof rec['message'] === 'string' && rec['message']) return rec['message'];
      if (typeof rec['status'] === 'number') return `HTTP ${rec['status']}`;
    }
    return 'Request failed';
  }

  // ---- API Credits helpers ----

  /** Depleted first, then low, then everything else — surface problems at the top. */
  sortedProviders(providers: CreditProvider[]): CreditProvider[] {
    const rank: Record<CreditProvider['status'], number> = {
      depleted: 0,
      low: 1,
      unknown: 2,
      healthy: 3,
      unconfigured: 4,
    };
    return [...providers].sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9));
  }

  /** One-line rollup like "1 depleted · 3 healthy" — only non-zero buckets, worst-first. */
  creditsSummary(c: CreditsResponse): string {
    const s = c.summary;
    const parts: string[] = [];
    if (s.depleted) parts.push(`${s.depleted} depleted`);
    if (s.low) parts.push(`${s.low} low`);
    if (s.healthy) parts.push(`${s.healthy} healthy`);
    if (s.unknown) parts.push(`${s.unknown} unknown`);
    if (s.unconfigured) parts.push(`${s.unconfigured} unconfigured`);
    return parts.length ? parts.join(' · ') : 'No providers';
  }

  /**
   * Cloudflare Unified Billing is now the SOLE AI-spend rail (EPIC B) — the credits widget
   * lists ONLY it. Match broadly on id/label/category so whatever the backend names the CF UB
   * provider (`cloudflare` / `unified` / `ai-gateway` / `workers-ai`) still surfaces while every
   * other provider (DeepSeek/OpenAI/Anthropic/…) is filtered out.
   */
  private isUnifiedBilling(p: CreditProvider): boolean {
    return /cloudflare|unified|ai.?gateway|workers.?ai/i.test(`${p.id} ${p.label} ${p.category}`);
  }

  /** Only the Cloudflare Unified Billing provider(s), worst-status first. */
  ubProviders(providers: CreditProvider[]): CreditProvider[] {
    return this.sortedProviders(providers.filter((p) => this.isUnifiedBilling(p)));
  }

  /** One-line CF Unified Billing balance/status — replaces the multi-provider rollup. */
  ubSummary(providers: CreditProvider[]): string {
    const ub = this.ubProviders(providers);
    if (ub.length === 0) return 'Not configured';
    const p = ub[0];
    if (p.balanceUsd !== null && p.currency) return `${p.currency} ${p.balanceUsd.toFixed(2)} available`;
    return p.detail || p.status;
  }

  // ---- Growth helpers ----

  growthRows(g: GrowthResponse): Array<{ key: string; label: string; d1: number; d7: number; d30: number }> {
    return [
      { key: 'orgs', label: 'Orgs', d1: g.orgs.d1, d7: g.orgs.d7, d30: g.orgs.d30 },
      { key: 'users', label: 'Users', d1: g.users.d1, d7: g.users.d7, d30: g.users.d30 },
      { key: 'sites-created', label: 'Sites created', d1: g.sitesCreated.d1, d7: g.sitesCreated.d7, d30: g.sitesCreated.d30 },
      { key: 'sites-published', label: 'Sites published', d1: g.sitesPublished.d1, d7: g.sitesPublished.d7, d30: g.sitesPublished.d30 },
    ];
  }

  /** -1 sentinel (query failed) renders as an em dash; real counts pass through. */
  growthCell(n: number): string {
    return n < 0 ? '—' : String(n);
  }

  // ---- Deliverability helpers ----

  /** Pick whichever address-like field the suppression row carries. */
  suppressedAddr(r: Record<string, unknown>): string {
    const v = r['email'] ?? r['address'] ?? r['recipient'];
    return typeof v === 'string' && v ? v : '(unknown address)';
  }

  private is403(e: unknown): boolean {
    return typeof e === 'object' && e !== null && 'status' in (e as Record<string, unknown>) && (e as { status: number }).status === 403;
  }
}

export default SuperAdminComponent;
