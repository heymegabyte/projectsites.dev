/**
 * Admin → Sites → MCP Server
 *
 * Per-site MCP server management (#29).
 * Accessible via `/admin/sites/:id/mcp-server`.
 *
 * Features:
 * - Token management (mint, copy, revoke)
 * - Tool list with per-tool inline "test" playground runner
 * - Per-tool usage chart (call_count last 30d)
 *
 * Design: cyan/black compact per [[cyan-black-compact-progression]].
 * Stats use `<app-rolling-counter>`.
 */
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterModule, ActivatedRoute } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { ApiService } from '../../../services/api.service';
import { catchError, of } from 'rxjs';
import { ToastService } from '../../../services/toast.service';
import { ConfirmService } from '../../../services/confirm.service';
import { RollingCounterComponent } from '../../../components/rolling-counter/rolling-counter.component';
import { MiniEmptyComponent } from '../../../components/mini-empty/mini-empty.component';
import { ErrorCardComponent } from '../../../components/states';
import { HlmInputDirective } from '../../../ui';
import { RevealDirective } from '../../../directives/reveal.directive';

interface McpToken {
  id: string;
  label: string;
  last_used: string | null;
  created_at: string;
}

interface ToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  requiresAuth?: boolean;
}

interface ToolUsage {
  tool_name: string;
  day: string;
  call_count: number;
  error_count: number;
}

