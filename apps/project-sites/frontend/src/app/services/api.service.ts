/**
 * @module services/api
 *
 * @description
 * Single typed HTTP entry-point for every `/api/*` call the admin SPA + marketing
 * shell make. Wraps `HttpClient` with: bearer-token injection, 30s timeout,
 * `http.failure` telemetry, user-friendly toast on every error, and an automatic
 * `/signin` redirect on 401 when the user is inside a protected route.
 *
 * @remarks
 * - Every typed endpoint method (e.g. `listSites`, `getSubscription`) delegates
 *   to the generic verb helpers (`get`/`post`/`put`/`patch`/`delete`) so the
 *   error envelope is consistent.
 * - 401 inside `/admin`, `/billing`, or `/editor` triggers a navigation to
 *   `/signin?returnUrl=…`; 401 from public routes silently clears the session.
 * - `postFormData()` omits the JSON `Content-Type` header so the browser sets
 *   the multipart boundary correctly.
 *
 * @example
 * ```ts
 * const api = inject(ApiService);
 * api.listSites().subscribe(res => this.sites.set(res.data));
 * ```
 */
import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { Observable, of, throwError, TimeoutError } from 'rxjs';
import { catchError, map, timeout } from 'rxjs/operators';
import { z } from 'zod';
import { Router } from '@angular/router';
import { AuthService } from './auth.service';
import { ToastService } from './toast.service';
import { TelemetryService } from './telemetry.service';

/**
 * Shape of the worker `GET /health` envelope (KV + R2 probe). `passthrough` so
 * extra fields (version, region, timestamp) don't fail validation — we only
 * depend on `status`, `environment`, and `checks` for the topbar status pill.
 */
export const HealthStatusSchema = z
  .object({
    status: z.enum(['ok', 'degraded']),
    environment: z.string().optional(),
    latency_ms: z.number().optional(),
    checks: z
      .record(
        z.string(),
        z.object({
          status: z.enum(['ok', 'error']),
          latency_ms: z.number().optional(),
          message: z.string().optional(),
        }),
      )
      .optional(),
  })
  .passthrough();
