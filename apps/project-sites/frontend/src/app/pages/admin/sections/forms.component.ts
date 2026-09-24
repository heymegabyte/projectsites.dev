import {
  Component,
  inject,
  signal,
  computed,
  effect,
  type OnInit,
  type OnDestroy,
} from '@angular/core';
import { DatePipe, JsonPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AdminStateService } from '../admin-state.service';
import { ApiService } from '../../../services/api.service';
import { ToastService } from '../../../services/toast.service';
import { toCsv, downloadText } from '../../../utils/csv-export';
import { FullscreenOverlayComponent } from '../../../components/fullscreen-overlay/fullscreen-overlay.component';
import { HlmInputDirective, HlmTablistDirective } from '../../../ui';
import { BrnTooltipImports } from '@spartan-ng/brain/tooltip';
import { mcpProvider } from './mcp-providers';
import { RevealDirective } from '../../../directives/reveal.directive';
import { RollingCounterComponent } from '../../../components/rolling-counter/rolling-counter.component';
import { ErrorCardComponent } from '../../../components/states';

/** Same-day equality in local timezone. */
function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** One row in the form-submissions inbox. Returned by `GET /sites/:id/form-submissions`. */
interface Submission {
  id: string;
  form_name: string;
  email: string | null;
  fields: Record<string, unknown>;
  status: string;
  origin_url: string | null;
  ip_address: string | null;
  created_at: string;
}

/** AI router trace row attached to a submission. Returned by `GET /sites/:id/form-submissions/:id` under `ai_logs`. */
interface AiLog {
  id: string;
  trace_kind: string;
  status: string;
  model: string;
  latency_ms: number | null;
  output_text: string | null;
  tool_name: string | null;
  tool_status: string | null;
  error_message: string | null;
  created_at: string;
}

/**
 * Settings payload for the form-handling-prompt widget. The fallback reply
 * email is intentionally NOT edited from here — it lives in Settings → General
 * and is mirrored read-only via the inline notice.
 */
interface Settings {
  form_router_prompt: string | null;
  form_router_prompt_default: string;
  reply_email: string | null;
  /** Server-persisted forms-designer MCP selection (which connected MCPs the router may use). */
  enabled_mcps?: string[];
}

/**
 * Single MCP brand metadata entry. Duplicated locally to avoid a circular
 * dep with `settings.component.ts` — keep this subset in sync if a new
 * provider is added there.
 */
interface McpMeta {
  readonly label: string;
  readonly color: string;
  readonly desc: string;
}

/**
 * Adapts the shared MCP_PROVIDERS catalogue to the `McpMeta` shape used by the
 * pill row. Sourced from `./mcp-providers.ts` (no Angular deps) to avoid a
 * circular import via `settings.component.ts`.
 */
function mcpMeta(id: string): McpMeta | undefined {
  const p = mcpProvider(id);
  return p ? { label: p.label, color: p.color, desc: p.desc } : undefined;
}

/** Decorated MCP connection used by the pill row. */
interface McpPill {
  readonly provider: string;
  readonly label: string;
  readonly color: string;
  readonly desc: string;
}

/**
 * Auto-poll cadence for the submissions inbox, milliseconds.
 * @remarks Paused while the tab is hidden (visibilityState !== 'visible').
 */
const POLL_INTERVAL_MS = 10_000;

/**
 * Admin → Forms section. Inbox + analytics list, plus the embedded
 * Form-Handling-Prompt widget (textarea + MCP pills + AI improve + save).
 *
 * @remarks
 * - No "Refresh" button: auto-polls every {@link POLL_INTERVAL_MS} ms.
 * - Fallback reply email is read-only here; edit it in Settings → General.
 * - MCP pills are unchecked by default and toggle to brand color on click.
 *
 * @example
 * <app-admin-forms />
 */
