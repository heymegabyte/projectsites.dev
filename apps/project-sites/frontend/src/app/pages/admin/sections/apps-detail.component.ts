import {
  Component,
  DestroyRef,
  HostListener,
  computed,
  inject,
  signal,
  type OnInit,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiService } from '../../../services/api.service';
import { ToastService } from '../../../services/toast.service';
import { ConfirmService } from '../../../services/confirm.service';
import { AdminStateService } from '../admin-state.service';
import { RevealDirective } from '../../../directives/reveal.directive';
import { RollingCounterComponent } from '../../../components/rolling-counter/rolling-counter.component';
import { HlmInputDirective } from '../../../ui';
import {
  APPS_CATALOG,
  isAppSupported,
  withHyperdrive,
  type CatalogApp,
  type InfraDep,
} from './apps-catalog.data';

interface InfraEstimate {
  readonly key: string;
  readonly label: string;
  readonly provider: string;
  readonly monthlyUsd: number;
}

const INFRA_PROVIDER_COST: Readonly<Record<InfraDep, InfraEstimate>> = {
  postgres:  { key: 'postgres',  label: 'Postgres',    provider: 'Neon (autoscale)',  monthlyUsd: 5 },
  redis:     { key: 'redis',     label: 'Redis',       provider: 'Upstash (per-req)', monthlyUsd: 3 },
  s3:        { key: 's3',        label: 'Object store', provider: 'Cloudflare R2',    monthlyUsd: 2 },
  sqlite:    { key: 'sqlite',    label: 'SQLite',      provider: 'Container volume',  monthlyUsd: 0 },
  volume:    { key: 'volume',    label: 'Volume',      provider: 'Container disk',    monthlyUsd: 1 },
  mailrelay: { key: 'mailrelay', label: 'Mail relay',  provider: 'Resend',            monthlyUsd: 0 },
  // Free Cloudflare primitive — pools + accelerates the Postgres connection.
  hyperdrive:{ key: 'hyperdrive', label: 'Hyperdrive', provider: 'Cloudflare (Postgres pooler)', monthlyUsd: 0 },
} as const;

const INFRA_META: Readonly<Record<InfraDep, { glyph: string; label: string }>> = {
  postgres:  { glyph: '🐘', label: 'Postgres' },
  redis:     { glyph: '🟥', label: 'Redis' },
  s3:        { glyph: '🪣', label: 'R2 / S3' },
  sqlite:    { glyph: '💾', label: 'SQLite' },
  volume:    { glyph: '📦', label: 'Volume' },
  mailrelay: { glyph: '📬', label: 'Mail relay' },
  hyperdrive:{ glyph: '⚡', label: 'Hyperdrive' },
} as const;

/**
 * Admin → App detail (catalog entry deep-dive + deploy panel).
 *
 * @remarks
 * Reads the `:id` route param, surfaces the full {@link CatalogApp} record
 * with env-var table, license, links, infra provisioning checklist, and the
 * cost breakdown for the deploy wizard. Submitting `Deploy` POSTs to
 * `/api/apps/instances` and routes to the boot-progress instance detail.
 */
