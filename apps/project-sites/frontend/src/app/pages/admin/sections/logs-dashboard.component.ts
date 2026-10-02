import { Component, signal, computed, inject, DestroyRef, type OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AdminAuditComponent } from './audit.component';
import { AdminLogsExplorerComponent } from './logs-explorer.component';
import { AdminAiLogsComponent } from './ai-logs.component';
import { AdminStateService } from '../admin-state.service';

type LogsTab = 'audit' | 'explorer' | 'traces';

/**
 * Unified logging dashboard (2026-06-08) — combines the former standalone
 * "Audit Log" (`/admin/audit`) and "Log Explorer" (`/admin/logs`) sidebar items
 * into ONE surface with two tabs. All logging lives here now.
 *
 * Deep-linkable + bookmarkable via `?tab=audit|explorer` (shared admin pattern)
 * so `/admin/logs?tab=explorer` lands directly on structured logs and the
 * legacy `/admin/audit` redirect lands on the Audit Trail tab (the default).
 */
@Component({
  selector: 'app-admin-logs-dashboard',
  standalone: true,
  imports: [AdminAuditComponent, AdminLogsExplorerComponent, AdminAiLogsComponent],
  template: `
    <div class="px-6 pt-5 pb-2 max-md:px-4" data-testid="logs-dashboard">
      <h1 class="text-[1.35rem] font-extrabold text-white tracking-tight m-0">Logs</h1>
      <p class="text-[0.82rem] text-text-secondary mt-1 mb-3">
        Audit trail + structured request / AI / job logs — one place for everything that happened.
      </p>
      <div class="flex overflow-x-auto max-w-full min-w-0 gap-1 p-1 rounded-xl border border-white/[0.06] bg-white/[0.02]" role="tablist" aria-label="Logs view">
        @for (t of tabs(); track t.id) {
          <button
            type="button"
            role="tab"
            [attr.aria-selected]="tab() === t.id"
            [attr.data-testid]="'logs-tab-' + t.id"
            class="px-3.5 py-1.5 rounded-lg text-[0.8rem] font-semibold transition-all cursor-pointer shrink-0 whitespace-nowrap"
            [class.bg-primary]="tab() === t.id"
            [class.text-dark]="tab() === t.id"
            [class.text-text-secondary]="tab() !== t.id"
            [class.hover:text-white]="tab() !== t.id"
            (click)="select(t.id)">
            {{ t.label }}
          </button>
        }
      </div>
    </div>

    @if (tab() === 'explorer' && isSuperAdmin()) {
      <app-logs-explorer />
    } @else if (tab() === 'traces' && isSuperAdmin()) {
      <app-admin-ai-logs />
    } @else {
      <app-admin-audit [embedded]="true" />
    }
  `,
})
export class AdminLogsDashboardComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly adminState = inject(AdminStateService);

  /**
   * Log Explorer + Traces read CROSS-TENANT Cloudflare Observability (platform-wide,
   * super-admin-only on the worker since fire-71 — see routes/logs.ts). Those two tabs
   * render ONLY for super-admins; the org-scoped, owner-facing Audit Trail is always
   * shown. Hiding the tabs (vs. letting them 403) avoids a doomed control.
   */
  readonly isSuperAdmin = this.adminState.isSuperAdmin;

  readonly tabs = computed<ReadonlyArray<{ id: LogsTab; label: string }>>(() => {
    const t: Array<{ id: LogsTab; label: string }> = [{ id: 'audit', label: 'Audit Trail' }];
    if (this.isSuperAdmin()) {
      t.push({ id: 'explorer', label: 'Log Explorer' }, { id: 'traces', label: 'Traces' });
    }
    return t;
  });
  readonly tab = signal<LogsTab>('audit');

  ngOnInit(): void {
    // Sync the active tab from `?tab=` so the view is deep-linkable + back/forward
    // restores it. takeUntilDestroyed: ActivatedRoute observables never complete.
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((q) => {
      const t = q.get('tab');
      this.tab.set(t === 'explorer' || t === 'traces' ? t : 'audit');
    });
  }

  select(tab: LogsTab): void {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab },
      queryParamsHandling: 'merge',
    });
  }
}