export type HealthStatus = z.infer<typeof HealthStatusSchema>;

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);
  private auth = inject(AuthService);
  private toast = inject(ToastService);
  private router = inject(Router);
  private telemetry = inject(TelemetryService);

  /** Injects `Authorization: Bearer <token>` when signed in. */
  private headers(): HttpHeaders {
    let headers = new HttpHeaders({ 'Content-Type': 'application/json' });
    const token = this.auth.getToken();
    if (token) {
      headers = headers.set('Authorization', `Bearer ${token}`);
    }
    return headers;
  }

  private static readonly REQUEST_TIMEOUT_MS = 30_000;

  /**
   * 30s timeout to prevent indefinite hangs; user-friendly toast on failure;
   * re-throws so callers can add their own handling.
   */
  private handleError<T>(silent = false): (source: Observable<T>) => Observable<T> {
    return (source: Observable<T>) =>
      source.pipe(
        timeout(ApiService.REQUEST_TIMEOUT_MS),
        catchError((error: HttpErrorResponse | TimeoutError) => {
          if (error instanceof TimeoutError) {
            if (!silent) this.toast.error('Request timed out. Please try again.');
            // Treat timeouts as `http.failure` with a `0` status so the
            // dashboards bucket them next to network drops.
            this.telemetry.track('http.failure', { status: 0, reason: 'timeout' });
            return throwError(() => error);
          }
          // A 2xx status in the error path means HttpClient could NOT parse the
          // body as JSON — almost always an /api/* path that fell through to the
          // SPA shell (worker route not deployed/registered → 200 + index.html).
          // Surface it as a clean 404 so the standard "endpoint unavailable"
          // handling (calm flag-gate notice in recipes/webhooks/deliverability,
          // all of which branch on status===404) applies instead of an alarming
          // "Couldn't load — retry" card that would re-hammer a route that can't
          // succeed. Never toast (not user-actionable; the section owns its notice).
          if (error.status >= 200 && error.status < 300) {
            this.telemetry.track('http.failure', {
              status: error.status,
              url: this.safeUrl(error.url),
              reason: 'spa_fallthrough',
            });
            return throwError(
              () =>
                new HttpErrorResponse({
                  error: error.error,
                  status: 404,
                  statusText: 'Not Found',
                  url: error.url ?? undefined,
                }),
            );
          }
          const message = this.getErrorMessage(error);
          // `silent` suppresses the user-facing toast for fire-and-forget /
          // forward-compatible syncs (e.g. a pref sync to a route that may not
          // have shipped yet) — telemetry + 401 handling below still run, so we
          // keep observability + security, we just don't nag the user.
          if (!silent) this.toast.error(message);
          // Single capture point for every HTTP failure at the boundary.
          // Carry the status + URL (path only, no query) + method so the
          // PostHog/GA4 funnel can spot endpoint-level regressions.
          this.telemetry.track('http.failure', {
            status: error.status,
            url: this.safeUrl(error.url),
            message,
          });

          if (error.status === 401) {
            this.auth.clearSession();
            // Only force the user to /signin when they're already inside a
            // protected route. A 401 from /auth/me on the public homepage
            // should NOT bounce the visitor into the signin flow.
            const url = this.router.url.split('?')[0] ?? '';
            const protectedRoutes = ['/admin', '/billing', '/editor'];
            if (protectedRoutes.some((r) => url === r || url.startsWith(r + '/'))) {
              this.router.navigate(['/signin'], { queryParams: { returnUrl: url } });
            }
          }

          return throwError(() => error);
        }),
      );
  }

  /**
   * Strip query string from the failing URL before forwarding to telemetry.
   * Keeps tokens / place-ids / search terms out of analytics events while
   * preserving the route shape for funnel debugging.
   */
  private safeUrl(url: string | null): string {
    if (!url) return '';
    const qIdx = url.indexOf('?');
    return qIdx === -1 ? url : url.slice(0, qIdx);
  }

  private getErrorMessage(error: HttpErrorResponse): string {
    if (error.status === 0 || error.statusText === 'Unknown Error') {
      return "Can't reach the server. Check your connection.";
    }
    switch (error.status) {
      case 401:
        return 'Your session expired. Please sign in again.';
      case 403:
        return "You don't have permission to do that.";
      case 404:
        return "That resource wasn't found.";
      case 429:
        return 'Too many requests. Please wait a moment.';
      default:
        return error.status >= 500
          ? "Something went wrong. We're looking into it."
          : 'An unexpected error occurred. Please try again.';
    }
  }

  /**
   * Generic GET — `path` is relative to `/api` (e.g. `/sites/123`).
   * Pass `{ silent: true }` to suppress the user-facing error toast (telemetry
   * + 401 handling still run) — for background/forward-compatible reads.
   */
  get<T>(
    path: string,
    params?: Record<string, string>,
    opts?: { silent?: boolean },
  ): Observable<T> {
    return this.http
      .get<T>(`/api${path}`, { headers: this.headers(), params })
      .pipe(this.handleError(opts?.silent));
  }

  /**
   * Authenticated binary GET → `Blob`, for endpoints that stream a file the user
   * downloads (e.g. a voice transcript or recording export). A plain
   * `<a download href>` navigation can't carry the `Authorization: Bearer` header
   * (auth here is bearer-only, not cookie), so those routes would 401 — the caller
   * must fetch WITH auth, then object-URL + click the resulting blob. The shared
   * 30s-timeout + `http.failure` telemetry + 401-redirect handling still apply.
   *
   * @param path - Relative to `/api` (e.g. `/voice/conversations/abc/download.txt`).
   * @example
   * ```ts
   * this.api.getBlob(`/voice/conversations/${id}/download.txt`).subscribe((b) => saveBlob(b));
   * ```
   */
  getBlob(path: string, opts?: { silent?: boolean }): Observable<Blob> {
    return this.http
      .get(`/api${path}`, { headers: this.headers(), responseType: 'blob' })
      .pipe(this.handleError(opts?.silent));
  }

  /**
   * Authenticated binary GET for an ALREADY-ABSOLUTE same-origin path (e.g. an
   * `/api/sites/…/screenshot.png` a component built itself). Same purpose as
   * {@link getBlob} but does NOT prepend `/api` — use when the caller holds the full
   * path. Backs the `AuthImageSrcDirective` (authed images) + authed file downloads,
   * because a plain image element / download anchor can't carry the Bearer.
   *
   * @param path - Full same-origin path beginning with `/api/`.
   * @example
   * ```ts
   * this.api.getBlobAbsolute('/api/sites/s1/snapshots/x/screenshot.png').subscribe(saveBlob);
   * ```
   */
  getBlobAbsolute(path: string, opts?: { silent?: boolean }): Observable<Blob> {
    return this.http
      .get(path, { headers: this.headers(), responseType: 'blob' })
      .pipe(this.handleError(opts?.silent));
  }

  /**
   * Worker `/health` probe (KV + R2). Lives OUTSIDE `/api`, needs no auth, and
   * must fail SAFE — a probe error resolves to `null` so the topbar status pill
   * shows "unknown" rather than spamming a toast. Zod-validated at the boundary
   * (real data only; an unexpected shape resolves to `null`, never a fake "ok").
   * @see HealthStatusSchema
   */
  health(): Observable<HealthStatus | null> {
    return this.http.get<unknown>('/health').pipe(
      map((raw) => {
        const parsed = HealthStatusSchema.safeParse(raw);
        return parsed.success ? parsed.data : null;
      }),
      catchError(() => of(null)),
    );
  }

  /**
   * Generic POST — JSON body, bearer header, 30s timeout.
   * Pass `{ silent: true }` to suppress the user-facing error toast (telemetry
   * + 401 handling still run) — for fire-and-forget syncs.
   */
  post<T>(path: string, body?: unknown, opts?: { silent?: boolean }): Observable<T> {
    return this.http
      .post<T>(`/api${path}`, body, { headers: this.headers() })
      .pipe(this.handleError(opts?.silent));
  }

  /** `{ silent: true }` suppresses the generic error toast (telemetry + 401-redirect still run). */
  put<T>(path: string, body?: unknown, opts?: { silent?: boolean }): Observable<T> {
    return this.http
      .put<T>(`/api${path}`, body, { headers: this.headers() })
      .pipe(this.handleError(opts?.silent));
  }

  /** `{ silent: true }` suppresses the generic error toast (telemetry + 401-redirect still run). */
  patch<T>(path: string, body?: unknown, opts?: { silent?: boolean }): Observable<T> {
    return this.http
      .patch<T>(`/api${path}`, body, { headers: this.headers() })
      .pipe(this.handleError(opts?.silent));
  }

  /**
   * Generic DELETE — bearer header, 30s timeout. Pass `{ silent: true }` to
   * suppress the generic error toast (telemetry + 401-redirect still run) when
   * the caller surfaces its OWN specific error message — avoids a double-toast.
   */
  delete<T>(path: string, opts?: { silent?: boolean }): Observable<T> {
    return this.http
      .delete<T>(`/api${path}`, { headers: this.headers() })
      .pipe(this.handleError(opts?.silent));
  }

  /**
   * Multipart-form POST for binary uploads (assets, logos, ZIPs).
   * Omits the JSON `Content-Type` so the browser sets the multipart boundary.
   * Pass `{ silent: true }` to suppress the generic error toast when the caller
   * aggregates per-file results into its own summary toast (avoids a flood of
   * one generic toast per failed file on a multi-file upload).
   */
  postFormData<T>(path: string, formData: FormData, opts?: { silent?: boolean }): Observable<T> {
    let headers = new HttpHeaders();
    const token = this.auth.getToken();
    if (token) {
      headers = headers.set('Authorization', `Bearer ${token}`);
    }
    return this.http
      .post<T>(`/api${path}`, formData, { headers })
      .pipe(this.handleError(opts?.silent));
  }

  searchBusinesses(
    query: string,
    lat?: number,
    lng?: number,
    opts?: { silent?: boolean },
  ): Observable<{ data: BusinessResult[]; _error?: SearchProviderError }> {
    const params: Record<string, string> = { q: query };
    if (lat != null && lng != null) {
      params['lat'] = lat.toString();
      params['lng'] = lng.toString();
    }
    // Typeahead callers own their inline "search unavailable" nudge, so they pass
    // { silent: true } — a per-keystroke generic "Can't reach the server" toast is
    // misleading (only the Places provider is down; manual entry still works).
    return this.get('/search/businesses', params, opts);
  }

  searchSites(query: string): Observable<{ data: PreBuiltSite[] }> {
    return this.get('/sites/search', { q: query });
  }

  /** Lookup site by place_id */
  lookupSite(placeId: string): Observable<{ data: SiteLookup | null }> {
    return this.get('/sites/lookup', { place_id: placeId });
  }

  sendMagicLink(
    email: string,
    redirectUrl: string,
  ): Observable<{ data: { token: string; identifier: string } }> {
    return this.post('/auth/magic-link', { email, redirect_url: redirectUrl });
  }

  /**
   * Secret-gated E2E test-login seam. Posts the canonical test email + password
   * to the worker's `POST /api/auth/test-login`, which 404s unless
   * `E2E_TEST_PASSWORD` is provisioned (never a live backdoor). Silent so the
   * signin component owns the inline + toast error UX.
   */
  testLogin(
    email: string,
    password: string,
  ): Observable<{ data: { token: string; email: string; user_id: string; org_id: string } }> {
    return this.post('/auth/test-login', { email, password }, { silent: true });
  }

  getMe(opts?: { silent?: boolean }): Observable<{ data: UserInfo }> {
    return this.get('/auth/me', undefined, opts);
  }

  createSiteFromSearch(body: CreateSitePayload): Observable<{ data: Site }> {
    return this.post('/sites/create-from-search', body);
  }

  /**
   * One-click site import from any URL. Crawls the source (Squarespace /
   * Wix / WordPress / Webflow / plain HTML), persists an inventory of every
   * discovered URL to R2, creates a draft site row, and kicks off the AI
   * rebuild workflow. Resolves once the workflow is enqueued — long-running
   * work happens server-side; the caller routes to /admin/waiting?id=…
   * to watch progress.
   *
   * @param body.url - Full http(s) URL of the source site. Required.
   * @param body.business_name - Optional override; defaults to the scraped
   *   `<title>` (with delimiter-suffix stripped) or the bare host.
   * @param body.target_slug - Optional subdomain slug; defaults to a
   *   business-name slugification.
   */
  importFromUrl(body: ImportFromUrlPayload): Observable<{ data: ImportFromUrlResult }> {
    return this.post('/sites/import-from-url', body);
  }

  /**
   * Fetch the 30-day rolling cost forecast for the authenticated org.
   *
   * @remarks
   * Backed by `GET /api/billing/cost-forecast?days=N`.
   * `days` clamps server-side to `[7, 90]`. Surface used by the Forecast card in
   * `billing.component.ts` — drives the rolling-counter projection, sparkline,
   * percent-of-cap meter, and the 80% threshold toast deduped via KV.
   *
   * @example
   * ```ts
   * this.api.getCostForecast(30).subscribe(r => this.forecast.set(r.data));
   * ```
   */
  getCostForecast(days = 30): Observable<{ data: CostForecastV2 }> {
    return this.get(`/billing/cost-forecast?days=${encodeURIComponent(String(days))}`);
  }

  listSites(opts?: { silent?: boolean }): Observable<{ data: Site[] }> {
    return this.get('/sites', undefined, opts);
  }

  getSite(id: string): Observable<{ data: Site }> {
    return this.get(`/sites/${id}`);
  }

  updateSite(id: string, body: Partial<Site>): Observable<{ data: Site }> {
    return this.patch(`/sites/${id}`, body);
  }

  deleteSite(id: string): Observable<void> {
    return this.delete(`/sites/${id}`);
  }

  /** Reset & rebuild */
  resetSite(id: string, body: ResetSitePayload): Observable<{ data: Site }> {
    return this.post(`/sites/${id}/reset`, body);
  }

  getSiteLogs(id: string, limit = 200): Observable<{ data: LogEntry[] }> {
    return this.get(`/sites/${id}/logs`, { limit: limit.toString() });
  }

  /** List a site's snapshots (version history, newest first) */
  getSnapshots(siteId: string): Observable<{ data: Snapshot[] }> {
    return this.get(`/sites/${siteId}/snapshots`);
  }

  /** List a site's branches (staged edits w/ approvals + preview URLs) */
  getSiteBranches(siteId: string): Observable<{ branches: SiteBranch[] }> {
    return this.get(`/sites/${siteId}/branches`);
  }

  /** Tools the site's own MCP server exposes to AI clients */
  getSiteMcpTools(siteId: string): Observable<{ tools: SiteMcpTool[] }> {
    return this.get(`/sites/${siteId}/mcp/tools`);
  }

  /** Recent calls AI clients made against the site's MCP server */
  getSiteMcpCalls(siteId: string): Observable<{ calls: SiteMcpCall[] }> {
    return this.get(`/sites/${siteId}/mcp/calls`);
  }

  /** List a site's AI trace rows (LLM calls + tool runs), newest first */
  getAiLogs(siteId: string, limit = 200): Observable<{ data: AiLogRow[] }> {
    return this.get(`/sites/${siteId}/ai-logs`, { limit: limit.toString() });
  }

  /** The full app catalog (~68 self-hostable apps) — browsable, install-able */
  getAppCatalog(): Observable<{ apps: CatalogApp[]; count: number }> {
    return this.get(`/apps/catalog`);
  }

  /** List the org's installed app instances (note: response key is `instances`) */
  getAppInstances(): Observable<{ instances: AppInstance[] }> {
    return this.get(`/apps/instances`);
  }

  /** Self-documenting API-surface stats (endpoint counts + categories + recent) */
  getDocsStats(): Observable<{ data: DocsStats }> {
    return this.get(`/admin/docs/stats`);
  }

  /** The feature-flag registry (key · stage · defaults · owner), org-wide */
  getFeatureFlags(): Observable<{ flags: FeatureFlag[]; count: number }> {
    return this.get(`/feature-flags`);
  }

  /** List the org's API keys (session-scoped; prefixes only, never full secret) */
  getApiKeys(): Observable<{ data: ApiKey[] }> {
    return this.get(`/admin/api-keys`);
  }

  /** List the org's MCP connections across all sites (safe columns; no tokens) */
  getMcpConnections(): Observable<{ data: McpConnection[] }> {
    return this.get(`/mcp/connections`);
  }

  /** Org audit log rows (who did what), newest first */
  getAuditLogs(limit = 50): Observable<{ data: AuditLogRow[] }> {
    return this.get(`/audit-logs`, { limit: limit.toString() });
  }

  /** Open human-in-the-loop tasks the AI posted (the task tray / inbox) */
  getInboxTasks(opts?: { silent?: boolean }): Observable<{ tasks: InboxTask[] }> {
    return this.get(`/inbox/tasks`, undefined, opts);
  }

  /** Resolve an inbox task by choosing an option (or free-text choice) */
  resolveInboxTask(id: string, choice: string): Observable<{ ok: boolean }> {
    return this.post(`/inbox/tasks/${id}/resolve`, { choice });
  }

  /** List a site's provisioned voice numbers (note: response key is `numbers`) */
  getVoiceNumbers(siteId: string): Observable<{ numbers: VoiceNumber[] }> {
    return this.get(`/voice/numbers`, { siteId });
  }

  /** List a site's recent voice conversations — calls + SMS (key is `items`) */
  getVoiceConversations(siteId: string): Observable<{ items: VoiceConversation[] }> {
    return this.get(`/voice/conversations`, { siteId });
  }

  getSocialAccounts(): Observable<{ data: SocialAccount[] }> {
    return this.get(`/social/accounts`);
  }

  /** List the org's scheduled/published social posts, newest first */
  getSocialPosts(limit = 50): Observable<{ data: SocialPost[] }> {
    return this.get(`/social/posts`, { limit: limit.toString() });
  }

  /** Aggregated social engagement by platform (the social-analytics surface) */
  getSocialAnalytics(): Observable<{
    window_days: number;
    platform_totals: SocialPlatformTotals[];
  }> {
    return this.get(`/social/analytics/aggregate`);
  }

  getHostnames(siteId: string): Observable<{ data: Hostname[] }> {
    return this.get(`/sites/${siteId}/hostnames`);
  }

  addHostname(siteId: string, hostname: string): Observable<{ data: Hostname }> {
    return this.post(`/sites/${siteId}/hostnames`, { hostname });
  }

  setPrimaryHostname(siteId: string, hostnameId: string): Observable<void> {
    return this.put(`/sites/${siteId}/hostnames/${hostnameId}/primary`);
  }

  /** Revert the site to its permanent `{slug}.projectsites.dev` default subdomain. */
  resetPrimaryHostname(siteId: string): Observable<void> {
    return this.post(`/sites/${siteId}/hostnames/reset-primary`, {});
  }

  deleteHostname(siteId: string, hostnameId: string): Observable<void> {
    return this.delete(`/sites/${siteId}/hostnames/${hostnameId}`);
  }

  /** Deactivate (unsubscribe) hostname — keeps the row but stops serving traffic. */
  unsubscribeHostname(siteId: string, hostnameId: string): Observable<void> {
    return this.post(`/sites/${siteId}/hostnames/${hostnameId}/unsubscribe`, {});
  }

  /** Workers-AI-enriched domain search (RDAP availability + CF Registrar pricing + Llama 3.3 reasoning). */
  searchDomainsEnriched(
    query: string,
    business?: string,
  ): Observable<{ results: DomainSuggestion[] }> {
    const params: Record<string, string> = { q: query };
    if (business) params['business'] = business;
    return this.get('/domains/search-enrich', params);
  }

  /** Direct-register a domain via CF Registrar + bind to site as custom hostname. */
  registerDomain(
    domain: string,
    siteId: string,
  ): Observable<{
    data: { purchase_id: string; domain: string; hostname_id: string | null; ssl_status: string };
  }> {
    return this.post('/domains/register', { domain, site_id: siteId });
  }

  checkSlug(slug: string, excludeId?: string): Observable<{ data: { available: boolean } }> {
    const params: Record<string, string> = { slug };
    if (excludeId) params['exclude_id'] = excludeId;
    return this.get('/slug/check', params);
  }

  createCheckout(
    orgId: string,
    siteId: string,
    returnUrl: string,
    budgetTier?: BudgetTier,
  ): Observable<{ data: { client_secret: string } }> {
    const payload: {
      org_id: string;
      site_id: string;
      return_url: string;
      budget_tier?: BudgetTier;
    } = {
      org_id: orgId,
      site_id: siteId,
      return_url: returnUrl,
    };
    if (budgetTier && budgetTier !== 'free') payload.budget_tier = budgetTier;
    return this.post('/billing/embedded-checkout', payload);
  }

  getBillingPortal(returnUrl: string): Observable<{ data: { portal_url: string } }> {
    return this.post('/billing/portal', { return_url: returnUrl });
  }

  getSubscription(opts?: { silent?: boolean }): Observable<{ data: SubscriptionInfo }> {
    return this.get('/billing/subscription', undefined, opts);
  }

  getDomainSummary(opts?: { silent?: boolean }): Observable<{ data: DomainSummary }> {
    return this.get('/admin/domains/summary', undefined, opts);
  }

  searchAddress(query: string, lat?: number, lng?: number, opts?: { silent?: boolean }): Observable<{ data: AddressResult[]; _error?: SearchProviderError }> {
    const params: Record<string, string> = { q: query };
    if (lat != null) params['lat'] = lat.toString();
    if (lng != null) params['lng'] = lng.toString();
    // Typeahead: caller owns the inline "address lookup unavailable" nudge.
    return this.get('/search/address', params, opts);
  }

  validateBusiness(body: unknown): Observable<{ data: { valid: boolean; message?: string } }> {
    return this.post('/validate-business', body);
  }

  submitContact(body: {
    name: string;
    email: string;
    phone?: string;
    message: string;
  }): Observable<void> {
    return this.post('/contact', body);
  }

  /** Generate an expert prompt using OpenAI research pipeline */
  generatePrompt(body: {
    site_id?: string;
    business_name: string;
    business_address?: string;
    google_place_id?: string;
    additional_context?: string;
  }): Observable<{ data: { prompt: string; research: Record<string, unknown> } }> {
    return this.post('/sites/generate-prompt', body);
  }

  /** Improve / restructure rough notes via Workers AI (no auth required) */
  improvePrompt(body: {
    text: string;
    business_name?: string;
    business_address?: string;
  }): Observable<{ data: { improved_text: string } }> {
    return this.post('/sites/improve-prompt', body);
  }

  deploySite(siteId: string, formData: FormData): Observable<{ data: { message: string } }> {
    return this.postFormData(`/sites/${siteId}/deploy`, formData);
  }

  getWorkflow(siteId: string): Observable<{ data: WorkflowStatus }> {
    return this.get(`/sites/${siteId}/workflow`);
  }

  deleteSiteWithOptions(id: string, cancelSubscription: boolean): Observable<void> {
    return this.http
      .request<void>('DELETE', `/api/sites/${id}`, {
        headers: this.headers(),
        body: { cancel_subscription: cancelSubscription },
      })
      .pipe(this.handleError());
  }

  getEntitlements(): Observable<{ data: Entitlements }> {
    return this.get('/billing/entitlements');
  }

  /** AI-powered business categorization */
  categorize(
    name: string,
    address?: string,
    types?: string[],
  ): Observable<{ data: { category: string } }> {
    return this.post('/ai/categorize', { name, address, types });
  }

  /**
   * AI autofill — given a business name, infer every create-form field.
   *
   * Every field on the response is nullable. The model is instructed to
   * return `null` rather than hallucinate, so the caller MUST treat
   * `null` as "leave the form alone" — never as "clear the field".
   *
   * @see {@link AutofillResult}
   */
  autofillSite(
    name: string,
  ): Observable<{
    data: AutofillResult;
    meta?: { model: string; latency_ms: number; status: 'ok' | 'error' };
  }> {
    return this.post('/sites/autofill', { name });
  }

  /** AI image discovery — finds logo, favicon, and images via web search */
  discoverImages(
    name: string,
    address?: string,
    website?: string,
  ): Observable<{ data: DiscoveredImages }> {
    return this.post('/ai/discover-images', { name, address, website });
  }

  /** AI video discovery — finds relevant videos from YouTube, Pexels, Pixabay */
  discoverVideos(
    name: string,
    address?: string,
    businessType?: string,
  ): Observable<{ data: DiscoveredVideos }> {
    return this.post('/ai/discover-videos', { name, address, business_type: businessType });
  }

  /** AI image edit — generates new image from a text prompt */
  editImage(
    prompt: string,
    originalUrl?: string,
  ): Observable<{ data: { url: string; prompt: string } }> {
    return this.post('/ai/edit-image', { prompt, originalUrl });
  }

  /** Upload assets (logo, favicon, images) before site creation */
  uploadAssets(
    formData: FormData,
  ): Observable<{
    data: {
      upload_id: string;
      assets: { key: string; name: string; size: number; type: string; url: string }[];
    };
  }> {
    return this.postFormData('/assets/upload', formData);
  }

  /** Get build assets for a site (generated during workflow) */
  getBuildAssets(
    siteId: string,
  ): Observable<{
    data: { key: string; name: string; type: string; size: number; url: string }[];
  }> {
    return this.get(`/sites/${siteId}/build-assets`);
  }

  /**
   * Restore a site to a previous snapshot by re-pointing its live build version
   * to that snapshot's frozen build. Reversible — the prior version's R2 files
   * remain, so restoring again rolls forward/back freely.
   */
  revertSnapshot(
    siteId: string,
    snapshotId: string,
  ): Observable<{ data: { version: string; slug: string; snapshot_id: string } }> {
    // Restore-by-version (the snapshot_id the UI already holds → its build_version),
    // NOT the legacy git-commit_id revert path. See worker
    // services/snapshot_restore.ts + POST /snapshots/:snapshotId/restore.
    return this.post(`/sites/${siteId}/snapshots/${snapshotId}/restore`, {});
  }

  /** Publish files + chat from bolt.diy to a site */
  publishFromBolt(
    siteId: string,
    slug: string,
    files: { path: string; content: string }[],
    chat: { messages: unknown[]; description?: string; exportDate?: string },
  ): Observable<{ data: { slug: string; version: string; url: string } }> {
    return this.post(`/sites/${siteId}/publish-bolt`, { files, chat, slug });
  }

  /** Get GA4 analytics data for a site */
  getAnalytics(siteId: string, period = '7'): Observable<{ data: AnalyticsData }> {
    return this.get(`/analytics/${siteId}`, { period });
  }

  /**
   * Aggregated Cloudflare GraphQL analytics across every URL bound to a site.
   * Reads `site_urls` rows, fans out one CF query per URL, sums the result.
   * Cached server-side in KV for 5 minutes.
   */
  getMultiUrlAnalytics(
    siteId: string,
    range: AnalyticsRange = '7d',
    excludeHostnames: string[] = [],
  ): Observable<{ data: MultiUrlAnalyticsEnvelope }> {
    const params: Record<string, string> = { range };
    if (excludeHostnames.length > 0) params['exclude'] = excludeHostnames.join(',');
    // Silent: the analytics component owns an accurate inline error banner +
    // a cred-aware "Connect Cloudflare" panel + Retry. The generic network-blame
    // toast firing on top would be a misleading, redundant double-signal.
    // Path is `/multi-url-analytics`, NOT `/analytics` — the `site_analytics`
    // SUMMARY handler owns `/api/sites/:siteId/analytics` and shadowed this call,
    // so the panel was fed the bare summary shape (no `data`) → every KPI showed
    // 0 / "No traffic yet". Distinct path = each feature serves its own shape.
    return this.get(`/sites/${siteId}/multi-url-analytics`, params, { silent: true });
  }

  /**
   * Owner per-site analytics summary backed by the D1 `visitor_events` store —
   * the AUTHORITATIVE per-site pageview signal, recorded on every site-serve.
   * (The CF-zone per-host dataset behind {@link getMultiUrlAnalytics} is empty for
   * `*.projectsites.dev` subdomains, so it under-reports real traffic; this is the
   * source of truth the analytics panel falls back to.) Flag-gated `site_analytics`
   * (404 when off). Silent — the component renders its own inline empty/error state.
   */
  getSiteAnalytics(siteId: string, windowDays = 30): Observable<SiteAnalyticsSummary> {
    return this.get(`/sites/${siteId}/analytics`, { windowDays: windowDays.toString() }, { silent: true });
  }

  /**
   * Per-day pageview/session series from the `analytics_daily` rollup — feeds the
   * analytics chart when the CF-zone series is empty (subdomain sites). Flag-gated
   * `site_analytics` (404 when off); silent. Returns `{ days: [] }` on any miss.
   */
  getSiteAnalyticsDaily(
    siteId: string,
    days = 30,
  ): Observable<{ days: { day: string; pageviews: number; uniqueSessions: number; conversions: number }[] }> {
    return this.get(`/sites/${siteId}/analytics/daily`, { days: days.toString() }, { silent: true });
  }

  /** List the URLs (primary + alternates) bound to a site. */
  listSiteUrls(siteId: string): Observable<{ data: SiteUrlRow[] }> {
    // Silent: a failed URL list is explained inline by the analytics empty/cred
    // state; no generic toast needed (the component catchErrors to an empty list).
    return this.get(`/sites/${siteId}/urls`, undefined, { silent: true });
  }

  /** Bind an alternate URL to a site. Returns 409 on duplicate hostname. */
  addSiteUrl(
    siteId: string,
    hostname: string,
  ): Observable<{ data: { id: string; hostname: string; is_primary: number } }> {
    return this.post(`/sites/${siteId}/urls`, { hostname });
  }

  /** Unbind an alternate URL. The primary URL cannot be removed via this endpoint. */
  removeSiteUrl(
    siteId: string,
    urlId: string,
  ): Observable<{ data: { id: string; deleted: boolean } }> {
    return this.delete(`/sites/${siteId}/urls/${urlId}`);
  }

  /**
   * Status of the signed-in org's Cloudflare credentials.
   * Never returns the secret itself — only whether it's set + when validated.
   */
  getCloudflareCredentialStatus(): Observable<{ data: CloudflareCredentialStatus }> {
    return this.get('/admin/cloudflare-credentials');
  }

  listFormSubmissions(siteId: string, limit = 50): Observable<{ data: FormSubmission[] }> {
    return this.get(`/sites/${siteId}/forms`, { limit: limit.toString() });
  }

  listIntegrations(
    siteId: string,
    opts?: { silent?: boolean },
  ): Observable<{ data: NewsletterIntegration[] }> {
    return this.get(`/sites/${siteId}/integrations`, undefined, opts);
  }

  createIntegration(
    siteId: string,
    body: {
      provider: NewsletterProvider;
      api_key: string;
      list_id?: string;
      webhook_url?: string;
      config?: Record<string, unknown>;
    },
  ): Observable<{ data: NewsletterIntegration }> {
    return this.post(`/sites/${siteId}/integrations`, body);
  }

  /** Update an integration (toggle active, rotate key) */
  updateIntegration(
    siteId: string,
    id: string,
    body: Partial<NewsletterIntegration>,
  ): Observable<{ data: NewsletterIntegration }> {
    return this.patch(`/sites/${siteId}/integrations/${id}`, body);
  }

  deleteIntegration(siteId: string, id: string): Observable<void> {
    return this.delete(`/sites/${siteId}/integrations/${id}`);
  }

  getGithubBackupStatus(siteId: string): Observable<{ data: GithubBackupStatus }> {
    return this.get(`/sites/${siteId}/github/status`);
  }

  /** Start GitHub OAuth flow; returns redirect URL */
  startGithubOAuth(siteId: string, returnUrl: string): Observable<{ url: string }> {
    return this.get(`/sites/${siteId}/github/connect`, { return_url: returnUrl });
  }

  /** Trigger immediate backup commit (HEAD of main → snapshot commit) */
  triggerGithubBackup(
    siteId: string,
  ): Observable<{ data: { commit_sha: string; html_url: string } }> {
    return this.post(`/sites/${siteId}/github/backup`, {});
  }

  /** Disconnect GitHub integration (revokes stored OAuth token) */
  disconnectGithub(siteId: string): Observable<void> {
    return this.post(`/sites/${siteId}/github/disconnect`, {});
  }
}

