import {
  Component,
  ChangeDetectionStrategy,
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
          <!-- 1. API Credits -->
          <div class="sa-card sa-ops-card" data-testid="sa-credits" appReveal>
            <header class="sa-card-head">
              <h2>API Credits</h2>
              @if (credits(); as c) {
                <p class="sa-ops-summary" data-testid="sa-credits-summary">{{ creditsSummary(c) }}</p>
              }
            </header>
            @if (creditsLoading()) {
              <p class="muted small sa-ops-msg">Loading…</p>
            } @else if (creditsError()) {
              <p class="sa-ops-err small" role="alert">Couldn't load: {{ creditsError() }}</p>
            } @else if (credits(); as c) {
              @if (c.providers.length === 0) {
                <p class="muted small sa-ops-msg">No providers configured.</p>
              } @else {
                <ul class="sa-ops-list">
                  @for (p of sortedProviders(c.providers); track p.id) {
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
                  <tr class="sa-row">
                    <td>{{ s.business_name || '—' }}</td>
                    <td><code class="sa-mono">{{ s.slug }}</code></td>
                    <td class="muted">{{ s.org_name || '—' }}</td>
                    <td><span class="sa-pill" [attr.data-status]="s.status">{{ s.status }}</span></td>
                    <td class="muted small">{{ s.created_at ? s.created_at.slice(0, 10) : '—' }}</td>
                    <td class="num">
                      <a class="sa-btn-ghost sa-ops-open" [href]="opsSiteUrl(s.slug)"
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
              <button type="button" class="sa-btn-ghost" (click)="opsPrev()" [disabled]="opsPage() <= 1">Prev</button>
              <button type="button" class="sa-btn-ghost" (click)="opsNext()" [disabled]="opsPage() >= opsPages()">Next</button>
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
