/**
 * Site Detail — `/admin/sites/:id`
 *
 * Per-project surface with four tabs exposed by `data-testid`-stable buttons:
 *
 * 1. **Logs** — live tail of the per-site WS log stream + level filter + search.
 * 2. **Snapshots** — merged snapshots + deploy history with rollback button.
 * 3. **SQL** — read-only D1 console for the per-site database. PLATFORM SUPER-ADMIN
 *    ONLY — the `/sites/:id/sql/exec` endpoint 403s non-super-admins, so the tab is
 *    hidden for everyone else (never show a control that will fail).
 * 4. **Integrations** — per-site MCP provider connect / paste-key fallback /
 *    disconnect surface.
 *
 * Satisfies TEST-PLAN.md TAB-01..TAB-13.
 *
 * Hard rule: never weaken tests. UI matches the spec contract — `data-testid`
 * attributes drive Playwright assertions.
 */
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { HlmInputDirective, HlmSelectDirective, HlmTablistDirective } from '../../../ui';
import { ApiService } from '../../../services/api.service';
import { ToastService } from '../../../services/toast.service';
import { ConfirmService } from '../../../services/confirm.service';
import { AdminStateService } from '../admin-state.service';
import { MiniEmptyComponent } from '../../../components/mini-empty/mini-empty.component';
import { ErrorCardComponent } from '../../../components/states';
import { RevealDirective } from '../../../directives/reveal.directive';
import { ReadinessBadgeComponent } from './readiness-badge.component';
import { SiteDataBrowserComponent } from './site-data-browser.component';
import { SiteSchemaBrowserComponent } from './site-schema-browser.component';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { of } from 'rxjs';
import { catchError, switchMap, timer } from 'rxjs';

interface LogRow {
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  source?: string;
}

interface SnapshotRow {
  id: string;
  snapshot_name: string;
  build_version: string;
  description?: string;
  created_at: string;
}

interface SqlResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  duration_ms: number;
  /**
   * D1 query-cost metadata from the statement's `meta` (rows read/written drive
   * D1 billing + performance; `d1_duration_ms` is D1's own execution time). `null`
   * when the runtime didn't report a value — never a fabricated 0. Optional so
   * older result literals (e.g. in tests) stay valid; `runSql` always sets them.
   */
  rows_read?: number | null;
  rows_written?: number | null;
  d1_duration_ms?: number | null;
}

interface IntegrationProvider {
  key: string;
  name: string;
  status: 'connected' | 'disconnected';
  oauth_supported: boolean;
}

type Tab = 'logs' | 'snapshots' | 'data' | 'sql' | 'schema' | 'integrations';
/** Runtime allow-list for validating a `?tab=` deep-link (unknown → default). */
const VALID_TABS: readonly Tab[] = ['logs', 'snapshots', 'data', 'sql', 'schema', 'integrations'];