export interface GithubBackupStatus {
  connected: boolean;
  repo?: string;
  owner?: string;
  html_url?: string;
  last_backup_at?: string;
  last_commit_sha?: string;
  commit_count?: number;
  github_user?: string;
  github_avatar_url?: string;
}

export type NewsletterProvider =
  | 'mailchimp'
  | 'webhook'
  | 'resend'
  | 'sendgrid'
  | 'convertkit'
  | 'klaviyo';

export interface NewsletterIntegration {
  id: string;
  site_id: string;
  provider: NewsletterProvider;
  list_id?: string;
  webhook_url?: string;
  active: boolean;
  config?: Record<string, unknown>;
  api_key_preview?: string;
  created_at: string;
  updated_at: string;
}

export interface FormSubmission {
  id: string;
  site_id: string;
  form_name: string;
  email?: string;
  payload: Record<string, unknown>;
  ip_address?: string;
  user_agent?: string;
  origin_url?: string;
  forwarded_to?: string[];
  created_at: string;
}

export interface BusinessResult {
  name: string;
  address: string;
  place_id: string;
  lat?: number;
  lng?: number;
  types?: string[];
  phone?: string;
  website?: string;
}

/**
 * Non-throwing provider-failure marker on a `200 { data: [] }` search response.
 * The worker emits it when the Google Places proxy is unusable so the client can
 * distinguish an honest 0-match result from "search is down — enter manually".
 * - `SEARCH_PROVIDER_NOT_CONFIGURED` — no `GOOGLE_PLACES_API_KEY` set
 * - `SEARCH_PROVIDER_UNAVAILABLE` — provider returned 403/error (e.g. billing off)
 */
