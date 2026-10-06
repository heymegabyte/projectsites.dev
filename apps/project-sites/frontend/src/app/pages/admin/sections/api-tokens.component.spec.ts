import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { signal } from '@angular/core';
import { NEVER, of, throwError } from 'rxjs';
import { HttpClient } from '@angular/common/http';
import { AdminApiTokensComponent } from './api-tokens.component';
import { ToastService } from '../../../services/toast.service';
import { AdminStateService } from '../admin-state.service';
import { FeatureFlagService } from '../../../services/feature-flag.service';
import { capabilityIdSchema } from '../../../../../../../../packages/shared/src/ai-policy/capability';

/**
 * Covers the security-critical API-token CRUD (no prior spec):
 *  - loadTokens success / 503-flag-disabled (graceful, NOT an error) / other-error (toast)
 *  - createToken validation (empty name is a no-op — no POST) + success flow
 *  - toggleScope set semantics
 *  - revokeToken (destructive) guard: no target / in-flight → no DELETE; success clears + toasts
 * overrideComponent strips the TanStack-table template so the constructor effect doesn't
 * auto-fire; private loadTokens() is driven via bracket access.
 */
interface Stubs {
  c: AdminApiTokensComponent;
  http: { get: jasmine.Spy; post: jasmine.Spy; delete: jasmine.Spy };
  show: jasmine.Spy;
}

function make(
  over: {
    get?: jasmine.Spy;
    post?: jasmine.Spy;
    delete?: jasmine.Spy;
    orgId?: string;
    /** ai_api_keys flag resolution — omitted = the real service resolves false off the mocked HTTP. */
    aiFlagOn?: boolean;
    sites?: unknown[];
  } = {},
): Stubs {
  const http = {
    get: over.get ?? jasmine.createSpy('get').and.returnValue(of({ data: [] })),
    post: over.post ?? jasmine.createSpy('post').and.returnValue(of({ id: 't1', plaintext: 'sk_live_x' })),
    delete: over.delete ?? jasmine.createSpy('delete').and.returnValue(of({})),
  };
  const show = jasmine.createSpy('show');
  TestBed.configureTestingModule({
    imports: [AdminApiTokensComponent],
    providers: [
      { provide: HttpClient, useValue: http },
      { provide: ToastService, useValue: { show } },
      { provide: AdminStateService, useValue: { orgId: signal(over.orgId ?? 'org1'), sites: signal(over.sites ?? []) } },
      ...(over.aiFlagOn !== undefined
        ? [{ provide: FeatureFlagService, useValue: { isOn: () => of(over.aiFlagOn) } }]
        : []),
      provideRouter([]), // component now injects Router + ActivatedRoute for ?sort= sync
    ],
  });
  TestBed.overrideComponent(AdminApiTokensComponent, { set: { template: '<div></div>', imports: [] } });
  return { c: TestBed.createComponent(AdminApiTokensComponent).componentInstance, http, show };
}