@Component({
  selector: 'app-admin-site-detail',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, HlmInputDirective, HlmSelectDirective, HlmTablistDirective, MiniEmptyComponent, ErrorCardComponent, RevealDirective, ReadinessBadgeComponent, SiteDataBrowserComponent, SiteSchemaBrowserComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="site-detail animate-fade-in" data-testid="site-detail">
      <header class="site-detail__head" appReveal>
        <h1 class="site-detail__title">{{ site()?.name || site()?.slug || siteId() || 'Site' }}</h1>
        @if (site()?.slug; as slug) {
          <a class="site-detail__subtitle site-detail__subtitle--link"
             [href]="'https://' + slug + '.projectsites.dev'" target="_blank" rel="noopener noreferrer"
             [attr.title]="'Open ' + slug + '.projectsites.dev'">{{ slug }}.projectsites.dev</a>
        } @else {
          <!-- Site didn't fully resolve (GET can 200 with site:null) — fall back to
               the URL slug so the host is meaningful, never a bare ".projectsites.dev". -->
          <p class="site-detail__subtitle">{{ siteId() ? siteId() + '.projectsites.dev' : 'Site overview' }}</p>
        }
        <!-- Production-readiness grade (#9) — renders nothing until the site has
             a scored build, so it never adds noise to an unbuilt site. -->
        <div class="mt-2.5">
          <app-readiness-badge [siteId]="siteId()" />
        </div>
      </header>

      <nav class="site-detail__tabs" role="tablist" hlmTablist aria-label="Site detail sections" appReveal data-testid="sd-tab-strip">
        <button
          type="button"
          role="tab"
          id="sd-tab-logs"
          data-testid="sd-tab-logs"
          [attr.aria-controls]="'sd-panel-logs'"
          [attr.aria-selected]="tab() === 'logs'"
          [class.active]="tab() === 'logs'"
          (click)="setTab('logs')"
        >Logs</button>
        <button
          type="button"
          role="tab"
          id="sd-tab-snapshots"
          data-testid="sd-tab-snapshots"
          [attr.aria-controls]="'sd-panel-snapshots'"
          [attr.aria-selected]="tab() === 'snapshots'"
          [class.active]="tab() === 'snapshots'"
          (click)="setTab('snapshots')"
        >Snapshots</button>
        <button
          type="button"
          role="tab"
          id="sd-tab-data"
          data-testid="sd-tab-data"
          [attr.aria-controls]="'sd-panel-data'"
          [attr.aria-selected]="tab() === 'data'"
          [class.active]="tab() === 'data'"
          (click)="setTab('data')"
        >Data</button>
        @if (canUseSqlConsole()) {
          <button
            type="button"
            role="tab"
            id="sd-tab-sql"
            data-testid="sd-tab-sql"
            [attr.aria-controls]="'sd-panel-sql'"
            [attr.aria-selected]="tab() === 'sql'"
            [class.active]="tab() === 'sql'"
            (click)="setTab('sql')"
          >SQL</button>
          <button
            type="button"
            role="tab"
            id="sd-tab-schema"
            data-testid="sd-tab-schema"
            [attr.aria-controls]="'sd-panel-schema'"
            [attr.aria-selected]="tab() === 'schema'"
            [class.active]="tab() === 'schema'"
            (click)="setTab('schema')"
          >Schema</button>
        }
        <button
          type="button"
          role="tab"
          id="sd-tab-integrations"
          data-testid="sd-tab-integrations"
          [attr.aria-controls]="'sd-panel-integrations'"
          [attr.aria-selected]="tab() === 'integrations'"
          [class.active]="tab() === 'integrations'"
          (click)="setTab('integrations')"
        >Integrations</button>
      </nav>

      <!-- ──────────────────────────────────────── LOGS TAB ──────────────────────────────────────── -->
      @if (tab() === 'logs') {
        <div class="site-detail__panel" role="tabpanel" appReveal id="sd-panel-logs" aria-labelledby="sd-tab-logs" data-testid="site-logs-panel">
          <div class="site-detail__toolbar">
            <label>
              Level
              <select hlmSelect class="mt-1" [ngModel]="logLevel()" (ngModelChange)="logLevel.set($event)">
                <option value="all">all</option>
                <option value="debug">debug</option>
                <option value="info">info</option>
                <option value="warn">warn</option>
                <option value="error">error</option>
              </select>
            </label>
            <input
              hlmInput
              type="search"
              placeholder="Search logs"
              aria-label="Search logs"
              [ngModel]="logSearch()"
              (ngModelChange)="logSearch.set($event)"
            />
            <span data-testid="site-logs-ws-status" [class]="'ws-status ws-' + wsStatus()">
              <span class="ws-dot" aria-hidden="true"></span>{{ wsStatus() === 'connected' ? 'connected' : wsStatus() }}
            </span>
          </div>
          <div class="site-detail__logs" data-testid="site-logs-tail">
            @for (row of filteredLogs(); track row.ts + row.message) {
              <div class="log-row" data-testid="site-logs-row" [attr.data-level]="row.level">
                <time [attr.datetime]="row.ts">{{ formatTs(row.ts) }}</time>
                <span class="log-level" [attr.data-level]="row.level">{{ row.level }}</span>
                <span class="log-message">{{ row.message }}</span>
              </div>
            } @empty {
              <app-mini-empty [text]="logsEmptyText()">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h10M4 18h7"/></svg>
              </app-mini-empty>
            }
          </div>
        </div>
      }

      <!-- ──────────────────────────────────── SNAPSHOTS TAB ──────────────────────────────────── -->
      @if (tab() === 'snapshots') {
        <div class="site-detail__panel" role="tabpanel" appReveal id="sd-panel-snapshots" aria-labelledby="sd-tab-snapshots" data-testid="site-snapshots-panel">
          @if (snapshotsError()) {
            <app-error-card data-testid="snapshots-load-error" class="block mb-3"
              title="Couldn't load snapshots"
              [message]="snapshotsError() ?? ''"
              [correlationId]="snapshotsErrorRef()"
              (retry)="loadSnapshots(siteId())" />
          }
          <ul class="snapshot-list" data-testid="site-snapshots-list">
            @for (s of snapshots(); track s.id) {
              <li class="snapshot-row" data-testid="snapshot-row">
                <div class="snapshot-meta">
                  <strong>{{ s.snapshot_name }}</strong>
                  @if (s.description) {
                    <span class="ai-name" data-testid="snapshot-description">{{ s.description }}</span>
                  }
                  <small>{{ formatTs(s.created_at) }} · <span class="snapshot-ver" data-testid="snapshot-build-version" title="R2 build version this snapshot froze"><span class="snapshot-ver-label">build</span> {{ s.build_version }}</span></small>
                </div>
                <button
                  type="button"
                  class="rollback-btn"
                  (click)="onRollbackClick(s)"
                >Rollback</button>
              </li>
            } @empty {
              <li>
                <app-mini-empty text="No snapshots yet — the first is created automatically on build.">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
                </app-mini-empty>
              </li>
            }
          </ul>

          @if (rollbackResult()) {
            <p class="rollback-result">Rolled back to {{ rollbackResult() }}</p>
          }
          @if (rollbackError()) {
            <p class="rollback-error" role="alert" data-testid="rollback-error">{{ rollbackError() }}</p>
          }
        </div>
      }

      <!-- ──────────────────────────────────────── DATA TAB ──────────────────────────────────────── -->
      @if (tab() === 'data') {
        <div class="site-detail__panel" role="tabpanel" appReveal id="sd-panel-data" aria-labelledby="sd-tab-data" data-testid="site-data-panel">
          <app-site-data-browser [siteId]="siteId()" />
        </div>
      }

      <!-- ──────────────────────────────────────── SCHEMA TAB ──────────────────────────────────────── -->
      @if (tab() === 'schema' && canUseSqlConsole()) {
        <div class="site-detail__panel" role="tabpanel" appReveal id="sd-panel-schema" aria-labelledby="sd-tab-schema" data-testid="site-schema-panel">
          <app-site-schema-browser [siteId]="siteId()" />
        </div>
      }

      <!-- ──────────────────────────────────────── SQL TAB ──────────────────────────────────────── -->
      @if (tab() === 'sql' && canUseSqlConsole()) {
        <div class="site-detail__panel" role="tabpanel" appReveal id="sd-panel-sql" aria-labelledby="sd-tab-sql" data-testid="site-sql-panel">
          <textarea
            data-testid="sql-editor"
            hlmInput
            [multiline]="true"
            class="font-mono resize-y"
            rows="5"
            aria-label="SQL query"
            [ngModel]="sqlQuery()"
            (ngModelChange)="sqlQuery.set($event)"
            placeholder="SELECT * FROM ..."
          ></textarea>
          <div class="sql-starters" role="group" aria-label="Starter queries">
            <span class="sql-starters-label">Starters</span>
            @for (st of sqlStarters; track st.label) {
              <button type="button" class="sql-starter-chip" [attr.data-testid]="'sql-starter-' + st.label"
                      [title]="st.query" (click)="useSqlStarter(st.query)">{{ st.label }}</button>
            }
          </div>
          <div class="sql-toolbar">
            <button type="button" (click)="runSql()" [disabled]="sqlRunning() || !sqlQuery().trim()">{{ sqlRunning() ? 'Running…' : 'Run' }}</button>
            <button type="button" class="sql-explain-btn" data-testid="sql-explain"
                    (click)="explainSql()" [disabled]="explainRunning() || sqlRunning() || !sqlQuery().trim()"
                    title="Show the SQLite query plan (EXPLAIN QUERY PLAN) + index guidance. Does NOT run the query.">{{ explainRunning() ? 'Explaining…' : 'Explain' }}</button>
            @if (sqlRunning()) { <span class="muted">running…</span> }
            <span class="sql-readonly-pill" data-testid="sql-readonly-pill"
                  title="This console runs SELECT / EXPLAIN / WITH queries only — writes are rejected.">Read-only</span>
          </div>
          <!-- Persistent, visible safe-mode explainer (P5) — the read-only contract
               must be obvious without hovering the pill (touch + SR accessible). -->
          <p class="sql-safe-note" data-testid="sql-safe-note">
            <span class="sql-safe-glyph" aria-hidden="true">🛡</span>
            Safe mode: <strong>SELECT · EXPLAIN · WITH</strong> only. Writes
            (INSERT / UPDATE / DELETE / DROP / ALTER…) are blocked to protect your live
            site database.
          </p>

          @if (explainPlan(); as plan) {
            <div class="sql-plan" data-testid="sql-plan" role="region" aria-label="Query plan">
              <div class="sql-plan-h">Query plan · EXPLAIN QUERY PLAN</div>
              <ol class="sql-plan-list">
                @for (line of plan; track $index) {
                  <li data-testid="sql-plan-line">{{ line }}</li>
                } @empty {
                  <li class="muted">No plan steps returned.</li>
                }
              </ol>
              @if (planHint(); as hint) {
                <p class="sql-plan-hint" [attr.data-level]="hint.level" data-testid="sql-plan-hint">
                  <span aria-hidden="true">{{ hint.level === 'ok' ? '✓' : '⚠' }}</span> {{ hint.text }}
                </p>
              }
            </div>
          }

          @if (sqlError(); as err) {
            <div class="sql-error" data-testid="sql-error" role="alert">
              @if (explainSqlError(err); as plain) {
                <p class="sql-error-plain" data-testid="sql-error-plain">{{ plain }}</p>
              }
              <p class="sql-error-raw" data-testid="sql-error-raw">
                <span class="sql-error-raw-label">Raw error:</span> <code>{{ err }}</code>
              </p>
            </div>
          }

          @if (sqlResult(); as r) {
            <div class="sql-result-meta">
              <span class="sql-result-count">{{ r.rows.length }} {{ r.rows.length === 1 ? 'row' : 'rows' }} · {{ r.duration_ms }}ms</span>
              @if (r.rows_read != null || r.rows_written != null || r.d1_duration_ms != null) {
                <span class="sql-cost" data-testid="sql-cost"
                      title="Cloudflare D1 query cost for this statement. D1 billing + performance are driven by ROWS READ — a large read behind a small result means a table scan (add an index).">
                  @if (r.rows_read != null) { <span data-testid="sql-cost-read">read {{ fmtNum(r.rows_read) }}</span> }
                  @if (r.rows_written != null && r.rows_written > 0) { <span> · wrote {{ fmtNum(r.rows_written) }}</span> }
                  @if (r.d1_duration_ms != null) { <span> · D1 {{ r.d1_duration_ms }}ms</span> }
                </span>
              }
              @if (r.rows.length > sqlRenderCap) {
                <span class="sql-result-cap" data-testid="sql-result-cap">showing first {{ sqlRenderCap }} — Copy JSON for all</span>
              }
              @if (r.rows.length > 0) {
                <button type="button" class="sql-result-copy" data-testid="sql-result-copy" (click)="copySqlResult(r)">
                  {{ sqlCopied() ? '✓ Copied' : 'Copy JSON' }}
                </button>
              }
            </div>
            @if (isExpensiveScan(r)) {
              <p class="sql-scan-warn" data-testid="sql-scan-warn" role="status">
                <span aria-hidden="true">⚠</span> Expensive scan — this query read {{ fmtNum(r.rows_read!) }} rows.
                D1 bills + slows on rows read; add an index on the filtered / sorted columns to scan fewer.
              </p>
            }
            <!-- Arbitrary SELECT results can be far wider than the viewport;
                 scroll the table inside its own region instead of overflowing
                 the page (WCAG 1.4.10 — matches the sites/domains/billing tables). -->
            <div class="sql-result-scroll" tabindex="0" role="region" aria-label="SQL result — scroll horizontally">
              <table class="sql-result-table">
                <thead>
                  <tr>
                    @for (col of r.columns; track col) { <th scope="col">{{ col }}</th> }
                  </tr>
                </thead>
                <tbody>
                  @for (row of cappedRows(r); track $index) {
                    <tr>
                      @for (col of r.columns; track col) {
                        <td data-testid="sql-result-cell">{{ row[col] }}</td>
                      }
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }

          <details class="sql-history" open>
            <summary>Query history</summary>
            <ul>
              @for (h of sqlHistory(); track h) {
                <li data-testid="sql-history-item">{{ h }}</li>
              } @empty {
                <li class="muted">No queries yet.</li>
              }
            </ul>
          </details>
        </div>
      }

      <!-- ──────────────────────────────────── INTEGRATIONS TAB ──────────────────────────────────── -->
      @if (tab() === 'integrations') {
        <div class="site-detail__panel" role="tabpanel" appReveal id="sd-panel-integrations" aria-labelledby="sd-tab-integrations" data-testid="site-integrations-panel">
          <div class="mcp-list" data-testid="mcp-provider-list">
            @for (p of integrations(); track p.key) {
              <article class="mcp-card" [attr.data-testid]="'mcp-provider-card-' + p.key">
                <header>
                  <strong>{{ p.name }}</strong>
                  <span class="mcp-status" [class.is-connected]="p.status === 'connected'"
                        role="status"
                        [attr.aria-label]="p.name + (p.status === 'connected' ? ' connected' : ' not connected')">
                    <span class="mcp-dot" aria-hidden="true"></span>{{ p.status === 'connected' ? 'Connected' : 'Not connected' }}
                  </span>
                </header>
                @if (p.status === 'connected') {
                  <button
                    type="button"
                    (click)="onDisconnect(p)"
                  >Disconnect</button>
                } @else {
                  <button
                    type="button"
                    (click)="onConnect(p)"
                  >Connect</button>
                }

                @if (pasteKeyOpen() === p.key) {
                  <form class="mcp-paste-key-form" data-testid="mcp-paste-key-form" (submit)="$event.preventDefault(); submitPasteKey(p)">
                    <input
                      hlmInput
                      type="text"
                      placeholder="API key"
                      aria-label="API key"
                      [ngModel]="pasteKeyValue()"
                      (ngModelChange)="pasteKeyValue.set($event)"
                      name="apiKey"
                    />
                    <button type="submit" [disabled]="pasteKeySaving()">{{ pasteKeySaving() ? 'Saving…' : 'Save key' }}</button>
                  </form>
                }
              </article>
            }
          </div>

        </div>
      }
    </section>
  `,
  styles: [`
    .site-detail { padding: 1.5rem; color: var(--ps-ink, #f4f4ff); }
    .site-detail__head { margin-bottom: 1rem; }
    .site-detail__title { font-size: 1.5rem; margin: 0; }
    .site-detail__subtitle { color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 65%, transparent); margin: 0.25rem 0 0; font-size: 0.9rem; }
    a.site-detail__subtitle--link { display: inline-block; text-decoration: none; transition: color 0.333s ease; }
    a.site-detail__subtitle--link:hover { color: var(--ps-accent, #00E5FF); }
    a.site-detail__subtitle--link:focus-visible { outline: 2px solid var(--ps-accent, #00E5FF); outline-offset: 2px; border-radius: 4px; }
    .site-detail__tabs { display: flex; gap: 0.25rem; border-bottom: 1px solid var(--ps-edge, rgba(255,255,255,0.08)); margin-bottom: 1.25rem; }
    .site-detail__tabs button { background: transparent; border: none; color: inherit; padding: 0.6rem 1rem; font: inherit; cursor: pointer; border-bottom: 2px solid transparent; }
    .site-detail__tabs button.active { border-bottom-color: var(--ps-accent, #00e5ff); color: var(--ps-accent, #00e5ff); }
    .site-detail__toolbar { display: flex; gap: 0.75rem; align-items: center; margin-bottom: 0.75rem; }
    .site-detail__logs { background: rgba(0,0,0,0.25); border-radius: 8px; padding: 0.75rem; max-height: 60vh; overflow-y: auto; font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.85rem; }
    .log-row { display: grid; grid-template-columns: 12rem 5rem 1fr; gap: 0.75rem; padding: 0.25rem 0; }
    .log-row[data-level="error"] { color: #ff7e8a; }
    .log-row[data-level="warn"] { color: #ffd166; }
    /* Level badge — conveys level via text+shape+color (not row-tint alone),
       WCAG 1.4.1 use-of-color. Distinct from the subtle whole-row tint. */
    .log-level {
      align-self: center; justify-self: start; text-transform: uppercase;
      font-size: 0.6rem; font-weight: 700; letter-spacing: 0.05em;
      padding: 1px 7px; border-radius: 999px; line-height: 1.5;
      color: var(--ps-text-secondary, rgba(255,255,255,0.6));
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.12);
    }
    .log-level[data-level="error"] { color: #ff7e8a; background: color-mix(in oklch, #ff4d6d 14%, transparent); border-color: color-mix(in oklch, #ff4d6d 34%, transparent); }
    .log-level[data-level="warn"]  { color: #ffd166; background: color-mix(in oklch, #ffd166 14%, transparent); border-color: color-mix(in oklch, #ffd166 34%, transparent); }
    .log-level[data-level="info"]  { color: var(--ps-accent, #00e5ff); background: color-mix(in oklch, var(--ps-accent, #00e5ff) 12%, transparent); border-color: color-mix(in oklch, var(--ps-accent, #00e5ff) 30%, transparent); }
    /* Status dot + text — matches the cockpit live-status pattern (ai-logs
       live-pill, apps-instances status-pill). The dot inherits the state colour. */
    .ws-status { display: inline-flex; align-items: center; gap: 5px; }
    .ws-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex-shrink: 0; }
    .ws-connected { color: #76e7a3; }
    .ws-connecting { color: #ffd166; }
    .ws-error { color: #ff7e8a; }
    .snapshot-list { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.5rem; }
    .snapshot-row { display: flex; justify-content: space-between; align-items: center; padding: 0.75rem; background: rgba(255,255,255,0.04); border-radius: 8px; }
    .snapshot-meta { display: flex; flex-direction: column; gap: 0.15rem; }
    .ai-name { color: var(--ps-accent, #00e5ff); font-size: 0.85rem; }
    .snapshot-ver { font-family: var(--ps-font-mono, ui-monospace, 'JetBrains Mono', monospace); opacity: 0.75; }
    .snapshot-ver-label { font-family: system-ui, sans-serif; text-transform: uppercase; letter-spacing: 0.04em; font-size: 0.72em; opacity: 0.7; }
    .rollback-btn { padding: 0.4rem 0.9rem; background: transparent; border: 1px solid var(--ps-accent, #00e5ff); color: var(--ps-accent, #00e5ff); border-radius: 6px; cursor: pointer; }
    .rollback-btn:hover { background: color-mix(in oklch, var(--ps-accent, #00e5ff) 12%, transparent); }
    /* .sql-editor removed — now Spartan hlmInput [multiline] (font-mono resize-y). */
    .sql-toolbar { display: flex; gap: 0.75rem; align-items: center; margin: 0.5rem 0 1rem; }
    .sql-explain-btn {
      font: inherit; font-size: 0.8rem; cursor: pointer; padding: 0.4rem 0.9rem; border-radius: 6px;
      color: var(--ps-accent, #00e5ff);
      background: color-mix(in oklch, var(--ps-accent, #00e5ff) 9%, transparent);
      border: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 30%, transparent);
    }
    .sql-explain-btn:hover:not(:disabled) { background: color-mix(in oklch, var(--ps-accent, #00e5ff) 18%, transparent); }
    .sql-explain-btn:disabled { opacity: 0.45; cursor: not-allowed; }
    .sql-explain-btn:focus-visible { outline: 2px solid var(--ps-accent, #00e5ff); outline-offset: 2px; }
    .sql-plan { margin: 0 0 1rem; padding: 0.6rem 0.75rem; border-radius: var(--ps-radius-sm, 8px); background: rgba(0,0,0,0.28); border: 1px solid var(--ps-edge, rgba(255,255,255,0.08)); }
    .sql-plan-h { font-size: 0.62rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); margin-bottom: 0.4rem; }
    .sql-plan-list { margin: 0; padding-left: 1.2rem; display: grid; gap: 0.2rem; font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.78rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 85%, transparent); }
    .sql-plan-hint { margin: 0.55rem 0 0; font-size: 0.72rem; line-height: 1.45; }
    .sql-plan-hint[data-level='warn'] { color: #ffd166; }
    .sql-plan-hint[data-level='ok'] { color: #4dffb5; }
    .sql-starters { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; margin-top: 0.5rem; }
    .sql-starters-label { font-size: 0.66rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 50%, transparent); }
    .sql-starter-chip {
      font-size: 0.72rem; font-weight: 500; padding: 0.22rem 0.6rem; border-radius: 999px; cursor: pointer;
      color: var(--ps-accent, #00e5ff);
      background: color-mix(in oklch, var(--ps-accent, #00e5ff) 9%, transparent);
      border: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 28%, transparent);
      transition: background 140ms ease, border-color 140ms ease;
    }
    .sql-starter-chip:hover { background: color-mix(in oklch, var(--ps-accent, #00e5ff) 18%, transparent); border-color: color-mix(in oklch, var(--ps-accent, #00e5ff) 50%, transparent); }
    .sql-starter-chip:focus-visible { outline: 2px solid var(--ps-accent, #00e5ff); outline-offset: 2px; }
    .sql-result-meta { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.4rem; }
    .sql-result-count { font-size: 0.72rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); font-variant-numeric: tabular-nums; }
    .sql-result-cap { font-size: 0.68rem; color: #ffc800; }
    .sql-cost { font-size: 0.68rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); font-variant-numeric: tabular-nums; cursor: help; }
    .sql-scan-warn {
      margin: 0.35rem 0 0.6rem; padding: 0.4rem 0.6rem; border-radius: var(--ps-radius-sm, 8px);
      font-size: 0.72rem; line-height: 1.45; color: #ffd166;
      background: color-mix(in oklch, #ffd166 8%, transparent);
      border: 1px solid color-mix(in oklch, #ffd166 26%, transparent);
    }
    .sql-result-copy {
      margin-left: auto; font-size: 0.7rem; font-weight: 500; padding: 0.2rem 0.55rem; border-radius: 6px; cursor: pointer;
      color: var(--ps-accent, #00e5ff);
      background: color-mix(in oklch, var(--ps-accent, #00e5ff) 9%, transparent);
      border: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 28%, transparent);
    }
    .sql-result-copy:hover { background: color-mix(in oklch, var(--ps-accent, #00e5ff) 18%, transparent); }
    .sql-result-copy:focus-visible { outline: 2px solid var(--ps-accent, #00e5ff); outline-offset: 2px; }
    .sql-result-scroll { overflow-x: auto; max-width: 100%; border-radius: 8px; }
    .sql-result-scroll:focus-visible { outline: 2px solid var(--ps-accent, #00e5ff); outline-offset: 2px; }
    .sql-result-table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
    .sql-result-table th, .sql-result-table td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--ps-edge, rgba(255,255,255,0.08)); }
    .sql-error {
      margin: 0.5rem 0 1rem; padding: 0.6rem 0.75rem; border-radius: var(--ps-radius-sm, 8px);
      background: color-mix(in oklch, #ff4d6d 8%, transparent);
      border: 1px solid color-mix(in oklch, #ff4d6d 26%, transparent);
    }
    .sql-error-plain { margin: 0 0 0.4rem; font-size: 0.82rem; line-height: 1.45; color: #ff9fa8; }
    .sql-error-raw { margin: 0; font-size: 0.72rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); }
    .sql-error-raw-label { text-transform: uppercase; letter-spacing: 0.04em; font-size: 0.62rem; font-weight: 700; opacity: 0.7; margin-right: 0.3rem; }
    .sql-error-raw code { font-family: 'JetBrains Mono', ui-monospace, monospace; color: #ff7e8a; word-break: break-word; }
    .sql-readonly-pill {
      margin-left: auto; font-size: 0.68rem; font-weight: 600; letter-spacing: 0.04em;
      text-transform: uppercase; padding: 0.2rem 0.55rem; border-radius: 999px; cursor: help;
      color: var(--ps-accent, #00e5ff);
      background: color-mix(in oklch, var(--ps-accent, #00e5ff) 12%, transparent);
      border: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 35%, transparent);
    }
    .sql-safe-note {
      margin: -0.5rem 0 1rem; display: flex; gap: 0.5rem; align-items: baseline;
      font-size: 0.72rem; line-height: 1.45;
      color: var(--ps-text-secondary, rgba(255,255,255,0.6));
      padding: 0.5rem 0.7rem; border-radius: var(--ps-radius-sm, 8px);
      background: color-mix(in oklch, var(--ps-accent, #00e5ff) 5%, transparent);
      border: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 16%, transparent);
    }
    .sql-safe-note strong { color: var(--ps-accent, #00e5ff); font-weight: 600; }
    .sql-safe-glyph { flex-shrink: 0; }
    .rollback-error { margin-top: 0.5rem; color: #ff7e8a; font-size: 0.85rem; }
    .sql-history { margin-top: 1rem; }
    .sql-history ul { list-style: none; padding: 0; margin: 0.5rem 0 0; display: grid; gap: 0.25rem; }
    .sql-history li { padding: 0.25rem 0.5rem; background: rgba(255,255,255,0.03); border-radius: 4px; font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.8rem; }
    .mcp-list { display: grid; gap: 0.75rem; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
    .mcp-card { padding: 1rem; background: rgba(255,255,255,0.04); border-radius: 8px; }
    .mcp-card header { display: flex; justify-content: space-between; margin-bottom: 0.5rem; }
    .mcp-status { display: inline-flex; align-items: center; gap: 6px; font-size: 0.74rem; font-weight: 600; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); }
    .mcp-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; background: color-mix(in oklch, var(--ps-ink, #f4f4ff) 35%, transparent); }
    .mcp-status.is-connected { color: var(--ps-success, #4dffb5); }
    .mcp-status.is-connected .mcp-dot { background: var(--ps-success, #4dffb5); box-shadow: 0 0 8px color-mix(in oklch, var(--ps-success, #4dffb5) 55%, transparent); }
    .mcp-paste-key-form { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
    .mcp-paste-key-form input { flex: 1; }
    .muted { color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); }
  `],
})
export class AdminSiteDetailComponent {
  private readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  private readonly adminState = inject(AdminStateService);

  readonly siteId = signal<string>('');
  readonly site = signal<{ id: string; slug: string; name: string } | null>(null);
  readonly tab = signal<Tab>('logs');

  /**
   * The SQL tab is a platform super-admin power tool — `/sites/:id/sql/exec` 403s
   * every non-super-admin. Gate the tab + panel + `runSql()` on the super-admin flag
   * (hydrated once from `/api/auth/me` into AdminStateService — no extra HTTP call) so a
   * regular site owner never sees a control that will only ever fail (embarrassingly-easy:
   * never show a doomed control).
   */
  readonly canUseSqlConsole = computed(() => this.adminState.isSuperAdmin() === true);

  // ── Logs ─────────────────────────────────────────────────────────────
  readonly logs = signal<LogRow[]>([]);
  readonly logLevel = signal<'all' | 'debug' | 'info' | 'warn' | 'error'>('all');
  readonly logSearch = signal('');
  readonly wsStatus = signal<'connecting' | 'connected' | 'error'>('connecting');
  readonly filteredLogs = computed(() => {
    const level = this.logLevel();
    const q = this.logSearch().toLowerCase().trim();
    return this.logs().filter((r) => {
      if (level !== 'all' && r.level !== level) return false;
      if (q && !r.message.toLowerCase().includes(q)) return false;
      return true;
    });
  });
  /**
   * Filter-aware empty message for the logs `@empty` block — "no match" when a
   * level/search filter is hiding existing logs, vs "no logs yet" when the site
   * truly has none (so we never claim "no logs yet" while logs exist).
   */
  readonly logsEmptyText = computed(() =>
    (this.logLevel() !== 'all' || this.logSearch().trim() !== '') && this.logs().length > 0
      ? 'No logs match this level / search filter.'
      : 'No logs yet — activity will stream in here.',
  );

  // ── Snapshots ────────────────────────────────────────────────────────
  readonly snapshots = signal<SnapshotRow[]>([]);
  /** Honest load-error surface — set when a stale route returns a shapeless 200
   *  (no snapshots array) so the panel shows a retryable notice instead of a
   *  fake "no snapshots yet" empty state. */
  readonly snapshotsError = signal<string | null>(null);
  /** Worker request_id from a failed snapshots load, surfaced as a copyable support reference on the error card. */
  readonly snapshotsErrorRef = signal('');
  readonly pendingRollback = signal<SnapshotRow | null>(null);
  readonly rollbackResult = signal<string | null>(null);
  readonly rollbackError = signal<string | null>(null);
  /** Re-entry guard for the most destructive action — a rapid double-click on
   *  Rollback must not open two confirm dialogs / fire two overwrites. */
  private rollbackBusy = false;

  // ── SQL ──────────────────────────────────────────────────────────────
  readonly sqlQuery = signal('');
  /** One-click starter queries — universal, read-only, pass both the client +
   *  server guards. Gives an empty console a guided first action (what tables
   *  exist?) instead of a blank `SELECT * FROM …` placeholder. */
  readonly sqlStarters: ReadonlyArray<{ label: string; query: string }> = [
    { label: 'List tables', query: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name" },
    { label: 'List indexes', query: "SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY tbl_name, name" },
    { label: 'SQLite version', query: 'SELECT sqlite_version() AS version' },
  ];
  /** Fill the editor with a starter and run it (all starters are read-only). */
  useSqlStarter(query: string): void {
    this.sqlQuery.set(query);
    this.runSql();
  }

  /** Cap the rendered table rows so a `SELECT *` on a large table can't dump
   *  thousands of <tr> into the DOM (layout shift + jank). The full result stays
   *  in sqlResult() — Copy JSON exports every row regardless of this cap. */
  readonly sqlRenderCap = 200;
  cappedRows(r: SqlResult): Array<Record<string, unknown>> {
    return r.rows.length > this.sqlRenderCap ? r.rows.slice(0, this.sqlRenderCap) : r.rows;
  }

  /** Rows-read threshold above which a query is flagged as an expensive scan. */
  private static readonly EXPENSIVE_SCAN_ROWS = 10_000;
  /**
   * True when D1 reported a large `rows_read` — a table scan that D1 bills + slows
   * on. Gated on a real reported value (never fires on a null/absent metric).
   */
  isExpensiveScan(r: SqlResult): boolean {
    return r.rows_read != null && r.rows_read > AdminSiteDetailComponent.EXPENSIVE_SCAN_ROWS;
  }

  /** Thousands-separated integer for the D1 cost readout (e.g. 12000 → "12,000"). */
  fmtNum(n: number): string {
    return n.toLocaleString();
  }

  /**
   * Plain-language explanation for a common SQLite/D1 error, or null when the error
   * isn't one we recognize (the raw error is always shown alongside, so an unmapped
   * error is never hidden). Pure — a regex map over the raw message, no side effects.
   */
  explainSqlError(raw: string): string | null {
    if (!raw) return null;
    let m = /no such table:\s*(\S+)/i.exec(raw);
    if (m) return `The table "${m[1]}" doesn't exist. Check the name — the "List tables" starter shows what's available.`;
    m = /no such column:\s*(\S+)/i.exec(raw);
    if (m) return `There's no column "${m[1]}" in that table. Check the spelling, or open the schema to see the columns.`;
    m = /no such function:\s*(\S+)/i.exec(raw);
    if (m) return `SQLite/D1 has no function called "${m[1]}". D1 supports standard SQLite functions only — no loadable extensions.`;
    m = /unique constraint failed:\s*(.+)$/i.exec(raw);
    if (m) return `A row with that value already exists — the UNIQUE constraint on ${m[1].trim()} was violated.`;
    m = /foreign key constraint failed/i.exec(raw);
    if (m) return 'A foreign-key constraint failed — the referenced row is missing, or a child row still references this one.';
    if (/syntax error/i.test(raw)) {
      const near = /near\s+"([^"]*)"/i.exec(raw);
      return near
        ? `SQL syntax error near "${near[1]}". Check for a typo, a missing comma, or an unclosed quote or parenthesis.`
        : 'SQL syntax error. Check for a typo, a missing comma, or an unclosed quote or parenthesis.';
    }
    if (/unrecognized token/i.test(raw)) return 'Unrecognized token — check for a stray character or an unclosed string literal.';
    if (/incomplete input/i.test(raw)) return 'The statement looks incomplete — you may be missing a closing quote, parenthesis, or the rest of the query.';
    if (/wrong number of arguments|requires an? .*argument/i.test(raw)) return 'A function was called with the wrong number of arguments — check its signature.';
    if (/expression tree is too large|too many|parser stack overflow/i.test(raw)) return 'The query is too large or complex for D1 — simplify it or split it into smaller queries.';
    return null;
  }

  /**
   * Render a timestamp (log `ts`, snapshot `created_at`) as a readable local
   * date/time instead of a raw ISO/D1 string. DEFENSIVE: if the value isn't a
   * parseable date (already formatted, relative, or empty) it's returned
   * unchanged — so this never turns a good value into "Invalid Date".
   */
  formatTs(value: string | null | undefined): string {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'medium' }).format(d);
  }

  /** Brief "✓ Copied" affordance on the SQL-result Copy button. */
  readonly sqlCopied = signal(false);
  /** Copy the query result rows to the clipboard as JSON (formula-injection-safe
   *  — JSON quotes every value, so pasting into a sheet never executes). */
  copySqlResult(r: SqlResult): void {
    void navigator.clipboard.writeText(JSON.stringify(r.rows, null, 2)).then(
      () => { this.sqlCopied.set(true); setTimeout(() => this.sqlCopied.set(false), 1500); },
      () => undefined,
    );
  }
  readonly sqlResult = signal<SqlResult | null>(null);
  readonly sqlError = signal<string | null>(null);
  readonly sqlRunning = signal(false);
  readonly sqlHistory = signal<string[]>([]);
  /** EXPLAIN QUERY PLAN output — the `detail` line per plan step; null until Explain runs. */
  readonly explainPlan = signal<string[] | null>(null);
  readonly explainRunning = signal(false);
  /**
   * Index guidance derived from the plan: a bare full-table `SCAN` (no index) or a
   * `USE TEMP B-TREE` (unindexed sort/group) → warn with an actionable hint; an
   * all-index plan → an OK note. Null when there's no plan.
   */
  readonly planHint = computed<{ level: 'warn' | 'ok'; text: string } | null>(() => {
    const plan = this.explainPlan();
    if (!plan || plan.length === 0) return null;
    const fullScan = plan.some(
      (d) => /\bSCAN\b/i.test(d) && !/USING\s+(?:COVERING\s+)?INDEX/i.test(d),
    );
    if (fullScan)
      return {
        level: 'warn',
        text: 'This query scans a whole table (no index used). Add an index on the columns in the WHERE / ORDER BY / JOIN to avoid the scan on large tables.',
      };
    if (plan.some((d) => /USE TEMP B-TREE/i.test(d)))
      return {
        level: 'warn',
        text: 'This query sorts or groups without an index (a temporary B-tree). An index matching the ORDER BY / GROUP BY can avoid it.',
      };
    return { level: 'ok', text: 'Uses an index — no full-table scan in this plan.' };
  });

  // ── Integrations ─────────────────────────────────────────────────────
  readonly integrations = signal<IntegrationProvider[]>([]);
  readonly pasteKeyOpen = signal<string | null>(null);
  readonly pasteKeyValue = signal('');

  constructor() {
    // Capture siteId once route param is available.
    this.route.paramMap
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((params) => {
        const id = params.get('id') ?? '';
        this.siteId.set(id);
        this.loadSite(id);
      });

    // Deep-linkable tabs: a `?tab=sql` URL opens that tab (bookmarkable +
    // shareable for support). Validated against VALID_TABS (unknown → default).
    // Sets the signal only — no re-navigation here, so there's no loop with
    // setTab's URL sync below.
    this.route.queryParamMap
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((q) => {
        const t = q.get('tab');
        if (t && VALID_TABS.includes(t as Tab) && t !== this.tab()) {
          this.tab.set(t as Tab);
        }
      });

    // Never strand a non-super-admin on a super-admin-only tab (SQL or Schema). A
    // `?tab=sql`/`?tab=schema` deep-link, or the super-admin flag arriving late (getMe
    // resolves after first paint) while one is active, would otherwise leave the active
    // tab pointing at a panel that no longer renders (a blank body). Fall back to the
    // first visible tab (logs) whenever a gated tab is selected but the console isn't
    // available.
    effect(() => {
      const gated = this.tab() === 'sql' || this.tab() === 'schema';
      if (gated && !this.canUseSqlConsole()) {
        this.tab.set('logs');
      }
    });

    // Restore SQL history from localStorage (per-site).
    effect(() => {
      const id = this.siteId();
      if (!id) return;
      try {
        const raw = localStorage.getItem(`ps_sql_history_${id}`);
        if (raw) this.sqlHistory.set(JSON.parse(raw) as string[]);
      } catch { /* private mode etc. */ }
    });

    // Poll logs every 3s as the floor (per [[rxjs-first-angular]]). WS is
    // the ceiling but not yet wired — polling keeps the live-tail UX honest
    // and the wsStatus signal flips to 'connected' once the first batch lands.
    effect(() => {
      const id = this.siteId();
      if (!id) return;
      this.startLogTail(id);
      this.loadSnapshots(id);
      this.loadIntegrations(id);
    });
  }

  setTab(t: Tab): void {
    this.tab.set(t);
    // Reflect the tab in the URL so it's bookmarkable/shareable. `replaceUrl`
    // keeps tab clicks out of browser history (no back-button spam); `merge`
    // preserves any other query params. SPA nav — never a reload.
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab: t },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  // ── Site load ────────────────────────────────────────────────────────
  private loadSite(id: string): void {
    this.api
      // { silent }: the catchError below degrades to a slug-only record, so a
      // 404/transient must NOT also fire ApiService's generic "resource wasn't
      // found" toast (it stacked scary toasts on this param route).
      // The worker returns { data: { id, slug, business_name, … } } — reading the old
      // res.site key always yielded undefined → site() stayed null → the h1 fell back
      // to siteId() (the raw UUID). Read res.data and map business_name → the signal's
      // `name` field so the title shows the real business name.
      .get<{ data: { id: string; slug: string; business_name: string } }>(`/sites/${id}`, undefined, { silent: true })
      .pipe(
        // On failure, fall back to a slug-only record (slug = the URL id) — never
        // inject a misleading "Site" name literal (the h1 + subtitle derive a
        // meaningful host from the slug/id instead of a generic word).
        catchError(() => of({ data: { id, slug: id, business_name: '' } })),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res) =>
        this.site.set(res.data ? { id: res.data.id, slug: res.data.slug, name: res.data.business_name } : null),
      );
  }

  // ── Logs ─────────────────────────────────────────────────────────────
  private startLogTail(id: string): void {
    this.wsStatus.set('connecting');
    timer(0, 3000)
      .pipe(
        switchMap(() => {
          // Only poll while the Logs tab is actually visible — otherwise the
          // tail kept hitting the network every 3s for the component's whole
          // lifetime while the user sat on SQL/Integrations/Snapshots (wasted
          // requests + console noise). `of(null)` skips the tick cleanly.
          if (this.tab() !== 'logs') return of(null);
          // { silent } + NO inner retry: the timer(0, 3000) above IS the poll
          // cadence, so retrying a permanent 404 just tripled the requests
          // (a 30×-in-seconds storm) and the missing { silent } toasted each
          // failure. catchError degrades this tick to empty; next tick re-polls.
          return this.api.get<{ logs: LogRow[] }>(`/sites/${id}/logs/tail`, undefined, { silent: true }).pipe(
            catchError(() => of({ logs: [] as LogRow[] })),
          );
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res) => {
        if (!res) return; // skipped tick — Logs tab not active
        this.wsStatus.set('connected');
        if (Array.isArray(res.logs) && res.logs.length) {
          this.logs.set(res.logs);
        }
      });
  }

  // ── Snapshots ────────────────────────────────────────────────────────
  /** Public so the panel's Retry button can re-fire it after a shapeless-200. */
  loadSnapshots(id: string): void {
    this.snapshotsErrorRef.set('');
    this.api
      // Worker returns { data: SnapshotRow[], git_history } (site_versioning route
      // extraction standardized on `data`). Reading the old `snapshots` key made
      // res.snapshots undefined → the shape-guard below fired on EVERY load, showing
      // "response was unexpected" instead of the snapshots.
      .get<{ data: SnapshotRow[] }>(`/sites/${id}/snapshots`, undefined, { silent: true })
      // catchError → null so a genuine network/404 is distinguishable from a
      // healthy-but-shapeless 200 (which reaches the subscriber as a non-array).
      // Capture the worker request_id off the real error so the shared error card
      // can offer a copyable support reference (the shapeless-200 path has no err).
      .pipe(
        catchError((err: { error?: unknown }) => {
          this.snapshotsErrorRef.set(this.requestIdFrom(err));
          return of(null);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res) => {
        // Shape guard: a STALE worker route can return a parseable 200 whose body
        // lacks the snapshots array (SPA/marketing HTML, or `{}`). `?? []` would
        // mask that as a fake "no snapshots yet" — or crash the @for on a non-array
        // (e.g. a coerced string). Surface an honest, retryable error instead and
        // keep the list a safe empty array.
        if (!res || !Array.isArray(res.data)) {
          this.snapshots.set([]);
          this.snapshotsError.set('The snapshots response was unexpected — check your connection and retry.');
          return;
        }
        this.snapshotsError.set(null);
        this.snapshotsErrorRef.set('');
        this.snapshots.set(res.data);
      });
  }

  /** Pull the worker request_id from a failed response ({ error: { request_id } }) for the support reference. */
  private requestIdFrom(e: { error?: unknown } | undefined): string {
    return (e?.error as { error?: { request_id?: string } } | undefined)?.error?.request_id ?? '';
  }

  /** Rolling back OVERWRITES the live production site — the single most
   *  destructive admin action. Gate it behind the shared ConfirmService
   *  (branded danger dialog: focus-trap + Esc + focus-restore), replacing the
   *  bespoke inline confirm <div>. confirmRollback() does the actual POST. */
  async onRollbackClick(s: SnapshotRow): Promise<void> {
    if (this.rollbackBusy) return; // re-entry guard: one confirm + one overwrite per click-burst
    this.rollbackBusy = true;
    try {
      const ok = await this.confirm.confirm({
        title: `Roll back to ${s.snapshot_name}?`,
        message: `This OVERWRITES the live production site with the "${s.snapshot_name}" snapshot — the current version is replaced immediately. You can only undo it by rolling back again.`,
        confirmLabel: 'Roll back live site',
        danger: true,
      });
      if (!ok) {
        this.pendingRollback.set(null);
        return;
      }
      this.pendingRollback.set(s);
      this.confirmRollback();
    } finally {
      this.rollbackBusy = false;
    }
  }

  confirmRollback(): void {
    const s = this.pendingRollback();
    if (!s) return;
    const id = this.siteId();
    this.rollbackError.set(null);
    this.api
      // {silent}: the catchError below sets the inline rollback-error panel
      // (the contextual failure surface) — suppress the generic ApiService toast
      // so a failed rollback shows ONE message, not two.
      .post<{ ok: boolean; snapshot_name: string }>(
        `/sites/${id}/snapshots/${s.id}/rollback`,
        {},
        { silent: true },
      )
      .pipe(
        // Surface the failure — do NOT fabricate a success shape. A faked
        // { ok: true } here would show "Rolled back to X" while the site was
        // never rolled back (a destructive-action lying-UI). Return null on
        // error and branch on it in the subscriber.
        catchError((err: unknown) => {
          const msg =
            (err as { error?: { error?: { message?: string } } })?.error?.error?.message ??
            (err as { message?: string })?.message ??
            'Rollback failed — please try again.';
          this.rollbackError.set(msg);
          return of(null);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res) => {
        this.pendingRollback.set(null);
        if (!res) return; // failure already surfaced via rollbackError — no false success
        this.rollbackError.set(null);
        this.rollbackResult.set(res.snapshot_name);
        this.loadSnapshots(id);
      });
  }

  // ── SQL ──────────────────────────────────────────────────────────────
  /** Leading write/DDL keyword → this console is read-only. Matches only the
   *  FIRST statement keyword (after any leading line comments) so a SELECT with
   *  "update" inside a string/column never false-positives. The server is the
   *  real boundary; this is instant feedback + defense-in-depth. */
  private static readonly WRITE_LEAD =
    /^\s*(?:--[^\n]*\r?\n\s*)*(DROP|DELETE|UPDATE|INSERT|ALTER|CREATE|TRUNCATE|REPLACE|ATTACH|DETACH|VACUUM|REINDEX)\b/i;

  runSql(): void {
    // Super-admin-only power tool — the server 403s non-super-admins, so never fire
    // the POST for them (the tab is hidden anyway; this is defense-in-depth).
    if (!this.canUseSqlConsole()) return;
    if (this.sqlRunning()) return; // guard: no concurrent /sql/exec pile-up while one is in flight
    const query = this.sqlQuery().trim();
    if (!query) return;
    const write = AdminSiteDetailComponent.WRITE_LEAD.exec(query);
    if (write) {
      this.sqlResult.set(null);
      this.sqlError.set(
        `This console is read-only — remove the ${write[1].toUpperCase()} statement. Only SELECT / EXPLAIN / WITH queries run here.`,
      );
      return;
    }
    const id = this.siteId();
    this.sqlRunning.set(true);
    this.sqlError.set(null);
    this.explainPlan.set(null); // a fresh run supersedes any prior EXPLAIN plan
    interface SqlExecRes {
      ok: boolean;
      columns?: string[];
      rows?: Array<Record<string, unknown>>;
      duration_ms?: number;
      rows_read?: number | null;
      rows_written?: number | null;
      d1_duration_ms?: number | null;
      error?: string;
    }
    this.api
      .post<SqlExecRes>(`/sites/${id}/sql/exec`, { query })
      .pipe(
        catchError((err) =>
          of<SqlExecRes>({
            ok: false,
            error: err?.error?.error?.message ?? err?.message ?? 'unknown error',
          }),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res: SqlExecRes) => {
        this.sqlRunning.set(false);
        if (!res.ok || res.error) {
          this.sqlError.set(res.error ?? 'query failed');
          return;
        }
        this.sqlResult.set({
          columns: res.columns ?? [],
          rows: res.rows ?? [],
          duration_ms: res.duration_ms ?? 0,
          rows_read: res.rows_read ?? null,
          rows_written: res.rows_written ?? null,
          d1_duration_ms: res.d1_duration_ms ?? null,
        });
        // Persist history.
        const next = [query, ...this.sqlHistory().filter((q) => q !== query)].slice(0, 50);
        this.sqlHistory.set(next);
        try {
          localStorage.setItem(`ps_sql_history_${id}`, JSON.stringify(next));
        } catch { /* ignore */ }
      });
  }

  /**
   * Run `EXPLAIN QUERY PLAN` for the current query and show the plan + index guidance.
   * EXPLAIN does NOT execute the statement (it only plans), and the server allows it
   * via the read allowlist — so this is safe for any query the editor holds, with no
   * write-guard needed. Superadmin-gated like the rest of the console.
   */
  explainSql(): void {
    if (!this.canUseSqlConsole()) return;
    if (this.explainRunning() || this.sqlRunning()) return;
    const query = this.sqlQuery().trim().replace(/;\s*$/, '');
    if (!query) return;
    const id = this.siteId();
    this.explainRunning.set(true);
    this.explainPlan.set(null);
    this.sqlError.set(null);
    interface ExplainRes {
      ok: boolean;
      rows?: Array<Record<string, unknown>>;
      error?: string;
    }
    this.api
      .post<ExplainRes>(`/sites/${id}/sql/exec`, { query: `EXPLAIN QUERY PLAN ${query}` })
      .pipe(
        catchError((err) =>
          of<ExplainRes>({
            ok: false,
            error: err?.error?.error?.message ?? err?.message ?? 'unknown error',
          }),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res: ExplainRes) => {
        this.explainRunning.set(false);
        if (!res.ok || res.error) {
          // Reuse the shared error surface — an explain failure is a query error.
          this.sqlError.set(res.error ?? 'Could not explain the query.');
          return;
        }
        // SQLite EXPLAIN QUERY PLAN rows carry a human-readable `detail` per plan step.
        this.explainPlan.set((res.rows ?? []).map((r) => String(r['detail'] ?? '')).filter(Boolean));
      });
  }

  // ── Integrations ─────────────────────────────────────────────────────
  private loadIntegrations(id: string): void {
    this.api
      .get<{ providers: IntegrationProvider[] }>(`/sites/${id}/integration-providers`, undefined, { silent: true })
      .pipe(
        catchError(() => of({ providers: DEFAULT_PROVIDERS })),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res) => {
        // Shape guard: only an actual non-empty ARRAY replaces the default catalog.
        // A shapeless 200 (e.g. `{ providers: '<html>' }`) has a truthy `.length`
        // and would otherwise slip a coerced string into the @for and crash it.
        this.integrations.set(
          Array.isArray(res.providers) && res.providers.length ? res.providers : DEFAULT_PROVIDERS,
        );
      });
  }

  onConnect(p: IntegrationProvider): void {
    // The `/connect` route is BEARER-AUTH-GATED, so opening a popup straight at
    // it shows an "auth required" 401 (or a raw JSON authorize blob). Fetch the
    // authorize URL WITH the bearer (ApiService) first, THEN open the popup at
    // the provider's authorize page. 501 / no URL → inline paste-key fallback.
    this.api
      .get<{ data?: { mode?: string; authorize_url?: string } }>(
        `/mcp/${p.key}/connect`,
        { site_id: this.siteId() },
        { silent: true },
      )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          const authUrl = res?.data?.authorize_url;
          if (authUrl) {
            const popup = window.open(authUrl, `mcp_${p.key}`, 'width=600,height=720');
            if (!popup) this.pasteKeyOpen.set(p.key); // popup blocked → paste-key
            return;
          }
          this.pasteKeyOpen.set(p.key); // paste_key adapter / missing URL
        },
        error: () => { this.pasteKeyOpen.set(p.key); }, // 501 (not configured) / failure
      });
  }

  readonly pasteKeySaving = signal(false);
  submitPasteKey(p: IntegrationProvider): void {
    const apiKey = this.pasteKeyValue().trim();
    if (!apiKey || this.pasteKeySaving()) return;
    this.pasteKeySaving.set(true);
    this.api
      // {silent} — surface the specific failure below, not the generic toast.
      // catchError returns null (not a fake { ok }) so failure is distinguishable.
      // Worker reads the site from `?state=` (OAuth flow) OR the `?site_id=`
      // query fallback — NOT the body. Without a query param it 400'd
      // "site_id required" on every paste-key connect (Resend + any provider
      // without OAuth creds). Send site_id as the query param it actually reads.
      .post(`/mcp/${p.key}/paste?site_id=${encodeURIComponent(this.siteId())}`, { api_key: apiKey, site_id: this.siteId() }, { silent: true })
      .pipe(
        catchError(() => of(null)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res) => {
        this.pasteKeySaving.set(false);
        if (res === null) {
          // Failure: keep the form open + the typed key so the operator can fix
          // + retry — never silently close on a rejected/bad key.
          this.toast.error(`Couldn't save the ${p.name} key — check it and try again.`);
          return;
        }
        this.pasteKeyOpen.set(null);
        this.pasteKeyValue.set('');
        this.toast.success(`Connected ${p.name}`);
        this.loadIntegrations(this.siteId());
      });
  }

  /** Disconnecting an integration is destructive (re-OAuth needed to restore) —
   *  it must be confirmed. Uses the shared ConfirmService (branded CDK dialog:
   *  focus-trap + Esc + focus-restore + cyan tokens) per the one-dialog-primitive
   *  rule, replacing a bespoke inline confirm <div>. */
  async onDisconnect(p: IntegrationProvider): Promise<void> {
    const ok = await this.confirm.confirm({
      title: `Disconnect ${p.name}?`,
      message: `${p.name} will be removed from this site. You'll need to reconnect it via OAuth to restore the integration.`,
      confirmLabel: 'Disconnect',
      danger: true,
    });
    if (!ok) return;
    this.api
      // {silent} — the catchError below shows the specific 'Could not disconnect'
      // toast, so the generic ApiService toast must not also fire (no double-toast).
      .delete(`/sites/${this.siteId()}/integration-providers/${p.key}`, { silent: true })
      .pipe(
        // Return null on error (don't fabricate { ok: true }) so a failed
        // disconnect never optimistically flips the chip to "disconnected".
        catchError(() => of(null)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res) => {
        if (res === null) {
          this.toast.error(`Could not disconnect ${p.name} — please try again.`);
          return;
        }
        // Optimistic flip only on a confirmed success.
        this.integrations.update((list) =>
          list.map((x) => (x.key === p.key ? { ...x, status: 'disconnected' as const } : x)),
        );
        this.loadIntegrations(this.siteId());
      });
  }
}

// Fallback catalog shown when the integrations API errors or returns empty.
// Every provider defaults to 'disconnected' — never fabricate a live connection
// (a hardcoded 'connected' Mailchimp misrepresented real connection state).
const DEFAULT_PROVIDERS: IntegrationProvider[] = [
  { key: 'mailchimp', name: 'Mailchimp', status: 'disconnected', oauth_supported: true },
  { key: 'stripe', name: 'Stripe', status: 'disconnected', oauth_supported: true },
  { key: 'hubspot', name: 'HubSpot', status: 'disconnected', oauth_supported: true },
  { key: 'resend', name: 'Resend', status: 'disconnected', oauth_supported: false },
];
