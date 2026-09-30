/**
 * @component AdminApiTokensComponent
 * @description `/admin/api-tokens` — Public API v1 token management.
 *
 * Cyan/black compact design per [[cyan-black-compact-progression]].
 *
 * ── Spartan reference migration (form-heavy) ─────────────────────────────
 * This section is the canonical "form-heavy" Spartan-UI migration example for
 * the cockpit. It maps the former hand-rolled patterns onto Spartan helm
 * directives + headless primitives (Spartan is the only admin UI kit; PrimeNG
 * was never adopted):
 *   - hand-rolled `<table>`        → native `<table>` + TanStack headless table
 *                                     (createAngularTable; client-side sort)
 *   - 3× hand-rolled modal/backdrop → Spartan `<app-dialog-shell>` (the mandated
 *                                     one-dialog primitive: blur backdrop + CDK
 *                                     focus-trap + Esc-close + scroll-lock built in)
 *   - `<input type=text>`          → Spartan `hlmInput` directive
 *   - `<input type=datetime-local>`→ native `<input hlmInput type=datetime-local>` (Spartan)
 *   - scope `<input type=checkbox>`→ Spartan `hlmCheckbox` directive (cyan accent)
 *   - scope / action `<button>`s    → Spartan `hlmBtn` (variant + size; busy via [disabled]+at-spin)
 *   - scope pill `<span>`          → Spartan `hlmBadge` (variant=info, cockpit-tinted)
 * Toasts go through the cockpit's `ToastService` (it renders its own toast layer).
 *
 * Surfaces:
 * - Header stats: active tokens, scopes available
 * - Token list table (native + TanStack): name, scopes, last used, expires, revoke action
 * - "New Token" dialog: name + scopes checkboxes + expiry datepicker
 * - Post-create dialog: one-time plaintext token display with copy button
 * - Revoke-confirm dialog
 * - `/admin/docs/api-reference` deep-link to Redocly-rendered API docs
 */

import { Component, computed, effect, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { formatSort, parseSort } from '../table-sort-url';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  createAngularTable,
  getCoreRowModel,
  getSortedRowModel,
  type ColumnDef,
  type SortingState,
} from '@tanstack/angular-table';
import { DialogShellComponent } from '../../../components/dialog-shell/dialog-shell.component';
import { HlmBadgeDirective, HlmButtonDirective, HlmInputDirective, HlmCheckboxDirective } from '../../../ui';
import { AdminStateService } from '../admin-state.service';
import { ApiService, type Site } from '../../../services/api.service';
import { ToastService } from '../../../services/toast.service';
import { FeatureFlagService } from '../../../services/feature-flag.service';
import { RevealDirective } from '../../../directives/reveal.directive';
import { RollingCounterComponent } from '../../../components/rolling-counter/rolling-counter.component';
import { FlagGateNoticeComponent } from '../../../components/states/flag-gate-notice.component';
import {
  capabilityIdSchema,
  type CapabilityKind,
} from '../../../../../../../../packages/shared/src/ai-policy/capability';

/**
 * Counts-only AI grant summary the worker attaches per token when the
 * `ai_api_keys` flag is ON (see routes/api_tokens_admin.ts + services/
 * ai_key_grants.ts summarizeGrant). NEVER the full id arrays — render only
 * what the server sends.
 */
interface GrantSummary {
  siteCount: number;
  connectionCount: number;
  actionCount: number;
  modelCount: number;
  approvalPolicy: string;
  revision: number;
  expiresAt: string;
  revokedAt?: string;
}

interface ApiToken {
  id: string;
  name: string;
  scopes: string[];
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
  /** Present only when the ai_api_keys flag is ON server-side AND the token carries a grant. */
  grant?: GrantSummary;
}

interface CreateTokenResponse {
  token: ApiToken;
  plaintext: string;
  warning: string;
  /** Echoed counts-only summary when a mint-time AI grant was attached. */
  grant?: GrantSummary;
}

/**
 * Mint-time AI grant body — EXACTLY the caller-selectable fields of the
 * server's GrantInputSchema (services/ai_key_grants.ts — a strict .pick() of
 * the SHARED GrantRecordSchema in packages/shared/src/ai-policy). The server
 * schema is .strict(), so no extra keys may EVER be added here (the protocol
 * picker is a client-side SDK-surface hint, never a payload field). The
 * server re-validates authoritatively.
 */
interface AiGrantInput {
  siteIds: string[];
  connectionIds: string[];
  actionIds: string[];
  modelIds: string[];
  expiresAt: string;
  limits?: { spendCents: number };
}

/** Grants are never perpetual — a token without an expiry still gets a 90-day AI grant. */
const AI_GRANT_DEFAULT_TTL_MS = 90 * 86_400_000;

/**
 * Curated mint-time capability options. Ids are canonical
 * provider.resource.action ids from the SHARED ai-policy layer and every id
 * is validated against the SHARED capabilityIdSchema (never a locally
 * redefined grammar); an id failing the schema is dropped so it can never
 * reach a grant. Kinds use the shared CapabilityKind vocabulary — the dialog
 * groups kind read under Read and everything else under Write.
 */
const AI_CAPABILITY_OPTIONS: ReadonlyArray<{
  id: string;
  kind: CapabilityKind;
  label: string;
  description: string;
}> = [
  {
    id: 'projectsites.site.read',
    kind: 'read',
    label: 'Sites — read',
    description: 'Read site content, structure and data',
  },
  {
    id: 'workers_ai.text.generate',
    kind: 'write',
    label: 'AI — generate text',
    description: 'Run text inference through the AI gateway',
  },
  {
    id: 'projectsites.site.publish',
    kind: 'publish',
    label: 'Sites — publish',
    description: 'Publish or promote a site build',
  },
].filter((option) => capabilityIdSchema.safeParse(option.id).success) as ReadonlyArray<{
  id: string;
  kind: CapabilityKind;
  label: string;
  description: string;
}>;

const ALL_SCOPES = [
  { key: 'sites:read', label: 'Sites — read', description: 'List and get site data' },
  { key: 'sites:write', label: 'Sites — write', description: 'Create, update, delete, deploy' },
  { key: 'media:read', label: 'Media — read', description: 'List media assets' },
  { key: 'media:write', label: 'Media — write', description: 'Upload and delete media' },
  { key: 'forms:read', label: 'Forms — read', description: 'Read form submissions' },
  { key: 'analytics:read', label: 'Analytics — read', description: 'Read analytics data' },
];