@Component({
  selector: 'app-site-mcp-server',
  standalone: true,
  imports: [FormsModule, RouterModule, RollingCounterComponent, ErrorCardComponent, RevealDirective, MiniEmptyComponent, HlmInputDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="p-5 flex-1 overflow-y-auto space-y-5 animate-fade-in" data-testid="site-mcp-server">

      <!-- Header -->
      <header appReveal>
        <div class="kicker">External Agents</div>
        <h1 class="section-h m-0 mt-1 flex items-center gap-2">
          MCP Server
          <span class="header-pill" [attr.title]="callsTodayUnknown() ? 'Calls today failed to load' : null">
            <span class="header-pill-dot" aria-hidden="true"></span>
            @if (toolsLoading()) {
              <span aria-label="Loading calls today">… calls today</span>
            } @else if (callsTodayUnknown()) {
              <span aria-label="Calls today: unknown — failed to load">— calls today</span>
            } @else {
              <app-rolling-counter [value]="totalCallsToday()" suffix=" calls today" />
            }
          </span>
        </h1>
        <p class="text-[0.78rem] text-text-secondary m-0 mt-1 max-w-prose">
          External agents (Claude, GPT, Cursor) can read and write site content via the MCP CRUD
          tools. Authenticate with a per-site Bearer token minted below.
        </p>
        @if (siteSlug()) {
          <p class="text-[0.75rem] text-text-secondary m-0 mt-1 font-mono">
            Endpoint: <span class="text-accent">https://{{ siteSlug() }}.projectsites.dev/mcp</span>
          </p>
        }
      </header>

      <!-- Stats -->
      <div class="grid grid-cols-3 gap-3" appReveal>
        @for (stat of stats(); track stat.label) {
          <div class="card p-3 text-center">
            @if (stat.unknown) {
              <div class="text-xl font-bold text-text-secondary/50" [attr.aria-label]="stat.label + ': unknown — failed to load'" title="Failed to load">—</div>
            } @else {
              <app-rolling-counter [value]="stat.value" class="text-xl font-bold text-accent" />
            }
            <div class="text-[0.7rem] text-text-secondary mt-0.5">{{ stat.label }}</div>
          </div>
        }
      </div>

      <!-- Tokens -->
      <section class="space-y-3" appReveal>
        <div class="flex items-center justify-between">
          <h3 class="text-sm font-semibold m-0">API Tokens</h3>
          <div class="flex items-center gap-2">
            <input
              hlmInput
              class="text-xs h-8 w-40"
              [(ngModel)]="newTokenLabel"
              [disabled]="minting()"
              maxlength="48"
              placeholder="Label (e.g. Cursor)"
              aria-label="New token label"
              data-testid="new-token-label"
              (keydown.enter)="mintToken()"
            />
            <button
              class="btn-ghost text-xs px-2 py-1"
              data-testid="mint-token-btn"
              (click)="mintToken()"
              [disabled]="minting()"
              [attr.aria-busy]="minting()"
            >{{ minting() ? 'Generating…' : '+ New Token' }}</button>
          </div>
        </div>

        <!-- Newly minted token — show once -->
        @if (newTokenRaw()) {
          <div class="card p-3 border-primary/30 space-y-2" data-testid="new-token-banner">
            <p class="text-xs text-amber-400 font-semibold m-0">Copy this token now — it won't be shown again.</p>
            <div class="flex items-center gap-2">
              <code class="flex-1 text-accent text-[0.72rem] break-all bg-white/5 px-2 py-1.5 rounded">{{ newTokenRaw() }}</code>
              <button class="btn-ghost text-xs px-2" (click)="copyToken(newTokenRaw()!)">Copy</button>
            </div>
            <button class="btn-ghost text-xs text-text-secondary" (click)="newTokenRaw.set(null)">Dismiss</button>
          </div>
        }

        @if (tokensError() && tokens().length === 0) {
          <app-error-card
            title="Couldn't load tokens"
            [message]="tokensError()!"
            [correlationId]="tokensErrorRef()"
            (retry)="loadTokens()" />
        } @else if (tokensLoading() && tokens().length === 0) {
          <div class="space-y-1.5">
            @for (i of [0,1]; track i) { <div class="skel h-9 rounded w-full"></div> }
          </div>
        } @else if (tokens().length === 0) {
          <app-mini-empty text="No tokens yet.">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3"/></svg>
          </app-mini-empty>
        } @else {
          <div class="card overflow-hidden">
            <table class="w-full text-xs" data-testid="tokens-table">
              <thead>
                <tr class="border-b border-white/5 text-text-secondary text-[0.65rem] uppercase tracking-wider">
                  <th scope="col" class="px-3 py-2 text-left font-medium">Label</th>
                  <th scope="col" class="px-3 py-2 text-left font-medium">Last Used</th>
                  <th scope="col" class="px-3 py-2 text-left font-medium">Created</th>
                  <th scope="col" class="px-3 py-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                @for (t of tokens(); track t.id) {
                  <tr class="border-b border-white/5 hover:bg-white/[0.02]" [attr.data-testid]="'token-row-' + t.id">
                    <td class="px-3 py-2 font-semibold">{{ t.label }}</td>
                    <td class="px-3 py-2 text-text-secondary">{{ t.last_used ? formatDate(t.last_used) : 'Never' }}</td>
                    <td class="px-3 py-2 text-text-secondary">{{ formatDate(t.created_at) }}</td>
                    <td class="px-3 py-2 text-right">
                      <button
                        class="btn-ghost text-[0.68rem] px-2 py-0.5 text-red-400"
                        data-testid="revoke-token-btn"
                        (click)="revokeToken(t.id)"
                        [disabled]="revoking() === t.id"
                        [attr.aria-busy]="revoking() === t.id"
                      >Revoke</button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>

      <!-- Tool list -->
      <section class="space-y-3" appReveal>
        <h3 class="text-sm font-semibold m-0">Available Tools</h3>
        @if (toolsError() && tools().length === 0) {
          <app-error-card
            title="Couldn't load tools"
            [message]="toolsError()!"
            [correlationId]="toolsErrorRef()"
            (retry)="loadTools()" />
        } @else if (toolsLoading() && tools().length === 0) {
          <div class="space-y-1.5">
            @for (i of [0,1,2,3]; track i) { <div class="skel h-9 rounded w-full"></div> }
          </div>
        } @else if (tools().length === 0) {
          <app-mini-empty text="No MCP tools available yet." data-testid="mcp-tools-empty">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
          </app-mini-empty>
        } @else {
          <div class="card overflow-hidden">
            @for (tool of tools(); track tool.name; let last = $last) {
              <div
                class="px-3 py-2 flex items-center justify-between gap-3"
                [class.border-b]="!last"
                [class.border-white/5]="!last"
                [attr.data-testid]="'tool-row-' + tool.name"
              >
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2">
                    <code class="text-accent text-[0.75rem] font-semibold">{{ tool.name }}</code>
                    @if (tool.requiresAuth) {
                      <span class="text-[0.62rem] bg-primary/10 text-accent px-1.5 rounded">auth required</span>
                    }
                    <span class="text-[0.65rem] text-text-secondary ml-auto">
                      {{ callsForTool(tool.name) }} calls (30d)
                    </span>
                  </div>
                  @if (tool.description) {
                    <p class="text-[0.72rem] text-text-secondary m-0 mt-0.5 truncate" [attr.title]="tool.description">{{ tool.description }}</p>
                  }
                </div>
                <button
                  class="btn-ghost text-[0.68rem] px-2 py-1 shrink-0"
                  data-testid="test-tool-btn"
                  (click)="openPlayground(tool)"
                >Test</button>
              </div>
            }
          </div>
        }
      </section>

      <!-- Inline playground -->
      @if (playgroundTool()) {
        <section class="card p-4 space-y-3" data-testid="tool-playground" appReveal>
          <div class="flex items-center justify-between">
            <h3 class="text-sm font-semibold m-0 font-mono text-accent">{{ playgroundTool()!.name }}</h3>
            <button class="btn-ghost text-xs" (click)="playgroundTool.set(null)">Close</button>
          </div>
          <div class="space-y-2">
            <label for="mcp-pg-args" class="text-[0.72rem] text-text-secondary font-medium">Arguments (JSON)</label>
            <textarea
              id="mcp-pg-args"
              hlmInput
              [multiline]="true"
              class="w-full font-mono text-xs min-h-[80px] resize-y"
              [(ngModel)]="playgroundArgs"
              placeholder="{}"
              data-testid="playground-args"
            ></textarea>
          </div>
          <div class="flex gap-2">
            <button
              class="btn-primary text-xs px-3"
              data-testid="playground-run-btn"
              (click)="runPlayground()"
              [disabled]="playgroundRunning()"
              [attr.aria-busy]="playgroundRunning()"
            >{{ playgroundRunning() ? 'Running…' : 'Run' }}</button>
          </div>
          @if (playgroundResult()) {
            <div class="space-y-1">
              <div class="text-[0.7rem] text-text-secondary font-medium">Result</div>
              <pre class="bg-white/5 rounded p-2 text-[0.72rem] overflow-x-auto whitespace-pre-wrap text-accent" data-testid="playground-result">{{ playgroundResult() }}</pre>
            </div>
          }
        </section>
      }

    </div>
  `,
  // Force the cyan token for .text-accent — without this local rule the global
  // utility cascades to a dim teal here (axe serious color-contrast ~1.1:1 on the
  // small endpoint URL). Mirrors analytics/apps/user-settings which all declare it.
  styles: [`.text-accent { color: var(--ps-accent, #00e5ff); }`],
})
export class SiteMcpServerComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  // ApiService for the admin /api/* calls (injects the bearer + 401-handling);
  // raw HttpClient stays ONLY for the public `/{slug}/mcp` playground endpoint.
  private readonly api = inject(ApiService);
  private readonly http = inject(HttpClient);
  private readonly toast = inject(ToastService);
  private readonly confirmSvc = inject(ConfirmService);

  readonly tokens = signal<McpToken[]>([]);
  readonly tools = signal<ToolDef[]>([]);
  readonly usage = signal<ToolUsage[]>([]);
  readonly tokensLoading = signal(true);
  readonly toolsLoading = signal(true);
  readonly tokensError = signal<string | null>(null);
  readonly toolsError = signal<string | null>(null);
  /** Worker request_ids from a failed tokens/tools load → copyable support references on the error cards. */
  readonly tokensErrorRef = signal('');
  readonly toolsErrorRef = signal('');
  readonly minting = signal(false);
  readonly revoking = signal<string | null>(null);
  readonly newTokenRaw = signal<string | null>(null);
  readonly playgroundTool = signal<ToolDef | null>(null);
  readonly playgroundRunning = signal(false);
  readonly playgroundResult = signal<string | null>(null);
  readonly siteSlug = signal<string | null>(null);

  playgroundArgs = '{}';
  newTokenLabel = '';

  private siteId = '';

  readonly totalCallsToday = computed(() => {
    const today = new Date().toISOString().slice(0, 10);
    return this.usage()
      .filter((u) => u.day === today)
      .reduce((sum, u) => sum + u.call_count, 0);
  });

  /** Calls Today is unknown (not zero) when the tools/usage feed failed to load — gates the header pill so it never claims a confident "0 calls today". */
  readonly callsTodayUnknown = computed(() => !!this.toolsError() && this.tools().length === 0);

  readonly stats = computed(() => {
    // `unknown` = the source FAILED to load → show "—", not a false "0" (a stat
    // claiming "0 Tools" next to a "Couldn't load tools" error-card is a lie —
    // see the premature-stat-during-load / lying-UI class). Calls Today derives
    // from the tools/usage feed, so a tools error makes it unknown too.
    const toolsUnknown = !!this.toolsError() && this.tools().length === 0;
    const tokensUnknown = !!this.tokensError() && this.tokens().length === 0;
    return [
      { label: 'Tools', value: this.tools().length, unknown: toolsUnknown },
      { label: 'Tokens', value: this.tokens().length, unknown: tokensUnknown },
      { label: 'Calls Today', value: this.totalCallsToday(), unknown: toolsUnknown },
    ];
  });

  ngOnInit(): void {
    this.siteId = this.route.parent?.snapshot.params['id'] ?? this.route.snapshot.params['id'] ?? '';
    this.loadTokens();
    this.loadTools();
    this.loadUsage();
    this.loadSiteSlug();
  }

  private loadSiteSlug(): void {
    if (!this.siteId) return;
    this.api
      .get<{ data: { slug: string } }>(`/sites/${this.siteId}`, undefined, { silent: true })
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        if (res?.data?.slug) this.siteSlug.set(res.data.slug);
      });
  }

  loadTokens(): void {
    this.tokensLoading.set(true);
    this.tokensError.set(null);
    this.tokensErrorRef.set('');
    this.api
      .get<{ tokens: McpToken[] }>(`/sites/${this.siteId}/mcp/tokens`, undefined, { silent: true })
      .pipe(catchError((err) => { this.tokensError.set('The MCP token service did not respond.'); this.tokensErrorRef.set(this.requestIdFrom(err)); return of(null); }))
      .subscribe((res) => {
        // A parseable-but-shapeless 200 (SPA/marketing HTML, `{}`) flows through
        // the success branch — ApiService only remaps UNPARSEABLE 2xx to 404.
        // Guard the shape so a shapeless 200 surfaces as an error, never a
        // confident "no tokens" fake-empty (stale-route class).
        if (res && Array.isArray(res.tokens)) {
          this.tokens.set(res.tokens);
        } else if (res) {
          this.tokensError.set('The MCP token service did not respond.');
        }
        this.tokensLoading.set(false);
      });
  }

  loadTools(): void {
    this.toolsLoading.set(true);
    this.toolsError.set(null);
    this.toolsErrorRef.set('');
    this.api
      .get<{ tools: ToolDef[] }>(`/sites/${this.siteId}/mcp/tools`, undefined, { silent: true })
      .pipe(catchError((err) => { this.toolsError.set('The MCP tool registry did not respond.'); this.toolsErrorRef.set(this.requestIdFrom(err)); return of(null); }))
      .subscribe((res) => {
        // Shape-guard the success branch — a shapeless 200 must not fake-empty
        // the tool list (which would also fake-zero the Calls-Today stat).
        if (res && Array.isArray(res.tools)) {
          this.tools.set(res.tools);
        } else if (res) {
          this.toolsError.set('The MCP tool registry did not respond.');
        }
        this.toolsLoading.set(false);
      });
  }

  private loadUsage(): void {
    this.api
      .get<{ usage: ToolUsage[] }>(`/sites/${this.siteId}/mcp/tool-usage`, undefined, { silent: true })
      .pipe(catchError(() => of({ usage: [] as ToolUsage[] })))
      // Guard the array so a shapeless 200 never sets `usage` to undefined —
      // totalCallsToday()/callsForTool() reduce over it and would crash the
      // header pill + per-tool counts. Non-array → empty (usage is a soft stat).
      .subscribe((res) => this.usage.set(Array.isArray(res?.usage) ? res.usage : []));
  }

  /** Pull the worker request_id from a failed response ({ error: { request_id } }) for the support reference. */
  private requestIdFrom(e: unknown): string {
    return ((e as { error?: { error?: { request_id?: string } } } | undefined)?.error?.error?.request_id) ?? '';
  }

  mintToken(): void {
    if (this.minting()) return;
    // A user-named label keeps the revoke table legible; blank → a unique
    // auto-label (`Token N`) so two tokens are never both "Default".
    const label = this.newTokenLabel.trim() || `Token ${this.tokens().length + 1}`;
    this.minting.set(true);
    this.api
      .post<{ id: string; token: string }>(`/sites/${this.siteId}/mcp/tokens`, { label }, { silent: true })
      .pipe(catchError((err) => { this.toast.error(err?.error?.error ?? 'Failed to mint token'); return of(null); }))
      .subscribe((res) => {
        if (res) {
          this.newTokenRaw.set(res.token);
          this.newTokenLabel = '';
          this.loadTokens(); // refresh list (hash only)
        }
        this.minting.set(false);
      });
  }

  copyToken(token: string): void {
    navigator.clipboard.writeText(token).then(
      () => this.toast.success('Token copied'),
      () => this.toast.error('Copy failed'),
    );
  }

  async revokeToken(tokenId: string): Promise<void> {
    const ok = await this.confirmSvc.confirm({
      title: 'Revoke MCP token',
      message: 'Revoke this MCP access token? Any MCP client or integration using it stops working immediately and cannot be restored — you would issue a new token.',
      confirmLabel: 'Revoke',
      danger: true,
    });
    if (!ok) return;
    this.revoking.set(tokenId);
    this.api
      .delete(`/sites/${this.siteId}/mcp/tokens/${tokenId}`, { silent: true })
      .pipe(catchError((err) => { this.toast.error(err?.error?.error ?? 'Failed'); return of(null); }))
      .subscribe(() => {
        this.tokens.update((ts) => ts.filter((t) => t.id !== tokenId));
        this.revoking.set(null);
      });
  }

  openPlayground(tool: ToolDef): void {
    this.playgroundTool.set(tool);
    this.playgroundArgs = '{}';
    this.playgroundResult.set(null);
  }

  /**
   * MCP CRUD tools include write/delete operations. A leading or token-bounded
   * mutating verb means the tool can change live site content, so gate it
   * behind a danger confirm before firing it against production data. Read
   * tools (get/list/read/search/…) run straight through.
   */
  private static readonly MUTATING_TOOL =
    /(^|[_-])(create|update|delete|remove|write|set|publish|unpublish|insert|patch|put|drop|reset|destroy|edit|upload|rename|move)([_-]|$)/i;

  async runPlayground(): Promise<void> {
    const tool = this.playgroundTool();
    if (!tool) return;
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(this.playgroundArgs || '{}') as Record<string, unknown>;
    } catch {
      this.toast.error('Invalid JSON arguments');
      return;
    }
    if (SiteMcpServerComponent.MUTATING_TOOL.test(tool.name)) {
      const ok = await this.confirmSvc.confirm({
        title: `Run ${tool.name}?`,
        message: `This MCP tool can modify live site content. Running it executes immediately against ${this.siteSlug() ?? 'this site'} and cannot be undone from here.`,
        confirmLabel: 'Run tool',
        danger: true,
      });
      if (!ok) return;
    }
    this.playgroundRunning.set(true);
    this.playgroundResult.set(null);

    // Call via the path-based admin MCP endpoint.
    const slug = this.siteSlug() ?? this.siteId;
    this.http
      .post<unknown>(`/${slug}/mcp`, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: tool.name, arguments: args },
      })
      .pipe(catchError((err) => of({ error: err?.message ?? 'Request failed' })))
      .subscribe((res) => {
        this.playgroundResult.set(JSON.stringify(res, null, 2));
        this.playgroundRunning.set(false);
      });
  }

  callsForTool(name: string): number {
    return this.usage()
      .filter((u) => u.tool_name === name)
      .reduce((sum, u) => sum + u.call_count, 0);
  }

  formatDate(iso: string): string {
    try {
      return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
    } catch {
      return iso;
    }
  }
}