describe('AdminApiTokensComponent (token CRUD)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('loadTokens success populates tokens and clears flagDisabled', () => {
    const { c } = make({ get: jasmine.createSpy('get').and.returnValue(of({ data: [{ id: 'a', name: 'CI' }] })) });
    (c as unknown as { loadTokens(): void }).loadTokens();
    expect(c.tokens().length).toBe(1);
    expect(c.loading()).toBe(false);
    expect(c.flagDisabled()).toBe(false);
  });

  it('a non-array data payload (stale-route fake-empty class) coerces to [] — TanStack never sees a non-array', () => {
    // Regression: `res.data ?? []` passed a non-array `data` straight through
    // and getCoreRowModel threw mid-render, blanking the section in the
    // feature-journey walk. Array.isArray is the contract, not truthiness.
    const { c } = make({
      get: jasmine.createSpy('get').and.returnValue(of({ data: { html: '<!doctype html>' } })),
    });
    (c as unknown as { loadTokens(): void }).loadTokens();
    expect(c.tokens()).toEqual([]);
    expect(c.loading()).toBe(false);
    expect(c.flagDisabled()).toBe(false);
  });

  it('a 503 marks the feature flag-disabled (graceful) — not an error toast', () => {
    const { c, show } = make({ get: jasmine.createSpy('get').and.returnValue(throwError(() => ({ status: 503 }))) });
    (c as unknown as { loadTokens(): void }).loadTokens();
    expect(c.flagDisabled()).toBe(true);
    expect(c.tokens().length).toBe(0);
    expect(show).not.toHaveBeenCalled();
  });

  it('a 404 marks the feature flag-disabled (worker 404s when public_api is off) — graceful, not an error toast', () => {
    // Regression: the worker gates `/api/v1-tokens` with 404 (feature-flag doctrine:
    // never 403). Detection previously only flipped `flagDisabled` on 503, so a flag-off
    // org saw a "Failed to load" toast + a dead create button (that also 404s) instead of
    // the graceful gate notice. Prod E2E: chaos-4 "flag-off org gets the graceful gate".
    const { c, show } = make({ get: jasmine.createSpy('get').and.returnValue(throwError(() => ({ status: 404 }))) });
    (c as unknown as { loadTokens(): void }).loadTokens();
    expect(c.flagDisabled()).toBe(true);
    expect(c.tokens().length).toBe(0);
    expect(show).not.toHaveBeenCalled();
  });

  it('a non-503 load error surfaces an error toast', () => {
    const { c, show } = make({ get: jasmine.createSpy('get').and.returnValue(throwError(() => ({ status: 500 }))) });
    (c as unknown as { loadTokens(): void }).loadTokens();
    expect(show).toHaveBeenCalledWith('Failed to load API tokens', 'error');
    expect(c.flagDisabled()).toBe(false);
  });

  it('skips the request entirely when orgId has not hydrated', () => {
    const { c, http } = make({ orgId: '' });
    (c as unknown as { loadTokens(): void }).loadTokens();
    expect(http.get).not.toHaveBeenCalled();
    expect(c.loading()).toBe(false);
  });

  it('createToken is a no-op when the name is blank (no POST)', () => {
    const { c, http } = make();
    c.newName = '   ';
    c.createToken();
    expect(http.post).not.toHaveBeenCalled();
    expect(c.creating()).toBe(false);
  });

  it('createToken posts, reveals the plaintext token, and closes the modal', () => {
    const { c, http } = make();
    c.openCreateModal();
    c.newName = 'Deploy bot';
    c.createToken();
    expect(http.post).toHaveBeenCalled();
    expect(c.createdToken()?.plaintext).toBe('sk_live_x');
    expect(c.createModalVisible).toBe(false);
  });

  // The native [min] only guards the picker — a typed/pasted PAST expiry would
  // mint a token born expired. expiryInvalid() blocks it (disables Create + a
  // no-op guard), while blank (never-expires) and a future date stay valid.
  it('expiryInvalid: blank = valid, future = valid, past = invalid', () => {
    const { c } = make();
    c.newExpiry = '';
    expect(c.expiryInvalid()).withContext('blank → never expires, valid').toBeFalse();
    c.newExpiry = new Date(Date.now() + 86_400_000).toISOString().slice(0, 16); // +1d, datetime-local
    expect(c.expiryInvalid()).withContext('future expiry valid').toBeFalse();
    c.newExpiry = new Date(Date.now() - 86_400_000).toISOString().slice(0, 16); // -1d
    expect(c.expiryInvalid()).withContext('past expiry invalid').toBeTrue();
  });

  it('createToken is a no-op when the expiry is in the past (never mints a born-expired token)', () => {
    const { c, http } = make();
    c.openCreateModal();
    c.newName = 'Deploy bot';
    c.newExpiry = new Date(Date.now() - 86_400_000).toISOString().slice(0, 16);
    c.createToken();
    expect(http.post).withContext('no POST for an already-expired token').not.toHaveBeenCalled();
    expect(c.creating()).toBe(false);
  });

  it('toggleScope adds then removes a scope', () => {
    const { c } = make();
    c.toggleScope('media:write');
    expect(c.selectedScopes().has('media:write')).toBe(true);
    c.toggleScope('media:write');
    expect(c.selectedScopes().has('media:write')).toBe(false);
  });

  it('revokeToken is guarded — no DELETE without a confirmed target', () => {
    const { c, http } = make();
    c.revokeTarget.set(null);
    c.revokeToken();
    expect(http.delete).not.toHaveBeenCalled();
  });

  it('revokeToken deletes the confirmed target, clears it, and toasts success', () => {
    const { c, http, show } = make();
    c.confirmRevoke({ id: 'tok-9', name: 'old-key' } as never);
    c.revokeToken();
    expect(http.delete).toHaveBeenCalled();
    expect(c.revokeTarget()).toBeNull();
    expect(show).toHaveBeenCalledWith('Token "old-key" revoked', 'success');
  });

  it('showTableSkeleton is true only while the first fetch is in flight with no tokens (no false-empty flash)', () => {
    const { c } = make();
    c.loading.set(true);
    c.tokens.set([]);
    expect(c.showTableSkeleton()).toBe(true);
    // Once tokens arrive, the skeleton yields to the table.
    c.tokens.set([{ id: 'a', name: 'CI' } as never]);
    expect(c.showTableSkeleton()).toBe(false);
    // A loaded-but-empty result shows the real empty state, not the skeleton.
    c.tokens.set([]);
    c.loading.set(false);
    expect(c.showTableSkeleton()).toBe(false);
  });
});