export interface SearchProviderError {
  code: 'SEARCH_PROVIDER_NOT_CONFIGURED' | 'SEARCH_PROVIDER_UNAVAILABLE';
  status: number;
  message: string;
}

export interface PreBuiltSite {
  id: string;
  slug: string;
  business_name: string;
  business_address: string;
  status: string;
  place_id?: string;
}

export interface SiteLookup {
  id: string;
  slug: string;
  status: string;
}

export interface UserInfo {
  id: string;
  email: string;
  org_id: string;
  /** Org display name (from `/api/auth/me`) — labels org-scoped surfaces with the real org. */
  org_name?: string | null;
  /** True when the user is a platform super-admin (gates super-admin-only fetches). */
  is_super_admin?: boolean;
}

export interface Site {
  id: string;
  slug: string;
  business_name: string;
  business_address: string;
  status: string;
  plan?: string;
  current_build_version?: number;
  primary_hostname?: string;
  place_id?: string;
  business_phone?: string;
  business_website?: string;
  site_id?: string;
  created_at: string;
  updated_at: string;
}

/**
 * Budget tier selected at /create checkout — drives premium media gating
 * (Sora hero video, NotebookLM podcast, immersive infographics) and the
 * `max_generated_images` cap inside the site-generation orchestrator.
 *
 * Mirrors `budgetTierSchema` in `@project-sites/shared/schemas`.
 */
