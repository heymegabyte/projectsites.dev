import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { SiteMcpServerComponent } from './site-mcp-server.component';
import { ApiService } from '../../../services/api.service';
import { ToastService } from '../../../services/toast.service';
import { ConfirmService } from '../../../services/confirm.service';

/**
 * First coverage for the per-site MCP server (security-critical token CRUD — untested):
 *  - admin token/tool CRUD routes through ApiService (carries the auth bearer — the
 *    section used to use raw HttpClient with NO Authorization header → every call
 *    401'd → the section was non-functional. Regression-guarded below.)
 *  - loadTokens/loadTools error gating (sets *Error, not a silent empty)
 *  - mintToken reveals the raw token once + reloads
 *  - revokeToken optimistically drops the row + clears the in-flight marker
 *  - runPlayground rejects invalid JSON args before firing a request (input validation)
 *  - totalCallsToday sums only today's usage
 * overrideComponent strips the template so ngOnInit doesn't auto-fire; methods driven directly.
 * The admin /api/* calls use `api` (bearer + 401-handling); the public `/{slug}/mcp`
 * playground call stays on raw `http`.
 */
function make(over: { get?: jasmine.Spy; post?: jasmine.Spy; del?: jasmine.Spy; confirmResult?: boolean } = {}): {
  c: SiteMcpServerComponent;
  api: { get: jasmine.Spy; post: jasmine.Spy; delete: jasmine.Spy };
  http: { get: jasmine.Spy; post: jasmine.Spy; delete: jasmine.Spy };
  toast: { error: jasmine.Spy; success: jasmine.Spy };
  confirmSpy: jasmine.Spy;
} {
  const api = {
    get: over.get ?? jasmine.createSpy('apiGet').and.returnValue(of({ tokens: [], tools: [], usage: [] })),
    post: over.post ?? jasmine.createSpy('apiPost').and.returnValue(of({ id: 't1', token: 'mcp_raw_secret' })),
    delete: over.del ?? jasmine.createSpy('apiDelete').and.returnValue(of({})),
  };
  // raw HttpClient is used ONLY by the public-endpoint playground call now.
  const http = {
    get: jasmine.createSpy('httpGet').and.returnValue(of({})),
    post: jasmine.createSpy('httpPost').and.returnValue(of({ ok: true })),
    delete: jasmine.createSpy('httpDelete').and.returnValue(of({})),
  };
  const toast = { error: jasmine.createSpy('error'), success: jasmine.createSpy('success') };
  const confirmSpy = jasmine.createSpy('confirm').and.resolveTo(over.confirmResult ?? true);
  TestBed.configureTestingModule({
    imports: [SiteMcpServerComponent],
    providers: [
      { provide: ApiService, useValue: api },
      { provide: HttpClient, useValue: http },
      { provide: ToastService, useValue: toast },
      { provide: ConfirmService, useValue: { confirm: confirmSpy } },
      { provide: ActivatedRoute, useValue: { snapshot: { params: { id: 's1' } }, parent: { snapshot: { params: { id: 's1' } } } } },
    ],
  });
  TestBed.overrideComponent(SiteMcpServerComponent, { set: { template: '<div></div>', imports: [] } });
  return { c: TestBed.createComponent(SiteMcpServerComponent).componentInstance, api, http, toast, confirmSpy };
}

/**
 * Full-render guard for the header "calls today" pill (lying-UI / premature-stat
 * class): the stats grid already shows "—" when the tools feed fails, but the
 * prominent header pill rendered totalCallsToday() raw → a confident "0 calls
 * today" next to a "Couldn't load tools" card. The pill must mirror the grid:
 * "…" while loading, "—" when unknown, the real rolling count only once loaded.
 */