@Component({
  selector: 'app-admin-app-detail',
  standalone: true,
  imports: [FormsModule, RouterLink, RevealDirective, RollingCounterComponent, HlmInputDirective],
  template: `
    <div class="p-7 flex-1 overflow-y-auto animate-fade-in max-md:p-4 space-y-6">

      <!-- ─────────────────── BACK LINK ─────────────────── -->
      <a class="back-link" routerLink="/admin/apps">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>
        <span>All apps</span>
      </a>

      @if (app(); as a) {

        <!-- ─────────────────── HEADER ─────────────────── -->
        <header class="detail-head" appReveal>
          <div class="head-main">
            <div class="head-glyph" aria-hidden="true">{{ a.glyph }}</div>
            <div class="min-w-0 flex-1">
              <div class="kicker">{{ categoryLabel(a) }}</div>
              <h2 class="section-h text-2xl font-bold text-white m-0 mt-1">{{ a.name }}</h2>
              <p class="text-[0.84rem] text-text-secondary m-0 mt-1 max-w-prose leading-relaxed">{{ a.tagline }}</p>
              @if (a.tags.length > 0) {
                <div class="tag-row mt-2">
                  @for (t of a.tags; track t) {
                    <!-- Clickable → catalog filtered to every app sharing this tag. -->
                    <a class="tag-pill tag-pill--link" routerLink="/admin/apps" [queryParams]="{ tag: t }"
                       [attr.data-testid]="'apps-detail-tag-' + t" [attr.aria-label]="'Find apps tagged ' + t">{{ t }}</a>
                  }
                </div>
              }
            </div>
          </div>
        </header>

        <!-- ─────────────────── TWO-COLUMN LAYOUT ─────────────────── -->
        <div class="grid-2col">

          <!-- ─── LEFT: description + links + env table ─── -->
          <section class="space-y-5" appReveal>

            <article class="card">
              <h3 class="card-h">About</h3>
              <p class="text-[0.85rem] text-text-secondary leading-relaxed m-0">{{ a.description }}</p>
              @if (a.features?.length) {
                <ul class="feature-list" aria-label="Key features" data-testid="apps-feature-list">
                  @for (f of a.features; track f) {
                    <li class="feature-item">
                      <svg class="feature-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>
                      <span>{{ f }}</span>
                    </li>
                  }
                </ul>
              }
              <div class="meta-row">
                <a class="meta-link" [href]="a.homepage" target="_blank" rel="noopener noreferrer">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/></svg>
                  Homepage
                </a>
                <a class="meta-link" [href]="a.repo" target="_blank" rel="noopener noreferrer">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/></svg>
                  Source
                </a>
                <span class="meta-pill"><span class="meta-pill-k">License</span> {{ a.license }}</span>
                <span class="meta-pill"><span class="meta-pill-k">Port</span> {{ a.port }}</span>
                <span class="meta-pill"><span class="meta-pill-k">RAM</span> {{ a.memoryMB }} MiB</span>
                @if (a.volumeMB) {
                  <span class="meta-pill"><span class="meta-pill-k">Disk</span> {{ a.volumeMB }} MiB</span>
                }
              </div>
            </article>

            <article class="card">
              <header class="flex items-center justify-between flex-wrap gap-2 mb-3">
                <h3 class="card-h m-0">Environment variables</h3>
                <span class="text-[0.66rem] text-text-secondary font-mono">{{ a.env.length }} {{ a.env.length === 1 ? 'key' : 'keys' }} · {{ requiredCount(a) }} required</span>
              </header>
              @if (a.env.length === 0) {
                <p class="text-[0.78rem] text-text-secondary m-0">No env vars required — container runs with defaults.</p>
              } @else {
                <div class="env-table" role="table">
                  <div class="env-row env-row-head" role="row">
                    <div role="columnheader">Key</div>
                    <div role="columnheader">Description</div>
                    <div role="columnheader">Value</div>
                  </div>
                  @for (e of a.env; track e.key) {
                    <div class="env-row" role="row">
                      <div role="cell">
                        <code class="env-key">{{ e.key }}</code>
                        @if (e.required) {
                          <span class="env-req" title="Required" aria-label="Required">*</span>
                        }
                      </div>
                      <div role="cell" class="env-desc">
                        {{ e.description }}
                        @if (e.default) {
                          <div class="env-default">default: <code>{{ e.default }}</code></div>
                        }
                      </div>
                      <div role="cell" class="env-value-cell">
                        @if (e.auto) {
                          <!-- Platform-injected — not user-editable. -->
                          <span class="env-auto" [title]="autoSourceLabel(e.auto)">{{ autoSourceLabel(e.auto) }}</span>
                        } @else {
                          <!-- Customize before deploy (seeded with the default). -->
                          <input
                            class="env-input"
                            [class.env-input--missing]="e.required && !envValue(e.key).trim()"
                            [value]="envValue(e.key)"
                            (input)="setEnvOverride(e.key, $any($event.target).value)"
                            [attr.placeholder]="e.default || (e.required ? 'required' : 'optional')"
                            [attr.aria-label]="'Value for ' + e.key"
                            [attr.aria-invalid]="e.required && !envValue(e.key).trim()"
                            [attr.data-testid]="'apps-env-input-' + e.key"
                            autocomplete="off" spellcheck="false" />
                        }
                      </div>
                    </div>
                  }
                </div>
              }
            </article>

            <article class="card">
              <h3 class="card-h">Dockerfile</h3>
              <p class="text-[0.74rem] text-text-secondary leading-relaxed">
                Container image — pulled at boot:
              </p>
              <pre class="code-pre"><code>{{ dockerfilePreview() }}</code></pre>
              <div class="mt-3 flex items-center gap-2 flex-wrap">
                <a class="meta-link" [href]="a.repo" target="_blank" rel="noopener noreferrer">
                  Upstream README
                </a>
                @if (a.composeRef) {
                  <a class="meta-link" [href]="a.composeRef" target="_blank" rel="noopener noreferrer">Reference compose file</a>
                }
              </div>
            </article>
          </section>

          <!-- ─── RIGHT: deploy panel ─── -->
          <aside class="space-y-5">
            <article class="card deploy-card" appReveal>
              <h3 class="card-h">Deploy</h3>

              @if (supported()) {
              <label class="form-field">
                <span class="form-label">Subdomain</span>
                <div class="subdomain-input">
                  <input
                    type="text"
                    hlmInput
                    [seamless]="true"
                    class="subdomain-field flex-1"
                    [(ngModel)]="subdomain"
                    (ngModelChange)="onSubdomainChange($event)"
                    placeholder="my-{{ a.id }}"
                    aria-label="Subdomain"
                    [pattern]="subdomainPattern"
                    data-testid="apps-deploy-subdomain" />
                  <span class="subdomain-suffix">{{ a.image?.startsWith('cf-native:') ? '.cms.projectsites.dev' : '.app.projectsites.dev' }}</span>
                </div>
                @if (subdomainError()) {
                  <span class="form-help form-help--err">{{ subdomainError() }}</span>
                } @else {
                  <span class="form-help">Lowercase letters, digits, dashes. 3-40 chars.</span>
                }
              </label>

              <div class="checklist">
                <div class="checklist-h">Provisioning</div>
                @for (item of provisioning(); track item.key) {
                  <div class="check-row">
                    <span class="check-glyph" [class.is-managed]="item.managed">
                      @if (item.managed) {
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                      } @else {
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                      }
                    </span>
                    <span class="check-label">{{ item.label }}</span>
                    <span class="check-provider">{{ item.provider }}</span>
                  </div>
                }
              </div>

              <div class="cost-breakdown">
                <div class="cost-h">Monthly estimate</div>
                @for (line of costLines(); track line.key) {
                  <div class="cost-line">
                    <span class="cost-line-label">{{ line.label }}</span>
                    <span class="cost-line-value">$<app-rolling-counter [value]="line.monthlyUsd" /></span>
                  </div>
                }
                <div class="cost-total" role="group" [attr.aria-label]="costTotalLabel()">
                  <span class="cost-total-label" aria-hidden="true">Total</span>
                  <span class="cost-total-value" aria-hidden="true">$<app-rolling-counter [value]="totalCost()" /><span class="cost-unit">/mo</span></span>
                </div>
              </div>

              <button
                type="button"
                class="btn-deploy"
                [disabled]="!readyToDeploy() || deploying()"
                [attr.aria-busy]="deploying()"
                (click)="deploy(a)"
                data-testid="apps-deploy-cta">
                @if (deploying()) {
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="spinning"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                  <span>Provisioning…</span>
                } @else {
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 5l7 7-7 7"/></svg>
                  <span>Deploy {{ a.name }}</span>
                }
              </button>

              @if (!readyToDeploy() && !deploying()) {
                <span class="form-help form-help--muted" data-testid="apps-deploy-help">
                  @if (canDeploy() && missingRequiredEnv().length > 0) {
                    Set required env: <strong>{{ missingRequiredEnv().join(', ') }}</strong>.
                  } @else {
                    Fix the form to unlock deploy.
                  }
                </span>
              }
              } @else {
                <div class="soon-panel" data-testid="apps-deploy-soon" role="status">
                  <span class="soon-badge">Coming soon</span>
                  <p class="soon-title">{{ a.name }} isn't deployable yet</p>
                  <p class="soon-body">
                    This app is in the catalog as a preview. Its one-click runtime
                    container ships in a future drop — we'll light up Deploy here the
                    moment it's ready.
                  </p>
                </div>
              }
            </article>
          </aside>
        </div>

        <!-- AI Recommends — the 2 most-similar OTHER apps (shared tags + category). -->
        @if (recommendations().length > 0) {
          <section class="rec-section" appReveal aria-labelledby="rec-heading" data-testid="apps-ai-recommends">
            <div class="rec-head">
              <span class="rec-spark" aria-hidden="true">✦</span>
              <div class="min-w-0">
                <h3 id="rec-heading" class="rec-title">AI Recommends</h3>
                <p class="rec-sub">Matched to {{ a.name }} on shared capabilities + category.</p>
              </div>
            </div>
            <div class="rec-grid">
              @for (r of recommendations(); track r.id) {
                <a class="rec-card" [routerLink]="['/admin/apps', r.id]" [attr.data-testid]="'apps-rec-' + r.id">
                  <span class="rec-glyph" aria-hidden="true">{{ r.glyph }}</span>
                  <span class="rec-body min-w-0">
                    <span class="rec-name">{{ r.name }}</span>
                    <span class="rec-tagline">{{ r.tagline }}</span>
                  </span>
                  <span class="rec-arrow" aria-hidden="true">→</span>
                </a>
              }
            </div>
          </section>
        }

        <!-- Prev / next app — full-width pager (←/→ keys also navigate). -->
        <nav class="pager" appReveal aria-label="Browse apps" data-testid="apps-pager">
          @if (prevApp(); as p) {
            <a class="pager-cell pager-prev" [routerLink]="['/admin/apps', p.id]" [attr.data-testid]="'apps-prev-' + p.id">
              <span class="pager-arrow" aria-hidden="true">←</span>
              <span class="pager-meta min-w-0">
                <span class="pager-dir">Previous</span>
                <span class="pager-name"><span class="pager-glyph" aria-hidden="true">{{ p.glyph }}</span>{{ p.name }}</span>
              </span>
            </a>
          }
          @if (nextApp(); as n) {
            <a class="pager-cell pager-next" [routerLink]="['/admin/apps', n.id]" [attr.data-testid]="'apps-next-' + n.id">
              <span class="pager-meta min-w-0">
                <span class="pager-dir">Next</span>
                <span class="pager-name">{{ n.name }}<span class="pager-glyph" aria-hidden="true">{{ n.glyph }}</span></span>
              </span>
              <span class="pager-arrow" aria-hidden="true">→</span>
            </a>
          }
        </nav>
      } @else {
        <div class="card notice notice-red" role="alert">
          <strong>App not found.</strong>
          <span class="block text-[0.74rem] mt-1">No catalog entry with id <code class="font-mono">{{ appId() }}</code>.</span>
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .kicker {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.6rem; font-weight: 700; letter-spacing: 0.14em;
      text-transform: uppercase; color: var(--ps-accent, #00E5FF); opacity: 0.85;
    }
    .section-h { font-family: 'Sora', system-ui, sans-serif; letter-spacing: -0.02em; }
    .card-h {
      font-family: 'Sora', system-ui, sans-serif;
      font-size: 0.78rem; font-weight: 700;
      color: var(--ps-ink, #fff); letter-spacing: 0.01em;
      margin: 0 0 0.7rem 0;
    }

    .back-link {
      display: inline-flex; align-items: center; gap: 5px;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.1em;
      color: rgba(255,255,255,0.62);
      text-decoration: none; padding: 4px 8px;
      border-radius: 6px; transition: color 140ms ease, background 140ms ease;
    }
    .back-link:hover { color: var(--ps-accent, #00E5FF); background: rgba(255,255,255,0.04); }
    .back-link:focus-visible { outline: var(--ps-ring-focus, 2px solid #00E5FF); outline-offset: 2px; }

    .detail-head { padding: 0; }
    .head-main {
      display: flex; align-items: flex-start; gap: 1rem;
      padding: 1.2rem;
      background: var(--ps-surface-1, rgba(13,13,40,0.62));
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: var(--ps-radius-xl, 22px);
    }
    .head-glyph {
      flex-shrink: 0;
      width: 64px; height: 64px;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 2.2rem; line-height: 1;
      background: color-mix(in oklch, var(--ps-accent, #00E5FF) 10%, transparent);
      border: 1px solid color-mix(in oklch, var(--ps-accent, #00E5FF) 24%, transparent);
      border-radius: var(--ps-radius-sm, 12px);
    }

    .tag-row { display: flex; flex-wrap: wrap; gap: 4px; }
    .tag-pill {
      padding: 2px 8px;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.62rem; font-weight: 600;
      color: rgba(255,255,255,0.65);
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.07);
      border-radius: 999px;
    }
    /* Clickable tag → cross-find other apps with the same tag. */
    a.tag-pill--link { text-decoration: none; cursor: pointer; transition: color 0.333s ease, border-color 0.333s ease, background 0.333s ease; }
    a.tag-pill--link:hover { color: var(--ps-accent, #00E5FF); border-color: color-mix(in oklch, var(--ps-accent, #00E5FF) 45%, transparent); background: color-mix(in oklch, var(--ps-accent, #00E5FF) 8%, transparent); }
    a.tag-pill--link:focus-visible { outline: 2px solid var(--ps-accent, #00E5FF); outline-offset: 2px; }

    .grid-2col {
      display: grid; gap: 1.25rem;
      grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
    }
    @media (max-width: 1000px) {
      .grid-2col { grid-template-columns: 1fr; }
    }

    .card {
      background: var(--ps-surface-1, rgba(13,13,40,0.62));
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: var(--ps-radius-lg, 14px);
      padding: 1.2rem;
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.02);
    }

    .feature-list {
      list-style: none; margin: 0.9rem 0 0; padding: 0;
      display: grid; grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr));
      gap: 0.4rem 0.9rem;
    }
    .feature-item {
      display: flex; align-items: flex-start; gap: 0.5rem;
      font-size: 0.78rem; color: rgba(255,255,255,0.82); line-height: 1.4;
    }
    .feature-check {
      flex-shrink: 0; margin-top: 0.15rem;
      color: var(--ps-accent, #00E5FF);
    }
    .meta-row {
      display: flex; flex-wrap: wrap; gap: 6px;
      margin-top: 0.85rem;
    }
    .meta-link {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 4px 10px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 999px;
      color: var(--ps-accent, #00E5FF);
      font-size: 0.7rem; font-weight: 600;
      text-decoration: none;
      transition: background 140ms ease, border-color 140ms ease;
    }
    .meta-link:hover { background: color-mix(in oklch, var(--ps-accent, #00E5FF) 8%, rgba(255,255,255,0.04)); border-color: color-mix(in oklch, var(--ps-accent, #00E5FF) 35%, transparent); }
    .meta-pill {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 4px 10px;
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 999px;
      color: rgba(255,255,255,0.74);
      font-size: 0.7rem;
    }
    .meta-pill-k {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.58rem; text-transform: uppercase; letter-spacing: 0.08em;
      color: rgba(255,255,255,0.48);
    }

    /* ─── Env table ─── */
    .env-table {
      display: flex; flex-direction: column; gap: 0;
      border-radius: var(--ps-radius-sm, 8px); overflow: hidden;
      border: 1px solid rgba(255,255,255,0.06);
    }
    .env-row {
      display: grid;
      grid-template-columns: minmax(110px, 1fr) minmax(160px, 1.5fr) minmax(150px, 1.3fr);
      gap: 0.85rem; align-items: center;
      padding: 0.65rem 0.85rem;
      border-bottom: 1px solid rgba(255,255,255,0.05);
      font-size: 0.74rem;
    }
    .env-value-cell { display: flex; justify-content: flex-end; }
    .env-value-cell .env-auto { white-space: nowrap; }
    /* Editable env value — customize before deploy. */
    .env-input {
      width: 100%; min-width: 0;
      padding: 0.32rem 0.5rem;
      font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.7rem;
      color: var(--ps-ink, #fff);
      background: rgba(0,0,0,0.28);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 8px;
      transition: border-color 0.333s ease, box-shadow 0.333s ease;
    }
    .env-input::placeholder { color: rgba(255,255,255,0.34); }
    .env-input:focus-visible {
      outline: none;
      border-color: color-mix(in oklch, var(--ps-accent, #00E5FF) 55%, transparent);
      box-shadow: 0 0 0 2px color-mix(in oklch, var(--ps-accent, #00E5FF) 22%, transparent);
    }
    .env-input--missing { border-color: rgba(251,191,36,0.55); background: rgba(251,191,36,0.06); }
    .env-row:last-child { border-bottom: none; }
    .env-row-head {
      background: rgba(255,255,255,0.03);
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.08em;
      color: rgba(255,255,255,0.48); font-weight: 700;
    }
    .env-key {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.72rem; color: var(--ps-accent, #00E5FF);
      background: rgba(0,229,255,0.08);
      padding: 1px 6px; border-radius: 4px; word-break: break-all;
    }
    .env-req { color: #fbbf24; margin-left: 4px; font-weight: 700; }
    .env-desc { color: rgba(255,255,255,0.78); line-height: 1.45; }
    .env-default {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.62rem; color: rgba(255,255,255,0.5); margin-top: 2px;
    }
    .env-auto, .env-optional, .env-manual {
      display: inline-flex; align-items: center;
      padding: 2px 7px; border-radius: 999px;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.6rem; font-weight: 600; white-space: nowrap;
    }
    .env-auto {
      color: #34d399;
      background: rgba(52,211,153,0.1);
      border: 1px solid rgba(52,211,153,0.28);
    }
    .env-optional { color: rgba(255,255,255,0.45); border: 1px solid rgba(255,255,255,0.08); }
    .env-manual { color: #fbbf24; background: rgba(251,191,36,0.08); border: 1px solid rgba(251,191,36,0.22); }

    /* ─── Code preview ─── */
    .code-pre {
      background: rgba(0,0,0,0.42);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: var(--ps-radius-sm, 8px);
      padding: 0.85rem 1rem;
      overflow-x: auto;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.72rem; line-height: 1.6;
      color: rgba(255,255,255,0.86);
      white-space: pre;
    }

    /* ─── Deploy panel ─── */
    .deploy-card {
      position: sticky; top: 1rem;
      display: flex; flex-direction: column; gap: 1.1rem;
    }

    /* Soon (catalog-placeholder) apps: no deploy form, an honest coming-soon note. */
    .soon-panel {
      display: flex; flex-direction: column; gap: 0.5rem;
      padding: 1.1rem 1rem;
      border: 1px dashed color-mix(in oklch, var(--ps-accent, #00E5FF) 32%, transparent);
      border-radius: 12px;
      background: color-mix(in oklch, var(--ps-accent, #00E5FF) 5%, transparent);
    }
    .soon-badge {
      align-self: flex-start;
      font-size: 0.6rem; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
      padding: 2px 8px; border-radius: 999px;
      color: var(--ps-accent, #00E5FF);
      background: color-mix(in oklch, var(--ps-accent, #00E5FF) 14%, transparent);
      border: 1px solid color-mix(in oklch, var(--ps-accent, #00E5FF) 30%, transparent);
    }
    .soon-title { margin: 0; font-size: 0.86rem; font-weight: 600; color: #fff; }
    .soon-body { margin: 0; font-size: 0.74rem; line-height: 1.5; color: rgba(255,255,255,0.6); }

    .form-field { display: flex; flex-direction: column; gap: 6px; }
    .form-label {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.1em;
      color: rgba(255,255,255,0.55); font-weight: 700;
    }
    .form-help { font-size: 0.66rem; color: rgba(255,255,255,0.5); }
    .form-help--err { color: #fca5a5; }
    .form-help--muted { color: rgba(255,255,255,0.4); }

    .subdomain-input {
      display: flex; align-items: stretch;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: var(--ps-radius-sm, 8px);
      background: rgba(0,0,0,0.32);
      transition: border-color 140ms ease;
      overflow: hidden;
    }
    .subdomain-input:focus-within {
      border-color: color-mix(in oklch, var(--ps-accent, #00E5FF) 50%, transparent);
    }
    /* seamless segment inside .subdomain-input; hlmInput [seamless] owns
       border/bg/outline — this only carries padding + mono type + color */
    .subdomain-field {
      padding: 0.55rem 0.7rem;
      color: var(--ps-ink, #fff);
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.74rem;
      min-width: 0;
    }
    .subdomain-suffix {
      display: inline-flex; align-items: center;
      padding: 0.55rem 0.7rem;
      background: rgba(255,255,255,0.04);
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.7rem; color: rgba(255,255,255,0.55);
      border-left: 1px solid rgba(255,255,255,0.08);
      white-space: nowrap;
    }

    /* ─── Provisioning checklist ─── */
    .checklist { display: flex; flex-direction: column; gap: 0; }
    .checklist-h {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.1em;
      color: rgba(255,255,255,0.55); font-weight: 700;
      margin-bottom: 6px;
    }
    .check-row {
      display: grid;
      grid-template-columns: 18px 1fr auto;
      gap: 8px; align-items: center;
      padding: 0.4rem 0; font-size: 0.74rem;
      border-bottom: 1px dashed rgba(255,255,255,0.04);
    }
    .check-row:last-child { border-bottom: none; }
    .check-glyph {
      width: 18px; height: 18px;
      display: inline-flex; align-items: center; justify-content: center;
      border-radius: 50%;
      background: rgba(251,191,36,0.12); color: #fbbf24;
      border: 1px solid rgba(251,191,36,0.32);
    }
    .check-glyph.is-managed {
      background: rgba(52,211,153,0.14); color: #34d399;
      border-color: rgba(52,211,153,0.36);
    }
    .check-label { color: var(--ps-ink, #fff); font-weight: 600; }
    .check-provider {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.62rem; color: rgba(255,255,255,0.55);
    }

    /* ─── Cost breakdown ─── */
    .cost-breakdown {
      padding: 0.85rem 1rem;
      background: color-mix(in oklch, var(--ps-accent, #00E5FF) 4%, transparent);
      border: 1px solid color-mix(in oklch, var(--ps-accent, #00E5FF) 16%, transparent);
      border-radius: var(--ps-radius-sm, 10px);
    }
    .cost-h {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.1em;
      color: rgba(255,255,255,0.55); font-weight: 700; margin-bottom: 6px;
    }
    .cost-line {
      display: flex; justify-content: space-between; align-items: baseline;
      font-size: 0.74rem; padding: 4px 0;
    }
    .cost-line-label { color: rgba(255,255,255,0.7); }
    .cost-line-value {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      color: var(--ps-ink, #fff); font-weight: 600;
    }
    .cost-total {
      display: flex; justify-content: space-between; align-items: baseline;
      padding-top: 8px; margin-top: 6px;
      border-top: 1px solid color-mix(in oklch, var(--ps-accent, #00E5FF) 22%, transparent);
    }
    .cost-total-label {
      font-family: 'Sora', system-ui, sans-serif; font-size: 0.78rem;
      color: var(--ps-ink, #fff); font-weight: 600;
    }
    .cost-total-value {
      font-family: 'Sora', system-ui, sans-serif; font-size: 1.15rem;
      font-weight: 700; color: var(--ps-accent, #00E5FF);
    }
    .cost-unit { font-size: 0.62rem; color: rgba(255,255,255,0.5); font-weight: 500; margin-left: 2px; }

    /* ─── Buttons ─── */
    .btn-deploy {
      display: inline-flex; align-items: center; justify-content: center; gap: 8px;
      width: 100%;
      padding: 0.85rem 1.2rem;
      border-radius: var(--ps-radius-sm, 10px);
      background: linear-gradient(135deg, var(--ps-accent, #00E5FF) 0%, color-mix(in oklch, var(--ps-accent, #00E5FF) 70%, #7c3aed) 100%);
      color: #060610;
      font-family: 'Sora', system-ui, sans-serif;
      font-size: 0.82rem; font-weight: 700;
      border: none; cursor: pointer;
      box-shadow: 0 8px 24px -10px color-mix(in oklch, var(--ps-accent, #00E5FF) 55%, transparent);
      transition: transform 140ms ease, box-shadow 140ms ease, filter 140ms ease;
    }
    .btn-deploy:hover:not(:disabled) {
      transform: translateY(-1px);
      filter: brightness(1.08);
      box-shadow: 0 12px 32px -10px color-mix(in oklch, var(--ps-accent, #00E5FF) 70%, transparent);
    }
    .btn-deploy:disabled { opacity: 0.45; cursor: not-allowed; box-shadow: none; }
    .btn-deploy:focus-visible { outline: 2px solid #fff; outline-offset: 3px; }

    .spinning { animation: spin 900ms linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spinning { animation: none; } }

    .notice {
      display: flex; gap: 0.6rem; align-items: flex-start;
      font-size: 0.82rem; line-height: 1.5;
      padding: 0.85rem 1rem;
    }
    .notice strong { display: block; }
    .notice-red {
      background: rgba(248,113,113,0.06);
      border-color: rgba(248,113,113,0.3);
      color: #fecaca;
    }
    .notice-red strong { color: #fca5a5; }

    /* ── AI Recommends ── */
    .rec-section {
      border: 1px solid color-mix(in oklch, var(--ps-accent, #00E5FF) 16%, transparent);
      border-radius: var(--ps-radius-xl, 22px);
      background: color-mix(in oklch, var(--ps-accent, #00E5FF) 4%, transparent);
      padding: 1.1rem 1.2rem 1.2rem;
    }
    .rec-head { display: flex; align-items: flex-start; gap: 0.7rem; margin-bottom: 0.9rem; }
    .rec-spark {
      flex-shrink: 0; width: 1.9rem; height: 1.9rem; border-radius: 999px;
      display: inline-flex; align-items: center; justify-content: center;
      background: color-mix(in oklch, var(--ps-accent, #00E5FF) 16%, transparent);
      color: var(--ps-accent, #00E5FF); font-size: 0.9rem;
    }
    .rec-title { font-family: 'Sora', system-ui, sans-serif; font-weight: 700; font-size: 0.96rem; color: var(--ps-ink, #fff); margin: 0; }
    .rec-sub { font-size: 0.74rem; color: var(--text-secondary, rgba(255,255,255,0.6)); margin: 0.15rem 0 0; }
    .rec-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr)); gap: 0.7rem; }
    .rec-card {
      display: flex; align-items: center; gap: 0.75rem; text-decoration: none;
      padding: 0.8rem 0.9rem; border-radius: 14px;
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.08);
      color: var(--ps-ink, #fff);
      transition: transform 0.333s ease, border-color 0.333s ease, background 0.333s ease;
    }
    .rec-card:hover { transform: translateY(-2px); border-color: color-mix(in oklch, var(--ps-accent, #00E5FF) 45%, transparent); background: rgba(255,255,255,0.05); }
    .rec-card:focus-visible { outline: 2px solid var(--ps-accent, #00E5FF); outline-offset: 2px; }
    .rec-glyph { flex-shrink: 0; font-size: 1.35rem; line-height: 1; }
    .rec-body { display: flex; flex-direction: column; gap: 0.1rem; flex: 1; }
    .rec-name { font-weight: 600; font-size: 0.84rem; }
    .rec-tagline { font-size: 0.72rem; color: var(--text-secondary, rgba(255,255,255,0.6)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .rec-arrow { flex-shrink: 0; color: var(--ps-accent, #00E5FF); font-size: 0.95rem; opacity: 0.7; transition: transform 0.333s ease; }
    .rec-card:hover .rec-arrow { transform: translateX(3px); opacity: 1; }

    /* ── Prev / next pager ── */
    .pager { display: grid; grid-template-columns: 1fr 1fr; gap: 0.7rem; }
    @media (max-width: 560px) { .pager { grid-template-columns: 1fr; } }
    .pager-cell {
      display: flex; align-items: center; gap: 0.8rem; text-decoration: none;
      padding: 0.9rem 1rem; border-radius: 16px;
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.08);
      color: var(--ps-ink, #fff);
      transition: transform 0.333s ease, border-color 0.333s ease, background 0.333s ease;
    }
    .pager-next { justify-content: flex-end; text-align: right; }
    .pager-cell:hover { border-color: color-mix(in oklch, var(--ps-accent, #00E5FF) 45%, transparent); background: rgba(255,255,255,0.05); }
    .pager-cell:focus-visible { outline: 2px solid var(--ps-accent, #00E5FF); outline-offset: 2px; }
    .pager-arrow { flex-shrink: 0; font-size: 1.1rem; color: var(--ps-accent, #00E5FF); transition: transform 0.333s ease; }
    .pager-prev:hover .pager-arrow { transform: translateX(-3px); }
    .pager-next:hover .pager-arrow { transform: translateX(3px); }
    .pager-meta { display: flex; flex-direction: column; gap: 0.15rem; min-width: 0; }
    .pager-dir { font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.1em; font-weight: 700; color: var(--text-secondary, rgba(255,255,255,0.5)); }
    .pager-name { font-weight: 600; font-size: 0.84rem; display: inline-flex; align-items: center; gap: 0.4rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .pager-next .pager-name { justify-content: flex-end; }
    .pager-glyph { font-size: 1rem; }
  `],
})
export class AppDetailComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);

  /** Catalog position of the current app (for prev/next nav). */
  private readonly catalogIndex = computed<number>(() => {
    const cur = this.app();
    return cur ? APPS_CATALOG.findIndex((a) => a.id === cur.id) : -1;
  });

  /** Previous / next catalog app — wraps around so both arrows always resolve. */
  readonly prevApp = computed<CatalogApp | null>(() => {
    const i = this.catalogIndex();
    if (i < 0) return null;
    return APPS_CATALOG[(i - 1 + APPS_CATALOG.length) % APPS_CATALOG.length] ?? null;
  });
  readonly nextApp = computed<CatalogApp | null>(() => {
    const i = this.catalogIndex();
    if (i < 0) return null;
    return APPS_CATALOG[(i + 1) % APPS_CATALOG.length] ?? null;
  });

  /** "AI Recommends" — the 2 most similar OTHER apps, matched on shared tags
   *  (weighted) + same category. Deterministic, instant, offline; the same tag
   *  signal that powers cross-find. Always returns 2 (most-similar, even if the
   *  top score is low) so the section is never half-empty. */
  readonly recommendations = computed<CatalogApp[]>(() => {
    const cur = this.app();
    if (!cur) return [];
    return APPS_CATALOG
      .filter((b) => b.id !== cur.id)
      .map((b) => ({ b, score: this.scoreSimilarity(cur, b) }))
      .sort((x, y) => y.score - x.score || x.b.name.localeCompare(y.b.name))
      .slice(0, 2)
      .map((x) => x.b);
  });

  /** Shared-tag-weighted similarity: each shared tag = 2, same category = 1. */
  private scoreSimilarity(a: CatalogApp, b: CatalogApp): number {
    const shared = b.tags.filter((t) => a.tags.includes(t)).length;
    return shared * 2 + (a.category === b.category ? 1 : 0);
  }

  /** ←/→ navigate prev/next app — ignored while typing in a form control. */
  @HostListener('window:keydown', ['$event'])
  onArrowNav(e: KeyboardEvent): void {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const target = e.key === 'ArrowLeft' ? this.prevApp() : this.nextApp();
    if (target) {
      e.preventDefault();
      this.router.navigate(['/admin/apps', target.id]);
    }
  }
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);
  private state = inject(AdminStateService);

  appId = signal<string>('');
  app = signal<CatalogApp | null>(null);
  subdomain = '';
  deploying = signal<boolean>(false);

  private subdomainTouched = signal<boolean>(false);
  private subdomainSignal = signal<string>('');

  /** Per-line cost breakdown — container + every infra provider. */
  costLines = computed<readonly InfraEstimate[]>(() => {
    const a = this.app();
    if (!a) return [];
    const container: InfraEstimate = {
      key: 'container',
      label: 'Container (Cloudflare Workers)',
      provider: 'CFC',
      monthlyUsd: Math.max(1, a.estCostMonthly - this.sumInfra(a)),
    };
    const infra = withHyperdrive(a.infra).map((d) => INFRA_PROVIDER_COST[d]);
    return [container, ...infra];
  });

  totalCost = computed<number>(() => this.costLines().reduce((acc, l) => acc + l.monthlyUsd, 0));

  /**
   * Complete accessible name for the cost-total group. The `<app-rolling-counter>`
   * inside exposes only the bare digits to AT, so the surrounding "Total" label and
   * the "/mo" unit are `aria-hidden` and the meaning is carried here instead — one
   * programmatic phrase a screen reader reads as a unit.
   */
  costTotalLabel = computed<string>(() => `Total monthly cost: $${this.totalCost()} per month`);

  /**
   * Synthetic Dockerfile shown on the detail page. Built off-template so
   * `}` in template literals doesn't collide with Angular's @-block syntax.
   */
  dockerfilePreview = computed<string>(() => {
    const a = this.app();
    if (!a) return '';
    const envLines = a.env.map((e) => {
      const value = e.auto ? `<from-${e.auto}>` : e.default ?? '<configured-at-deploy>';
      return `ENV ${e.key}=${value}`;
    });
    return [
      `FROM ${a.image}`,
      '',
      `EXPOSE ${a.port}`,
      '',
      '# Auto-resolved by the deploy pipeline:',
      ...envLines,
    ].join('\n');
  });

  /** Provisioning checklist — every infra dep + whether the platform manages it. */
  provisioning = computed<ReadonlyArray<{ key: string; label: string; provider: string; managed: boolean }>>(() => {
    const a = this.app();
    if (!a) return [];
    return withHyperdrive(a.infra).map((d) => ({
      key: d,
      label: INFRA_META[d].label,
      provider: INFRA_PROVIDER_COST[d].provider,
      managed: d !== 'mailrelay',
    }));
  });

  subdomainError = computed<string | null>(() => {
    if (!this.subdomainTouched()) return null;
    const v = this.subdomainSignal().trim();
    if (!v) return 'Subdomain is required.';
    if (v.length < 3) return 'Min 3 characters.';
    if (v.length > 40) return 'Max 40 characters.';
    if (!/^[a-z0-9-]+$/.test(v)) return 'Lowercase letters, digits, and dashes only.';
    if (v.startsWith('-') || v.endsWith('-')) return 'Cannot start or end with a dash.';
    return null;
  });

  canDeploy = computed<boolean>(() => {
    const v = this.subdomainSignal().trim();
    return v.length >= 3 && v.length <= 40 && /^[a-z0-9-]+$/.test(v) && !v.startsWith('-') && !v.endsWith('-');
  });

  /** User-customized env values (brief: customize env vars before deploy). Seeded
   *  from each non-`auto` var's default when the app resolves; only non-empty
   *  values ride along as `env_overrides`. Auto (platform-injected) vars excluded. */
  envOverrides = signal<Record<string, string>>({});

  envValue(key: string): string {
    return this.envOverrides()[key] ?? '';
  }

  setEnvOverride(key: string, value: string): void {
    this.envOverrides.update((m) => ({ ...m, [key]: value }));
  }

  /** Required, user-provided (non-auto) env keys still missing a value. */
  readonly missingRequiredEnv = computed<string[]>(() => {
    const a = this.app();
    if (!a) return [];
    const o = this.envOverrides();
    return a.env.filter((e) => e.required && !e.auto && !(o[e.key] ?? '').trim()).map((e) => e.key);
  });

  /** Deploy-ready only when the subdomain is valid AND every required user-var is set. */
  readonly readyToDeploy = computed<boolean>(() => this.canDeploy() && this.missingRequiredEnv().length === 0);

  /** Live (deployable today) vs Soon (catalog placeholder — no runtime container yet). */
  readonly supported = computed<boolean>(() => {
    const a = this.app();
    return !!a && isAppSupported(a.id);
  });

  ngOnInit(): void {
    // Subscribe (not snapshot) so prev/next nav — which re-uses THIS component
    // with a new `:id` — re-resolves the app instead of showing the old one.
    this.route.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((pm) => {
      const id = pm.get('id') ?? '';
      this.appId.set(id);
      const found = APPS_CATALOG.find((a) => a.id === id) ?? null;
      this.app.set(found);
      if (found) {
        this.subdomain = `${found.id}-${this.shortSlug()}`;
        this.subdomainSignal.set(this.subdomain);
        // Pre-fill the editable env inputs with each user-provided var's default.
        const seed: Record<string, string> = {};
        for (const e of found.env) {
          if (!e.auto) seed[e.key] = e.default ?? '';
        }
        this.envOverrides.set(seed);
      }
    });
  }

  onSubdomainChange(value: string): void {
    this.subdomainTouched.set(true);
    this.subdomainSignal.set(value);
  }

  /**
   * Native-validation pattern for the subdomain input. Chrome compiles HTML
   * `pattern` attributes as `v`-flag regexes, which REJECT any unescaped dash
   * in a character class ("Invalid character class" console error — the
   * chaos-15 console gate caught it 2026-08-19). The runtime string must carry
   * the literal `\-` escape; Angular's template compiler collapses `\-` in a
   * static attribute, so the value is bound from this TS constant (whose
   * source `\\-` survives compilation as `\-`).
   */
  readonly subdomainPattern = '[\\-a-z0-9]+';

  categoryLabel(a: CatalogApp): string {
    return a.category.charAt(0).toUpperCase() + a.category.slice(1);
  }

  requiredCount(a: CatalogApp): number {
    return a.env.filter((e) => e.required).length;
  }

  autoSourceLabel(auto: NonNullable<CatalogApp['env'][number]['auto']>): string {
    switch (auto) {
      case 'postgres_url': return 'auto · postgres';
      case 'redis_url':    return 'auto · redis';
      case 's3_url':       return 'auto · r2';
      case 'public_url':   return 'auto · domain';
      case 'secret':       return 'auto · secret';
      default:             return 'auto';
    }
  }

  private sumInfra(a: CatalogApp): number {
    return a.infra.reduce((acc, d) => acc + INFRA_PROVIDER_COST[d].monthlyUsd, 0);
  }

  private shortSlug(): string {
    const s = this.state.selectedSite();
    if (!s) return 'app';
    return (s.slug || s.business_name || 'app').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 12).replace(/-+$/, '');
  }

  /**
   * POST `/api/apps/instances` and route to the boot-progress detail.
   *
   * The worker-side handler is wired by the backend agent — failures
   * surface via the standard toast pipeline.
   */
  async deploy(a: CatalogApp): Promise<void> {
    // Soon apps have no runtime container yet — never POST a doomed deploy.
    // readyToDeploy also blocks until every REQUIRED user-provided var has a value.
    if (!isAppSupported(a.id) || !this.readyToDeploy() || this.deploying()) return;

    // A4 — never SILENTLY provision billable infra. Show exactly which managed
    // resources will be created + the monthly estimate, and require an explicit
    // confirm before the POST. `danger:false` → cyan (creating, not destroying).
    const managed = this.provisioning().filter((p) => p.managed);
    // CF-native apps (empty `infra`) provision a dedicated D1 + R2 + Worker stack,
    // not a container — say so exactly so the confirm copy never lies.
    const infraSummary = managed.length
      ? managed.map((p) => p.provider).join(', ')
      : a.infra.length === 0
        ? 'a dedicated Cloudflare D1 database, R2 bucket & Worker'
        : 'a managed container';
    const ok = await this.confirm.confirm({
      title: `Deploy ${a.name}?`,
      message: `This provisions ${infraSummary} on your account at an estimated ~$${this.totalCost()}/mo (estimate, not exact billing). You can destroy it anytime.`,
      confirmLabel: 'Deploy',
      danger: false,
    });
    if (!ok) return;

    this.deploying.set(true);
    // Only non-empty values ride along; the worker fills auto vars + defaults.
    const env_overrides: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.envOverrides())) {
      if (v.trim()) env_overrides[k] = v.trim();
    }
    const payload = {
      app_id: a.id,
      subdomain: this.subdomain.trim(),
      env_overrides,
    };
    this.api.post<{ instance_id: string }>('/apps/instances', payload).subscribe({
      next: (r) => {
        this.deploying.set(false);
        const id = r.instance_id;
        this.toast.success(`${a.name} provisioning — booting container`);
        if (id) {
          this.router.navigate(['/admin/apps/instances', id]);
        } else {
          this.router.navigate(['/admin/apps/instances']);
        }
      },
      error: () => {
        this.deploying.set(false);
        // Error toast handled inside ApiService — no double-fire here.
        console.warn('[apps] deploy failed', a.id);
      },
    });
  }
}