export type BudgetTier = 'free' | 'standard' | 'plus' | 'premium';

export interface CreateSitePayload {
  mode: 'business' | 'custom';
  additional_context?: string;
  business: {
    name: string;
    address: string;
    place_id?: string;
    phone?: string;
    website?: string;
    types?: string[];
    category?: string;
  };
  /**
   * Explicit visual personality the form chose for the selected category (one of
   * the 16 theme-style preset names). The worker prefers it over re-deriving the
   * theme from `additional_context` prose, so the deliberate elaborate theme
   * reliably lands (AL-467). Sent only for known dropdown categories.
   */
  theme_style?: string;
  budget_tier?: BudgetTier;
}

export interface ResetSitePayload {
  business: { name: string; address: string; place_id?: string };
  additional_context?: string;
  budget_tier?: BudgetTier;
}

export interface LogEntry {
  id: string;
  action: string;
  created_at: string;
  metadata_json?: string;
}

export interface Hostname {
  id: string;
  hostname: string;
  status: string;
  is_primary: boolean;
}

/** A provisioned voice phone number on a site. */
export interface VoiceNumber {
  id: string;
  site_id?: string | null;
  phone_number: string;
  friendly_name?: string | null;
  vanity_display?: string | null;
  capabilities?: string | null;
  monthly_cost_cents?: number | null;
  status?: string | null;
  created_at: string;
}