describe('SiteMcpServerComponent (header calls-today pill — no false "0")', () => {
  afterEach(() => TestBed.resetTestingModule());

  function renderFull(): import('@angular/core/testing').ComponentFixture<SiteMcpServerComponent> {
    TestBed.configureTestingModule({
      imports: [SiteMcpServerComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: { get: () => of({ tokens: [], tools: [], usage: [] }), post: () => of({}), delete: () => of({}) } },
        { provide: HttpClient, useValue: { get: () => of({}), post: () => of({}), delete: () => of({}) } },
        { provide: ToastService, useValue: { error: () => 0, success: () => 0 } },
        { provide: ConfirmService, useValue: { confirm: () => Promise.resolve(true) } },
        { provide: ActivatedRoute, useValue: { snapshot: { params: { id: 's1' } }, parent: { snapshot: { params: { id: 's1' } } } } },
      ],
    });
    return TestBed.createComponent(SiteMcpServerComponent);
  }

  it('shows "—" (not a false "0 calls today") when the tools feed failed', () => {
    const f = renderFull();
    f.detectChanges(); // ngOnInit fires the (mock-success) loads first
    f.componentInstance.toolsLoading.set(false); // then simulate the failed-feed state
    f.componentInstance.toolsError.set('The MCP tool registry did not respond.');
    f.componentInstance.tools.set([]);
    f.detectChanges();
    const pill = (f.nativeElement as HTMLElement).querySelector('.header-pill') as HTMLElement;
    expect(pill).withContext('header pill renders').not.toBeNull();
    expect(pill.textContent ?? '').withContext('unknown → em dash, not a fabricated count').toContain('—');
    expect(pill.textContent ?? '').withContext('must NOT claim a definitive 0').not.toContain('0 calls today');
    expect(pill.querySelector('app-rolling-counter')).withContext('no rolling count when the value is unknown').toBeNull();
  });

  it('shows the real rolling count once loaded (no error, not loading)', () => {
    const f = renderFull();
    f.detectChanges();
    f.componentInstance.toolsLoading.set(false);
    f.componentInstance.toolsError.set(null);
    f.componentInstance.tools.set([{ name: 'read', description: 'd' } as never]);
    f.detectChanges();
    const pill = (f.nativeElement as HTMLElement).querySelector('.header-pill') as HTMLElement;
    expect(pill.querySelector('app-rolling-counter')).withContext('loaded → the real rolling counter').not.toBeNull();
    expect(pill.textContent ?? '').not.toContain('—');
  });

  // a11y: the mint button reflects its in-flight state to assistive tech via
  // aria-busy (the disabled + "Generating…" label is visual; aria-busy is the
  // programmatic signal SR users get). Mirrors feature-flags.component.ts.
  it('mint-token button exposes aria-busy="true" while minting', () => {
    const f = renderFull();
    f.detectChanges();
    const btn = (f.nativeElement as HTMLElement).querySelector('[data-testid="mint-token-btn"]') as HTMLElement;
    expect(btn).withContext('mint button renders').not.toBeNull();
    expect(btn.getAttribute('aria-busy')).withContext('idle → not busy').toBe('false');
    f.componentInstance.minting.set(true);
    f.detectChanges();
    expect(btn.getAttribute('aria-busy')).withContext('minting → busy').toBe('true');
  });

  // Empty-state-is-launchpad: zero tokens must offer a real primary CTA (not a
  // bare "No tokens yet." dead-end), and clicking it focuses the mint-label input
  // so the owner's next step is obvious.
  it('tokens empty state renders a launchpad CTA that focuses the mint input', () => {
    const f = renderFull();
    f.detectChanges(); // mock get → tokens: [] → empty state
    const host = f.nativeElement as HTMLElement;
    const cta = host.querySelector('[data-testid="mcp-tokens-empty-cta"]') as HTMLButtonElement | null;
    expect(cta).withContext('tokens empty-state CTA must render').not.toBeNull();
    expect(cta!.textContent).toContain('Mint your first token');
    const input = host.querySelector('[data-testid="new-token-label"]') as HTMLInputElement;
    expect(input).withContext('mint-label input renders').not.toBeNull();
    cta!.click();
    expect(document.activeElement).withContext('CTA focuses the mint-label input').toBe(input);
  });
});