@Component({
  selector: 'app-admin-forms',
  standalone: true,
  imports: [RevealDirective, RollingCounterComponent, FormsModule, RouterLink, DatePipe, JsonPipe, FullscreenOverlayComponent, HlmInputDirective, HlmTablistDirective, ErrorCardComponent, ...BrnTooltipImports],
  template: `
    <div class="p-7 flex-1 overflow-y-auto animate-fade-in max-md:p-4 space-y-6">
      <header appReveal>
        <div class="kicker">Inbox &amp; routing</div>
        <div class="flex items-center justify-between gap-4 flex-wrap mt-1">
          <h1 class="section-h text-lg font-bold text-white m-0 flex items-center gap-2">
            Forms
            @if (totalCount() > 0) {
              <span class="header-pill" [attr.aria-label]="totalCount() + ' submission' + (totalCount() === 1 ? '' : 's') + ' in inbox'" title="Total submissions stored (the inbox shows the most recent)">
                <span class="header-pill-dot" aria-hidden="true"></span>
                <app-rolling-counter [value]="totalCount()" [duration]="900" aria-hidden="true" />
                submission{{ totalCount() === 1 ? '' : 's' }}
              </span>
            }
          </h1>
          <div class="flex items-center gap-2 flex-wrap header-actions">
            <button class="btn-prompt-quiet"
                    type="button"
                    data-testid="forms-open-prompt-designer"
                    (click)="designerOpen.set(true)"
                    [brnTooltip]="'Open the full-screen prompt designer + tester'"
                    aria-label="Open the form-handling prompt designer">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M9 13h6M9 17h4"/></svg>
              <span>Edit prompt</span>
            </button>
          </div>
        </div>
        <p class="text-[0.78rem] text-text-secondary m-0 mt-1 max-w-prose leading-relaxed">
          One prompt handles every form submission and routes it to the right action — MailChimp signup, Stripe invoice, email reply, HubSpot contact — using your connected MCPs.
          @if (mcpConnections().length > 0) {
            <span class="text-emerald-300">· {{ mcpConnections().length }} MCP{{ mcpConnections().length === 1 ? '' : 's' }} connected</span>
          } @else {
            <span class="text-amber-300">· no MCPs connected — only email fallback available</span>
          }
        </p>
      </header>

      <!-- Legacy inline test panel — retained behind testOpen() only so any
           in-flight test (rare, since the new designer hosts the panel) still
           renders. New entry point is the Prompt Designer overlay. -->
      @if (testOpen()) {
        <section class="card border border-primary/30" appReveal>
          <div class="flex items-center justify-between mb-2">
            <div>
              <h2 class="section-h m-0 text-base font-semibold text-white">Test the Form Handling Prompt</h2>
              <p class="m-0 mt-0.5 text-[0.7rem] text-text-secondary">Runs the current prompt against this payload (1 credit).</p>
            </div>
            <button class="icon-close" type="button" (click)="testOpen.set(false)" aria-label="Close test panel" [brnTooltip]="'Close test panel'">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <div class="grid sm:grid-cols-2 gap-2">
            <input hlmInput placeholder="form_name (e.g. newsletter, contact)" aria-label="Form name" [(ngModel)]="testInput.form_name" />
            <input hlmInput type="email" placeholder="email" aria-label="Submitter email" [(ngModel)]="testInput.email" />
          </div>
          @if (formNameInvalid()) {
            <p class="text-[0.7rem] text-red-300/90 mt-1" role="alert" data-testid="forms-test-name-hint">Form name must be a short slug — letters, numbers, hyphen or underscore, max 64 chars.</p>
          }
          <textarea hlmInput [multiline]="true" class="w-full mt-2 font-mono text-[0.72rem]" rows="3" placeholder='Other fields as JSON, e.g. { "message": "hi", "name": "Brian" }'
                    aria-label="Additional fields as JSON"
                    [(ngModel)]="testInput.fields_json"></textarea>
          <div class="flex justify-between items-center mt-2">
            <div class="flex items-center gap-1.5 flex-wrap">
              @for (m of mcpConnections(); track m.provider) {
                <span class="mcp-chip" [style.background]="m.color + '20'" [style.color]="m.color" [style.border-color]="m.color + '60'" [title]="m.desc">{{ m.label }}</span>
              }
            </div>
            <button class="btn-primary" (click)="runTest()" [disabled]="testing() || formNameInvalid()" [brnTooltip]="'Run the prompt now'">{{ testing() ? 'Running…' : 'Run' }}</button>
          </div>
          @if (testResult()) {
            <div class="mt-3 submission-success" data-testid="forms-submission-success">
              <div class="success-head">
                <span class="success-check" aria-hidden="true">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                </span>
                <div>
                  <h3 class="success-title">Submission accepted</h3>
                  <p class="success-body">Routed through the form-handling prompt. Trace summary below — open AI Logs for the full timeline.</p>
                </div>
              </div>
              <pre class="bg-black/40 border border-white/5 rounded-lg p-3 text-[0.7rem] overflow-auto max-h-72 mt-2">{{ testResult() | json }}</pre>
            </div>
          }
        </section>
      }

      <!-- Form Handling Prompt — full-screen Prompt Designer overlay.
           Hidden by default; opens via the "Form Handling Prompt" button
           in the header. Inline editor lives ONLY inside this overlay. -->
      <app-fullscreen-overlay
        [open]="designerOpen()"
        (closed)="designerOpen.set(false)"
        ariaLabel="Form Handling Prompt Designer">
        <span overlayTitle>Form Handling Prompt</span>
        <span overlaySubtitle>
          One prompt routes every submission. Edit on the left, run a sample on the right.
        </span>
        <div overlayActions>
          <button class="btn-primary" [disabled]="saving()" data-testid="forms-designer-save" (click)="save()" [brnTooltip]="'Save prompt + MCP selection'">
            {{ saving() ? 'Saving…' : 'Save' }}
          </button>
        </div>

        <div class="designer-grid">
          <!-- LEFT 2/3 — Prompt editor -->
          <section class="designer-pane designer-pane-editor">
            <header class="flex items-start justify-between gap-3 flex-wrap mb-2">
              <div>
                <span class="muted-h">Handling prompt</span>
                <p class="text-[0.66rem] text-text-secondary m-0 mt-0.5">
                  Use <code class="font-mono text-white/70">{{ '{{' }} name {{ '}}' }}</code> placeholders for incoming POST data. Resolved server-side before the LLM call.
                </p>
              </div>
              <div class="flex items-center gap-2 designer-editor-actions">
                <button type="button"
                        class="btn-improve"
                        data-testid="forms-load-example"
                        (click)="loadExamplePrompt()"
                        [disabled]="improving()"
                        [brnTooltip]="'Insert a ready-to-edit example prompt (no AI credits used)'">
                  Load example
                </button>
                <button type="button"
                        class="btn-improve"
                        data-testid="forms-improve-ai"
                        (click)="improvePrompt()"
                        [disabled]="improving()"
                        [title]="improveButtonTitle()">
                  {{ improving() ? '…' : 'Improve with AI' }}
                </button>
              </div>
            </header>

            <textarea #promptTextarea
                      hlmInput
                      [multiline]="true"
                      class="designer-textarea font-mono"
                      aria-label="Form router prompt"
                      [placeholder]="settings.form_router_prompt_default || 'Describe how form submissions should be routed…'"
                      [(ngModel)]="settings.form_router_prompt"></textarea>

            <div class="mt-3">
              <span class="muted-h">Template variables</span>
              <p class="text-[0.66rem] text-text-secondary m-0 mt-1 mb-2">
                Click a chip to insert it at the cursor.
              </p>
              <div class="flex flex-wrap gap-1.5">
                @for (v of templateVars; track v.token) {
                  <button type="button"
                          class="var-chip"
                          [title]="v.description"
                          (click)="insertVar(promptTextarea, v.token)">
                    <code>{{ v.token }}</code>
                  </button>
                }
              </div>
            </div>

            <div class="mt-3">
              <span class="muted-h">MCP integrations available to this prompt</span>
              <p class="text-[0.66rem] text-text-secondary m-0 mt-1 mb-2">Tap a pill to enable it for routing.</p>
              <div class="flex flex-wrap gap-1.5">
                @for (m of mcpConnections(); track m.provider) {
                  <button type="button"
                          class="mcp-pill"
                          [class.is-on]="isMcpEnabled(m.provider)"
                          [style.--brand]="m.color"
                          (click)="togglePromptMcp(m.provider)"
                          [attr.aria-pressed]="isMcpEnabled(m.provider)"
                          [title]="m.desc">
                    <svg class="mcp-logo" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                      <rect x="1" y="1" width="12" height="12" rx="3" fill="currentColor" />
                      <text x="7" y="9.6" text-anchor="middle" font-size="7" font-weight="700"
                            fill="#060610" font-family="system-ui, sans-serif">{{ providerMonogram(m.provider) }}</text>
                    </svg>
                    <span class="mcp-pill-label">{{ m.label }}</span>
                    @if (isMcpEnabled(m.provider)) {
                      <span class="mcp-check" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>
                    }
                  </button>
                }
                @if (mcpConnections().length === 0) {
                  <a routerLink="/admin/settings" fragment="mcp" class="text-[0.7rem] text-primary underline">+ Connect MCPs in Settings → MCP</a>
                }
              </div>
            </div>

            <p class="text-[0.7rem] text-text-secondary mt-3 mb-0">
              Fallback reply email is controlled in
              <a routerLink="/admin/settings" fragment="general" class="text-primary underline">Settings → General</a>.
            </p>
          </section>

          <!-- RIGHT 1/3 — Test panel -->
          <aside class="designer-pane designer-pane-tester">
            <header class="mb-2">
              <span class="muted-h">Test the prompt</span>
              <p class="text-[0.66rem] text-text-secondary m-0 mt-0.5">
                Submits to the same flow as a real form. Costs 1 credit.
              </p>
            </header>

            <div class="scenario-pills" role="group" aria-label="Load example test scenario">
              <span class="muted-h scenario-pills-label">Try a sample</span>
              <div class="scenario-pills-row">
                @for (s of testScenarios; track s.id) {
                  <button type="button"
                          class="scenario-pill"
                          [class.is-active]="activeScenario() === s.id"
                          [attr.aria-pressed]="activeScenario() === s.id"
                          [attr.aria-label]="'Load ' + s.label + ' sample — ' + s.description"
                          [title]="s.description"
                          [attr.data-testid]="'forms-scenario-' + s.id"
                          (click)="applyTestScenario(s.id)">
                    {{ s.label }}
                  </button>
                }
              </div>
            </div>

            <label class="block mb-2">
              <span class="muted-h">form_name</span>
              <input hlmInput class="w-full mt-1" placeholder="newsletter, contact, …"
                     [(ngModel)]="testInput.form_name"
                     (ngModelChange)="onTestInputEdited()"
                     data-testid="forms-test-form-name" />
            </label>
            <label class="block mb-2">
              <span class="muted-h">email</span>
              <input hlmInput class="w-full mt-1" type="email" placeholder="you@example.com"
                     [(ngModel)]="testInput.email"
                     (ngModelChange)="onTestInputEdited()"
                     data-testid="forms-test-email" />
            </label>
            <label class="block mb-2">
              <span class="muted-h">fields (JSON)</span>
              <textarea hlmInput [multiline]="true" class="w-full mt-1 font-mono text-[0.7rem]"
                        rows="6"
                        placeholder='{ "message": "hi", "name": "Brian" }'
                        [(ngModel)]="testInput.fields_json"
                        (ngModelChange)="onTestInputEdited()"
                        data-testid="forms-test-body"></textarea>
            </label>

            <button class="btn-primary w-full" [disabled]="testing() || formNameInvalid()" data-testid="forms-test-run" (click)="runTest()">
              {{ testing() ? 'Running…' : 'Run test' }}
            </button>

            @if (testResult()) {
              <div class="submission-success mt-3" data-testid="forms-submission-success">
                <div class="success-head">
                  <span class="success-check" aria-hidden="true">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                  </span>
                  <div>
                    <h3 class="success-title">Submission accepted</h3>
                    <p class="success-body">Routed through the form-handling prompt. Trace below.</p>
                  </div>
                </div>
              </div>

              <div class="mt-3">
                <span class="muted-h flex items-center justify-between">
                  <span>Trace</span>
                  <button type="button" class="text-[0.6rem] text-text-secondary hover:text-primary px-1.5 py-0.5 rounded" (click)="copyTrace()" [brnTooltip]="'Copy trace JSON to clipboard'">copy</button>
                </span>
                <textarea
                  hlmInput
                  [multiline]="true"
                  readonly
                  class="w-full mt-1 font-mono text-[0.68rem]"
                  rows="10"
                  aria-label="Test result trace"
                  data-testid="forms-test-result"
                  [value]="testResultPretty()"
                ></textarea>
              </div>

              @if (testResultSummary(); as s) {
                <div class="mt-2 trace-summary">
                  @if (s.action) {
                    <div class="trace-row"><span class="muted-h">decision</span><code class="trace-val">{{ s.action }}</code></div>
                  }
                  @if (s.mcp) {
                    <div class="trace-row"><span class="muted-h">mcp</span><code class="trace-val">{{ s.mcp }}</code></div>
                  }
                  @if (s.ms != null) {
                    <div class="trace-row"><span class="muted-h">latency</span><code class="trace-val">{{ s.ms }}ms</code></div>
                  }
                  @if (s.cost != null) {
                    <div class="trace-row"><span class="muted-h">cost</span><code class="trace-val">{{ s.cost.toFixed(4) }} credits</code></div>
                  }
                </div>
              }
            }
          </aside>
        </div>
      </app-fullscreen-overlay>

      <!-- Submissions table -->
      <section class="card p-0 overflow-hidden" appReveal>
        <div class="flex items-center justify-between p-4 flex-wrap gap-2">
          <h2 class="section-h m-0 text-base font-semibold text-white">Submissions</h2>
          <div class="flex items-center gap-2">
            <div class="filter-chips" role="tablist" hlmTablist aria-label="Saved views">
              @for (v of views; track v.id) {
                <button class="filter-chip" [class.active]="activeView() === v.id" (click)="setView(v.id)" role="tab">{{ v.label }} <span class="filter-count">{{ countView(v.id) }}</span></button>
              }
            </div>
            <span class="text-[0.7rem] text-text-secondary">{{ filteredSubmissions().length }} / {{ submissions().length }}</span>
            @if (hasHiddenLeads()) {
              <span class="text-[0.66rem] text-amber-300/90" data-testid="forms-cap-note"
                    title="Showing the {{ submissions().length }} most recent of {{ totalCount() }} stored submissions. Older leads are still stored.">· latest {{ submissions().length }} of {{ totalCount() }}</span>
            }
            <button class="btn-ghost text-xs inline-flex items-center gap-1.5" type="button" data-testid="forms-export-csv"
                    [disabled]="exportRows().length === 0" (click)="exportCsv()"
                    [attr.title]="exportRows().length === 0 ? 'No submissions to export' : (selectedIds().size > 0 ? 'Download the ' + selectedIds().size + ' selected submission' + (selectedIds().size === 1 ? '' : 's') + ' as CSV' : 'Download the filtered submissions as CSV')"
                    [attr.aria-label]="'Export ' + exportRows().length + ' submission' + (exportRows().length === 1 ? '' : 's') + ' as CSV'">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              {{ selectedIds().size > 0 ? 'Export ' + selectedIds().size + ' selected' : 'Export CSV' }}
            </button>
            @if (selectedIds().size > 0) {
              <button class="btn-ghost text-xs" type="button" data-testid="forms-clear-selection" (click)="clearSelection()"
                      [attr.aria-label]="'Clear selection of ' + selectedIds().size + ' submission' + (selectedIds().size === 1 ? '' : 's')">
                Clear
              </button>
            }
          </div>
        </div>
        @if (loading() && submissions().length === 0) {
          <div class="p-4 space-y-2" data-testid="forms-loading" aria-busy="true" aria-label="Loading submissions">
            @for (i of [0,1,2,3]; track i) {
              <div class="skeleton skeleton-row"></div>
            }
          </div>
        } @else if (loadError() && submissions().length === 0) {
          <app-error-card data-testid="forms-load-error" class="block"
            title="Couldn't load submissions"
            [message]="loadError() ?? ''"
            [correlationId]="loadErrorRef()"
            (retry)="reload()" />
        } @else if (submissions().length === 0) {
          <div class="empty-state" role="status" data-testid="forms-empty">
            <svg class="empty-icon" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M4 4h16v12H5.5L4 18z"/><path d="M8 9h8M8 13h5"/>
            </svg>
            <h3 class="empty-title">No submissions yet</h3>
            <p class="empty-body">Your contact form is already live on your site — the moment a visitor sends a message, it lands right here. No backend, no setup.</p>
            <button type="button" class="empty-snippet-btn" data-testid="forms-copy-snippet"
                    (click)="copyInstallSnippet()"
                    [brnTooltip]="'Want this form on another site too? Copy the app.js script tag'">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              Copy install snippet
            </button>
            <!--
              Card-style CTA pulled out of the page header so the call-to-action
              to open the Prompt Designer is front-and-centre while there are no
              submissions. The "Test the prompt" button is intentionally absent
              here — the designer overlay hosts its own tester pane.
            -->
            <button class="empty-cta"
                    type="button"
                    data-testid="forms-open-prompt-designer"
                    (click)="designerOpen.set(true)"
                    [brnTooltip]="'Open the full-screen prompt designer + tester'">
              <span class="empty-cta-icon" aria-hidden="true">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M9 13h6M9 17h4"/></svg>
              </span>
              <span class="empty-cta-text">
                <span class="empty-cta-title">Form Handling Prompt</span>
                <span class="empty-cta-sub">Open the full-screen designer + tester</span>
              </span>
              <svg class="empty-cta-arrow" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
            </button>
          </div>
        } @else if (filteredSubmissions().length === 0) {
          <div class="empty-state" role="status" data-testid="forms-view-empty">
            <svg class="empty-icon" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
            <h3 class="empty-title">No submissions match this view</h3>
            <p class="empty-body">Nothing matches the “{{ activeViewLabel() }}” filter. Try another view or show them all.</p>
            <button class="empty-cta" type="button" data-testid="forms-view-show-all" (click)="activeView.set('all')"
                    [brnTooltip]="'Reset to the All view'">
              <span class="empty-cta-text"><span class="empty-cta-title">Show all submissions</span></span>
              <svg class="empty-cta-arrow" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
            </button>
          </div>
        } @else {
          <div class="overflow-x-auto" tabindex="0" role="region" aria-label="Submissions table — scroll horizontally" data-testid="forms-table-scroll">
          <table class="w-full text-[0.78rem]">
            <thead class="text-text-secondary/70 uppercase text-[0.6rem] tracking-wider">
              <tr class="border-b border-white/[0.06]">
                <th scope="col" class="p-3 w-8">
                  <input type="checkbox" class="accent-[#00E5FF] cursor-pointer align-middle" data-testid="forms-select-all"
                         [checked]="allFilteredSelected()" [indeterminate]="someFilteredSelected()" (change)="toggleSelectAll()"
                         [attr.aria-label]="allFilteredSelected() ? 'Deselect all submissions' : (someFilteredSelected() ? 'Select all (' + selectedRows().length + ' of ' + filteredSubmissions().length + ' selected)' : 'Select all ' + filteredSubmissions().length + ' submissions')" />
                </th>
                <th scope="col" class="text-left p-3 font-semibold">When</th>
                <th scope="col" class="text-left p-3 font-semibold">Form</th>
                <th scope="col" class="text-left p-3 font-semibold">Email</th>
                <th scope="col" class="text-left p-3 font-semibold">Origin</th>
                <th scope="col" class="text-right p-3 font-semibold"></th>
              </tr>
            </thead>
            <tbody>
              @for (s of filteredSubmissions(); track s.id) {
                <tr class="submission-row border-b border-white/[0.04] hover:bg-white/[0.03] cursor-pointer transition-colors"
                    [class.expanded]="selected()?.id === s.id"
                    role="button"
                    tabindex="0"
                    [attr.aria-expanded]="selected()?.id === s.id"
                    [attr.data-testid]="'forms-row-' + s.id"
                    [attr.aria-label]="(selected()?.id === s.id ? 'Collapse' : 'Expand') + ' submission from ' + (s.form_name) + (s.email ? ' by ' + s.email : '')"
                    (click)="open(s)"
                    (keydown.enter)="$event.preventDefault(); open(s)"
                    (keydown.space)="$event.preventDefault(); open(s)">
                  <td class="p-3 w-8" (click)="$event.stopPropagation()">
                    <input type="checkbox" class="accent-[#00E5FF] cursor-pointer align-middle"
                           [attr.data-testid]="'forms-row-select-' + s.id"
                           [checked]="selectedIds().has(s.id)" (change)="toggleSelect(s.id)" (keydown)="$event.stopPropagation()"
                           [attr.aria-label]="'Select submission from ' + s.form_name + (s.email ? ' by ' + s.email : '')" />
                  </td>
                  <td class="p-3 text-text-secondary">{{ s.created_at | date:'short' }}</td>
                  <td class="p-3 font-mono text-[0.72rem]">{{ s.form_name }}</td>
                  <td class="p-3" (click)="$event.stopPropagation()">
                    @if (s.email) {
                      <a class="forms-email-link" [href]="'mailto:' + s.email" [title]="'Email ' + s.email">{{ s.email }}</a>
                    } @else {
                      <span class="text-text-secondary">—</span>
                    }
                  </td>
                  <td class="p-3 text-text-secondary/70 truncate max-w-[240px]" [title]="s.origin_url">{{ s.origin_url || '—' }}</td>
                  <td class="p-3 text-right text-primary text-[0.7rem] font-semibold whitespace-nowrap">
                    <span class="expand-caret" [class.open]="selected()?.id === s.id" aria-hidden="true">›</span>
                    <span class="ml-1">{{ selected()?.id === s.id ? 'Close' : 'Open' }}</span>
                  </td>
                </tr>
                @if (selected()?.id === s.id) {
                  <tr class="detail-row" [attr.data-testid]="'forms-detail-' + s.id">
                    <td [attr.colspan]="6" class="p-0">
                      <div class="detail-panel" appReveal role="region"
                           [attr.aria-label]="'Details for submission from ' + s.form_name">
                        <div class="grid md:grid-cols-2 gap-3">
                          <div>
                            <h3 class="muted-h">Fields</h3>
                            <pre class="bg-black/30 border border-white/5 rounded-lg p-3 text-[0.7rem] overflow-auto max-h-72">{{ s.fields | json }}</pre>
                          </div>
                          <div>
                            <h3 class="muted-h">AI Trace</h3>
                            @if (logs().length === 0) {
                              <p class="text-text-secondary/70 italic text-[0.78rem]">No AI trace yet — the router may still be running or credits exhausted.</p>
                            } @else {
                              @for (l of logs(); track l.id) {
                                <div class="bg-black/30 border border-white/5 rounded-lg p-3 mb-2 text-[0.7rem]">
                                  <div class="flex justify-between text-[0.6rem] mb-1">
                                    <span class="font-mono opacity-70">{{ l.model }}</span>
                                    <span class="font-bold uppercase" [class.text-emerald-400]="l.status === 'ok'" [class.text-red-400]="l.status === 'error'">{{ l.status }} · {{ l.latency_ms }}ms</span>
                                  </div>
                                  @if (l.tool_name) {
                                    <div class="text-primary font-mono mb-1">{{ l.tool_name }} · {{ l.tool_status }}</div>
                                  }
                                  @if (l.error_message) {
                                    <div class="text-red-300">{{ l.error_message }}</div>
                                  } @else {
                                    <pre class="whitespace-pre-wrap break-words">{{ l.output_text }}</pre>
                                  }
                                </div>
                              }
                            }
                          </div>
                        </div>
                      </div>
                    </td>
                  </tr>
                }
              }
            </tbody>
          </table>
          </div>
        }
      </section>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .kicker {
      font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.62rem; font-weight: 700; letter-spacing: 0.14em;
      text-transform: uppercase; color: var(--ps-accent, #00E5FF); opacity: 0.85;
    }
    .card { background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06); border-radius: var(--ps-radius-lg, 14px); padding: 1.4rem; }
    .section-h { font-family: 'Sora', system-ui, sans-serif; font-weight: 600; letter-spacing: -0.02em; }
    /* .input-field removed — all form controls now use Spartan hlmInput. */
    .icon-close {
      display: inline-flex; align-items: center; justify-content: center;
      width: 28px; height: 28px;
      border-radius: var(--ps-radius-sm, 8px);
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      color: rgba(255,255,255,0.6);
      cursor: pointer;
      transition: background var(--ps-dur-fast, 140ms) ease, color var(--ps-dur-fast, 140ms) ease, border-color var(--ps-dur-fast, 140ms) ease;
    }
    .icon-close:hover { background: rgba(255,255,255,0.08); color: #fff; border-color: rgba(255,255,255,0.16); }
    .icon-close:focus-visible { outline: var(--ps-ring-focus, 2px solid #00E5FF); outline-offset: var(--ps-ring-focus-offset, 2px); }
    .btn-primary { padding: 0.5rem 1rem; border-radius: var(--ps-radius-sm, 10px); background: var(--ps-grad-primary); color: var(--ps-bg, #060610); font-weight: 700; border: 0; cursor: pointer; font-size: 0.74rem; box-shadow: 0 6px 18px -8px rgba(0, 212, 255, 0.55); transition: transform 140ms ease, box-shadow 140ms ease; }
    .btn-primary:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 10px 24px -8px rgba(0, 212, 255, 0.7); }
    .btn-primary:disabled { opacity: 0.55; cursor: not-allowed; transform: none; box-shadow: none; }
    .btn-primary:focus-visible { outline: var(--ps-ring-focus, 2px solid #00E5FF); outline-offset: var(--ps-ring-focus-offset, 2px); }
    .btn-gradient { padding: 0.55rem 1.1rem; border-radius: var(--ps-radius-sm, 10px); background: var(--ps-grad-primary); color: var(--ps-bg, #060610); font-weight: 700; border: 0; cursor: pointer; font-size: 0.78rem; box-shadow: 0 8px 22px -10px rgba(0, 212, 255, 0.7); transition: transform 140ms ease, box-shadow 140ms ease; }
    .btn-gradient:hover { transform: translateY(-1px); }
    .btn-gradient:focus-visible { outline: var(--ps-ring-focus, 2px solid #00E5FF); outline-offset: var(--ps-ring-focus-offset, 2px); }
    /* Quiet header CTA — small, ghost-style, no loud gradient. Sits next to
       the submissions count pill without competing for attention. */
    .btn-prompt-quiet {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 4px 10px;
      font-size: 0.7rem;
      font-weight: 500;
      letter-spacing: -0.005em;
      color: rgba(255, 255, 255, 0.78);
      background: rgba(255, 255, 255, 0.035);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 8px;
      cursor: pointer;
      transition: background var(--ps-dur-fast, 140ms) ease, border-color var(--ps-dur-fast, 140ms) ease, color var(--ps-dur-fast, 140ms) ease;
    }
    .btn-prompt-quiet svg { opacity: 0.7; transition: opacity var(--ps-dur-fast, 140ms) ease; }
    .btn-prompt-quiet:hover {
      background: rgba(0, 229, 255, 0.06);
      border-color: rgba(0, 229, 255, 0.22);
      color: #fff;
    }
    .btn-prompt-quiet:hover svg { opacity: 1; color: #00E5FF; }
    .btn-prompt-quiet:focus-visible {
      outline: var(--ps-ring-focus, 2px solid #00E5FF);
      outline-offset: var(--ps-ring-focus-offset, 2px);
    }
    @media (prefers-reduced-motion: reduce) { .btn-prompt-quiet, .btn-prompt-quiet svg { transition: none; } }
    .btn-ghost { padding: 0.4rem 0.9rem; border-radius: var(--ps-radius-sm, 8px); background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1); color: #e5e7eb; font-size: 0.72rem; font-weight: 600; cursor: pointer; }
    .btn-ghost:focus-visible { outline: var(--ps-ring-focus, 2px solid #00E5FF); outline-offset: var(--ps-ring-focus-offset, 2px); }
    /* AI-action pills (Load example · Improve with AI). Gradient chrome with a
       guaranteed near-white label so the text NEVER collapses into the hover
       background — hover only deepens the violet + lifts, color stays bright. */
    .btn-improve {
      display: inline-flex; align-items: center; gap: 5px;
      font-size: 0.66rem; line-height: 1;
      padding: 0.32rem 0.7rem; border-radius: 999px;
      background: linear-gradient(135deg, rgba(124,58,237,0.22), rgba(0,229,255,0.12));
      border: 1px solid rgba(124,58,237,0.5);
      color: #ede9fe; font-weight: 700; letter-spacing: -0.005em;
      cursor: pointer;
      box-shadow: 0 6px 16px -10px rgba(124,58,237,0.65);
      transition: background 140ms ease, color 140ms ease, border-color 140ms ease, transform 140ms ease, box-shadow 140ms ease;
    }
    .btn-improve:hover:not(:disabled) {
      background: linear-gradient(135deg, rgba(124,58,237,0.42), rgba(0,229,255,0.22));
      border-color: rgba(167,139,250,0.85);
      color: #fff;
      transform: translateY(-1px);
      box-shadow: 0 10px 22px -10px rgba(124,58,237,0.8);
    }
    .btn-improve:disabled { opacity: 0.5; cursor: not-allowed; transform: none; box-shadow: none; }
    .btn-improve:focus-visible { outline: 2px solid #c4b5fd; outline-offset: 2px; }
    @media (prefers-reduced-motion: reduce) { .btn-improve { transition: none; } .btn-improve:hover:not(:disabled) { transform: none; } }
    .muted-h { font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.08em; color: rgba(255,255,255,0.5); font-weight: 700; margin: 0 0 0.4rem; }
    .filter-chips { display: inline-flex; flex-wrap: wrap; gap: 4px; }
    .filter-chip { display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; min-height: 24px; border-radius: 999px; background: rgba(255,255,255,0.04); border: 1px solid color-mix(in oklch, currentColor 20%, transparent); color: rgba(255,255,255,0.7); font-size: 0.7rem; font-weight: 600; cursor: pointer; transition: all 150ms ease; }
    .filter-chip:hover { color: #fff; border-color: rgba(0,229,255,0.3); }
    .filter-chip:focus-visible { outline: var(--ps-ring-focus, 2px solid #00E5FF); outline-offset: var(--ps-ring-focus-offset, 2px); }
    .filter-chip.active { background: linear-gradient(135deg, rgba(0,229,255,0.18), rgba(124,58,237,0.18)); color: var(--ps-accent, #00E5FF); border-color: rgba(0,229,255,0.4); }
    .filter-count { font-size: 0.6rem; opacity: 0.7; padding: 1px 5px; border-radius: 999px; background: rgba(255,255,255,0.06); }
    .mcp-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 9px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.1); font-size: 0.62rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
    .mcp-pill { display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; border-radius: 999px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.1); color: rgba(255,255,255,0.55); font-size: 0.66rem; font-weight: 600; cursor: pointer; transition: all 160ms ease; --brand: #94a3b8; }
    .mcp-pill:hover { border-color: rgba(255,255,255,0.25); color: rgba(255,255,255,0.85); }
    .mcp-pill:focus-visible { outline: var(--ps-ring-focus, 2px solid #00E5FF); outline-offset: var(--ps-ring-focus-offset, 2px); }
    .mcp-pill.is-on { background: color-mix(in oklch, var(--brand) 18%, transparent); border-color: color-mix(in oklch, var(--brand) 55%, transparent); color: var(--brand); }
    .mcp-pill .mcp-logo { flex-shrink: 0; }
    .mcp-pill.is-on .mcp-logo { color: var(--brand); }
    .mcp-pill:not(.is-on) .mcp-logo { color: rgba(255,255,255,0.55); }
    .mcp-pill-label { line-height: 1; }
    .var-chip { display: inline-flex; align-items: center; padding: 3px 8px; border-radius: 7px; background: rgba(0, 229, 255, 0.06); border: 1px solid color-mix(in oklch, oklch(0.78 0.18 220) 28%, transparent); color: #9be9ff; font-family: 'JetBrains Mono', ui-monospace, Menlo, monospace; font-size: 0.66rem; cursor: pointer; transition: background 140ms ease, transform 140ms ease, border-color 140ms ease; }
    .var-chip:hover { background: rgba(0, 229, 255, 0.14); border-color: color-mix(in oklch, oklch(0.78 0.18 220) 50%, transparent); transform: translateY(-1px); }
    .var-chip:focus-visible { outline: 2px solid #00E5FF; outline-offset: 2px; }
    .var-chip code { font-family: inherit; }
    @media (prefers-reduced-motion: reduce) { .var-chip { transition: none; } .var-chip:hover { transform: none; } }

    /* ── Prompt Designer overlay (full-screen) ───────────────────── */
    .designer-grid {
      display: grid;
      grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
      gap: 1.5rem;
      padding: 1.25rem clamp(1.25rem, 3vw, 2rem);
      width: 100%;
      height: 100%;
      min-height: 0;
      overflow: hidden;
    }
    @media (max-width: 960px) {
      .designer-grid { grid-template-columns: 1fr; overflow-y: auto; }
    }
    .designer-pane {
      display: flex; flex-direction: column;
      min-height: 0;
      background: var(--ps-surface-1, rgba(13, 13, 40, 0.6));
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: var(--ps-radius-lg, 16px);
      padding: 1rem 1.1rem;
      overflow-y: auto;
      box-shadow: var(--ps-shadow-md, 0 6px 18px -8px rgba(0, 0, 0, 0.42));
    }
    .designer-editor-actions { display: inline-flex; align-items: center; gap: 6px; float: right; }

    /* ── Test-scenario pill row (tester pane) ─────────────────────
       Sits above the form_name input. Each pill loads a sample payload
       (newsletter, contact, quote) into the test inputs so operators can
       iterate without typing JSON by hand. Brand-token only — no hex. */
    .scenario-pills {
      display: flex; flex-direction: column; gap: 4px;
      margin-bottom: 10px;
    }
    .scenario-pills-label { margin: 0; }
    .scenario-pills-row {
      display: flex; flex-wrap: wrap; gap: 5px;
    }
    .scenario-pill {
      display: inline-flex; align-items: center;
      padding: 4px 11px;
      min-height: 26px;
      border-radius: var(--ps-radius-xl, 22px);
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: rgba(255, 255, 255, 0.72);
      font-family: 'Sora', system-ui, sans-serif;
      font-size: 0.66rem;
      font-weight: 600;
      letter-spacing: -0.005em;
      cursor: pointer;
      transition:
        background var(--ps-dur-fast, 140ms) ease,
        border-color var(--ps-dur-fast, 140ms) ease,
        color var(--ps-dur-fast, 140ms) ease,
        transform var(--ps-dur-fast, 140ms) ease;
    }
    .scenario-pill:hover {
      background: color-mix(in oklch, var(--ps-accent, #00E5FF) 10%, transparent);
      border-color: color-mix(in oklch, var(--ps-accent, #00E5FF) 35%, transparent);
      color: #fff;
      transform: translateY(-1px);
    }
    .scenario-pill:focus-visible {
      outline: var(--ps-ring-focus, 2px solid #00E5FF);
      outline-offset: var(--ps-ring-focus-offset, 2px);
    }
    .scenario-pill.is-active {
      background: color-mix(in oklch, var(--ps-accent, #00E5FF) 18%, transparent);
      border-color: color-mix(in oklch, var(--ps-accent, #00E5FF) 55%, transparent);
      color: var(--ps-accent, #00E5FF);
    }
    @media (prefers-reduced-motion: reduce) {
      .scenario-pill { transition: none; }
      .scenario-pill:hover { transform: none; }
    }

    /* Trace summary chip strip — at-a-glance LLM decision/mcp/latency/cost
       above the raw-JSON textarea inside the test panel. */
    .trace-summary {
      display: flex; flex-wrap: wrap; gap: 6px 14px;
      padding: 8px 10px;
      background: color-mix(in oklch, var(--ps-accent, #00E5FF) 5%, transparent);
      border: 1px solid color-mix(in oklch, var(--ps-accent, #00E5FF) 16%, transparent);
      border-radius: 8px;
    }
    .trace-row {
      display: inline-flex; align-items: baseline; gap: 4px;
      font-size: 0.66rem;
    }
    .trace-val {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      color: var(--ps-accent, #00E5FF);
      font-size: 0.7rem;
    }
    /* layout-only modifier on top of Spartan hlmInput [multiline] (box-chrome +
       focus now owned by the directive). */
    .designer-textarea {
      flex: 1;
      min-height: 240px;
      max-height: 60vh;
      font-size: 0.78rem;
      line-height: 1.55;
      font-feature-settings: "calt", "liga";
      resize: vertical;
    }
    /* Enabled-MCP check is a monochrome SVG (cockpit semantic-glyph standard,
       cross-OS consistent), inheriting the pill's --brand via currentColor. */
    .mcp-check { line-height: 1; color: var(--brand); display: inline-flex; }
    .mcp-check svg { width: 0.8rem; height: 0.8rem; display: block; }
    .skeleton { background: rgba(255,255,255,0.10); border-radius: 8px; animation: skel-pulse 1.4s ease-in-out infinite; }
    .skeleton-row { height: 44px; }
    @keyframes skel-pulse { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
    /* Keyboard-openable submission rows — role=button + tabindex on the <tr>.
       Cyan focus ring (inset so it reads inside the table chrome) satisfies
       WCAG 2.4.11 focus appearance + 2.4.7 visible focus for keyboard users. */
    .submission-row:focus-visible {
      outline: none;
      box-shadow: inset 0 0 0 2px var(--ps-accent, #00E5FF);
      background: color-mix(in oklch, var(--ps-accent, #00E5FF) 7%, transparent);
    }
    /* Expanded master row: cyan-tinted, no bottom border so it fuses with the
       detail row beneath it into one visual accordion unit. */
    .submission-row.expanded {
      background: color-mix(in oklch, var(--ps-accent, #00E5FF) 9%, transparent);
      border-bottom-color: transparent;
    }
    /* Rotating caret cues expand/collapse (matches the "Open"/"Close" label). */
    .expand-caret {
      display: inline-block;
      transition: transform 0.18s ease;
      transform: rotate(0deg);
    }
    .expand-caret.open { transform: rotate(90deg); }
    @media (prefers-reduced-motion: reduce) { .expand-caret { transition: none; } }
    /* Full-width inline detail row rendered directly under its master row. */
    .detail-row > td {
      border-bottom: 1px solid rgba(255,255,255,0.06);
      background: color-mix(in oklch, var(--ps-accent, #00E5FF) 4%, rgba(0,0,0,0.25));
    }
    .detail-panel {
      padding: 1rem 1.1rem 1.2rem;
      border-left: 2px solid var(--ps-accent, #00E5FF);
    }
    .empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 2.8rem 1.4rem; gap: 0.6rem; }
    .empty-icon { color: color-mix(in oklch, var(--ps-accent, #00E5FF) 65%, transparent); }
    /* Submitter email = reply target: cyan mailto link (cell stops row-open propagation). */
    .forms-email-link { color: var(--ps-accent, #00E5FF); text-decoration: none; }
    .forms-email-link:hover { text-decoration: underline; }
    .forms-email-link:focus-visible { outline: 2px solid var(--ps-accent, #00E5FF); outline-offset: 2px; border-radius: 3px; }
    .empty-title { font-family: 'Sora', system-ui, sans-serif; font-weight: 600; letter-spacing: -0.02em; font-size: 1rem; color: #fff; margin: 0.2rem 0 0; }
    .empty-body { font-size: 0.78rem; color: rgba(255,255,255,0.65); margin: 0 0 0.9rem; max-width: 420px; line-height: 1.5; }

    /* Header CTA pair (button + filter-pill) appears only when submissions exist. */
    .header-actions { align-items: center; }
    .header-pill {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 6px 12px; min-height: 30px;
      border-radius: 999px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.12);
      color: rgba(255,255,255,0.78);
      font-family: 'Sora', system-ui, sans-serif;
      font-size: 0.7rem; font-weight: 600; letter-spacing: -0.005em;
    }
    .header-pill-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: #34d399; box-shadow: 0 0 6px rgba(52, 211, 153, 0.7);
    }
    .header-cta { min-height: 44px; padding-inline: 1.1rem; font-family: 'Sora', system-ui, sans-serif; font-weight: 600; letter-spacing: -0.01em; }

    /* Card-style CTA inside the submissions empty state. */
    .empty-cta {
      display: inline-flex; align-items: center; gap: 14px;
      min-height: 44px; padding: 12px 18px;
      background: linear-gradient(135deg, rgba(0, 229, 255, 0.16), rgba(0, 212, 255, 0.16));
      border: 1px solid rgba(0, 229, 255, 0.42);
      border-radius: var(--ps-radius-lg, 16px);
      color: #e6fcff;
      font-family: 'Sora', system-ui, sans-serif;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 12px 30px -16px rgba(0, 212, 255, 0.55), inset 0 1px 0 rgba(255,255,255,0.06);
      transition: transform var(--ps-dur-fast, 140ms) ease, box-shadow var(--ps-dur-fast, 140ms) ease, border-color var(--ps-dur-fast, 140ms) ease;
      text-align: left;
    }
    .empty-cta:hover {
      transform: translateY(-1px);
      border-color: rgba(0, 229, 255, 0.65);
      box-shadow: 0 18px 38px -16px rgba(0, 212, 255, 0.75), inset 0 1px 0 rgba(255,255,255,0.08);
    }
    .empty-cta:focus-visible { outline: var(--ps-ring-focus, 2px solid #00E5FF); outline-offset: 2px; }
    .empty-cta-icon {
      display: inline-flex; align-items: center; justify-content: center;
      width: 36px; height: 36px; flex-shrink: 0;
      border-radius: 10px;
      background: var(--ps-grad-primary);
      color: #060610;
    }
    .empty-cta-text { display: flex; flex-direction: column; gap: 2px; }
    .empty-cta-title { font-size: 0.86rem; color: #fff; letter-spacing: -0.01em; }
    .empty-cta-sub { font-size: 0.7rem; color: rgba(230, 252, 255, 0.7); font-weight: 500; }
    .empty-cta-arrow { color: rgba(0, 229, 255, 0.75); transition: transform var(--ps-dur-fast, 140ms) ease; }
    .empty-cta:hover .empty-cta-arrow { transform: translateX(2px); color: #9be9ff; }
    @media (prefers-reduced-motion: reduce) {
      .empty-cta, .empty-cta-arrow { transition: none; }
      .empty-cta:hover { transform: none; }
      .empty-cta:hover .empty-cta-arrow { transform: none; }
    }
    /* Secondary CTA in the empty state — copies the app.js install <script> inline
       (no ⌘K needed → works on mobile). Accent only on border+icon; text stays
       near-white so it clears AA in both dark + light admin themes. */
    .empty-snippet-btn {
      display: inline-flex; align-items: center; gap: 8px;
      min-height: 40px; padding: 8px 16px; margin-bottom: 2px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(0, 229, 255, 0.28);
      border-radius: 999px;
      color: #e6fcff;
      font-family: 'Sora', system-ui, sans-serif;
      font-size: 0.78rem; font-weight: 600; letter-spacing: -0.005em;
      cursor: pointer;
      transition: border-color var(--ps-dur-fast, 140ms) ease, background var(--ps-dur-fast, 140ms) ease;
    }
    .empty-snippet-btn:hover { border-color: rgba(0,229,255,0.55); background: rgba(0,229,255,0.08); }
    .empty-snippet-btn:focus-visible { outline: var(--ps-ring-focus, 2px solid #00E5FF); outline-offset: 2px; }
    .empty-snippet-btn svg { color: rgba(0,229,255,0.85); flex-shrink: 0; }
    @media (prefers-reduced-motion: reduce) { .empty-snippet-btn { transition: none; } }
    .submission-success { border: 1px solid rgba(16,185,129,0.32); background: rgba(16,185,129,0.06); border-radius: 12px; padding: 0.9rem; animation: success-in 260ms cubic-bezier(0.16, 1, 0.3, 1); }
    .success-head { display: flex; gap: 0.7rem; align-items: flex-start; }
    .success-check { width: 32px; height: 32px; flex-shrink: 0; border-radius: 999px; background: rgba(16,185,129,0.18); display: inline-flex; align-items: center; justify-content: center; color: #34d399; }
    .success-title { font-family: 'Sora', system-ui, sans-serif; font-weight: 600; letter-spacing: -0.02em; font-size: 0.88rem; color: #6ee7b7; margin: 0; }
    .success-body { font-size: 0.74rem; color: rgba(255,255,255,0.7); margin: 0.2rem 0 0; line-height: 1.5; }
    @keyframes success-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
    @media (prefers-reduced-motion: reduce) {
      .skeleton, .submission-success, .btn-primary, .btn-gradient { animation: none; transition: none; }
    }
  `],
})
export class AdminFormsComponent implements OnInit, OnDestroy {
  state = inject(AdminStateService);
  private api = inject(ApiService);
  private toast = inject(ToastService);