/** A voice conversation row (call or SMS) on a site. */
export interface VoiceConversation {
  id: string;
  kind: 'call' | 'sms' | string;
  direction?: string | null;
  from_number?: string | null;
  to_number?: string | null;
  status?: string | null;
  event_at?: string | null;
  duration_seconds?: number | null;
  sentiment?: string | null;
  summary?: string | null;
}

/** A human-in-the-loop task the AI posted (the inbox / task tray). */
export interface InboxTask {
  id: string;
  taskKind: string;
  prompt: string;
  options: string[];
  defaultChoice?: string | null;
  expiresAt: number;
  createdAt: number;
}

/** An org audit-log row (from `/audit-logs`). */
export interface AuditLogRow {
  id: string;
  action: string;
  message?: string | null;
  actor_id?: string | null;
  target_type?: string | null;
  created_at: string;
}

/** An MCP connection (from `/mcp/connections`) — safe columns, no tokens. */
export interface McpConnection {
  id: string;
  site_id: string;
  provider: string;
  display_name?: string | null;
  status: string;
  scopes: string[];
  token_expires_at?: string | null;
  connected_at: string;
  updated_at?: string | null;
}

/** An org API key (from `/admin/api-keys`) — prefix only, secret never returned. */
export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  active: boolean;
  last_used_at?: string | null;
  expires_at?: string | null;
  created_at: string;
  revoked_at?: string | null;
}