/**
 * The "active tokens" stat must not render a definitive "0" over the table
 * skeleton during the first load (premature-stat) — it shows a loading
 * placeholder until tokens resolve, then the rolling-counter.
 */
describe('AdminApiTokensComponent (no premature active-tokens count while loading)', () => {
  function render(): ComponentFixture<AdminApiTokensComponent> {
    TestBed.configureTestingModule({
      imports: [AdminApiTokensComponent],
      providers: [
        { provide: HttpClient, useValue: { get: () => of({ data: [] }), post: () => of({}), delete: () => of({}) } },
        { provide: ToastService, useValue: { show: () => 0 } },
        { provide: AdminStateService, useValue: { orgId: signal('org1') } },
        provideRouter([]),
      ],
    });
    return TestBed.createComponent(AdminApiTokensComponent);
  }
  afterEach(() => TestBed.resetTestingModule());

  it('shows a loading placeholder (not "0") on the active-tokens stat while the first fetch is in flight', () => {
    const fx = render();
    fx.detectChanges();
    fx.componentInstance.loading.set(true);
    fx.componentInstance.tokens.set([]);
    fx.detectChanges();
    const activeChip = (fx.nativeElement as HTMLElement).querySelector('.at-stat-chip');
    expect(activeChip?.querySelector('app-rolling-counter')).withContext('no definitive "0 active tokens" while loading').toBeNull();
    expect(activeChip?.querySelector('.at-stat-loading')).withContext('loading placeholder shown instead').not.toBeNull();
  });

  it('shows the active-tokens rolling-counter once the load resolves', () => {
    const fx = render();
    fx.componentInstance.loading.set(false);
    fx.componentInstance.tokens.set([{ id: 'a', name: 'CI' } as never]);
    fx.detectChanges();
    const activeChip = (fx.nativeElement as HTMLElement).querySelector('.at-stat-chip');
    expect(activeChip?.querySelector('app-rolling-counter')).withContext('real count once loaded').not.toBeNull();
  });

  // Pluralization: "1 active tokens" (rendered uppercase → "1 ACTIVE TOKENS") is a grammar
  // bug every one-token org sees. The stat noun must agree with tokens().length.
  const statLabel = (fx: ComponentFixture<AdminApiTokensComponent>) =>
    (fx.nativeElement as HTMLElement).querySelector('.at-stat-chip .at-stat-label')?.textContent?.replace(/\s+/g, ' ').trim();

  it('the active-tokens stat noun is SINGULAR at exactly 1 token', () => {
    const fx = render();
    fx.detectChanges(); // settle the constructor auto-load (get→data:[]) BEFORE seeding, else it clobbers
    fx.componentInstance.loading.set(false);
    fx.componentInstance.tokens.set([{ id: 'a', name: 'CI' } as never]);
    fx.detectChanges();
    expect(statLabel(fx)).withContext('1 token → "active token"').toBe('active token');
  });

  it('the active-tokens stat noun is PLURAL at 0 and at 2+ tokens', () => {
    const fx = render();
    fx.detectChanges(); // settle the auto-load first (orgId unchanged → the effect won't re-fire + re-clobber)
    fx.componentInstance.loading.set(false);
    fx.componentInstance.tokens.set([]);
    fx.detectChanges();
    expect(statLabel(fx)).withContext('0 tokens → "active tokens"').toBe('active tokens');
    fx.componentInstance.tokens.set([{ id: 'a', name: 'CI' }, { id: 'b', name: 'CD' }] as never);
    fx.detectChanges();
    expect(statLabel(fx)).withContext('2 tokens → "active tokens"').toBe('active tokens');
  });

  // The quick-start <pre> scrolls horizontally on narrow viewports (overflow-x:auto). axe
  // scrollable-region-focusable (serious, @390) fires unless it's keyboard-reachable.
  const withTokens = (): ComponentFixture<AdminApiTokensComponent> => {
    const fx = render();
    fx.detectChanges(); // settle auto-load first (detectChanges-first, else it clobbers)
    fx.componentInstance.loading.set(false);
    fx.componentInstance.tokens.set([{ id: 'a', name: 'CI' } as never]); // QUICK START renders only with ≥1 token
    fx.detectChanges();
    return fx;
  };

  it('the quick-start <pre> is keyboard-focusable (tabindex=0) — WCAG 2.1.1 scrollable-region-focusable', () => {
    const pre = (withTokens().nativeElement as HTMLElement).querySelector('pre.at-code');
    expect(pre).withContext('quick-start snippet renders with a token').not.toBeNull();
    expect(pre?.getAttribute('tabindex')).withContext('scrollable region must be keyboard-reachable').toBe('0');
  });

  it('the quick-start Copy button copies the rendered curl snippet to the clipboard', async () => {
    const fx = withTokens();
    const btn = (fx.nativeElement as HTMLElement).querySelector('[data-testid="at-qs-copy"]') as HTMLButtonElement | null;
    expect(btn).withContext('Copy button present in the quick-start header').not.toBeNull();
    const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    btn!.click();
    await Promise.resolve();
    expect(writeText).withContext('copies on click').toHaveBeenCalled();
    expect(writeText.calls.mostRecent().args[0] as string)
      .withContext('copied text is the actual rendered curl example (SSOT — no drifting duplicate)')
      .toContain('curl https://projectsites.dev/v1/sites');
  });
});