  submissions = signal<Submission[]>([]);
  /** Raw `meta.total` from the last load (a worker `COUNT(*)`); 0 when unknown. */
  private readonly metaTotal = signal(0);
  /** TRUE lead count: the worker's `meta.total` when known, else the loaded page
   *  length. The count pill reads THIS, never bare `submissions().length` — a
   *  hardcoded LIMIT with no total silently under-reports leads (= revenue) once a
   *  site gets popular. The `max` also keeps the pill honest if any path sets
   *  `submissions` without a meta total (never < what's actually on screen). */
  readonly totalCount = computed(() => Math.max(this.metaTotal(), this.submissions().length));
  /** True when the store holds more leads than the loaded page shows — drives the
   *  honest "showing latest N of M" note instead of pretending the page is everything.
   *  (The worker caps the page at the 200 most-recent rows; `hasHiddenLeads` fires
   *  off the real `meta.total`, so the note shows exact counts, not a hardcoded 200.) */
  readonly hasHiddenLeads = computed(() => this.totalCount() > this.submissions().length);
  loading = signal(false);
  /** Persistent submissions-load failure — so a fetch error shows a Retry card, not a fake "No submissions yet" empty state. */
  loadError = signal<string | null>(null);
  /** Worker request_id from a failed load → the copyable support reference on the error card. */
  readonly loadErrorRef = signal('');
  views = [
    { id: 'all', label: 'All', test: (_s: Submission) => true },
    { id: 'today', label: 'Today', test: (s: Submission) => sameDay(new Date(s.created_at), new Date()) },
    { id: 'newsletter', label: 'Newsletter', test: (s: Submission) => /newsletter|subscribe/i.test(s.form_name) },
    { id: 'contact', label: 'Contact', test: (s: Submission) => /contact|message|hello/i.test(s.form_name) },
    { id: 'with-email', label: 'With email', test: (s: Submission) => !!s.email },
    { id: 'errors', label: 'Errors', test: (s: Submission) => s.status !== 'received' },
  ] as const;
  /**
   * Submissions list filter — always defaults to "All" on mount so operators
   * never land on a pre-filtered slice that hides relevant rows. Selections
   * still persist for the lifetime of the session (via setView's localStorage
   * write), but a fresh page load resets the chip to All.
   */
  activeView = signal<(typeof this.views)[number]['id']>('all');
  filteredSubmissions = computed(() => {
    const v = this.views.find((x) => x.id === this.activeView()) ?? this.views[0]!;
    return this.submissions().filter((s) => v.test(s));
  });
  /** Human label of the active view — for the "no submissions match this view" notice. */
  readonly activeViewLabel = computed(() => this.views.find((v) => v.id === this.activeView())?.label ?? 'this view');