/** A feature-flag registry entry from `/feature-flags`. */
export interface FeatureFlag {
  key: string;
  description: string;
  default_enabled: boolean;
  default_rollout_percent: number;
  stage: 'experimental' | 'beta' | 'stable' | 'deprecated' | 'killswitch' | string;
  owner_email: string;
  has_docs?: boolean;
}

/** Self-documenting API-surface stats from `/admin/docs/stats`. */
export interface DocsEndpointRef {
  method: string;
  path: string;
  addedAt: string;
  category?: string;
}
export interface DocsStats {
  public: number;
  authed: number;
  rate_limited: number;
  recent: DocsEndpointRef[];
  category_counts: Record<string, number>;
  generated_at: string;
}

/** Per-platform engagement totals (from /social/analytics/aggregate). */
export interface SocialPlatformTotals {
  platform: string;
  posts: number;
  impressions: number;
  reach: number;
  engagement: number;
}

/** A connected social account (org-scoped). */
export interface SocialAccount {
  id: string;
  platform: string;
  handle?: string | null;
  display_name?: string | null;
  avatar_url?: string | null;
  status?: string | null;
  last_error?: string | null;
  token_expires_at?: string | null;
  created_at: string;
}

/** A scheduled or published social post (org-scoped). */
export interface SocialPost {
  id: string;
  status?: string | null;
  scheduled_at?: string | null;
  published_at?: string | null;
  content?: string | null;
  account_ids?: string | null;
  hashtags?: string | null;
  link?: string | null;
  site_id?: string | null;
  created_at: string;
}

/** A catalog app (one of ~68 self-hostable apps from /apps/catalog). */
export interface CatalogApp {
  id: string;
  name: string;
  tagline?: string | null;
  description?: string | null;
  category: string;
  supported?: boolean;
}

/** An installed app instance (org-scoped container app on *.app.projectsites.dev). */
export interface AppInstance {
  id: string;
  app_slug: string;
  subdomain: string;
  status: string;
  last_started_at?: string | null;
  last_error?: string | null;
  created_at: string;
  updated_at?: string | null;
}

/** One AI trace row from `ai_form_logs` (LLM call or tool run on a site). */
export interface AiLogRow {
  id: string;
  submission_id?: string | null;
  trace_kind?: string | null;
  endpoint_slug?: string | null;
  model?: string | null;
  status?: string | null;
  latency_ms?: number | null;
  tokens_input?: number | null;
  tokens_output?: number | null;
  credits_debited?: number | null;
  tool_name?: string | null;
  tool_status?: string | null;
  output_preview?: string | null;
  error_message?: string | null;
  created_at: string;
}

/** A tool the site's MCP server exposes to AI clients. */
export interface SiteMcpTool {
  id: string;
  tool_name: string;
  handler_kind?: string | null;
  requires_auth?: number | boolean | null;
  enabled?: number | boolean | null;
  updated_at?: string | null;
}

/** A call an AI client made against the site's MCP server. */
export interface SiteMcpCall {
  id: string;
  tool_name: string;
  called_at: string;
  agent_client_id?: string | null;
  result_status?: string | null;
  latency_ms?: number | null;
}

/** A site branch — a staged edit with approvals + a preview URL. */
export interface SiteBranch {
  id: string;
  branch_name: string;
  status: 'draft' | 'review' | 'merged' | 'closed' | string;
  preview_url?: string | null;
  approvals_required: number;
  approvals_received: number;
  created_at: string;
}

/** A frozen version of a site (auto on build, AI-named on edit). */
export interface Snapshot {
  id: string;
  snapshot_name: string;
  /** The build version this snapshot froze (the meaningful identifier the
   * legacy list showed). The `GET /sites/:id/snapshots` route returns exactly
   * id · snapshot_name · build_version · description · created_at. */
  build_version?: string | null;
  description?: string | null;
  created_at: string;
}

/** Workers-AI-enriched domain suggestion from /api/domains/search-enrich (RDAP-backed). */
export interface DomainSuggestion {
  domain: string;
  available: boolean;
  status: 'available' | 'taken' | 'unknown';
  reason: string;
  pitch: string;
  price_usd_yr: number | null;
  /** True when CF Registrar carries the TLD AND availability came back `available`. */
  can_register_inline: boolean;
  /** Porkbun checkout deeplink when CF doesn't carry the TLD. */
  fallback_url?: string;
}

export interface SubscriptionInfo {
  plan: string;
  status: string;
}

export interface DomainSummary {
  total: number;
  active: number;
  pending: number;
  failed: number;
}

export interface AddressResult {
  description: string;
  place_id?: string;
}

export interface WorkflowStatus {
  status: string;
  current_step?: string;
  steps_completed?: number;
  total_steps?: number;
}

export interface Entitlements {
  topBarHidden: boolean;
  maxCustomDomains: number;
  chatEnabled: boolean;
  analyticsEnabled: boolean;
}

export interface ImageQualityResult {
  quality_score: number;
  is_professional: boolean;
  is_safe: boolean;
  description: string;
  recommendation: 'use_as_is' | 'use_as_inspiration' | 'enhance' | 'reject';
  issues: string[];
}

export interface DiscoveredImage {
  url: string;
  name: string;
  type: 'logo' | 'favicon' | 'image';
  source: string;
  quality?: ImageQualityResult | null;
  dimensions?: { width: number; height: number } | null;
}

export interface BrandAssessment {
  brand_maturity: 'established' | 'developing' | 'minimal';
  website_quality_score: number;
  asset_strategy: string;
  has_professional_logo: boolean;
  has_quality_favicon: boolean;
  recommendation: string;
}

export interface DiscoveredImages {
  logo?: DiscoveredImage;
  favicon?: DiscoveredImage;
  images: DiscoveredImage[];
  brand_assessment?: BrandAssessment | null;
}

export interface DiscoveredVideo {
  url: string;
  embed_url: string;
  thumbnail: string;
  title: string;
  source: 'youtube' | 'pexels' | 'pixabay';
  duration_seconds: number;
  attribution: { author: string; license: string; source_url: string };
  relevance: 'business_specific' | 'category_generic';
}

export interface DiscoveredVideos {
  videos: DiscoveredVideo[];
  attribution: { author: string; license: string; source_url: string }[];
}

export interface AnalyticsStats {
  pageViews: number;
  uniqueVisitors: number;
  /**
   * Average session duration. Only GA4 supplies a real value; CF zone analytics
   * and the D1 audit-log fallback both surface `'—'` / `'0s'`.
   */
  avgSessionDuration: string;
  bounceRate: number;
  /** CF zone analytics adds total HTTP requests (page views + assets). */
  totalRequests?: number;
}