/**
 * TanStack sort coverage (previously untested) — this is the same
 * createAngularTable pattern the ag-grid→TanStack perf wave will replicate on
 * audit/ai-logs, so locking it here hardens that pattern too: the a11y/glyph
 * mappers are exact, and the table genuinely re-sorts its rows when the sorting
 * state changes.
 */
describe('AdminApiTokensComponent (TanStack table sort)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('ariaSort maps the TanStack direction → an aria-sort token', () => {
    const { c } = make();
    expect(c.ariaSort('asc')).toBe('ascending');
    expect(c.ariaSort('desc')).toBe('descending');
    expect(c.ariaSort(false)).toBe('none');
  });

  it('sortGlyph maps the direction → its header indicator', () => {
    const { c } = make();
    expect(c.sortGlyph('asc')).toBe('↑');
    expect(c.sortGlyph('desc')).toBe('↓');
    expect(c.sortGlyph(false)).toBe('↕');
  });

  it('the table re-sorts its rows when the sorting state changes (asc + desc)', () => {
    const { c } = make();
    c.tokens.set([{ id: '2', name: 'Bravo' }, { id: '1', name: 'Alpha' }] as never);
    const sorting = (c as unknown as { sorting: { set(v: { id: string; desc: boolean }[]): void } }).sorting;
    sorting.set([{ id: 'name', desc: false }]);
    expect(c.table.getRowModel().rows.map((r) => (r.original as { name: string }).name)).toEqual(['Alpha', 'Bravo']);
    sorting.set([{ id: 'name', desc: true }]);
    expect(c.table.getRowModel().rows.map((r) => (r.original as { name: string }).name)).toEqual(['Bravo', 'Alpha']);
  });
});