@Component({
  selector: 'app-admin-api-tokens',
  standalone: true,
  imports: [RevealDirective, RollingCounterComponent,
    RouterLink,
    CommonModule,
    FormsModule,
    DialogShellComponent,
    HlmBadgeDirective,
    HlmButtonDirective,
    HlmInputDirective,
    HlmCheckboxDirective,
    FlagGateNoticeComponent,
  ],
  template: `
    <div class="api-tokens-root">
      <!-- Header -->
      <div class="at-header" appReveal>
        <div class="at-title-row">
          <div>
            <div class="at-eyebrow">Developer</div>
            <h2 class="at-heading">API Tokens</h2>
            <p class="at-sub">Authenticate programmatic access with scoped Bearer tokens.</p>
          </div>
          <div class="at-header-actions">
            <a hlmBtn variant="outline" size="sm" [routerLink]="'/admin/docs/api-reference'">
              <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg> API Docs
            </a>
            <!-- The New Token button lives in the always-rendered header, so it MUST be
                 flag-gated too — otherwise a flag-off org (worker 404s /v1-tokens) sees a
                 create button that 404s on click, beside the "not enabled" gate notice. -->
            @if (!flagDisabled()) {
              <button hlmBtn variant="primary" size="sm" type="button" data-testid="at-create-open" (click)="openCreateModal()">
                <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="M12 5v14"/></svg> New Token
              </button>
            }
          </div>
        </div>

        <!-- Stat chips -->
        <div class="at-stats-row" appReveal>
          <div class="at-stat-chip">
            @if (showTableSkeleton()) {
              <span class="at-stat-value at-stat-loading" aria-hidden="true">…</span>
            } @else {
              <span class="at-stat-value"><app-rolling-counter [value]="tokens().length" [duration]="1100" /></span>
            }
            <span class="at-stat-label">active {{ tokens().length === 1 ? 'token' : 'tokens' }}</span>
          </div>
          <div class="at-stat-chip">
            <span class="at-stat-value"><app-rolling-counter [value]="scopeCount()" [duration]="1100" /></span>
            <span class="at-stat-label">scopes available</span>
          </div>
          <div class="at-stat-chip">
            <a href="/api/openapi.json" target="_blank" rel="noopener noreferrer" class="at-openapi-link">OpenAPI 3.1 spec<svg class="inline-block align-[-2px] ml-[3px]" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></a>
          </div>
        </div>
      </div>

      <!-- Feature-disabled banner (shared primitive). -->
      @if (flagDisabled()) {
        <app-flag-gate-notice feature="Public API v1" flag="public_api_v1" testid="api-tokens-flag-gate" margin="mb-5" />
      }

      <!-- Token list (TanStack headless table) -->
      @if (!flagDisabled()) {
        @if (showTableSkeleton()) {
          <div class="at-table-wrap" aria-busy="true" aria-label="Loading API tokens" data-testid="api-tokens-skeleton">
            <div class="at-sk-line at-sk-head"></div>
            @for (n of [1,2,3,4]; track n) { <div class="at-sk-line"></div> }
          </div>
        } @else {
        <div class="at-table-wrap" appReveal>
          <table class="at-grid" data-testid="api-tokens-table">
            <thead>
              <tr>
                @for (header of table.getHeaderGroups()[0].headers; track header.id) {
                  @if (header.column.getCanSort()) {
                    <th
                      scope="col"
                      class="at-sortable"
                      tabindex="0"
                      [attr.aria-sort]="ariaSort(header.column.getIsSorted())"
                      (click)="header.column.toggleSorting()"
                      (keydown.enter)="header.column.toggleSorting()"
                      (keydown.space)="header.column.toggleSorting(); $event.preventDefault()">
                      {{ headerLabel[header.id] }}
                      <span class="at-sort-ind" aria-hidden="true">{{ sortGlyph(header.column.getIsSorted()) }}</span>
                    </th>
                  } @else {
                    <th scope="col" [class.at-actions-col]="header.id === 'actions'" [attr.aria-label]="header.id === 'actions' ? 'Actions' : null">{{ headerLabel[header.id] }}</th>
                  }
                }
              </tr>
            </thead>
            <tbody>
              @for (row of table.getRowModel().rows; track row.original.id) {
                <tr>
                  <td class="at-name-cell">
                    <span class="at-token-name">{{ row.original.name }}</span>
                    <span class="at-token-id">{{ row.original.id.slice(0, 8) }}…</span>
                  </td>
                  <td>
                    <div class="at-scopes-cell">
                      @for (scope of row.original.scopes; track scope) {
                        <span hlmBadge variant="info" class="at-scope-tag">{{ scope }}</span>
                      }
                    </div>
                    <!-- Counts-only AI grant summary (server sends it only when ai_api_keys is ON). -->
                    @if (row.original.grant; as g) {
                      <div class="at-grant-chip" data-testid="at-grant-chip">
                        <span class="at-grant-chip-ai">AI</span>
                        <span>{{ g.siteCount }} {{ g.siteCount === 1 ? 'site' : 'sites' }}</span>
                        <span class="at-grant-chip-dot" aria-hidden="true">·</span>
                        <span>{{ g.actionCount }} {{ g.actionCount === 1 ? 'capability' : 'capabilities' }}</span>
                        <span class="at-grant-chip-dot" aria-hidden="true">·</span>
                        <span>{{ g.modelCount }} {{ g.modelCount === 1 ? 'model' : 'models' }}</span>
                        @if (g.revokedAt) {
                          <span class="at-grant-chip-revoked">revoked</span>
                        }
                      </div>
                    }
                  </td>
                  <td class="at-meta-cell">{{ row.original.last_used_at ? formatRelative(row.original.last_used_at) : '—' }}</td>
                  <td class="at-meta-cell">{{ row.original.expires_at ? formatDate(row.original.expires_at) : 'Never' }}</td>
                  <td class="at-meta-cell">{{ formatDate(row.original.created_at) }}</td>
                  <td class="at-actions-col">
                    <button hlmBtn variant="ghost" size="sm" type="button"
                      class="text-destructive"
                      data-testid="at-revoke-btn"
                      (click)="confirmRevoke(row.original)"
                      [attr.aria-label]="'Revoke token ' + row.original.name">
                      Revoke
                    </button>
                  </td>
                </tr>
              } @empty {
                <tr>
                  <td colspan="6">
                    <div class="at-empty" role="status">
                      <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="font-size: 1.8rem; color: var(--ps-accent); opacity: .4"><path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4"/><path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/></svg>
                      <p>No API tokens yet.</p>
                      <button hlmBtn variant="primary" size="sm" type="button" (click)="openCreateModal()">Create your first token</button>
                    </div>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        }
      }

      <!-- Quick-start code snippet -->
      @if (tokens().length > 0) {
        <div class="at-quickstart" appReveal>
          <div class="at-qs-header">
            <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/></svg>
            Quick start
            <button type="button" class="at-qs-copy" data-testid="at-qs-copy" (click)="copyCurlSnippet(qsCode.textContent || '')" aria-label="Copy the quick-start request to the clipboard">Copy</button>
          </div>
          <!-- tabindex=0: the snippet scrolls horizontally on narrow viewports (.at-code
               overflow-x:auto) so WCAG 2.1.1 / axe scrollable-region-focusable requires a
               scrollable region be keyboard-reachable. No aria-label on the pre element — it
               would suppress the code content for a screen reader (the code IS the name). -->
          <pre #qsCode class="at-code" tabindex="0"><code>curl https://projectsites.dev/v1/sites \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json"</code></pre>
          <div class="at-qs-footer">
            <a href="/api/openapi.json" target="_blank" rel="noopener noreferrer" class="at-link">Full API reference<svg class="inline-block align-[-2px] ml-[3px]" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></a>
          </div>
        </div>
      }
    </div>

    <!-- Create Token Dialog (Spartan DialogShell) -->
    @if (createModalVisible) {
    <app-dialog-shell (closed)="closeCreateModal()">
      <span dialogTitle>New API Token</span>
      <div class="at-dialog-body">
        <div class="at-field">
          <label class="at-label" for="token-name">Token name *</label>
          <input id="token-name" hlmInput type="text" data-testid="at-name-input" [(ngModel)]="newName" placeholder="e.g. CI Deploy Bot" autocomplete="off" class="w-full" />
        </div>

        <div class="at-field">
          <label class="at-label">Scopes</label>
          <div class="at-scopes-grid">
            @for (scope of availableScopes; track scope.key) {
              <label class="at-scope-row" [attr.for]="'scope-' + scope.key">
                <input
                  type="checkbox"
                  hlmCheckbox
                  [id]="'scope-' + scope.key"
                  [ngModel]="selectedScopes().has(scope.key)"
                  (ngModelChange)="toggleScope(scope.key)" />
                <span class="at-scope-info">
                  <span class="at-scope-key">{{ scope.label }}</span>
                  <span class="at-scope-desc">{{ scope.description }}</span>
                </span>
              </label>
            }
          </div>
        </div>

        <div class="at-field">
          <label class="at-label" for="token-expires">Expiry (optional)</label>
          <input
            id="token-expires"
            hlmInput
            type="datetime-local"
            [(ngModel)]="newExpiry"
            [min]="nowLocal"
            [attr.aria-invalid]="expiryInvalid() || null"
            [attr.aria-describedby]="expiryInvalid() ? 'token-expiry-err' : null"
            placeholder="Never expires"
            class="w-full" />
          @if (expiryInvalid()) {
            <span id="token-expiry-err" data-testid="token-expiry-err" class="block text-[0.7rem] mt-1" style="color:var(--ps-danger)" role="alert">Expiry must be in the future — leave blank for a token that never expires.</span>
          } @else {
            <span class="at-field-hint">Leave blank for a token that never expires.</span>
          }
        </div>

        <!-- Optional AI permissions (campaign lane-3, flag ai_api_keys — DARK renders NOTHING). -->
        @if (aiKeysOn()) {
          <div class="at-ai-section" data-testid="at-ai-section">
            <label class="at-scope-row" for="ai-grant-enable">
              <input
                type="checkbox"
                hlmCheckbox
                id="ai-grant-enable"
                data-testid="at-ai-enable"
                [ngModel]="aiGrantEnabled()"
                (ngModelChange)="aiGrantEnabled.set($event)" />
              <span class="at-scope-info">
                <span class="at-scope-key">AI permissions (optional)</span>
                <span class="at-scope-desc">Attach a scoped AI grant — concrete sites + capabilities only, never future resources.</span>
              </span>
            </label>

            @if (aiGrantEnabled()) {
              <div class="at-field">
                <span class="at-label" id="ai-protocol-label">Protocol</span>
                <div class="at-protocol-row" role="radiogroup" aria-labelledby="ai-protocol-label">
                  @for (p of aiProtocols; track p.value) {
                    <label class="at-protocol-pill" [class.at-protocol-active]="aiProtocol() === p.value">
                      <input
                        type="radio"
                        name="ai-protocol"
                        class="sr-only"
                        [value]="p.value"
                        [attr.data-testid]="'at-ai-protocol-' + p.value"
                        [checked]="aiProtocol() === p.value"
                        (change)="aiProtocol.set(p.value)" />
                      {{ p.label }}
                    </label>
                  }
                </div>
                <span class="at-field-hint">Which SDK surface this key targets — it names the env var shown after minting.</span>
              </div>

              <div class="at-field">
                <span class="at-label">Sites</span>
                <div class="at-scopes-grid at-ai-sites" data-testid="at-ai-sites">
                  @for (site of aiSites(); track site.id) {
                    <label class="at-scope-row" [attr.for]="'ai-site-' + site.id">
                      <input
                        type="checkbox"
                        hlmCheckbox
                        [id]="'ai-site-' + site.id"
                        [attr.data-testid]="'at-ai-site-' + site.id"
                        [ngModel]="selectedAiSites().has(site.id)"
                        (ngModelChange)="toggleAiSite(site.id)" />
                      <span class="at-scope-info">
                        <span class="at-scope-key">{{ site.business_name }}</span>
                        <span class="at-scope-desc">{{ site.slug }}.projectsites.dev</span>
                      </span>
                    </label>
                  } @empty {
                    <span class="at-field-hint">No sites yet — leave empty for a key that is not site-bound.</span>
                  }
                </div>
                <span class="at-field-hint">The key may touch only the selected sites — never future ones.</span>
              </div>

              <div class="at-field">
                <span class="at-label">Capabilities</span>
                <div class="at-scopes-grid">
                  <span class="at-cap-group">Read</span>
                  @for (cap of readAiCapabilities; track cap.id) {
                    <label class="at-scope-row" [attr.for]="'ai-cap-' + cap.id">
                      <input
                        type="checkbox"
                        hlmCheckbox
                        [id]="'ai-cap-' + cap.id"
                        [attr.data-testid]="'at-ai-cap-' + cap.id"
                        [ngModel]="selectedAiCapabilities().has(cap.id)"
                        (ngModelChange)="toggleAiCapability(cap.id)" />
                      <span class="at-scope-info">
                        <span class="at-scope-key">{{ cap.label }}</span>
                        <span class="at-scope-desc">{{ cap.description }}</span>
                      </span>
                    </label>
                  }
                  <span class="at-cap-group">Write</span>
                  @for (cap of writeAiCapabilities; track cap.id) {
                    <label class="at-scope-row" [attr.for]="'ai-cap-' + cap.id">
                      <input
                        type="checkbox"
                        hlmCheckbox
                        [id]="'ai-cap-' + cap.id"
                        [attr.data-testid]="'at-ai-cap-' + cap.id"
                        [ngModel]="selectedAiCapabilities().has(cap.id)"
                        (ngModelChange)="toggleAiCapability(cap.id)" />
                      <span class="at-scope-info">
                        <span class="at-scope-key">{{ cap.label }}</span>
                        <span class="at-scope-desc">{{ cap.description }}</span>
                      </span>
                    </label>
                  }
                </div>
                @if (aiGrantEnabled() && selectedAiCapabilities().size === 0) {
                  <span class="at-field-hint" data-testid="at-ai-cap-hint" style="color:var(--ps-warning)">Select at least one capability — a grant without capabilities allows nothing.</span>
                }
              </div>

              <div class="at-field">
                <label class="at-label" for="ai-budget">Monthly budget (USD, optional)</label>
                <input
                  id="ai-budget"
                  hlmInput
                  type="number"
                  min="1"
                  step="1"
                  inputmode="decimal"
                  data-testid="at-ai-budget"
                  [(ngModel)]="aiBudgetUsd"
                  [attr.aria-invalid]="aiBudgetInvalid() || null"
                  [attr.aria-describedby]="aiBudgetInvalid() ? 'ai-budget-err' : null"
                  placeholder="e.g. 25"
                  class="w-full" />
                @if (aiBudgetInvalid()) {
                  <span id="ai-budget-err" data-testid="at-ai-budget-err" class="block text-[0.7rem] mt-1" style="color:var(--ps-danger)" role="alert">Budget must be a positive dollar amount — leave blank for no spend cap.</span>
                } @else {
                  <span class="at-field-hint">Hard spend cap for this key. AI access expires with the token, or in 90 days when the token never expires.</span>
                }
              </div>
            }
          </div>
        }
      </div>
      <div dialogFooter class="px-6 py-4 border-t border-white/[0.06] flex items-center justify-end gap-3">
        <button hlmBtn variant="ghost" size="sm" type="button" (click)="closeCreateModal()">Cancel</button>
        <button hlmBtn variant="primary" size="sm" type="button" data-testid="at-create-submit"
          [disabled]="creating() || !newName.trim() || expiryInvalid() || aiGrantBlocked()" (click)="createToken()">
          <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" [class.at-spin]="creating()"><path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4"/><path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/></svg>
          {{ creating() ? 'Creating…' : 'Create Token' }}
        </button>
      </div>
    </app-dialog-shell>
    }

    <!-- Reveal Dialog (one-time plaintext) -->
    @if (createdToken() !== null) {
    <app-dialog-shell (closed)="clearCreatedToken()">
      <span dialogTitle>Token created</span>
      <div class="at-dialog-body">
        <div class="at-warning-box" role="alert">
          <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="color:var(--ps-warning)"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
          Store this token securely — it will <strong>not</strong> be shown again.
        </div>
        <div class="at-token-reveal" data-testid="at-token-reveal">
          <code class="at-token-text" data-testid="at-token-plaintext">{{ createdToken()?.plaintext }}</code>
          <button hlmBtn variant="outline" size="sm" type="button" data-testid="at-copy-btn" (click)="copyToken()">
            {{ copied() ? '✓ Copied' : 'Copy' }}
          </button>
        </div>
        <!-- SDK hint — only when a mint-time AI grant was actually attached. -->
        @if (createdToken()?.grant) {
          <div class="at-ai-env-hint" data-testid="at-ai-env-hint">
            AI grant attached — use this key as
            @if (aiProtocol() === 'openai' || aiProtocol() === 'both') {
              <code>OPENAI_API_KEY</code>
            }
            @if (aiProtocol() === 'both') {
              <span aria-hidden="true">/</span>
            }
            @if (aiProtocol() === 'anthropic' || aiProtocol() === 'both') {
              <code>ANTHROPIC_API_KEY</code>
            }
            with your SDK pointed at your ProjectSites base URL.
          </div>
        }
      </div>
      <div dialogFooter class="px-6 py-4 border-t border-white/[0.06] flex items-center justify-end gap-3">
        <button hlmBtn variant="primary" size="sm" type="button" data-testid="at-reveal-done" (click)="clearCreatedToken()">Done — I've saved this token</button>
      </div>
    </app-dialog-shell>
    }

    <!-- Revoke confirm Dialog -->
    @if (revokeTarget() !== null) {
    <app-dialog-shell (closed)="revokeTarget.set(null)">
      <span dialogTitle>Revoke {{ revokeTarget()?.name ?? '' }}?</span>
      <div class="at-dialog-body">
        <p class="at-revoke-warn">Any integrations using this token will stop working immediately.</p>
      </div>
      <div dialogFooter class="px-6 py-4 border-t border-white/[0.06] flex items-center justify-end gap-3">
        <button hlmBtn variant="ghost" size="sm" type="button" (click)="revokeTarget.set(null)">Cancel</button>
        <button hlmBtn variant="destructive" size="sm" type="button" data-testid="at-revoke-confirm"
          [disabled]="revoking()" (click)="revokeToken()">
          {{ revoking() ? 'Revoking…' : 'Yes, revoke' }}
        </button>
      </div>
    </app-dialog-shell>
    }
  `,
  styles: [`
    .api-tokens-root { padding: 28px 32px; max-width: 960px; }
    .at-header { margin-bottom: 28px; }
    .at-title-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; }
    .at-eyebrow { font-size: 11px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; color: var(--ps-accent); margin-bottom: 4px; }
    .at-heading { font-size: 24px; font-weight: 700; margin: 0 0 4px; color: var(--ps-ink); }
    .at-sub { font-size: 13px; color: rgba(244,244,255,0.55); margin: 0; }
    .at-header-actions { display: flex; gap: 10px; align-items: center; flex-shrink: 0; }
    .at-stats-row { display: flex; gap: 12px; flex-wrap: wrap; }
    .at-stat-chip { background: var(--ps-accent-soft, rgba(0,229,255,0.06)); border: 1px solid var(--ps-accent-line, rgba(0,229,255,0.15)); border-radius: 8px; padding: 8px 14px; display: flex; flex-direction: column; gap: 2px; }
    .at-stat-value { font-size: 20px; font-weight: 700; color: var(--ps-accent); font-variant-numeric: tabular-nums; }
    .at-stat-loading { opacity: 0.5; letter-spacing: 0.1em; }
    .at-stat-label { font-size: 11px; color: rgba(244,244,255,0.62); text-transform: uppercase; letter-spacing: 0.5px; }
    .at-openapi-link { font-size: 12px; color: var(--ps-accent); text-decoration: none; display: flex; align-items: center; gap: 4px; }
    .at-flag-banner { background: rgba(255,209,102,0.08); border: 1px solid rgba(255,209,102,0.25); border-radius: 10px; padding: 12px 16px; font-size: 13px; color: rgba(244,244,255,0.8); display: flex; align-items: center; gap: 8px; margin-bottom: 24px; }
    .at-flag-banner a { color: var(--ps-accent); text-decoration: none; }
    .at-table-wrap { border: 1px solid var(--ps-accent-line, rgba(0,229,255,0.1)); border-radius: 12px; overflow: hidden; background: rgba(255,255,255,0.02); }
    .at-sk-line { height: 16px; border-radius: 6px; margin: 14px 16px; background: linear-gradient(90deg, rgba(255,255,255,0.04) 25%, rgba(0,229,255,0.10) 50%, rgba(255,255,255,0.04) 75%); background-size: 200% 100%; animation: at-shimmer 1.4s ease-in-out infinite; }
    .at-sk-head { width: 32%; height: 20px; margin-top: 18px; }
    @keyframes at-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
    @media (prefers-reduced-motion: reduce) { .at-sk-line { animation: none; } }
    .at-name-cell { display: table-cell; }
    .at-token-name { display: block; font-weight: 600; color: var(--ps-ink); font-size: 13px; }
    .at-token-id { display: block; font-size: 11px; color: rgba(244,244,255,0.8); font-family: 'JetBrains Mono', monospace; margin-top: 1px; }
    .at-scopes-cell { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
    .at-meta-cell { color: rgba(244,244,255,0.55); font-size: 12px; }
    .at-actions-col { text-align: right; white-space: nowrap; }
    .at-empty { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 48px 0; color: rgba(244,244,255,0.62); font-size: 14px; }
    .at-quickstart { margin-top: 24px; border: 1px solid var(--ps-accent-line, rgba(0,229,255,0.1)); border-radius: 12px; overflow: hidden; }
    .at-qs-header { display: flex; align-items: center; gap: 8px; padding: 10px 14px; font-size: 12px; font-weight: 600; color: rgba(244,244,255,0.55); background: rgba(0,229,255,0.03); border-bottom: 1px solid rgba(0,229,255,0.08); text-transform: uppercase; letter-spacing: 0.5px; }
    .at-code { margin: 0; padding: 16px 18px; background: rgba(6,6,16,0.7); font-family: 'JetBrains Mono', monospace; font-size: 12px; color: var(--ps-ink); overflow-x: auto; }
    .at-qs-footer { padding: 10px 14px; border-top: 1px solid rgba(0,229,255,0.08); background: rgba(0,229,255,0.02); }
    .at-link { font-size: 12px; color: var(--ps-accent); text-decoration: none; }
    .at-link:hover { text-decoration: underline; }
    /* Copy button lives at the right of the uppercase "Quick start" header (margin-left:auto).
       min-height 26px keeps it ≥ the WCAG 2.5.8 24px target-size floor (target-size-scan gate). */
    .at-qs-copy { margin-left: auto; display: inline-flex; align-items: center; min-height: 26px; padding: 4px 12px; border: 1px solid var(--ps-accent-line, rgba(0,229,255,0.22)); border-radius: 6px; background: rgba(0,229,255,0.06); color: var(--ps-accent); font-size: 11px; font-weight: 600; letter-spacing: 0.4px; cursor: pointer; transition: background 160ms ease, border-color 160ms ease; }
    .at-qs-copy:hover { background: rgba(0,229,255,0.12); border-color: var(--ps-accent); }

    /* Dialog body / fields (chrome handled by app-dialog-shell). */
    .at-dialog-body { display: flex; flex-direction: column; gap: 18px; }
    .at-dialog-title { display: inline-flex; align-items: center; gap: 8px; font-size: 16px; font-weight: 700; color: var(--ps-ink); }
    .at-field { display: flex; flex-direction: column; gap: 7px; }
    .at-label { font-size: 12px; font-weight: 600; color: rgba(244,244,255,0.6); text-transform: uppercase; letter-spacing: 0.4px; }
    .at-field-hint { font-size: 11px; color: rgba(244,244,255,0.4); }
    /* Brighten the native datetime-local picker indicator on the dark cockpit. */
    input[type="datetime-local"]::-webkit-calendar-picker-indicator { filter: invert(0.85); cursor: pointer; }
    .at-scopes-grid { display: flex; flex-direction: column; gap: 8px; }
    .at-scope-row { display: flex; align-items: flex-start; gap: 10px; cursor: pointer; padding: 8px 12px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.06); transition: background 0.12s; }
    .at-scope-row:hover { background: rgba(0,229,255,0.04); }
    .at-scope-info { display: flex; flex-direction: column; gap: 2px; }
    .at-scope-key { font-size: 13px; font-weight: 600; color: var(--ps-ink); }
    .at-scope-desc { font-size: 11px; color: rgba(244,244,255,0.45); }
    .at-warning-box { display: flex; align-items: flex-start; gap: 8px; background: rgba(255,209,102,0.08); border: 1px solid rgba(255,209,102,0.2); border-radius: 8px; padding: 10px 14px; font-size: 12px; color: rgba(244,244,255,0.75); }
    .at-token-reveal { display: flex; align-items: center; gap: 10px; background: rgba(6,6,16,0.8); border: 1px solid rgba(0,229,255,0.15); border-radius: 10px; padding: 12px 16px; }
    .at-token-text { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--ps-accent); flex: 1; word-break: break-all; }
    .at-revoke-warn { font-size: 13px; color: rgba(244,244,255,0.7); margin: 0; }
    @media (prefers-reduced-motion: reduce) { .at-spinner, .at-spin { animation: none; } }

    /* Buttons are Spartan hlmBtn now — variants carry WCAG-correct ink on the
       cyan fill / outline natively, so the old ::ng-deep p-button contrast
       overrides are gone. Icon sizing + busy-spin for pi glyphs inside hlmBtn: */
    .at-header-actions svg, .at-actions-col svg, [hlmBtn] svg { font-size: .72rem; }
    @keyframes at-spin { to { transform: rotate(360deg); } }
    .at-spin { display: inline-block; animation: at-spin .8s linear infinite; }

    /* ── Native cockpit table (TanStack headless drives sort; CSS is ours) ──── */
    .at-grid { width: 100%; min-width: 44rem; border-collapse: collapse; background: transparent; color: var(--ps-ink, #f4f4ff); }
    .at-grid thead > tr > th {
      font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px;
      padding: 10px 14px; font-weight: 600; text-align: left;
      background: rgba(0,229,255,0.04);
      color: rgba(244,244,255,0.6);
      border-bottom: 1px solid rgba(0,229,255,0.12);
    }
    .at-grid tbody > tr > td {
      padding: 10px 14px; font-size: 13px;
      border-bottom: 1px solid rgba(0,229,255,0.08);
    }
    .at-grid tbody > tr:last-child > td { border-bottom: 0; }
    .at-grid tbody > tr { transition: background 140ms; }
    .at-grid tbody > tr:hover > td { background: rgba(0,229,255,0.04); }
    /* Sortable header affordance. */
    .at-grid th.at-sortable { cursor: pointer; user-select: none; }
    .at-grid th.at-sortable:hover { color: var(--ps-accent, #00e5ff); }
    .at-grid th.at-sortable:focus-visible { outline: 2px solid var(--ps-accent, #00e5ff); outline-offset: -2px; }
    .at-sort-ind { margin-left: 4px; opacity: 0.5; font-size: 10px; }
    .at-grid th.at-sortable[aria-sort="ascending"] .at-sort-ind,
    .at-grid th.at-sortable[aria-sort="descending"] .at-sort-ind { opacity: 1; color: var(--ps-accent, #00e5ff); }
    .at-scope-tag {
      font-family: 'JetBrains Mono', monospace; font-size: 10px; letter-spacing: 0.3px;
    }

    /* ── AI API keys (flag ai_api_keys) ─────────────────────────────────── */
    .at-ai-section { display: flex; flex-direction: column; gap: 18px; border-top: 1px solid rgba(0,229,255,0.10); padding-top: 18px; }
    .at-protocol-row { display: flex; gap: 8px; flex-wrap: wrap; }
    /* Pill radio: 28px min-height clears the WCAG 2.5.8 24px target-size floor. */
    .at-protocol-pill {
      display: inline-flex; align-items: center; min-height: 28px; padding: 4px 14px;
      border: 1px solid rgba(255,255,255,0.12); border-radius: 999px; cursor: pointer;
      font-size: 12px; font-weight: 600; color: rgba(244,244,255,0.7);
      transition: background 140ms ease, border-color 140ms ease, color 140ms ease;
    }
    .at-protocol-pill:hover { border-color: var(--ps-accent-line, rgba(0,229,255,0.35)); }
    .at-protocol-pill:has(input:focus-visible) { outline: 2px solid var(--ps-accent, #00e5ff); outline-offset: 2px; }
    .at-protocol-active { border-color: var(--ps-accent, #00e5ff); background: rgba(0,229,255,0.10); color: var(--ps-accent, #00e5ff); }
    .at-ai-sites { max-height: 180px; overflow-y: auto; }
    .at-cap-group { font-size: 10px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; color: rgba(244,244,255,0.45); margin-top: 2px; }
    .at-grant-chip {
      display: inline-flex; align-items: center; gap: 5px; margin-top: 5px;
      font-family: 'JetBrains Mono', monospace; font-size: 10px; letter-spacing: 0.3px;
      color: rgba(244,244,255,0.62); white-space: nowrap;
    }
    .at-grant-chip-ai {
      display: inline-flex; align-items: center; padding: 1px 6px; border-radius: 5px;
      border: 1px solid var(--ps-accent-line, rgba(0,229,255,0.25)); background: rgba(0,229,255,0.08);
      color: var(--ps-accent, #00e5ff); font-weight: 700;
    }
    .at-grant-chip-dot { opacity: 0.5; }
    .at-grant-chip-revoked { color: var(--ps-danger, #ff6b81); font-weight: 600; }
    .at-ai-env-hint { margin-top: 12px; font-size: 12px; color: rgba(244,244,255,0.62); line-height: 1.6; }
    .at-ai-env-hint code { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--ps-accent, #00e5ff); background: rgba(0,229,255,0.06); border: 1px solid rgba(0,229,255,0.15); border-radius: 5px; padding: 1px 5px; }
  `],
})
export class AdminApiTokensComponent {
  // ApiService injects the Authorization bearer (no global HTTP interceptor
  // exists). The token-mgmt endpoints now derive orgId from that verified
  // bearer/session server-side — NOT a client x-org-id header (closed IDOR).
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private adminState = inject(AdminStateService);
  private flags = inject(FeatureFlagService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  /** Sortable column ids — allow-list guarding a hand-edited `?sort=`. */
  private static readonly SORT_IDS = ['name', 'last_used_at', 'expires_at', 'created_at'] as const;

  tokens = signal<ApiToken[]>([]);
  loading = signal(true);
  flagDisabled = signal(false);

  // ── TanStack headless table (client-side sort) ────────────────────────────
  /** Human header labels keyed by column id (template reads these). */
  readonly headerLabel: Record<string, string> = {
    name: 'Name', scopes: 'Scopes', last_used_at: 'Last used',
    expires_at: 'Expires', created_at: 'Created', actions: '',
  };
  // Initial sort restored from ?sort= (bookmarkable / refresh-safe — P3).
  private readonly sorting = signal<SortingState>(
    parseSort(this.route.snapshot.queryParamMap.get('sort'), AdminApiTokensComponent.SORT_IDS),
  );

  /** Apply a TanStack sorting update + reflect it in `?sort=` (SPA nav, merge). */
  private applySorting(next: SortingState): void {
    this.sorting.set(next);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { sort: formatSort(next) },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }
  private readonly columns: ColumnDef<ApiToken>[] = [
    { id: 'name', accessorKey: 'name' },
    { id: 'scopes', enableSorting: false },
    { id: 'last_used_at', accessorKey: 'last_used_at' },
    { id: 'expires_at', accessorKey: 'expires_at' },
    { id: 'created_at', accessorKey: 'created_at' },
    { id: 'actions', enableSorting: false },
  ];
  readonly table = createAngularTable<ApiToken>(() => ({
    data: this.tokens(),
    columns: this.columns,
    state: { sorting: this.sorting() },
    onSortingChange: (updater) =>
      this.applySorting(typeof updater === 'function' ? updater(this.sorting()) : updater),
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  }));
  /** Map TanStack's `false | 'asc' | 'desc'` to an aria-sort token. */
  ariaSort(dir: false | 'asc' | 'desc'): 'ascending' | 'descending' | 'none' {
    return dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none';
  }
  /** Sort indicator glyph for the header. */
  sortGlyph(dir: false | 'asc' | 'desc'): string {
    return dir === 'asc' ? '↑' : dir === 'desc' ? '↓' : '↕';
  }

  /** Dialog visibility — DialogShell binds these via @if [open]/(closed). */
  createModalVisible = false;
  creating = signal(false);
  newName = '';
  /** Native datetime-local binds a `YYYY-MM-DDTHH:mm` string; '' = never expires. */
  newExpiry = '';
  /** Lower bound for the expiry picker — now, in the input's local format. */
  readonly nowLocal = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
  selectedScopes = signal<Set<string>>(new Set(['sites:read']));

  /**
   * True when a (typed/pasted) expiry is set but already in the past. The native
   * `[min]` only constrains the date picker — a hand-typed past value would mint
   * a token born expired, so the Create action is blocked here too (disabled
   * button + a no-op guard). Blank = "never expires" (valid); future = valid.
   */
  expiryInvalid(): boolean {
    if (!this.newExpiry) return false;
    const t = new Date(this.newExpiry).getTime();
    return Number.isFinite(t) && t <= Date.now();
  }

  // ── AI API keys (flag ai_api_keys — DARK renders NOTHING new) ─────────────
  /**
   * Client-side ai_api_keys resolution. Resolved LAZILY when the create dialog
   * opens (never an eager fetch on section load — the LIST surface needs no
   * client flag: the server only attaches grant summaries when the flag is ON,
   * so chips are server-driven). Fail-safe false.
   */
  aiKeysOn = signal(false);
  /** The AI permissions section is OPT-IN — default mint stays byte-identical. */
  aiGrantEnabled = signal(false);
  /**
   * SDK surface the key targets. A client-side hint ONLY (names the env var in
   * the reveal dialog) — GrantInputSchema is strict server-side and carries no
   * protocol field, so this never enters the payload.
   */
  aiProtocol = signal<'openai' | 'anthropic' | 'both'>('both');
  readonly aiProtocols = [
    { value: 'openai' as const, label: 'OpenAI' },
    { value: 'anthropic' as const, label: 'Anthropic' },
    { value: 'both' as const, label: 'Both' },
  ];
  selectedAiSites = signal<Set<string>>(new Set());
  selectedAiCapabilities = signal<Set<string>>(new Set());
  /** Monthly budget in USD; '' = no spend cap. Sent as integer spendCents. */
  aiBudgetUsd: string | number = '';
  /** Sites available for the grant's site multi-select — the shared admin state list. */
  readonly aiSites = computed<Site[]>(() => this.adminState.sites());
  readonly readAiCapabilities = AI_CAPABILITY_OPTIONS.filter((c) => c.kind === 'read');
  readonly writeAiCapabilities = AI_CAPABILITY_OPTIONS.filter((c) => c.kind !== 'read');

  toggleAiSite(id: string): void {
    const s = new Set(this.selectedAiSites());
    if (s.has(id)) { s.delete(id); } else { s.add(id); }
    this.selectedAiSites.set(s);
  }

  toggleAiCapability(id: string): void {
    const s = new Set(this.selectedAiCapabilities());
    if (s.has(id)) { s.delete(id); } else { s.add(id); }
    this.selectedAiCapabilities.set(s);
  }

  /** True when a budget is typed but not a positive dollar amount. Blank = no cap = valid. */
  aiBudgetInvalid(): boolean {
    const raw = String(this.aiBudgetUsd).trim();
    if (!raw) return false;
    const n = Number(raw);
    return !Number.isFinite(n) || n <= 0;
  }

  /**
   * Blocks the mint while the OPT-IN grant draft is doomed: zero capabilities
   * (a grant that allows nothing) or an invalid budget. Inert when the flag is
   * off or the section is unchecked — the plain token flow is never gated.
   */
  aiGrantBlocked(): boolean {
    if (!this.aiKeysOn() || !this.aiGrantEnabled()) return false;
    return this.selectedAiCapabilities().size === 0 || this.aiBudgetInvalid();
  }

  /**
   * Build the optional mint-time grant — EXACTLY the server GrantInputSchema
   * shape (strict): siteIds / connectionIds / actionIds / modelIds / expiresAt
   * + optional limits. Capability ids are re-validated against the SHARED
   * capabilityIdSchema at this boundary (an invalid id can never ship).
   * Grant expiry follows the token's expiry, else defaults to +90 days —
   * grants are never perpetual.
   */
  private buildAiGrant(): AiGrantInput | null {
    if (!this.aiKeysOn() || !this.aiGrantEnabled() || this.aiGrantBlocked()) return null;
    const actionIds = Array.from(this.selectedAiCapabilities()).filter(
      (id) => capabilityIdSchema.safeParse(id).success,
    );
    if (actionIds.length === 0) return null;
    const grant: AiGrantInput = {
      siteIds: Array.from(this.selectedAiSites()),
      connectionIds: [],
      actionIds,
      modelIds: [],
      expiresAt: this.newExpiry
        ? new Date(this.newExpiry).toISOString()
        : new Date(Date.now() + AI_GRANT_DEFAULT_TTL_MS).toISOString(),
    };
    const usd = Number(String(this.aiBudgetUsd).trim());
    if (Number.isFinite(usd) && usd > 0) grant.limits = { spendCents: Math.round(usd * 100) };
    return grant;
  }

  /** Resolve ai_api_keys lazily (cached shareReplay observable; completes after one emission). */
  private resolveAiKeysFlag(): void {
    this.flags.isOn('ai_api_keys').subscribe((on) => this.aiKeysOn.set(on));
  }

  createdToken = signal<CreateTokenResponse | null>(null);
  /** Derived dialog visibility — mirrors the createdToken signal. */
  get revealVisible(): boolean { return this.createdToken() !== null; }
  set revealVisible(v: boolean) { if (!v) this.clearCreatedToken(); }
  copied = signal(false);

  revokeTarget = signal<ApiToken | null>(null);
  get revokeVisible(): boolean { return this.revokeTarget() !== null; }
  set revokeVisible(v: boolean) { if (!v) this.revokeTarget.set(null); }
  revoking = signal(false);

  readonly availableScopes = ALL_SCOPES;

  readonly scopeCount = computed(() => ALL_SCOPES.length);
  /** While the first fetch is in flight with nothing yet, show a skeleton — never the "no tokens yet" empty state (a false-empty flash on a security surface). */
  readonly showTableSkeleton = computed(() => this.loading() && this.tokens().length === 0);

  /** Reactive org id from the shared admin state (hydrated from /api/auth/me). */
  private get orgId(): string {
    return this.adminState.orgId();
  }

  constructor() {
    // Reads `orgId()` synchronously via loadTokens → the effect re-fires once
    // the shared state hydrates. We gate on it so the first paint waits for
    // the authenticated session to be ready before hitting the bearer-guarded
    // endpoint (the worker derives the org from the verified bearer, not a
    // client header).
    effect(() => {
      this.loadTokens();
    });
  }

  private loadTokens(): void {
    const orgId = this.orgId; // tracked by the effect — re-runs when it hydrates
    if (!orgId) {
      // Session not ready yet; the effect re-runs when it resolves. Avoid
      // firing before the bearer/session context exists.
      this.loading.set(false);
      return;
    }
    this.loading.set(true);
    this.api
      .get<{ data: ApiToken[] }>('/v1-tokens', undefined, { silent: true })
      .subscribe({
        next: (res) => {
          // Stale-route fake-empty guard: a non-array `data` (error envelope,
          // SPA-shell HTML on a stale route, catch-all stub drift) must never
          // reach the TanStack `data:` input — a non-array throws inside
          // getCoreRowModel mid-render and blanks the whole section. The
          // contract is Array.isArray, not truthiness.
          this.tokens.set(Array.isArray(res?.data) ? res.data : []);
          this.loading.set(false);
          this.flagDisabled.set(false);
        },
        error: (err) => {
          this.loading.set(false);
          // The worker returns 404 (never 403) when the `public_api` flag is off for
          // the org — the feature-flag doctrine's "don't leak existence" guard. Treat
          // 404 (and 503 maintenance) as "feature not enabled" → show the graceful
          // gate notice + hide the create UI, NOT a scary "Failed to load" toast + a
          // create button that then 404s. (Before this, only 503 flipped the gate, so
          // a flag-off org saw a dead create button and the gate notice was dead code.)
          if (err?.status === 404 || err?.status === 503) {
            this.flagDisabled.set(true);
            this.tokens.set([]);
          } else {
            this.toast.show('Failed to load API tokens', 'error');
          }
        },
      });
  }

  openCreateModal(): void {
    this.newName = '';
    this.newExpiry = '';
    this.selectedScopes.set(new Set(['sites:read']));
    // Fresh AI draft every open — a stale half-configured grant must never leak
    // into an unrelated mint.
    this.aiGrantEnabled.set(false);
    this.aiProtocol.set('both');
    this.selectedAiSites.set(new Set());
    this.selectedAiCapabilities.set(new Set());
    this.aiBudgetUsd = '';
    this.resolveAiKeysFlag();
    this.createModalVisible = true;
  }

  closeCreateModal(): void {
    this.createModalVisible = false;
  }

  toggleScope(key: string): void {
    const s = new Set(this.selectedScopes());
    if (s.has(key)) { s.delete(key); } else { s.add(key); }
    this.selectedScopes.set(s);
  }

  createToken(): void {
    if (!this.newName.trim() || this.creating() || this.expiryInvalid() || this.aiGrantBlocked()) return;
    this.creating.set(true);

    const body: {
      name: string;
      scopes: string[];
      expires_at: string | null;
      grant?: AiGrantInput;
    } = {
      name: this.newName.trim(),
      scopes: Array.from(this.selectedScopes()),
      expires_at: this.newExpiry ? new Date(this.newExpiry).toISOString() : null,
    };
    // Optional AI grant: flag-off / opted-out mints stay byte-identical (no key at all).
    const grant = this.buildAiGrant();
    if (grant) body.grant = grant;

    this.api
      .post<CreateTokenResponse>('/v1-tokens', body, { silent: true })
      .subscribe({
        next: (res) => {
          this.creating.set(false);
          this.createModalVisible = false;
          this.createdToken.set(res);
          this.loadTokens();
        },
        error: () => {
          this.creating.set(false);
          this.toast.show('Failed to create token', 'error');
        },
      });
  }

  clearCreatedToken(): void {
    this.createdToken.set(null);
    this.copied.set(false);
  }

  async copyToken(): Promise<void> {
    const t = this.createdToken();
    if (!t) return;
    try {
      await navigator.clipboard.writeText(t.plaintext);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2500);
    } catch {
      this.toast.show('Copy failed — select the token text manually', 'warning');
    }
  }

  /**
   * Copy the quick-start curl example to the clipboard (dev value-add — this is the
   * developer API-token section). Reads the rendered `<pre>` textContent so there's a
   * single source of truth (the displayed snippet), never a drifting duplicate string.
   */
  async copyCurlSnippet(text: string): Promise<void> {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      this.toast.show('Copied the quick-start request', 'success');
    } catch {
      this.toast.show('Copy failed — select the text manually', 'warning');
    }
  }

  confirmRevoke(token: ApiToken): void {
    this.revokeTarget.set(token);
  }

  revokeToken(): void {
    const t = this.revokeTarget();
    if (!t || this.revoking()) return;
    this.revoking.set(true);

    this.api
      .delete(`/v1-tokens/${t.id}`, { silent: true })
      .subscribe({
        next: () => {
          this.revoking.set(false);
          this.revokeTarget.set(null);
          this.toast.show(`Token "${t.name}" revoked`, 'success');
          this.loadTokens();
        },
        error: () => {
          this.revoking.set(false);
          this.toast.show('Failed to revoke token', 'error');
        },
      });
  }

  formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  formatRelative(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const days = Math.floor(diff / 86400000);
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 30) return `${days}d ago`;
    return this.formatDate(iso);
  }
}