export interface AnalyticsChartPoint {
  date: string;
  views: number;
}

export interface AnalyticsTrafficSource {
  name: string;
  percent: number;
}

export interface AnalyticsTopPage {
  path: string;
  views: number;
}

export interface AnalyticsTopCountry {
  country: string;
  views: number;
}

/**
 * Per-site analytics envelope returned by `GET /api/analytics/:siteId`.
 *
 * The worker falls back through three sources:
 *  - `'ga4'` — Google Analytics Data API (requires `GA4_PROPERTY_ID` +
 *    `GA4_SERVICE_ACCOUNT_JSON`; ships bounceRate + avgSessionDuration).
 *  - `'cloudflare_zone_analytics'` — CF GraphQL (requires `CF_API_TOKEN` +
 *    `CF_ZONE_ID`; ships pageViews, uniqueVisitors, totalRequests, topPages,
 *    topCountries — but NOT bounceRate / avgSessionDuration).
 *  - `undefined` (D1 audit-log estimate) — last resort when neither GA4
 *    nor CF zone analytics is configured. All stats render as 0.
 */
export interface AnalyticsData {
  period: number;
  slug?: string;
  /** Which fallback path produced this payload. `undefined` = D1 estimate. */
  source?: 'ga4' | 'cloudflare_zone_analytics';
  ga4_connected: boolean;
  ga4_measurement_id?: string | null;
  gtm_container_id?: string | null;
  stats: AnalyticsStats;
  chartData: AnalyticsChartPoint[];
  trafficSources: AnalyticsTrafficSource[];
  topPages: AnalyticsTopPage[];
  topCountries?: AnalyticsTopCountry[];
}

/** Time-range buckets accepted by the multi-URL analytics endpoint. */
export type AnalyticsRange = '24h' | '7d' | '30d' | '90d';

/**
 * Aggregated Cloudflare GraphQL analytics envelope.
 * Returned by `GET /api/sites/:id/analytics`.
 */
export interface MultiUrlAnalyticsEnvelope {
  range_days: number;
  urls_included: { hostname: string; resolved_zone: boolean }[];
  pageviews: number;
  uniques: number;
  total_requests: number;
  series: { date: string; page_views: number; unique_visitors: number; requests: number }[];
  top_pages: { path: string; views: number }[];
  top_countries: { country: string; views: number }[];
  top_referrers: { referrer: string; views: number }[];
  /**
   * `true` when at least one URL contributed real CF data. `false` means the
   * UI should surface a "connect Cloudflare credentials" CTA.
   */
  any_real_data: boolean;
}

/**
 * Per-site traffic totals from the D1 `visitor_events` store (populated on every
 * site-serve). The `.traffic` block of {@link SiteAnalyticsSummary}.
 */
export interface SiteTrafficSummary {
  pageviews: number;
  uniqueSessions: number;
  conversions: number;
  /**
   * TRUE single-page-session bounce, computed by the Worker from D1
   * `visitor_events` session depth: integer 0–100 = % of sessions that saw
   * exactly one page; `null`/absent when there is no per-session data yet.
   * When present it is preferred over the edge `2 − pagesPerVisit` proxy.
   */
  bounceRatePercent?: number | null;
  topPaths: { path: string; count: number; uniques: number }[];
  byType: { type: string; count: number }[];
  byDevice: { label: string; count: number }[];
  byChannel: { label: string; count: number }[];
  byCountry: { label: string; count: number }[];
  previous: { pageviews: number; uniqueSessions: number; conversions: number };
  windowDays: number;
}

/**
 * Owner per-site analytics summary returned by `GET /api/sites/:id/analytics`
 * (the `site_analytics` feature). Only `.traffic` is consumed by the analytics
 * panel today; the other blocks (contacts/forms/newsletter/donations) are present
 * on the wire but unused here.
 */
export interface SiteAnalyticsSummary {
  siteId: string;
  windowDays: number;
  traffic: SiteTrafficSummary;
}

/** Row in `site_urls` — primary URL plus alternates. */
export interface SiteUrlRow {
  id: string;
  site_id: string;
  hostname: string;
  is_primary: number;
  zone_id: string | null;
  account_id: string | null;
  added_at: string;
}

/**
 * Per-org Cloudflare credential status. Never includes the API key itself —
 * only the email + whether the credential is configured + when it was last
 * validated successfully.
 */
export interface CloudflareCredentialStatus {
  has_credentials: boolean;
  source: 'org' | 'worker_global_key' | 'worker_token' | 'none';
  email: string | null;
  last_validated_at: string | null;
  last_validated_account_id: string | null;
}

/**
 * AI autofill inference result — every field nullable so the server can
 * decline rather than hallucinate. The frontend treats `null` as "leave
 * the field alone", never as "clear the field".
 */
export interface AutofillResult {
  name: string | null;
  description: string | null;
  category: string | null;
  primary_url: string | null;
  suggested_subdomains: string[] | null;
  brand_colors: string[] | null;
  tagline: string | null;
  target_audience: string | null;
  business_address: string | null;
  phone: string | null;
  additional_context: string | null;
}

/**
 * POST /api/sites/import-from-url request body. `business_name` and
 * `target_slug` are optional — the server falls back to the scraped page
 * title and a slugified business name respectively when omitted.
 */
export interface ImportFromUrlPayload {
  url: string;
  business_name?: string;
  target_slug?: string;
}

/**
 * One-click-import success envelope. `workflow_id` is null only on dev
 * environments where the `SITE_WORKFLOW` binding is absent — production
 * always returns a workflow id and the UI can route straight to
 * `/admin/waiting?id={site_id}`.
 */
export interface ImportFromUrlResult {
  site_id: string;
  slug: string;
  workflow_id: string | null;
  source_url_count: number;
  estimated_minutes: number;
  preview: {
    homepage_title: string | null;
    theme_color: string | null;
    by_source: Record<'sitemap' | 'robots' | 'wayback' | 'html_bfs', number>;
  };
}

/**
 * 30-day rolling cost-forecast envelope returned by
 * `GET /api/billing/cost-forecast?days=N`.
 *
 * @remarks
 * `breakdown` is zero-filled: every day in the requested window has an entry
 * even when no usage events fired that day. The Forecast card sparkline
 * relies on this shape so it can render a uniform x-axis without gaps.
 *
 * `days_until_cap_hit` is `null` either when the rolling rate is zero
 * (no projected ramp) OR when the cap is already exceeded — the UI renders
 * a "cap reached" badge in the latter case.
 */
export interface CostForecastV2 {
  projected_usd: number;
  current_period_usd: number;
  breakdown: Array<{ day: string; usd: number; calls: number }>;
  plan_cap_usd: number | null;
  percent_of_cap: number;
  days_until_cap_hit: number | null;
  rolling_daily_avg: number;
  period_start: string;
  period_end: string;
}