describe('SiteMcpServerComponent (MCP token CRUD + playground)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('admin token CRUD routes through ApiService (auth bearer), NEVER raw HttpClient (the 401 bug)', () => {
    const { c, api, http } = make();
    c.ngOnInit(); // resolves siteId + fires loadTokens/loadTools/loadUsage
    // The 5 admin /api calls go through ApiService (which injects the bearer +
    // 401-handling) at the de-/api-prefixed path. Raw http must NOT be used for them.
    expect(api.get).toHaveBeenCalledWith('/sites/s1/mcp/tokens', undefined, { silent: true });
    expect(api.get).toHaveBeenCalledWith('/sites/s1/mcp/tools', undefined, { silent: true });
    expect(http.get).not.toHaveBeenCalled(); // was the bug: raw http.get → no Authorization → 401
  });

  it('loadTokens success populates tokens and clears error', () => {
    const c = make({ get: jasmine.createSpy('get').and.returnValue(of({ tokens: [{ id: 'a' }] })) }).c;
    c.loadTokens();
    expect(c.tokens().length).toBe(1);
    expect(c.tokensError()).toBeNull();
    expect(c.tokensLoading()).toBe(false);
  });

  it('loadTokens failure sets tokensError (not a silent empty list)', () => {
    const c = make({ get: jasmine.createSpy('get').and.returnValue(throwError(() => ({ status: 500 }))) }).c;
    c.loadTokens();
    expect(c.tokensError()).toContain('did not respond');
    expect(c.tokensLoading()).toBe(false);
  });

  it('loadTools failure sets toolsError', () => {
    const c = make({ get: jasmine.createSpy('get').and.returnValue(throwError(() => ({ status: 500 }))) }).c;
    c.loadTools();
    expect(c.toolsError()).toContain('did not respond');
    expect(c.toolsLoading()).toBe(false);
  });

  // Both load-error cards carry a copyable worker request_id (the catchError
  // previously discarded the err → no support reference).
  it('loadTokens captures the request_id for the error card', () => {
    const c = make({ get: jasmine.createSpy('get').and.returnValue(throwError(() => ({ status: 500, error: { error: { request_id: 'req-tok-1' } } }))) }).c;
    c.loadTokens();
    expect(c.tokensError()).not.toBeNull();
    expect(c.tokensErrorRef()).withContext('tokens support reference captured').toBe('req-tok-1');
  });

  it('loadTools captures the request_id for the error card', () => {
    const c = make({ get: jasmine.createSpy('get').and.returnValue(throwError(() => ({ status: 500, error: { error: { request_id: 'req-tool-1' } } }))) }).c;
    c.loadTools();
    expect(c.toolsError()).not.toBeNull();
    expect(c.toolsErrorRef()).withContext('tools support reference captured').toBe('req-tool-1');
  });

  // ── Stale-route fake-empty class (parseable-but-shapeless 200) ──────────────
  // ApiService's 2xx→404 remap only fires on an UNPARSEABLE body. A parseable
  // shapeless 200 (SPA/marketing HTML routed to the SPA, or `{}`) flows STRAIGHT
  // through the success branch. Without an Array.isArray guard, `res.tokens` /
  // `res.tools` / `res.usage` are `undefined` → set() with undefined →
  // `tokens().length` / `@for` / `totalCallsToday()`'s reduce crash or fake-empty.
  // The handled ERROR branch does NOT cover this — it's a 200, not a throw.
  it('loadTokens on a shapeless 200 ({}) stays an array + sets tokensError (no fake-empty / crash)', () => {
    const c = make({ get: jasmine.createSpy('get').and.returnValue(of({})) }).c;
    c.loadTokens();
    expect(Array.isArray(c.tokens())).withContext('tokens stays an array').toBe(true);
    expect(c.tokens().length).toBe(0);
    expect(c.tokensError()).withContext('shapeless 200 is surfaced as an error, not a confident empty').toContain('did not respond');
    expect(c.tokensLoading()).toBe(false);
  });

  it('loadTools on a shapeless 200 ({}) stays an array + sets toolsError', () => {
    const c = make({ get: jasmine.createSpy('get').and.returnValue(of({})) }).c;
    c.loadTools();
    expect(Array.isArray(c.tools())).withContext('tools stays an array').toBe(true);
    expect(c.tools().length).toBe(0);
    expect(c.toolsError()).toContain('did not respond');
    expect(c.toolsLoading()).toBe(false);
  });

  it('loadUsage on a shapeless 200 ({}) keeps usage an array so totalCallsToday()’s reduce never crashes', () => {
    const c = make({ get: jasmine.createSpy('get').and.returnValue(of({})) }).c;
    c.ngOnInit(); // loadUsage is private — fired via ngOnInit (siteId resolves to 's1')
    expect(Array.isArray(c.usage())).withContext('usage stays an array even on a shapeless 200').toBe(true);
    expect(() => c.totalCallsToday()).withContext('reduce over a guarded array never throws').not.toThrow();
    expect(c.totalCallsToday()).toBe(0);
  });

  it('mintToken reveals the raw token once and clears the minting flag', () => {
    const c = make().c;
    c.mintToken();
    expect(c.newTokenRaw()).toBe('mcp_raw_secret');
    expect(c.minting()).toBe(false);
  });

  it('mintToken posts the user-entered label (trimmed) so revoke rows are distinguishable', () => {
    const { c, api } = make();
    c.ngOnInit(); // resolves siteId='s1' from the route (fires get only; post stays clean)
    c.newTokenLabel = '  Cursor laptop  ';
    c.mintToken();
    expect(api.post).toHaveBeenCalledWith('/sites/s1/mcp/tokens', { label: 'Cursor laptop' }, { silent: true });
    expect(c.newTokenLabel).toBe(''); // input clears after mint
  });

  it('mintToken falls back to a unique auto-label when the field is blank (never another "Default")', () => {
    const { c, api } = make();
    c.ngOnInit();
    c.tokens.set([{ id: 'a' } as never, { id: 'b' } as never]); // 2 existing
    c.newTokenLabel = '   ';
    c.mintToken();
    expect(api.post).toHaveBeenCalledWith('/sites/s1/mcp/tokens', { label: 'Token 3' }, { silent: true });
  });

  it('revokeToken (after confirm) optimistically removes the row and clears the in-flight marker', async () => {
    const { c, confirmSpy } = make();
    c.tokens.set([{ id: 'keep' } as never, { id: 'gone' } as never]);
    await c.revokeToken('gone');
    expect(confirmSpy).toHaveBeenCalled(); // destructive token revoke is confirmed first
    expect(c.tokens().map((t) => t.id)).toEqual(['keep']);
    expect(c.revoking()).toBeNull();
  });

  it('revokeToken does NOT delete when the confirm is cancelled', async () => {
    const { c, api, confirmSpy } = make({ confirmResult: false });
    c.tokens.set([{ id: 'keep' } as never, { id: 'gone' } as never]);
    await c.revokeToken('gone');
    expect(confirmSpy).toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();
    expect(c.tokens().map((t) => t.id)).toEqual(['keep', 'gone']); // nothing removed
  });

  it('runPlayground rejects invalid JSON arguments before firing a request', async () => {
    const { c, http, toast } = make();
    c.openPlayground({ name: 'echo' } as never);
    c.playgroundArgs = '{ not json';
    await c.runPlayground();
    expect(toast.error).toHaveBeenCalledWith('Invalid JSON arguments');
    expect(http.post).not.toHaveBeenCalled();
    expect(c.playgroundRunning()).toBe(false);
  });

  it('runPlayground confirms before running a mutating CRUD tool (verify destructive actions)', async () => {
    const { c, http, confirmSpy } = make();
    c.ngOnInit();
    c.openPlayground({ name: 'delete_page' } as never);
    c.playgroundArgs = '{"slug":"home"}';
    await c.runPlayground();
    expect(confirmSpy).toHaveBeenCalled(); // destructive write is gated
    expect(http.post).toHaveBeenCalled(); // confirmed → fires
  });

  it('runPlayground does NOT fire a mutating tool when the confirm is cancelled', async () => {
    const { c, http, confirmSpy } = make({ confirmResult: false });
    c.ngOnInit();
    c.openPlayground({ name: 'update_content' } as never);
    c.playgroundArgs = '{}';
    await c.runPlayground();
    expect(confirmSpy).toHaveBeenCalled();
    expect(http.post).not.toHaveBeenCalled();
    expect(c.playgroundRunning()).toBe(false);
  });

  it('runPlayground runs a read-only tool with NO confirm prompt', async () => {
    const { c, http, confirmSpy } = make();
    c.ngOnInit();
    c.openPlayground({ name: 'get_page' } as never);
    c.playgroundArgs = '{}';
    await c.runPlayground();
    expect(confirmSpy).not.toHaveBeenCalled(); // read tools run straight through
    expect(http.post).toHaveBeenCalled();
  });

  it('totalCallsToday sums only today’s usage rows', () => {
    const c = make().c;
    const today = new Date().toISOString().slice(0, 10);
    c.usage.set([
      { day: today, call_count: 3 } as never,
      { day: today, call_count: 4 } as never,
      { day: '2000-01-01', call_count: 99 } as never,
    ]);
    expect(c.totalCallsToday()).toBe(7);
  });
});