  // ── Bulk selection (→ export selected) ───────────────────────────────────
  readonly selectedIds = signal<ReadonlySet<string>>(new Set());
  /** Selected rows ∩ currently-filtered (stale ids from a prior view never leak in). */
  readonly selectedRows = computed(() => this.filteredSubmissions().filter((s) => this.selectedIds().has(s.id)));
  /** Rows the Export button acts on: the selection if any, else all filtered. */
  readonly exportRows = computed(() => (this.selectedIds().size > 0 ? this.selectedRows() : this.filteredSubmissions()));
  /** True when every filtered row is selected (drives the header checkbox). */
  readonly allFilteredSelected = computed(() => {
    const f = this.filteredSubmissions();
    return f.length > 0 && f.every((s) => this.selectedIds().has(s.id));
  });
  /** Some-but-not-all filtered rows selected → the select-all box renders indeterminate (—). */
  readonly someFilteredSelected = computed(() => this.selectedRows().length > 0 && !this.allFilteredSelected());

  toggleSelect(id: string): void {
    this.selectedIds.update((set) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  /** Deselect all in one click — reliable clear from any state (incl. partial). */
  clearSelection(): void {
    this.selectedIds.set(new Set());
  }
  toggleSelectAll(): void {
    const f = this.filteredSubmissions();
    this.selectedIds.set(this.allFilteredSelected() ? new Set<string>() : new Set(f.map((s) => s.id)));
  }

  /**
   * Download the currently-filtered submissions as a CSV (leads → spreadsheet/CRM).
   * Columns: Date/Form/Email/Status + the union of dynamic field keys. Client-side
   * (no worker round-trip). No-ops on an empty list (the button is also disabled).
   */
  exportCsv(): void {
    const rows = this.exportRows();
    if (rows.length === 0) return;
    downloadText(
      `submissions-${new Date().toISOString().slice(0, 10)}.csv`,
      this.buildSubmissionsCsv(rows),
      'text/csv;charset=utf-8;',
    );
  }

  /**
   * Build a CSV from submission rows via the SHARED `toCsv`/`csvEscape` (one tested,
   * formula-injection-safe code path — replaces the former bespoke `csvCell`).
   * Columns: Date/Form/Email/Status + the union of dynamic field keys; the base
   * columns are spread last so a field named "Email" etc. can't shadow them.
   */
  buildSubmissionsCsv(rows: Submission[]): string {
    const fieldKeys = Array.from(new Set(rows.flatMap((r) => Object.keys(r.fields ?? {})))).sort();
    const header = ['Date', 'Form', 'Email', 'Status', ...fieldKeys];
    const flat = rows.map((r) => ({
      ...(r.fields ?? {}),
      Date: r.created_at,
      Form: r.form_name,
      Email: r.email ?? '',
      Status: r.status,
    }));
    return toCsv(flat, header);
  }

  testing = signal(false);
  testOpen = signal(false);
  improving = signal(false);
  /**
   * Active test-prompt scenario pill. `null` when the operator has typed
   * something custom into the inputs (so we don't lie about which scenario
   * is loaded). Set by {@link applyTestScenario}.
   */
  activeScenario = signal<string | null>(null);
  designerOpen = signal(false);

  // Per-prompt MCP allow-list — drives the pill row + is sent to the backend
  // so the router only offers checked MCPs as routing targets.
  promptMcps = signal<string[]>(((): string[] => {
    try {
      return JSON.parse(localStorage.getItem('ps_form_prompt_mcps') ?? '[]') as string[];
    } catch {
      return [];
    }
  })());

  mcpConnections = signal<McpPill[]>([]);
  testInput: { form_name: string; email: string; fields_json: string } = {
    form_name: 'newsletter',
    email: 'test@example.com',
    fields_json: '{ "message": "Hi — please add me to your list." }',
  };
  testResult = signal<unknown | null>(null);
  selected = signal<Submission | null>(null);
  logs = signal<AiLog[]>([]);
  saving = signal(false);
  settings: Settings = { form_router_prompt: '', form_router_prompt_default: '', reply_email: '' };

  // ── Auto-polling state ────────────────────────────────────
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private visibilityHandler: (() => void) | null = null;
  private polling = signal(true);

  improveButtonLabel = computed(() =>
    (this.settings.form_router_prompt ?? '').trim().length === 0
      ? 'Load an example routing prompt'
      : 'Improve prompt',
  );

  improveButtonTitle = computed(() =>
    (this.settings.form_router_prompt ?? '').trim().length === 0
      ? 'Insert a ready-to-edit example prompt (no AI credits used)'
      : 'Tighten + clarify the current prompt via AI',
  );

  /**
   * Rich, MCP-aware example template inserted by the "Load example" button.
   * Uses Mustache-style `{{ … }}` placeholders that the worker
   * (`services/template.ts → resolveTemplate`) substitutes before the LLM
   * call. Demonstrates every major variable family (business, form,
   * submission, mcps, brand) plus MCP routing, structured JSON output,
   * spam scoring, and human-in-the-loop escalation via task_inbox.
   */
  private readonly RICH_EXAMPLE_PROMPT: string = [
    'You are processing a form submission for {{business.business_name}} (a {{business.business_type}} in {{business.city}}, {{business.state}}).',
    '',
    'FORM CONTEXT:',
    '- Form name: {{form.form_name}}',
    '- Form slug: {{form.slug}}',
    '- Submitted at: {{submission.created_at}}',
    '- Submitter IP: {{submission.ip_hash}}',
    '- Submission ID: {{submission.id}}',
    '',
    'SUBMITTER DATA:',
    '{{#each submission.fields}}',
    '- {{this.label}}: {{this.value}}',
    '{{/each}}',
    '',
    'ATTACHED MCPs (use intelligently when relevant):',
    '{{#each mcps}}',
    '- {{this.provider}} ({{this.scope}}): {{this.description}}',
    '{{/each}}',
    '',
    'INSTRUCTIONS:',
    '1. Classify the intent of this submission (contact / quote-request / complaint / newsletter-signup / booking / spam / other).',
    '2. If spam (score >0.7), tag and skip downstream actions.',
    '3. If contact/quote, draft a reply email matching the brand voice ({{brand.tone}}, {{brand.signature}}).',
    '4. If newsletter-signup, add the email to the configured list via the {{mcps.email}} MCP.',
    '5. If booking, attempt to schedule via the {{mcps.calendar}} MCP at the requested time.',
    '6. Always log a structured summary (intent, confidence, action_taken, next_action) to the audit log.',
    '7. If you need information you don\'t have, ask via task_inbox (postAskUser) — do NOT guess.',
    '',
    'RESPOND with strict JSON:',
    '{',
    '  "intent": "contact|quote|complaint|newsletter|booking|spam|other",',
    '  "confidence": 0.0-1.0,',
    '  "spam_score": 0.0-1.0,',
    '  "reply_draft": "..." | null,',
    '  "actions": [{"tool": "<mcp_name>", "args": {...}, "reason": "..."}],',
    '  "audit_summary": "...",',
    '  "needs_human_input": null | { "prompt": "...", "options": ["..."] }',
    '}',
  ].join('\n');

  /**
   * Sample payload shape used by every test-prompt scenario pill. Mirrors
   * the structure the worker hands the LLM at runtime so the operator can
   * see exactly what the router will receive.
   */
  readonly testScenarios: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly description: string;
    readonly form_name: string;
    readonly email: string;
    readonly payload: Record<string, unknown>;
  }> = [
    {
      id: 'newsletter',
      label: 'Newsletter sign-up',
      description: 'Adds a subscriber via the email MCP',
      form_name: 'newsletter',
      email: 'jane@example.com',
      payload: {
        form: { form_name: 'Newsletter', slug: 'newsletter' },
        submission: {
          id: 'sub_demo_001',
          created_at: '2026-05-25T18:00:00Z',
          ip_hash: 'ab12c3',
          fields: [
            { label: 'Email', value: 'jane@example.com' },
            { label: 'First name', value: 'Jane' },
            { label: 'Topics', value: 'AI updates, product news' },
          ],
        },
        mcps: [
          { provider: 'mailchimp', scope: 'org', description: 'Adds to Audience' },
        ],
      },
    },
    {
      id: 'contact',
      label: 'Contact form',
      description: 'Inbound venue-booking inquiry',
      form_name: 'contact',
      email: 'marcus@bakery.example',
      payload: {
        form: { form_name: 'Contact', slug: 'contact' },
        submission: {
          id: 'sub_demo_002',
          created_at: '2026-05-25T18:05:00Z',
          ip_hash: 'cd34e5',
          fields: [
            { label: 'Name', value: 'Marcus Chen' },
            { label: 'Email', value: 'marcus@bakery.example' },
            { label: 'Phone', value: '+1-555-014-2287' },
            {
              label: 'Message',
              value:
                "Hi! I'd like to book your venue for a 50-person birthday party on June 14. Is the back patio available?",
            },
          ],
        },
        mcps: [
          {
            provider: 'google-calendar',
            scope: 'org',
            description: 'Check availability + create event',
          },
          { provider: 'resend', scope: 'org', description: 'Send confirmation email' },
        ],
      },
    },
    {
      id: 'quote',
      label: 'Quote request',
      description: 'Roof-replacement quote with site visit',
      form_name: 'quote',
      email: '',
      payload: {
        form: { form_name: 'Free Quote', slug: 'quote' },
        submission: {
          id: 'sub_demo_003',
          created_at: '2026-05-25T18:10:00Z',
          ip_hash: 'ef56g7',
          fields: [
            { label: 'Service', value: 'Roof replacement' },
            { label: 'Property address', value: '742 Evergreen Terrace, Springfield IL' },
            { label: 'Roof age (years)', value: '22' },
            { label: 'Square footage', value: '2100' },
            { label: 'Preferred contact', value: 'Phone — evenings' },
            { label: 'Phone', value: '+1-555-019-3344' },
          ],
        },
        mcps: [
          { provider: 'stripe', scope: 'org', description: 'Create draft invoice' },
          {
            provider: 'google-calendar',
            scope: 'org',
            description: 'Schedule site visit',
          },
        ],
      },
    },
  ];

  /**
   * Template variables available inside `{{ … }}` inside the router prompt.
   * Resolved server-side by `services/template.ts → resolveTemplate` before
   * the LLM call. Keep in sync with worker `TEMPLATE_VARIABLES`.
   */
  readonly templateVars: ReadonlyArray<{ readonly token: string; readonly description: string }> = [
    { token: '{{business}}', description: 'The site’s business name.' },
    { token: '{{form.form_name}}', description: 'The form’s name (e.g. "contact", "newsletter").' },
    { token: '{{form.email}}', description: 'Submitter’s email address.' },
    { token: '{{form.fields}}', description: 'All submitted fields as JSON.' },
    { token: '{{form.fields.name}}', description: 'Any specific field by key — replace "name".' },
    { token: '{{query.utm_source}}', description: 'A URL query parameter (replace with any param name).' },
    { token: '{{meta.ip}}', description: 'Submitter’s IP address.' },
    { token: '{{meta.user_agent}}', description: 'Browser user agent.' },
    { token: '{{meta.origin_url}}', description: 'Page URL the form was submitted from.' },
    { token: '{{meta.referer}}', description: 'Referer header on the POST.' },
    { token: '{{meta.timestamp}}', description: 'ISO-8601 timestamp.' },
    { token: '{{meta.submission_id}}', description: 'UUID for the submission.' },
  ];

  /** Insert a template token at the textarea's cursor (or append if collapsed). */
  insertVar(textarea: HTMLTextAreaElement, token: string): void {
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    const next = before + token + after;
    this.settings.form_router_prompt = next;
    queueMicrotask(() => {
      textarea.focus();
      const caret = start + token.length;
      textarea.setSelectionRange(caret, caret);
    });
  }

  private loadedSiteId: string | null = null;

  constructor() {
    // Site-reactive load: submissions self-heal via polling, but settings + MCP
    // were ngOnInit-once (empty forever on deep-link, stale on site switch). Load
    // all three when the site resolves/changes; guarded so we never re-load the same site.
    effect(() => {
      const id = this.state.selectedSite()?.id ?? null;
      if (id && id !== this.loadedSiteId) {
        this.loadedSiteId = id;
        this.reload();
        this.loadSettings();
        this.loadMcp();
      }
    });
  }

  ngOnInit(): void {
    this.startPolling();
    this.visibilityHandler = (): void => this.handleVisibility();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.visibilityHandler);
    }
  }

  ngOnDestroy(): void {
    this.stopPolling();
    if (this.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
  }

  private startPolling(): void {
    if (this.pollTimer !== null) return;
    this.polling.set(true);
    this.pollTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      this.reload({ silent: true });
    }, POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.polling.set(false);
  }

  private handleVisibility(): void {
    if (typeof document === 'undefined') return;
    if (document.visibilityState === 'visible') {
      this.startPolling();
      this.reload({ silent: true });
    } else {
      this.stopPolling();
    }
  }

  setView(id: (typeof this.views)[number]['id']): void {
    this.activeView.set(id);
    this.selectedIds.set(new Set()); // selection is per-view — reset on switch
    try {
      localStorage.setItem('ps_forms_view', id);
    } catch {
      /* persistence is best-effort */
    }
  }

  countView(id: (typeof this.views)[number]['id']): number {
    const v = this.views.find((x) => x.id === id) ?? this.views[0]!;
    return this.submissions().filter((s) => v.test(s)).length;
  }

  toggleTest(): void {
    this.testOpen.update((v) => !v);
  }

  /** True when an MCP provider is currently enabled for the router. */
  isMcpEnabled(provider: string): boolean {
    return this.promptMcps().includes(provider);
  }

  /**
   * Toggle an MCP on/off + persist locally + push to the backend config.
   * @param provider - the MCP provider id (e.g. "stripe", "resend").
   */
  togglePromptMcp(provider: string): void {
    const cur = this.promptMcps();
    const next = cur.includes(provider) ? cur.filter((p) => p !== provider) : [...cur, provider];
    this.promptMcps.set(next);
    try {
      localStorage.setItem('ps_form_prompt_mcps', JSON.stringify(next));
    } catch {
      /* persistence is best-effort */
    }
    // Push to backend immediately so the live router picks up the change.
    const site = this.state.selectedSite();
    if (!site) return;
    this.api
      .put(`/sites/${site.id}/ai-settings`, { enabled_mcps: next })
      .subscribe({
        next: () => {
          /* silent — UI already reflects the change */
        },
        error: () => this.toast.error('Could not save MCP selection — retry from the pill row'),
      });
  }

  /** Single-letter monogram used inside the inline SVG logo (no external image refs). */
  providerMonogram(provider: string): string {
    const meta = mcpMeta(provider);
    return (meta?.label ?? provider).charAt(0).toUpperCase();
  }

  loadMcp(): void {
    const s = this.state.selectedSite();
    if (!s) return;
    this.api
      .get<{ data: { connections: { provider: string; status: string }[] } }>(
        `/sites/${s.id}/mcp/connections`,
      )
      .subscribe({
        next: (r) => {
          const list = (r.data?.connections ?? [])
            .filter((c) => c.status === 'active')
            .map<McpPill>((c) => {
              const meta = mcpMeta(c.provider);
              return {
                provider: c.provider,
                label: meta?.label ?? c.provider,
                color: meta?.color ?? '#94a3b8',
                desc:
                  meta?.desc ?? `${meta?.label ?? c.provider} — integration available.`,
              };
            });
          this.mcpConnections.set(list);
        },
        error: () => this.mcpConnections.set([]),
      });
  }

  /**
   * Insert the rich, MCP-aware example prompt template into the editor.
   * Instant + deterministic — no AI credits consumed, no network call.
   */
  loadExamplePrompt(): void {
    if (!this.state.selectedSite()) {
      this.toast.error('Select a site first');
      return;
    }
    this.settings.form_router_prompt = this.RICH_EXAMPLE_PROMPT;
    this.toast.success('Loaded example prompt — edit + save');
  }

  improvePrompt(): void {
    const site = this.state.selectedSite();
    if (!site) {
      this.toast.error('Select a site first');
      return;
    }
    const value = (this.settings.form_router_prompt ?? '').trim();
    this.improving.set(true);
    this.api
      .post<{ data: { mode: 'seed' | 'improved'; text: string } }>(
        `/sites/${site.id}/form-router/improve`,
        { value },
      )
      .subscribe({
        next: (r) => {
          this.improving.set(false);
          const text = r.data?.text?.trim();
          if (!text || text.length < 40) {
            this.toast.error('No usable prompt returned — try Improve with AI again');
            return;
          }
          this.settings.form_router_prompt = text;
          if (r.data?.mode === 'seed') {
            this.toast.success('Loaded example prompt — edit + save');
          } else {
            this.toast.success('Improved with AI — review + save');
          }
        },
        error: () => {
          this.improving.set(false);
          this.toast.error('AI improve failed — check credits + retry');
        },
      });
  }

  /**
   * Reload the submissions list.
   * @param opts.silent - when true, suppress the loading spinner + error toast
   *   (used by the auto-poll timer so the UI doesn't flicker every 10s).
   */
  reload(opts: { silent?: boolean } = {}): void {
    const site = this.state.selectedSite();
    if (!site) return;
    if (!opts.silent) this.loading.set(true);
    if (!opts.silent) { this.loadError.set(null); this.loadErrorRef.set(''); }
    this.api
      .get<{ data: Submission[]; meta?: { total?: number; has_more?: boolean } }>(
        `/sites/${site.id}/form-submissions`,
        undefined,
        { silent: true },
      )
      .subscribe({
      next: (r) => {
        const rows = r.data ?? [];
        this.submissions.set(rows);
        // The count pill reflects the TRUE total (meta.total), not the loaded page —
        // else a site with >200 leads reads "200" and hides real leads. `metaTotal`=0
        // (older worker w/o meta) makes totalCount fall back to the loaded length.
        this.metaTotal.set(r.meta?.total ?? 0);
        this.loadError.set(null);
        this.loading.set(false);
      },
      error: (err: unknown) => {
        this.loading.set(false);
        // Persist the failure so the empty state can't masquerade as "no submissions".
        // (Silent background polls keep any already-loaded list visible.)
        // Read is {silent} so the generic ApiService toast never fires (even on a
        // background poll); the inline error card is the user-facing feedback on a
        // non-silent (user-initiated) load — no transient toast on top of it. The
        // shared <app-error-card> owns the Retry, so the message drops "— retry".
        if (!opts.silent) {
          this.loadError.set('Could not load submissions.');
          this.loadErrorRef.set(this.requestIdFrom(err));
        }
      },
    });
  }

  /** Pull the worker request_id from a failed response ({ error: { request_id } }) for the support reference. */
  private requestIdFrom(e: unknown): string {
    return ((e as { error?: { error?: { request_id?: string } } } | undefined)?.error?.error?.request_id) ?? '';
  }

  /**
   * Toggle the inline master-detail row for a submission. Clicking (or
   * Enter/Space on) the same row again collapses it; clicking a different row
   * moves the expansion to that row. When expanding, the AI router trace is
   * (re)fetched so the accordion body is always fresh.
   */
  open(s: Submission): void {
    if (this.selected()?.id === s.id) {
      this.selected.set(null);
      this.logs.set([]);
      return;
    }
    this.selected.set(s);
    this.logs.set([]);
    const site = this.state.selectedSite();
    if (!site) return;
    this.api
      .get<{ data: { ai_logs: AiLog[] } }>(`/sites/${site.id}/form-submissions/${s.id}`)
      .subscribe({
        next: (r) => this.logs.set(r.data?.ai_logs ?? []),
        error: () => this.logs.set([]),
      });
  }

  loadSettings(): void {
    const site = this.state.selectedSite();
    if (!site) return;
    this.api.get<{ data: Settings }>(`/sites/${site.id}/ai-settings`).subscribe({
      next: (r) => {
        this.settings = {
          form_router_prompt: r.data?.form_router_prompt ?? '',
          form_router_prompt_default: r.data?.form_router_prompt_default ?? '',
          reply_email: r.data?.reply_email ?? '',
        };
        // Seed the MCP-selection pills from the SERVER value (authoritative + cross-
        // device), not just the localStorage cache — the write-only-field lesson: the
        // server is the source of truth once the PUT persists enabled_mcps. Mirror it
        // back into the cache so the next cold paint is instant.
        if (Array.isArray(r.data?.enabled_mcps)) {
          this.promptMcps.set(r.data.enabled_mcps);
          try {
            localStorage.setItem('ps_form_prompt_mcps', JSON.stringify(r.data.enabled_mcps));
          } catch {
            /* best-effort cache */
          }
        }
      },
      error: () => {
        /* api.service already surfaced the toast — keep current settings */
      },
    });
  }

  save(): void {
    const site = this.state.selectedSite();
    if (!site) return;
    this.saving.set(true);
    this.api
      .put(`/sites/${site.id}/ai-settings`, {
        form_router_prompt: this.settings.form_router_prompt,
        enabled_mcps: this.promptMcps(),
      })
      .subscribe({
        next: () => {
          this.toast.success('Saved — router will use the new prompt on the next submission');
          this.saving.set(false);
          this.loadSettings();
        },
        error: () => {
          this.toast.error('Could not save prompt — check your connection + retry');
          this.saving.set(false);
        },
      });
  }

  testRouter(): void {
    this.testOpen.set(true);
  }

  /** JSON.stringify of the result with 2-space indent — bound to the readonly textarea. */
  testResultPretty(): string {
    const r = this.testResult();
    if (!r) return '';
    try {
      return JSON.stringify(r, null, 2);
    } catch {
      return String(r);
    }
  }

  /**
   * Extract the at-a-glance trace metadata so the designer panel can
   * surface a small "decision · mcp · latency · cost" strip above the
   * raw JSON. Pulls from the common ai_form_logs row shape; tolerates
   * either flat or nested response envelopes.
   */
  testResultSummary(): { action?: string; mcp?: string; ms?: number; cost?: number } | null {
    const r = this.testResult() as Record<string, unknown> | null;
    if (!r || typeof r !== 'object') return null;
    const out = r['output'] as Record<string, unknown> | undefined;
    const decision = (out?.['action'] as string | undefined) ?? (r['action'] as string | undefined);
    const mcp = (out?.['mcp'] as string | undefined) ?? (r['mcp'] as string | undefined);
    const ms = (r['duration_ms'] as number | undefined) ?? (r['ms'] as number | undefined);
    const cost = (r['cost_credits'] as number | undefined) ?? (r['cost'] as number | undefined);
    if (decision == null && mcp == null && ms == null && cost == null) return null;
    return { action: decision, mcp, ms, cost };
  }

  /**
   * Internal guard: while true, `ngModelChange` handlers on the test inputs
   * skip clearing `activeScenario` (programmatic apply is in progress).
   * @internal
   */
  private applyingScenario = false;

  /**
   * Populate the test inputs from a named example scenario.
   *
   * @remarks
   * Pretty-prints the full sample payload (form + submission + mcps) into
   * the `fields_json` textarea so the operator sees exactly what the
   * router will receive. Sets `activeScenario` so the matching pill
   * highlights. Safe to call repeatedly — overwrites previous content.
   * Uses {@link applyingScenario} as a re-entrancy guard so the
   * `ngModelChange` listeners (which clear `activeScenario` on manual
   * edits) don't fire mid-apply and wipe the highlight.
   */
  applyTestScenario(id: string): void {
    const scenario = this.testScenarios.find((s) => s.id === id);
    if (!scenario) {
      console.warn('[forms] unknown test scenario', id);
      return;
    }
    this.applyingScenario = true;
    this.testInput.form_name = scenario.form_name;
    this.testInput.email = scenario.email;
    try {
      this.testInput.fields_json = JSON.stringify(scenario.payload, null, 2);
    } catch (err) {
      // Structured + message-only (matches the worker convention) — never log the
      // raw error object / payload, so nothing sensitive can leak to the console.
      console.warn(JSON.stringify({ service: 'forms', event: 'scenario_serialize_failed', error: err instanceof Error ? err.message : String(err) }));
      this.testInput.fields_json = '{}';
    }
    this.activeScenario.set(id);
    // Release the guard on the next microtask — gives Angular's change
    // detection time to flush the ngModel writes before manual edits can
    // clear the active scenario again.
    queueMicrotask(() => {
      this.applyingScenario = false;
    });
  }

  /**
   * Handler bound to every test-input `ngModelChange`. Clears the active
   * scenario chip on a real user edit, but is a no-op while
   * {@link applyTestScenario} is mid-flight.
   */
  onTestInputEdited(): void {
    if (this.applyingScenario) return;
    this.activeScenario.set(null);
  }

  /** Copy the formatted trace JSON to the clipboard with a toast confirm. */
  copyTrace(): void {
    const text = this.testResultPretty();
    if (!text) return;
    navigator.clipboard.writeText(text).then(
      () => this.toast.success('Trace copied'),
      () => this.toast.error('Copy failed — select + ⌘C from the textarea instead'),
    );
  }

  /** Copy the app.js install `<script>` snippet for the selected site to the
   *  clipboard, with a toast confirm. Surfaces the primary onboarding action
   *  inline from the empty state — no ⌘K required (so it works on mobile too).
   *  Matches the `<script src=".../app.js" data-slug=…>` tag app.js self-locates
   *  (data-slug drives `POST /api/contact-form/<slug>`; falls back to hostname). */
  copyInstallSnippet(): void {
    const slug = this.state.selectedSite()?.slug || 'your-site';
    const snippet = `<script src="https://projectsites.dev/app.js" data-slug="${slug}" defer></script>`;
    navigator.clipboard.writeText(snippet).then(
      () => this.toast.success('Install snippet copied — paste it before </body> on your site'),
      () => this.toast.error('Copy failed — open ⌘K → "Copy app.js install snippet" instead'),
    );
  }

  /** Mirror the worker formSubmissionInputSchema form_name rule (min1/max64/slug
   *  regex). Empty is VALID — the worker defaults it to 'default'. */
  formNameInvalid(): boolean {
    const raw = (this.testInput.form_name ?? '').trim();
    if (raw.length === 0) return false;
    return raw.length > 64 || !/^[a-z0-9][a-z0-9-_]{0,62}$/i.test(raw);
  }

  runTest(): void {
    const site = this.state.selectedSite();
    if (!site) return;
    if (this.formNameInvalid()) {
      this.toast.error('Form name must be a short slug — letters, numbers, hyphen or underscore, max 64 chars.');
      return;
    }
    let fields: Record<string, unknown> = {};
    try {
      fields = JSON.parse(this.testInput.fields_json || '{}') as Record<string, unknown>;
    } catch {
      this.toast.error('Fields must be valid JSON — check brackets and quotes');
      return;
    }
    this.testing.set(true);
    this.testResult.set(null);
    // Reuse the public form-submit endpoint — the worker runs the router prompt
    // and writes an ai_form_logs row we then poll back for the structured trace.
    // The worker resolves the site from ?slug= (or the X-Site-Slug header) —
    // WITHOUT it the request 400s "Missing X-Site-Slug" before validation ever
    // runs, so the test panel never worked. Pass the selected site's slug.
    this.api
      .post<{ data?: { id?: string } }>(`/v1/forms/submit?slug=${encodeURIComponent(site.slug)}`, {
        form_name: this.testInput.form_name,
        email: this.testInput.email,
        fields,
        origin_url: 'admin://test',
      })
      .subscribe({
        next: (res) => {
          // Worker returns { data: { id } } (was read as `submission_id` → always
          // undefined → the inline AI-trace poll was skipped every time).
          const subId = res?.data?.id;
          if (!subId) {
            this.testResult.set({ note: 'Submitted — open AI Logs to see the trace.' });
            this.testing.set(false);
            return;
          }
          // Poll once the AI trace exists (router runs async via waitUntil).
          let tries = 0;
          const poll = (): void => {
            this.api
              .get<{ data: { ai_logs: unknown[] } }>(
                `/sites/${site.id}/form-submissions/${subId}`,
              )
              .subscribe({
                next: (d) => {
                  const logs = d.data?.ai_logs ?? [];
                  if (logs.length || tries++ > 12) {
                    this.testResult.set(logs[0] ?? { note: 'No trace returned in time — check AI Logs.' });
                    this.testing.set(false);
                  } else {
                    setTimeout(poll, 750);
                  }
                },
                error: () => {
                  this.testing.set(false);
                  this.toast.error('Could not fetch trace — open AI Logs for the full timeline');
                },
              });
          };
          setTimeout(poll, 700);
        },
        error: (err: { error?: { error?: { message?: string } } }) => {
          this.testing.set(false);
          this.toast.error(err?.error?.error?.message || 'Test failed');
        },
      });
  }
}