/**
 * WCAG 1.4.1: the flag-disabled banner's "Feature Flags" link is an in-text-block
 * link → must be underlined by default (color-only fails axe link-in-text-block,
 * serious). It lives in @if (flagDisabled()), so force that state + real render.
 */
import { provideRouter } from '@angular/router';
describe('AdminApiTokensComponent (flag-disabled banner link is underlined)', () => {
  afterEach(() => TestBed.resetTestingModule());
  it('the in-text Feature Flags link carries the underline affordance', async () => {
    TestBed.configureTestingModule({
      imports: [AdminApiTokensComponent],
      providers: [
        // `NEVER` for the auto-load `get`: the constructor effect fires loadTokens(), whose async
        // leg (ApiService's timeout over the mocked HttpClient) used to re-run AFTER whenStable()
        // settled — on some Jasmine random orderings it cleared/clobbered the forced flag post-render,
        // flaking this at `link === null` (band-aided across fire-80/fire-100; the real race remained).
        // A NEVER observable never emits or errors, so loadTokens NEVER writes flagDisabled: the spec's
        // explicit `set(true)` is the SOLE writer and the banner renders deterministically. Root-cause
        // isolation, not another settle-dance (CLAUDE.md §9). `post` still resolves for any mint path.
        { provide: HttpClient, useValue: { get: () => NEVER, post: () => of({}) } },
        { provide: ToastService, useValue: { show: () => 0 } },
        { provide: AdminStateService, useValue: { orgId: signal('org1') } },
        provideRouter([]),
      ],
    });
    const fx = TestBed.createComponent(AdminApiTokensComponent);
    fx.componentInstance.flagDisabled.set(true); // force the flag-disabled banner to render
    fx.detectChanges();
    const link = (fx.nativeElement as HTMLElement).querySelector('[data-testid="api-tokens-flag-gate"] a[routerLink="/admin/feature-flags"]') as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    // Shared <app-flag-gate-notice> underlines via `.flag-gate__link` CSS (not the Tailwind class).
    expect(getComputedStyle(link!).textDecorationLine).withContext('in-text link permanently underlined').toContain('underline');
  });

  it('the OpenAPI external link uses the canonical external-link icon (aria-hidden), not a bare ↗', () => {
    TestBed.configureTestingModule({
      imports: [AdminApiTokensComponent],
      providers: [
        { provide: HttpClient, useValue: { get: () => of({ data: [] }), post: () => of({}) } },
        { provide: ToastService, useValue: { show: () => 0 } },
        { provide: AdminStateService, useValue: { orgId: signal('org1') } },
        provideRouter([]),
      ],
    });
    const fx = TestBed.createComponent(AdminApiTokensComponent);
    fx.componentInstance.flagDisabled.set(false); // render the normal content (not the flag banner)
    fx.detectChanges();
    const link = (fx.nativeElement as HTMLElement).querySelector('a.at-openapi-link');
    expect(link).withContext('OpenAPI spec link renders').not.toBeNull();
    // was a bare unicode "↗" (announced "north east arrow") → now the canonical
    // external-link SVG (aria-hidden) matching the "Preview in new tab" button.
    expect(link!.querySelector('svg[aria-hidden="true"]'))
      .withContext('crisp external-link SVG, not a unicode arrow').not.toBeNull();
    expect(link!.textContent ?? '').withContext('no leftover ↗ glyph').not.toContain('↗');
  });
});

/**
 * AI API Keys (campaign lane-3, flag `ai_api_keys` — DARK in prod).
 *
 * The mint dialog gains an OPTIONAL "AI permissions" section that constructs the
 * POST /api/v1-tokens `grant` body in EXACTLY the server's GrantInputSchema shape
 * (a strict .pick() of the SHARED GrantRecordSchema): siteIds / connectionIds /
 * actionIds / modelIds / expiresAt (+ optional limits). The schema is .strict()
 * server-side, so NO extra keys may leak (protocol is a client-side SDK-surface
 * hint, never a payload field). Flag OFF → the mint body is byte-identical to the
 * pre-existing flow (no `grant` key at all — existing tokens never silently gain
 * AI access).
 */