/**
 * Empty-state parity: the "Available Tools" list mirrored the "API Tokens"
 * error/loading branches but was MISSING the `tools().length === 0` empty
 * branch — so a genuinely-empty (loaded, no error) tools feed rendered a blank
 * card with no explanation. It must show the cockpit cyan mini-empty, matching
 * the "No tokens yet." treatment right above it.
 */
describe('SiteMcpServerComponent (Available Tools empty-state parity)', () => {
  afterEach(() => TestBed.resetTestingModule());

  function renderFull(): import('@angular/core/testing').ComponentFixture<SiteMcpServerComponent> {
    TestBed.configureTestingModule({
      imports: [SiteMcpServerComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: { get: () => of({ tokens: [], tools: [], usage: [] }), post: () => of({}), delete: () => of({}) } },
        { provide: HttpClient, useValue: { get: () => of({}), post: () => of({}), delete: () => of({}) } },
        { provide: ToastService, useValue: { error: () => 0, success: () => 0 } },
        { provide: ConfirmService, useValue: { confirm: () => Promise.resolve(true) } },
        { provide: ActivatedRoute, useValue: { snapshot: { params: { id: 's1' } }, parent: { snapshot: { params: { id: 's1' } } } } },
      ],
    });
    return TestBed.createComponent(SiteMcpServerComponent);
  }

  it('renders a cyan mini-empty (not a blank card) when the tools feed is genuinely empty', () => {
    const f = renderFull();
    f.detectChanges();
    f.componentInstance.toolsLoading.set(false);
    f.componentInstance.toolsError.set(null);
    f.componentInstance.tools.set([]);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    const empty = el.querySelector('[data-testid="mcp-tools-empty"]');
    expect(empty).withContext('empty Available Tools shows a mini-empty, not a blank card').not.toBeNull();
    expect(empty!.querySelector('svg')).withContext('cockpit cyan empty-state glyph present').not.toBeNull();
    expect(el.querySelector('[data-testid^="tool-row-"]')).withContext('no tool rows when empty').toBeNull();
  });

  it('renders tool rows (no empty-state) when the tools feed has items', () => {
    const f = renderFull();
    f.detectChanges();
    f.componentInstance.toolsLoading.set(false);
    f.componentInstance.toolsError.set(null);
    f.componentInstance.tools.set([{ name: 'read_page', description: 'd' } as never]);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="mcp-tools-empty"]')).withContext('no empty-state when tools exist').toBeNull();
    expect(el.querySelector('[data-testid="tool-row-read_page"]')).withContext('tool row rendered').not.toBeNull();
  });
});
