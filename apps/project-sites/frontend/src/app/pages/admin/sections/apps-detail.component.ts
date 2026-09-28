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
import { AppSecretInputComponent } from './app-secret-input.component';
import { APP_SCREENSHOTS } from './app-screenshots.data';
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
  imports: [FormsModule, RouterLink, RevealDirective, RollingCounterComponent, HlmInputDirective, AppSecretInputComponent],
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
            <div class="head-glyph" aria-hidden="true">
              @if (a.logo) {
                <img class="head-logo" [src]="a.logo" [alt]="a.name + ' logo'" loading="eager" decoding="async" />
              } @else {
                {{ a.glyph }}
              }
            </div>
            <div class="min-w-0 flex-1">
              <div class="kicker">{{ categoryLabel(a) }}</div>
              <h1 class="section-h text-2xl font-bold text-white m-0 mt-1">{{ a.name }}</h1>
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

        <!-- ─────────────────── SCREENSHOT CAROUSEL ─────────────────── -->
        @if (screenshots().length) {
          <section class="shots-card" appReveal [attr.aria-label]="'Screenshots of ' + a.name">
            <div class="shots-track" #shotsTrack (scroll)="onShotsScroll(shotsTrack)"
                 tabindex="0" role="group"
                 [attr.aria-label]="a.name + ' screenshots — arrow keys, side buttons, or dots to browse'">
              @for (shot of screenshots(); track shot; let i = $index) {
                <img class="shot" [src]="shot" [alt]="a.name + ' preview ' + (i + 1)"
                     loading="lazy" decoding="async"
                     (error)="$any($event.target).style.display='none'" />
              }
            </div>
            @if (screenshots().length > 1) {
              <button type="button" class="shots-nav shots-prev" (click)="scrollShots(shotsTrack, -1)" aria-label="Previous image">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>
              </button>
              <button type="button" class="shots-nav shots-next" (click)="scrollShots(shotsTrack, 1)" aria-label="Next image">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
              </button>
              <div class="shots-dots" aria-hidden="true">
                @for (shot of screenshots(); track shot; let i = $index) {
                  <button type="button" class="shots-dot" [class.active]="activeShot() === i"
                          (click)="goToShot(shotsTrack, i)" tabindex="-1"
                          [attr.aria-label]="'Go to image ' + (i + 1)"></button>
                }
              </div>
            }
          </section>
        }

        <!-- ─────────────────── TWO-COLUMN LAYOUT ─────────────────── -->
        <div class="grid-2col">

          <!-- ─── LEFT: description + links + env table ─── -->
          <section class="space-y-5" appReveal>

            <article class="card">
              <h2 class="card-h">About</h2>
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
                @if (a.image?.startsWith('cf-native:')) {
                  <span class="meta-pill"><span class="meta-pill-k">Runtime</span> Cloudflare Worker · edge</span>
                } @else {
                  <span class="meta-pill"><span class="meta-pill-k">Port</span> {{ a.port }}</span>
                  <span class="meta-pill"><span class="meta-pill-k">RAM</span> {{ a.memoryMB }} MiB</span>
                  @if (a.volumeMB) {
                    <span class="meta-pill"><span class="meta-pill-k">Disk</span> {{ a.volumeMB }} MiB</span>
                  }
                }
              </div>
            </article>

            <article class="card">
              <header class="flex items-center justify-between flex-wrap gap-2 mb-3">
                <h2 class="card-h m-0">Environment variables</h2>
                <span class="text-[0.66rem] text-text-secondary font-mono">{{ a.env.length }} {{ a.env.length === 1 ? 'key' : 'keys' }} · {{ requiredCount(a) }} required</span>
              </header>
              @if (a.env.length === 0) {
                <p class="text-[0.78rem] text-text-secondary m-0">No env vars required — {{ a.image?.startsWith('cf-native:') ? 'the Worker' : 'the container' }} runs with defaults.</p>
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
                        @if (e.auto && !isEditingAuto(e.key)) {
                          <!-- Platform-injected default — click to OVERRIDE with a manual value. -->
                          <button type="button" class="env-auto env-auto--editable"
                                  (click)="startEditAuto(e.key)"
                                  [title]="'Click to set a custom ' + e.key"
                                  [attr.aria-label]="'Override ' + e.key + ' (currently ' + autoSourceLabel(e.auto) + ')'"
                                  [attr.data-testid]="'apps-env-auto-' + e.key">
                            {{ autoSourceLabel(e.auto) }}
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
                          </button>
                        } @else {
                          <!-- Manual override (auto vars) OR a normal user var — masked, with reveal. -->
                          <app-secret-input
                            [value]="envValue(e.key)"
                            (valueChange)="setEnvOverride(e.key, $event)"
                            (valueBlur)="e.auto && onAutoBlur(e.key)"
                            [placeholder]="e.auto ? ('override ' + autoSourceLabel(e.auto)) : (e.default || (e.required ? 'required' : 'optional'))"
                            [ariaLabel]="'Value for ' + e.key"
                            [testid]="'apps-env-input-' + e.key" />
                        }
                      </div>
                    </div>
                  }
                </div>
              }

              <!-- Owner-added custom env vars, applied AT LAUNCH — the primary editor for
                   CF-native apps (empty catalog env) + extra vars for any app. -->
              <div class="custom-env">
                <div class="custom-env-head">
                  <span class="custom-env-title">Custom variables</span>
                  <span class="custom-env-sub">applied at launch</span>
                </div>
                @if (customEnv().length === 0) {
                  <p class="text-[0.74rem] text-text-secondary m-0">None yet — add keys the {{ a.image?.startsWith('cf-native:') ? 'Worker' : 'container' }} should start with.</p>
                }
                @for (row of customEnv(); track $index) {
                  <div class="custom-env-row">
                    <input class="env-input custom-env-key" [value]="row.key"
                           (input)="setEnvRowKey($index, $any($event.target).value)"
                           placeholder="KEY" [attr.aria-label]="'Custom env name ' + ($index + 1)"
                           [attr.data-testid]="'apps-env-custom-key-' + $index"
                           autocomplete="off" spellcheck="false" />
                    <app-secret-input class="custom-env-val"
                           [value]="row.value"
                           (valueChange)="setEnvRowValue($index, $event)"
                           placeholder="value" [ariaLabel]="'Custom env value ' + ($index + 1)"
                           [testid]="'apps-env-custom-val-' + $index" />
                    <button type="button" class="custom-env-remove" (click)="removeEnvRow($index)"
                            [attr.aria-label]="'Remove custom env ' + ($index + 1)">✕</button>
                  </div>
                }
                <button type="button" class="btn-add-env" (click)="addEnvRow()" data-testid="apps-env-add-row">
                  <span aria-hidden="true">+</span> Add variable
                </button>
                @if (invalidEnvKeys()) {
                  <p class="text-[0.7rem] mt-1 m-0" style="color: var(--ps-warning, #ffb454);" role="alert">
                    Names must start with a letter or underscore (A–Z, 0–9, _ only).
                  </p>
                }
              </div>
            </article>

            <article class="card">
              @if (a.image?.startsWith('cf-native:')) {
                <h2 class="card-h">Runtime</h2>
                <p class="text-[0.74rem] text-text-secondary leading-relaxed">
                  Deployed as a real <strong>Cloudflare Worker</strong> on the edge network via
                  Workers for Platforms — <em>not</em> a container. Each instance runs in the V8
                  isolate model (no Dockerfile, no image pull, no container cold-start) with its
                  own D1 database + R2 bucket.
                </p>
                <ul class="text-[0.74rem] text-text-secondary leading-relaxed mt-2 space-y-1 list-none p-0">
                  <li><span class="meta-pill-k">Compute</span> Cloudflare Workers (WfP dispatch)</li>
                  <li><span class="meta-pill-k">Database</span> Cloudflare D1 (per instance)</li>
                  <li><span class="meta-pill-k">Storage</span> Cloudflare R2 (per instance)</li>
                </ul>
              } @else {
                <h2 class="card-h">Dockerfile</h2>
                <p class="text-[0.74rem] text-text-secondary leading-relaxed">
                  Container image — pulled at boot:
                </p>
                <pre class="code-pre"><code>{{ dockerfilePreview() }}</code></pre>
              }
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
              <h2 class="card-h">Deploy</h2>

              @if (supported()) {
              <label class="form-field">
                <span class="form-label">Subdomain</span>
                <div class="subdomain-input"
                     [class.subdomain-input--valid]="subdomainValid() === true && subdomainAvailable() === true"
                     [class.subdomain-input--invalid]="subdomainValid() === false || subdomainAvailable() === false"
                     [class.subdomain-input--checking]="subdomainChecking()">
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
                    [attr.aria-invalid]="(subdomainValid() === false || subdomainAvailable() === false)"
                    data-testid="apps-deploy-subdomain" />
                  @if (subdomainChecking()) {
                    <span class="subdomain-check-icon subdomain-check-icon--checking" aria-hidden="true"></span>
                  } @else if (subdomainValid() === true && subdomainAvailable() === true) {
                    <span class="subdomain-check-icon subdomain-check-icon--valid" aria-hidden="true">✓</span>
                  } @else if (subdomainValid() === false || subdomainAvailable() === false) {
                    <span class="subdomain-check-icon subdomain-check-icon--invalid" aria-hidden="true">✕</span>
                  }
                  <span class="subdomain-suffix">{{ a.image?.startsWith('cf-native:') ? '.cms.projectsites.dev' : '.app.projectsites.dev' }}</span>
                </div>
                @if (subdomainChecking()) {
                  <span class="form-help" role="status" aria-live="polite">Checking availability…</span>
                } @else if (subdomainError()) {
                  <span class="form-help form-help--err">{{ subdomainError() }}</span>
                } @else if (subdomainCheckMessage()) {
                  <span class="form-help form-help--err" aria-live="polite" role="status">{{ subdomainCheckMessage() }}</span>
                } @else if (subdomainValid() === true && subdomainAvailable() === true) {
                  <span class="form-help form-help--ok" aria-live="polite" role="status">✓ Available</span>
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
                  @if (canDeploy() && subdomainAvailable() === true && subdomainValid() === true && missingRequiredEnv().length > 0) {
                    Set required env: <strong>{{ missingRequiredEnv().join(', ') }}</strong>.
                  } @else if (!canDeploy() || subdomainValid() === false || subdomainAvailable() === false) {
                    Fix subdomain to unlock deploy.
                  } @else {
                    Fix the form to unlock deploy.
                  }
                </span>
              }

              <!-- Instances Table -->
              @if (instances().length > 0) {
                <div class="instances-section">
                  <div class="instances-head">
                    <h3 class="instances-h">Active Instances ({{ instances().length }})</h3>
                    <a class="instances-manage" [routerLink]="['/admin/apps/instances']">
                      Manage all →
                    </a>
                  </div>
                  <div class="instances-table">
                    <div class="instances-row instances-row-head">
                      <div class="instances-col">Subdomain</div>
                      <div class="instances-col">Status</div>
                      <div class="instances-col instances-col-menu"></div>
                    </div>
                    @for (inst of instances(); track inst.id) {
                      <div class="instances-row">
                        <div class="instances-col">
                          <code class="instances-code">{{ inst.subdomain }}</code>
                        </div>
                        <div class="instances-col">
                          <span class="instances-pill instances-pill--{{ inst.status }}">{{ inst.status }}</span>
                        </div>
                        <div class="instances-col instances-col-menu">
                          <button
                            class="instances-menu-btn"
                            [attr.aria-label]="'Menu for ' + inst.subdomain"
                            (click)="toggleInstanceMenu(inst.id, $event)"
                            type="button">
                            ⋮
                          </button>
                          @if (openMenuInstanceId() === inst.id) {
                            <div class="instances-menu" role="menu"
                                 [style.top.px]="menuPos().top" [style.right.px]="menuPos().right">
                              <a
                                class="instances-menu-item"
                                [routerLink]="['/admin/apps/instances', inst.id]"
                                role="menuitem">
                                Manage
                              </a>
                              <button
                                class="instances-menu-item"
                                (click)="openInstanceLive(inst)"
                                type="button"
                                role="menuitem">
                                Open
                              </button>
                              <button
                                class="instances-menu-item instances-menu-item--danger"
                                (click)="deleteInstance(inst.id)"
                                type="button"
                                role="menuitem">
                                Delete
                              </button>
                              <button
                                class="instances-menu-item"
                                (click)="cloneInstance(inst)"
                                type="button"
                                role="menuitem">
                                Clone
                              </button>
                            </div>
                          }
                        </div>
                      </div>
                    }
                  </div>
                </div>
              } @else if (supported()) {
                <div class="instances-empty">No instances launched yet</div>
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
                <h2 id="rec-heading" class="rec-title">AI Recommends</h2>
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
      overflow: hidden;
    }
    .head-logo { width: 62%; height: 62%; object-fit: contain; display: block; }

    /* ─── Screenshot carousel ─── */
    .shots-card {
      position: relative;
      border-radius: var(--ps-radius-xl, 22px);
      border: 1px solid rgba(255,255,255,0.06);
      background: var(--ps-surface-1, rgba(13,13,40,0.62));
      overflow: hidden;
    }
    .shots-track {
      display: flex; gap: 12px; overflow-x: auto;
      scroll-snap-type: x mandatory; scroll-behavior: smooth;
      padding: 14px; scrollbar-width: none;
    }
    .shots-track::-webkit-scrollbar { display: none; }
    .shots-track:focus-visible { outline: 2px solid var(--ps-accent, #00E5FF); outline-offset: -2px; border-radius: var(--ps-radius-sm, 10px); }
    .shot {
      scroll-snap-align: center; flex: 0 0 100%;
      height: clamp(200px, 42vh, 420px); width: 100%; max-width: 100%;
      border-radius: var(--ps-radius-sm, 10px);
      border: 1px solid rgba(255,255,255,0.08);
      object-fit: contain; background: #0b0b16;
    }
    .shots-nav {
      position: absolute; top: 50%; transform: translateY(-50%);
      width: 40px; height: 40px; border-radius: 50%;
      display: inline-flex; align-items: center; justify-content: center;
      background: rgba(6,6,16,0.72); border: 1px solid rgba(255,255,255,0.14);
      color: #fff; cursor: pointer; backdrop-filter: blur(6px);
      transition: background 140ms ease, border-color 140ms ease;
    }
    .shots-nav:hover { background: rgba(0,229,255,0.25); border-color: var(--ps-accent, #00E5FF); }
    .shots-nav:focus-visible { outline: var(--ps-ring-focus, 2px solid #00E5FF); outline-offset: 2px; }
    .shots-prev { left: 10px; }
    .shots-next { right: 10px; }
    .shots-dots {
      position: absolute; left: 0; right: 0; bottom: 12px;
      display: flex; justify-content: center; gap: 7px; pointer-events: none;
    }
    .shots-dot {
      pointer-events: auto; width: 7px; height: 7px; padding: 0; border: 0;
      border-radius: 999px; background: rgba(255,255,255,0.3); cursor: pointer;
      box-shadow: 0 1px 3px rgba(0,0,0,0.5);
      transition: width 180ms ease, background 180ms ease;
    }
    .shots-dot:hover { background: rgba(255,255,255,0.55); }
    .shots-dot.active { width: 20px; background: var(--ps-accent, #00E5FF); }
    .shots-dot:focus-visible { outline: 2px solid var(--ps-accent, #00E5FF); outline-offset: 2px; }
    @media (prefers-reduced-motion: reduce) { .shots-track { scroll-behavior: auto; } }
    /* Tighten the frame on phones so a wide screenshot doesn't letterbox into dead space. */
    @media (max-width: 640px) { .shot { height: clamp(170px, 26vh, 240px); } }

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
    .env-value-cell { display: flex; justify-content: flex-start; }
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

    .custom-env { margin-top: 0.9rem; padding-top: 0.9rem; border-top: 1px solid rgba(255,255,255,0.07); display: flex; flex-direction: column; gap: 8px; }
    .custom-env-head { display: flex; align-items: baseline; gap: 8px; }
    .custom-env-title { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.66rem; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ps-accent, #00E5FF); opacity: 0.85; }
    .custom-env-sub { font-size: 0.62rem; color: rgba(255,255,255,0.5); }
    .custom-env-row { display: grid; grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.3fr) 30px; gap: 6px; align-items: center; }
    .custom-env-remove {
      display: inline-flex; align-items: center; justify-content: center;
      width: 30px; height: 30px; padding: 0; border: none; background: none; cursor: pointer;
      color: rgba(255,255,255,0.5); border-radius: 6px; font-size: 0.9rem;
    }
    .custom-env-remove:hover { color: #fca5a5; background: rgba(255,255,255,0.05); }
    .custom-env-remove:focus-visible { outline: var(--ps-ring-focus, 2px solid #00E5FF); outline-offset: 2px; }
    .btn-add-env {
      align-self: flex-start; display: inline-flex; align-items: center; gap: 6px;
      padding: 5px 12px; border-radius: 8px; cursor: pointer;
      background: color-mix(in oklch, var(--ps-accent, #00E5FF) 10%, transparent);
      border: 1px solid color-mix(in oklch, var(--ps-accent, #00E5FF) 30%, transparent);
      color: var(--ps-accent, #00E5FF); font-size: 0.72rem; font-weight: 600;
    }
    .btn-add-env:hover { background: color-mix(in oklch, var(--ps-accent, #00E5FF) 18%, transparent); }
    .btn-add-env:focus-visible { outline: var(--ps-ring-focus, 2px solid #00E5FF); outline-offset: 2px; }
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
    /* The auto chip is a real button that opens a manual override on click. */
    .env-auto--editable { gap: 5px; cursor: pointer; transition: background 140ms ease, border-color 140ms ease; }
    .env-auto--editable:hover { background: rgba(52,211,153,0.2); border-color: rgba(52,211,153,0.5); }
    .env-auto--editable:focus-visible { outline: var(--ps-ring-focus, 2px solid #00E5FF); outline-offset: 2px; }

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
    /* Live availability state — colors the whole field green/red from the get-go. */
    .subdomain-input--valid {
      border-color: rgba(52,211,153,0.7);
      background: rgba(52,211,153,0.08);
    }
    .subdomain-input--valid:focus-within { border-color: #34d399; }
    .subdomain-input--invalid {
      border-color: rgba(248,113,113,0.7);
      background: rgba(248,113,113,0.08);
    }
    .subdomain-input--invalid:focus-within { border-color: #f87171; }
    /* Checking wins the neutral look — a subtle accent hairline while the round-trip is in flight. */
    .subdomain-input--checking { border-color: color-mix(in oklch, var(--ps-accent, #00E5FF) 45%, transparent); }
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

    /* ─── Subdomain validity ─── */
    /* The check icon is a normal flex child sitting directly to the RIGHT of the input (before the
       suffix) — never absolutely positioned over the suffix text, so it can't overlap. */
    .subdomain-check-icon {
      display: inline-flex; align-items: center; justify-content: center;
      padding: 0 0.5rem; font-weight: 700; font-size: 0.9rem; flex: 0 0 auto;
    }
    .subdomain-check-icon--valid { color: #34d399; }
    .subdomain-check-icon--invalid { color: #fca5a5; }
    .subdomain-check-icon--checking {
      width: 12px; height: 12px; margin-top: -1px;
      border: 2px solid color-mix(in oklch, var(--ps-accent, #00E5FF) 35%, transparent);
      border-top-color: var(--ps-accent, #00E5FF);
      border-radius: 50%;
      animation: spin 700ms linear infinite;
    }
    @media (prefers-reduced-motion: reduce) { .subdomain-check-icon--checking { animation: none; } }
    .form-help--ok { color: #34d399; }

    /* ─── Instances table ─── */
    .instances-section {
      display: flex; flex-direction: column; gap: 0.6rem; margin-top: 1.1rem;
    }
    .instances-head {
      display: flex; align-items: center; justify-content: space-between; gap: 1rem;
    }
    .instances-h {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.1em;
      color: rgba(255,255,255,0.55); font-weight: 700; margin: 0;
    }
    .instances-manage {
      font-size: 0.72rem; font-weight: 600; color: var(--ps-accent, #00e5ff);
      text-decoration: none; white-space: nowrap; padding: 2px 4px; border-radius: 6px;
      transition: opacity 0.15s ease;
    }
    .instances-manage:hover { text-decoration: underline; opacity: 0.85; }
    .instances-manage:focus-visible { outline: 2px solid var(--ps-accent, #00e5ff); outline-offset: 2px; }
    .instances-table {
      display: flex; flex-direction: column; gap: 0; overflow: hidden;
      border: 1px solid rgba(255,255,255,0.06); border-radius: var(--ps-radius-sm, 8px);
    }
    .instances-row {
      display: grid;
      grid-template-columns: 1fr 120px 40px;
      gap: 0.6rem; align-items: center;
      padding: 0.65rem 0.85rem;
      border-bottom: 1px solid rgba(255,255,255,0.05);
      font-size: 0.74rem;
    }
    .instances-row:last-child { border-bottom: none; }
    .instances-row-head {
      background: rgba(255,255,255,0.03);
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.08em;
      color: rgba(255,255,255,0.48); font-weight: 700;
      padding: 0.5rem 0.85rem;
    }
    .instances-col { display: flex; align-items: center; min-width: 0; }
    .instances-col-menu { justify-content: flex-end; position: relative; }
    .instances-code {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.72rem; color: var(--ps-accent, #00E5FF);
      background: rgba(0,229,255,0.08);
      padding: 2px 6px; border-radius: 4px; word-break: break-all;
    }
    .instances-pill {
      display: inline-flex; align-items: center;
      padding: 2px 7px; border-radius: 999px;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.6rem; font-weight: 600; white-space: nowrap;
      background: rgba(52,211,153,0.1); color: #34d399; border: 1px solid rgba(52,211,153,0.28);
    }
    .instances-pill--error { background: rgba(248,113,113,0.1); color: #fecaca; border-color: rgba(248,113,113,0.3); }
    .instances-menu-btn {
      background: none; border: none; color: rgba(255,255,255,0.6); cursor: pointer;
      font-size: 1.2rem; padding: 4px 8px; border-radius: 6px;
      transition: color 140ms ease, background 140ms ease;
    }
    .instances-menu-btn:hover { color: var(--ps-accent, #00E5FF); background: rgba(255,255,255,0.04); }
    .instances-menu-btn:focus-visible { outline: 2px solid var(--ps-accent, #00E5FF); outline-offset: 2px; }
    .instances-menu {
      position: fixed; z-index: 99950;
      background: var(--ps-surface-1, rgba(13,13,40,0.92)); border: 1px solid rgba(255,255,255,0.1);
      border-radius: var(--ps-radius-sm, 8px); box-shadow: 0 8px 24px rgba(0,0,0,0.4);
      min-width: 120px; overflow: hidden;
    }
    .instances-menu-item {
      display: block; width: 100%; text-align: left;
      padding: 0.6rem 0.85rem; background: none; border: none;
      font-size: 0.74rem; color: rgba(255,255,255,0.8); cursor: pointer;
      transition: background 140ms ease, color 140ms ease;
    }
    .instances-menu-item:hover { background: rgba(255,255,255,0.08); color: var(--ps-accent, #00E5FF); }
    .instances-menu-item--danger:hover { background: rgba(248,113,113,0.15); color: #fecaca; }
    .instances-empty {
      font-size: 0.74rem; color: rgba(255,255,255,0.5); padding: 0.8rem 1rem;
      text-align: center; font-style: italic;
    }

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

  subdomainTouched = signal<boolean>(false);
  private subdomainSignal = signal<string>('');
  private subdomainCheckTimer: any;
  subdomainValid = signal<boolean | null>(null);
  subdomainAvailable = signal<boolean | null>(null);
  subdomainCheckMessage = signal<string>('');
  /** True while a debounced availability round-trip is in flight (drives the neutral "Checking…" state). */
  subdomainChecking = signal<boolean>(false);
  instances = signal<Array<{ id: string; app_id: string; app_slug?: string; subdomain: string; host: string; status: string; created_at: string }>>([]);
  openMenuInstanceId = signal<string | null>(null);
  /** Fixed-overlay coords for the open ⋮ menu — captured from the button so the instances
   *  table's `overflow:hidden` (rounded corners) never crops the dropdown. */
  menuPos = signal<{ top: number; right: number }>({ top: 0, right: 0 });

  /** Toggle a row's ⋮ menu; anchor it as a viewport-fixed overlay under the button. */
  toggleInstanceMenu(id: string, ev: Event): void {
    if (this.openMenuInstanceId() === id) {
      this.openMenuInstanceId.set(null);
      return;
    }
    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    this.menuPos.set({
      top: Math.round(rect.bottom + 4),
      right: Math.round(window.innerWidth - rect.right),
    });
    this.openMenuInstanceId.set(id);
  }

  /** Per-line cost breakdown — container + every infra provider. */
  costLines = computed<readonly InfraEstimate[]>(() => {
    const a = this.app();
    if (!a) return [];
    // CF-native apps run as a real edge Worker (Workers for Platforms) on their own
    // D1 + R2 — NOT a container. Reflect that in the cost breakdown.
    if (a.image?.startsWith('cf-native:')) {
      return [
        { key: 'worker', label: 'Cloudflare Worker (edge)', provider: 'CF Workers for Platforms', monthlyUsd: Math.max(1, a.estCostMonthly - 1) },
        { key: 'd1', label: 'D1 database', provider: 'Cloudflare D1', monthlyUsd: 0 },
        { key: 'r2', label: 'R2 bucket', provider: 'Cloudflare R2', monthlyUsd: 1 },
      ];
    }
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

  /** Owner-added custom env vars set AT LAUNCH (key+value rows), merged into env_overrides on
   *  deploy. The primary env editor for CF-native apps (whose catalog env is empty) + extra
   *  vars for container apps. Reset per-app in ngOnInit. */
  customEnv = signal<Array<{ key: string; value: string }>>([]);

  addEnvRow(): void {
    this.customEnv.update((r) => [...r, { key: '', value: '' }]);
  }
  removeEnvRow(idx: number): void {
    this.customEnv.update((r) => r.filter((_, i) => i !== idx));
  }
  setEnvRowKey(idx: number, key: string): void {
    this.customEnv.update((r) => r.map((row, i) => (i === idx ? { ...row, key } : row)));
  }
  setEnvRowValue(idx: number, value: string): void {
    this.customEnv.update((r) => r.map((row, i) => (i === idx ? { ...row, value } : row)));
  }
  /** True when a custom row has a non-empty key that isn't a valid env identifier — blocks deploy. */
  readonly invalidEnvKeys = computed<boolean>(() =>
    this.customEnv().some(
      (r) => r.key.trim() !== '' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(r.key.trim()),
    ),
  );

  /** Auto (platform-injected) catalog vars the owner chose to OVERRIDE with a manual value.
   *  Clicking the "auto" chip opens an editable masked input; blurring it empty reverts to auto. */
  editingAuto = signal<ReadonlySet<string>>(new Set());
  isEditingAuto(key: string): boolean {
    return this.editingAuto().has(key);
  }
  startEditAuto(key: string): void {
    this.editingAuto.update((s) => new Set(s).add(key));
  }
  /** On blur: an emptied override reverts to the auto default (chip); a filled one persists. */
  onAutoBlur(key: string): void {
    if (!this.envValue(key).trim()) {
      this.setEnvOverride(key, '');
      this.editingAuto.update((s) => {
        const n = new Set(s);
        n.delete(key);
        return n;
      });
    }
  }

  /** Required, user-provided (non-auto) env keys still missing a value. */
  readonly missingRequiredEnv = computed<string[]>(() => {
    const a = this.app();
    if (!a) return [];
    const o = this.envOverrides();
    return a.env.filter((e) => e.required && !e.auto && !(o[e.key] ?? '').trim()).map((e) => e.key);
  });

  /** Deploy-ready only when subdomain is valid+available AND every required user-var is set. */
  readonly readyToDeploy = computed<boolean>(() => {
    const available = this.subdomainAvailable();
    const valid = this.subdomainValid();
    return (
      this.canDeploy() &&
      available === true &&
      valid === true &&
      this.missingRequiredEnv().length === 0 &&
      !this.invalidEnvKeys()
    );
  });

  /** Live (deployable today) vs Soon (catalog placeholder — no runtime container yet). */
  readonly supported = computed<boolean>(() => {
    const a = this.app();
    return !!a && isAppSupported(a.id);
  });

  ngOnInit(): void {
    // A fixed-position ⋮ menu detaches from its button on scroll — close it on ANY
    // scroll (capture phase catches the inner scrollable panel too, not just window)
    // or resize so it never floats orphaned. Cleaned up on destroy.
    const closeInstanceMenu = () => {
      if (this.openMenuInstanceId()) this.openMenuInstanceId.set(null);
    };
    document.addEventListener('scroll', closeInstanceMenu, true);
    window.addEventListener('resize', closeInstanceMenu);
    this.destroyRef.onDestroy(() => {
      document.removeEventListener('scroll', closeInstanceMenu, true);
      window.removeEventListener('resize', closeInstanceMenu);
    });

    // Subscribe (not snapshot) so prev/next nav — which re-uses THIS component
    // with a new `:id` — re-resolves the app instead of showing the old one.
    this.route.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((pm) => {
      const id = pm.get('id') ?? '';
      this.appId.set(id);
      const found = APPS_CATALOG.find((a) => a.id === id) ?? null;
      this.app.set(found);
      if (found) {
        // Pre-fill the editable env inputs with each user-provided var's default.
        const seed: Record<string, string> = {};
        for (const e of found.env) {
          if (!e.auto) seed[e.key] = e.default ?? '';
        }
        this.envOverrides.set(seed);
        this.customEnv.set([]); // per-app reset — custom launch vars don't leak across apps
        this.editingAuto.set(new Set()); // per-app reset — auto-override edits don't leak

        // Auto-pick subdomain from API
        this.checkAndSetSubdomain(found.id);
      }
    });
  }

  private checkAndSetSubdomain(appId: string): void {
    const seed = `${appId}-${this.shortSlug()}`;
    this.api.get<{ suggestion: string }>(`/apps/slug-check?app_id=${encodeURIComponent(appId)}&subdomain=${encodeURIComponent(seed)}`).subscribe({
      next: (r) => {
        this.subdomain = r.suggestion ?? seed;
        this.subdomainSignal.set(this.subdomain);
        this.runSubdomainCheck(this.subdomain); // color green/red immediately on load
      },
      error: () => {
        // Fallback on error
        this.subdomain = seed;
        this.subdomainSignal.set(this.subdomain);
        this.runSubdomainCheck(this.subdomain);
      },
    });
    // Fetch instances for this app
    this.fetchInstances(appId);
  }

  private fetchInstances(appId: string): void {
    this.api.get<any>('/apps/instances').subscribe({
      next: (r: any) => {
        // Instances carry `app_slug` (the catalog id, e.g. 'payload'); `app_id` is null on
        // the read side. Match on app_slug first (fall back to app_id) — mirrors the working
        // apps-instances page. Filtering on the null app_id was why launched instances showed
        // "No instances launched yet".
        const filtered = (r.instances ?? []).filter(
          (i: any) => (i.app_slug ?? i.app_id) === appId,
        );
        this.instances.set(filtered);
      },
      error: () => {
        console.warn('[apps] failed to fetch instances');
        this.instances.set([]);
      },
    });
  }

  deleteInstance(instanceId: string): void {
    const ok = confirm('Delete this instance?');
    if (!ok) return;
    this.api.delete(`/apps/instances/${instanceId}`).subscribe({
      next: () => {
        this.toast.success('Instance deleted.');
        const appId = this.app()?.id;
        if (appId) this.fetchInstances(appId);
      },
      error: () => {
        console.warn('[apps] delete instance failed', instanceId);
      },
    });
  }

  cloneInstance(instance: any): void {
    this.subdomain = instance.subdomain;
    this.subdomainSignal.set(this.subdomain);
    this.openMenuInstanceId.set(null);
    this.toast.info('Subdomain prefilled. Customize and Deploy.');
  }

  openInstanceLive(instance: any): void {
    window.open(`https://${instance.host}`, '_blank');
    this.openMenuInstanceId.set(null);
  }

  onSubdomainChange(value: string): void {
    this.subdomainTouched.set(true);
    this.subdomainSignal.set(value);

    // Debounce: clear the pending check + go NEUTRAL (drops stale green/red) while typing.
    if (this.subdomainCheckTimer) clearTimeout(this.subdomainCheckTimer);
    this.subdomainValid.set(null);
    this.subdomainAvailable.set(null);
    this.subdomainCheckMessage.set('');
    // Show the pending state only for a non-empty value the user is actively editing.
    this.subdomainChecking.set(!!value.trim());
    this.subdomainCheckTimer = setTimeout(() => this.runSubdomainCheck(value), 350);
  }

  /**
   * Resolve a subdomain's validity + availability and drive the green/red field state.
   * Shared by the debounced input handler AND the initial auto-pick, so the field is
   * colored from the get-go (not only after the user types). Local format gate first
   * (instant red, no round-trip); server `/apps/slug-check` confirms availability.
   */
  private runSubdomainCheck(value: string): void {
    const v = value.trim();
    if (!v) {
      // Empty → neutral (default hint), never red.
      this.subdomainChecking.set(false);
      this.subdomainValid.set(null);
      this.subdomainAvailable.set(null);
      this.subdomainCheckMessage.set('');
      return;
    }
    if (v.length < 3 || v.length > 40 || !/^[a-z0-9-]+$/.test(v) || v.startsWith('-') || v.endsWith('-')) {
      this.subdomainChecking.set(false);
      this.subdomainValid.set(false);
      this.subdomainAvailable.set(false);
      this.subdomainCheckMessage.set('Invalid subdomain.');
      return;
    }
    const appId = this.app()?.id;
    if (!appId) {
      this.subdomainChecking.set(false);
      return;
    }
    this.subdomainChecking.set(true);
    this.api
      .get<{ available: boolean; valid: boolean; suggestion?: string }>(
        `/apps/slug-check?app_id=${encodeURIComponent(appId)}&subdomain=${encodeURIComponent(v)}`,
      )
      .subscribe({
        next: (r) => {
          this.subdomainChecking.set(false);
          this.subdomainValid.set(r.valid);
          this.subdomainAvailable.set(r.available);
          this.subdomainCheckMessage.set(
            !r.available ? 'Subdomain taken.' : !r.valid ? 'Invalid subdomain.' : '',
          );
        },
        error: () => {
          this.subdomainChecking.set(false);
          this.subdomainValid.set(false);
          this.subdomainAvailable.set(false);
          this.subdomainCheckMessage.set('Error checking availability.');
        },
      });
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

  /** Per-service carousel images: explicit captured screenshots first, then the repo's GitHub
   *  social card — a reliable "telling image" available for EVERY service, zero hosting. */
  readonly screenshots = computed<string[]>(() => {
    const a = this.app();
    if (!a) return [];
    const shots = [...(a.screenshots ?? []), ...(APP_SCREENSHOTS[a.id] ?? [])];
    const gh = this.githubOgCard(a.repo);
    if (gh && !shots.includes(gh)) shots.push(gh);
    // De-dupe while preserving order (an app may repeat its og image + card).
    return [...new Set(shots)];
  });

  private githubOgCard(repo: string): string | null {
    const m = /github\.com\/([^/]+)\/([^/#?]+)/.exec(repo ?? '');
    return m ? `https://opengraph.githubassets.com/1/${m[1]}/${m[2].replace(/\.git$/, '')}` : null;
  }

  /** Active carousel frame index — drives the pagination dots. */
  readonly activeShot = signal(0);

  /** Scroll the screenshot track by exactly one frame (prev/next buttons); scroll-snap settles it. */
  scrollShots(track: HTMLElement, dir: number): void {
    track.scrollBy({ left: dir * track.clientWidth, behavior: 'smooth' });
  }

  /** Jump the carousel to frame `i` (pagination-dot click). */
  goToShot(track: HTMLElement, i: number): void {
    track.scrollTo({ left: i * track.clientWidth, behavior: 'smooth' });
  }

  /** Sync the active-frame index from the live scroll position (drives the dots). */
  onShotsScroll(track: HTMLElement): void {
    this.activeShot.set(Math.round(track.scrollLeft / (track.clientWidth || 1)));
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
    // Owner-added custom vars override catalog values; value may be intentionally blank.
    for (const row of this.customEnv()) {
      const k = row.key.trim();
      if (k) env_overrides[k] = row.value;
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
        this.toast.success(
          a.image?.startsWith('cf-native:')
            ? `${a.name} provisioning — deploying Worker + D1 + R2 to the edge`
            : `${a.name} provisioning — booting container`,
        );
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