describe('AdminApiTokensComponent (AI API keys — grant payload)', () => {
  afterEach(() => TestBed.resetTestingModule());

  const DAY = 86_400_000;

  it('flag OFF: the mint body carries NO grant key even if AI selections were made', () => {
    const { c, http } = make(); // real FeatureFlagService resolves false off the mocked HTTP
    c.openCreateModal();
    c.newName = 'CI bot';
    c.aiGrantEnabled.set(true);
    c.toggleAiCapability('workers_ai.text.generate');
    c.createToken();
    expect(http.post).toHaveBeenCalled();
    const body = http.post.calls.mostRecent().args[1] as Record<string, unknown>;
    expect('grant' in body).withContext('flag-off mint is byte-identical — no grant key').toBeFalse();
  });

  it('flag ON but AI section left disabled: no grant key (the section is opt-in)', () => {
    const { c, http } = make({ aiFlagOn: true });
    c.openCreateModal();
    c.newName = 'CI bot';
    c.createToken();
    const body = http.post.calls.mostRecent().args[1] as Record<string, unknown>;
    expect('grant' in body).toBeFalse();
  });

  it('flag ON + enabled: builds the grant in the EXACT GrantInputSchema shape from the selections', () => {
    const { c, http } = make({ aiFlagOn: true });
    c.openCreateModal();
    c.newName = 'AI key';
    c.aiGrantEnabled.set(true);
    c.toggleAiSite('s1');
    c.toggleAiCapability('workers_ai.text.generate');
    c.aiBudgetUsd = '12.5';
    c.createToken();
    expect(http.post).toHaveBeenCalled();
    const body = http.post.calls.mostRecent().args[1] as {
      grant: {
        siteIds: string[]; connectionIds: string[]; actionIds: string[];
        modelIds: string[]; expiresAt: string; limits?: { spendCents: number };
      };
    };
    expect(body.grant.siteIds).toEqual(['s1']);
    expect(body.grant.connectionIds).toEqual([]);
    expect(body.grant.actionIds).toEqual(['workers_ai.text.generate']);
    expect(body.grant.modelIds).toEqual([]);
    expect(body.grant.limits).withContext('USD → integer cents').toEqual({ spendCents: 1250 });
    // Strict-schema safety: EXACTLY the pickable keys — a stray `protocol` (or any
    // other extra key) would 400 the whole mint against the strict server schema.
    expect(Object.keys(body.grant).sort()).toEqual(
      ['actionIds', 'connectionIds', 'expiresAt', 'limits', 'modelIds', 'siteIds'],
    );
    // Grants are never perpetual: token has no expiry → grant defaults to ~90 days out.
    const exp = Date.parse(body.grant.expiresAt);
    expect(exp).withContext('expiresAt parses').not.toBeNaN();
    expect(exp).toBeGreaterThan(Date.now() + 89 * DAY);
    expect(exp).toBeLessThan(Date.now() + 91 * DAY);
  });

  it('a token expiry drives the grant expiry (same instant), and a blank budget omits limits', () => {
    const { c, http } = make({ aiFlagOn: true });
    c.openCreateModal();
    c.newName = 'AI key';
    c.newExpiry = new Date(Date.now() + 30 * DAY).toISOString().slice(0, 16);
    c.aiGrantEnabled.set(true);
    c.toggleAiCapability('projectsites.site.read');
    c.aiBudgetUsd = '';
    c.createToken();
    const body = http.post.calls.mostRecent().args[1] as { grant: { expiresAt: string; limits?: unknown } };
    expect(body.grant.expiresAt).toBe(new Date(c.newExpiry).toISOString());
    expect('limits' in body.grant).withContext('no budget → limits key omitted (schema default)').toBeFalse();
  });

  it('flag ON + enabled + ZERO capabilities selected: createToken is a no-op (never mint a doomed grant)', () => {
    const { c, http } = make({ aiFlagOn: true });
    c.openCreateModal();
    c.newName = 'AI key';
    c.aiGrantEnabled.set(true);
    expect(c.aiGrantBlocked()).toBeTrue();
    c.createToken();
    expect(http.post).not.toHaveBeenCalled();
    expect(c.creating()).toBe(false);
  });

  it('aiBudgetInvalid: blank = valid (no cap), positive = valid, zero/negative/garbage = invalid + blocks', () => {
    const { c } = make({ aiFlagOn: true });
    c.openCreateModal();
    c.aiGrantEnabled.set(true);
    c.toggleAiCapability('workers_ai.text.generate');
    c.aiBudgetUsd = '';
    expect(c.aiBudgetInvalid()).toBeFalse();
    c.aiBudgetUsd = '25';
    expect(c.aiBudgetInvalid()).toBeFalse();
    expect(c.aiGrantBlocked()).toBeFalse();
    c.aiBudgetUsd = '0';
    expect(c.aiBudgetInvalid()).toBeTrue();
    c.aiBudgetUsd = '-3';
    expect(c.aiBudgetInvalid()).toBeTrue();
    expect(c.aiGrantBlocked()).withContext('invalid budget blocks the mint').toBeTrue();
  });

  it('openCreateModal resets the AI draft (protocol both, nothing selected, no budget)', () => {
    const { c } = make({ aiFlagOn: true });
    c.openCreateModal();
    c.aiGrantEnabled.set(true);
    c.aiProtocol.set('anthropic');
    c.toggleAiSite('s1');
    c.toggleAiCapability('workers_ai.text.generate');
    c.aiBudgetUsd = '9';
    c.openCreateModal();
    expect(c.aiGrantEnabled()).toBeFalse();
    expect(c.aiProtocol()).toBe('both');
    expect(c.selectedAiSites().size).toBe(0);
    expect(c.selectedAiCapabilities().size).toBe(0);
    expect(String(c.aiBudgetUsd)).toBe('');
  });

  it('every offered capability id passes the SHARED ai-policy capabilityIdSchema, grouped read/write non-empty', () => {
    const { c } = make();
    expect(c.readAiCapabilities.length).toBeGreaterThan(0);
    expect(c.writeAiCapabilities.length).toBeGreaterThan(0);
    for (const cap of [...c.readAiCapabilities, ...c.writeAiCapabilities]) {
      expect(capabilityIdSchema.safeParse(cap.id).success)
        .withContext(`"${cap.id}" must be a valid provider.resource.action id`).toBeTrue();
    }
  });
});

/**
 * AI API Keys — rendered UI. Flag OFF must render NOTHING new (the existing token
 * UI is unchanged); flag ON reveals the opt-in AI permissions section inside the
 * mint dialog. List-row grant chips are SERVER-driven: they render exactly the
 * counts-only GrantSummary fields the list response carries (flag off ⇒ the server
 * never sends `grant` ⇒ no chip — no client flag check needed).
 */
describe('AdminApiTokensComponent (AI API keys — rendered UI)', () => {
  afterEach(() => TestBed.resetTestingModule());

  function render(opts: { aiFlagOn?: boolean; get?: () => unknown } = {}): ComponentFixture<AdminApiTokensComponent> {
    TestBed.configureTestingModule({
      imports: [AdminApiTokensComponent],
      providers: [
        {
          provide: HttpClient,
          useValue: { get: opts.get ?? (() => of({ data: [] })), post: () => of({}), delete: () => of({}) },
        },
        { provide: ToastService, useValue: { show: () => 0 } },
        {
          provide: AdminStateService,
          useValue: {
            orgId: signal('org1'),
            sites: signal([{ id: 's1', slug: 'one', business_name: 'Site One' }]),
          },
        },
        ...(opts.aiFlagOn !== undefined
          ? [{ provide: FeatureFlagService, useValue: { isOn: () => of(opts.aiFlagOn) } }]
          : []),
        provideRouter([]),
      ],
    });
    return TestBed.createComponent(AdminApiTokensComponent);
  }

  it('flag OFF: the mint dialog renders NO AI section (existing token UI unchanged)', () => {
    const fx = render({ aiFlagOn: false });
    fx.detectChanges();
    fx.componentInstance.openCreateModal();
    fx.detectChanges();
    const el = fx.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="at-name-input"]')).withContext('dialog itself renders').not.toBeNull();
    expect(el.querySelector('[data-testid="at-ai-section"]')).withContext('no new UI while dark').toBeNull();
  });

  it('flag ON: the dialog shows the opt-in AI section — protocol picker, sites, read/write capabilities, budget', () => {
    const fx = render({ aiFlagOn: true });
    fx.detectChanges();
    fx.componentInstance.openCreateModal();
    fx.detectChanges();
    const el = fx.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="at-ai-section"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="at-ai-enable"]')).withContext('opt-in toggle').not.toBeNull();
    // Collapsed until opted in — no doomed half-configured controls.
    expect(el.querySelector('[data-testid="at-ai-budget"]')).toBeNull();
    fx.componentInstance.aiGrantEnabled.set(true);
    fx.detectChanges();
    expect(el.querySelector('[data-testid="at-ai-protocol-openai"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="at-ai-protocol-anthropic"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="at-ai-protocol-both"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="at-ai-site-s1"]')).withContext('sites multi-select from admin state').not.toBeNull();
    expect(el.querySelector('[data-testid="at-ai-cap-workers_ai.text.generate"]')).withContext('capability checkbox').not.toBeNull();
    expect(el.querySelector('[data-testid="at-ai-budget"]')).withContext('budget input').not.toBeNull();
    const section = el.querySelector('[data-testid="at-ai-section"]') as HTMLElement;
    expect(section.textContent).withContext('read/write grouping headers').toContain('Read');
    expect(section.textContent).toContain('Write');
  });

  it('renders a compact grant chip from the server GrantSummary — and no chip on grantless rows', () => {
    const withGrant = {
      id: 'a', name: 'AI key', scopes: ['sites:read'], last_used_at: null, expires_at: null,
      created_at: '2026-01-01T00:00:00Z',
      grant: {
        siteCount: 2, connectionCount: 0, actionCount: 3, modelCount: 1,
        approvalPolicy: 'follow_capability', revision: 1, expiresAt: '2027-01-01T00:00:00Z',
      },
    };
    const plain = {
      id: 'b', name: 'CI', scopes: ['sites:read'], last_used_at: null, expires_at: null,
      created_at: '2026-01-01T00:00:00Z',
    };
    const fx = render({ get: () => of({ data: [withGrant, plain] }) });
    fx.detectChanges();
    const el = fx.nativeElement as HTMLElement;
    const chips = el.querySelectorAll('[data-testid="at-grant-chip"]');
    expect(chips.length).withContext('exactly the granted row carries a chip').toBe(1);
    const text = (chips[0].textContent ?? '').replace(/\s+/g, ' ');
    expect(text).toContain('2 sites');
    expect(text).toContain('3 capabilities');
    expect(text).toContain('1 model');
  });

  it('the reveal dialog names the SDK env var(s) for the chosen protocol when a grant was minted', () => {
    const fx = render({ aiFlagOn: true });
    fx.detectChanges();
    fx.componentInstance.aiProtocol.set('both');
    fx.componentInstance.createdToken.set({
      token: { id: 't1', name: 'AI key', scopes: ['sites:read'], last_used_at: null, expires_at: null, created_at: '2026-01-01T00:00:00Z' },
      plaintext: 'psk_once',
      warning: 'once',
      grant: {
        siteCount: 1, connectionCount: 0, actionCount: 1, modelCount: 0,
        approvalPolicy: 'follow_capability', revision: 1, expiresAt: '2027-01-01T00:00:00Z',
      },
    });
    fx.detectChanges();
    const hint = (fx.nativeElement as HTMLElement).querySelector('[data-testid="at-ai-env-hint"]');
    expect(hint).withContext('grant-minted reveal carries the SDK hint').not.toBeNull();
    expect(hint!.textContent).toContain('OPENAI_API_KEY');
    expect(hint!.textContent).toContain('ANTHROPIC_API_KEY');
  });

  it('a grantless mint reveal shows NO SDK env hint', () => {
    const fx = render({ aiFlagOn: true });
    fx.detectChanges();
    fx.componentInstance.createdToken.set({
      token: { id: 't1', name: 'CI', scopes: ['sites:read'], last_used_at: null, expires_at: null, created_at: '2026-01-01T00:00:00Z' },
      plaintext: 'psk_once',
      warning: 'once',
    });
    fx.detectChanges();
    expect((fx.nativeElement as HTMLElement).querySelector('[data-testid="at-ai-env-hint"]')).toBeNull();
  });
});
