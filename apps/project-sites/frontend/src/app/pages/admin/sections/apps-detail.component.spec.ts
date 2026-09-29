import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of, throwError } from 'rxjs';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { AppDetailComponent } from './apps-detail.component';
import { ApiService } from '../../../services/api.service';
import { ToastService } from '../../../services/toast.service';
import { ConfirmService } from '../../../services/confirm.service';
import { AdminStateService } from '../admin-state.service';
import { APPS_CATALOG } from './apps-catalog.data';

/** Real Umami catalog entry — deploy() reads `a.infra`, so tests must pass a full
 *  CatalogApp, never a `{id,name}` stub (would crash on `a.infra.length`). */
const UMAMI = APPS_CATALOG.find((a) => a.id === 'umami')!;

/**
 * First coverage for the app-deploy detail (subdomain input validation — untested):
 *  - subdomainError messages (required / min / max / charset / dash edges) + untouched=null
 *  - canDeploy gate mirrors the validity rules
 *  - deploy() is guarded (invalid subdomain → no POST) and on success navigates to the instance
 * overrideComponent strips the template; validation is driven via the public onSubdomainChange.
 */
function make(
  post = jasmine.createSpy('post').and.returnValue(of({ instance_id: 'inst-1' })),
  appId = '',
  confirmResult = true,
): {
  c: AppDetailComponent;
  nav: jasmine.Spy;
  post: jasmine.Spy;
  toast: { success: jasmine.Spy; error: jasmine.Spy };
  confirm: { confirm: jasmine.Spy };
} {
  const nav = jasmine.createSpy('navigate');
  const toast = { success: jasmine.createSpy('success'), error: jasmine.createSpy('error') };
  // A4 — deploy() awaits this confirm gate before provisioning billable infra.
  const confirm = {
    confirm: jasmine.createSpy('confirm').and.returnValue(Promise.resolve(confirmResult)),
  };
  TestBed.configureTestingModule({
    imports: [AppDetailComponent],
    providers: [
      { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap(appId ? { id: appId } : {})) } },
      { provide: Router, useValue: { navigate: nav } },
      // `get` stub — when an appId is loaded, ngOnInit → checkAndSetSubdomain hits
      // `/apps/slug-check` (added by the pricing commit). Without it the whole
      // suite errored on `api.get is not a function`.
      { provide: ApiService, useValue: { post, get: () => of({ available: true, valid: true, suggestion: 'auto-sub' }) } },
      { provide: ToastService, useValue: toast },
      { provide: ConfirmService, useValue: confirm },
      { provide: AdminStateService, useValue: { selectedSite: signal({ id: 's1', slug: 'demo' }) } },
    ],
  });
  TestBed.overrideComponent(AppDetailComponent, { set: { template: '<div></div>', imports: [] } });
  return { c: TestBed.createComponent(AppDetailComponent).componentInstance, nav, post, toast, confirm };
}

/**
 * Set a valid, available subdomain synchronously — mirrors the state AFTER the
 * debounced `/apps/slug-check` round-trip resolves. `onSubdomainChange` alone
 * only starts a 350ms timer + goes NEUTRAL (valid/available → null), which
 * Jasmine never advances, so a deploy-guard test must drive the resolved
 * signals directly (the pricing commit added `subdomainAvailable` to the
 * `readyToDeploy` gate).
 */
function setValidSubdomain(c: AppDetailComponent, v = 'my-cool-app'): void {
  c.subdomain = v;
  c.onSubdomainChange(v);
  c.subdomainValid.set(true);
  c.subdomainAvailable.set(true);
}

describe('AppDetailComponent (subdomain validation + deploy guard)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('subdomainError is null until the field is touched', () => {
    const { c } = make();
    expect(c.subdomainError()).toBeNull();
  });

  it('rejects too-short, over-long, bad-charset, and dash-edge subdomains', () => {
    const { c } = make();
    c.onSubdomainChange('ab');
    expect(c.subdomainError()).toBe('Min 3 characters.');
    c.onSubdomainChange('a'.repeat(41));
    expect(c.subdomainError()).toBe('Max 40 characters.');
    c.onSubdomainChange('My_App');
    expect(c.subdomainError()).toBe('Lowercase letters, digits, and dashes only.');
    c.onSubdomainChange('-lead');
    expect(c.subdomainError()).toBe('Cannot start or end with a dash.');
    c.onSubdomainChange('');
    expect(c.subdomainError()).toBe('Subdomain is required.');
  });

  it('accepts a valid subdomain (no error, canDeploy true)', () => {
    const { c } = make();
    c.onSubdomainChange('my-cool-app');
    expect(c.subdomainError()).toBeNull();
    expect(c.canDeploy()).toBe(true);
  });

  it('deploy() is a no-op when the subdomain is invalid (no POST)', () => {
    const { c, post } = make();
    c.onSubdomainChange('x'); // invalid
    c.subdomain = 'x';
    c.deploy({ id: 'medusa', name: 'Medusa' } as never);
    expect(post).not.toHaveBeenCalled();
  });

  it('deploy() posts and routes to the new instance on success (after confirm)', async () => {
    const { c, post, nav, toast, confirm } = make();
    setValidSubdomain(c);
    await c.deploy(UMAMI); // supported (Live) app — full catalog entry (deploy reads a.infra)
    expect(confirm.confirm).toHaveBeenCalled();
    expect(post).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalled();
    expect(nav).toHaveBeenCalledWith(['/admin/apps/instances', 'inst-1']);
    expect(c.deploying()).toBe(false);
  });

  it('A4: deploy() does NOT provision when the confirm gate is declined', async () => {
    const { c, post, confirm } = make(
      jasmine.createSpy('post').and.returnValue(of({ instance_id: 'inst-1' })),
      '',
      false, // user cancels the confirm dialog
    );
    setValidSubdomain(c);
    await c.deploy(UMAMI);
    expect(confirm.confirm).toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(c.deploying()).toBe(false);
  });

  it('deploy() clears the deploying flag on error', async () => {
    const { c } = make(jasmine.createSpy('post').and.returnValue(throwError(() => ({ status: 500 }))));
    setValidSubdomain(c);
    await c.deploy(UMAMI);
    expect(c.deploying()).toBe(false);
  });

  // A "Soon" (catalog-placeholder) app must NOT be deployable — its runtime
  // container ships in a future drop, so a POST would be a doomed dead action.
  it('deploy() is a no-op for an unsupported (Soon) app even with a valid subdomain', () => {
    const { c, post } = make();
    c.onSubdomainChange('valid-subdomain');
    c.subdomain = 'valid-subdomain';
    c.deploy({ id: 'matomo', name: 'Matomo' } as never); // not in SUPPORTED_APP_SLUGS
    expect(post).not.toHaveBeenCalled();
  });

  it('supported() reflects the loaded catalog app (Live=true, Soon=false)', () => {
    const live = make(undefined, 'umami').c;
    live.ngOnInit();
    expect(live.supported()).toBeTrue();
    TestBed.resetTestingModule();
    const soon = make(undefined, 'matomo').c;
    soon.ngOnInit();
    expect(soon.supported()).toBeFalse();
  });

  // a11y: the cost total is a financial figure rendered through
  // <app-rolling-counter>, which exposes only the bare digits ("47") to AT.
  // A screen reader otherwise hears "$ 47 / mo" as three disconnected nodes
  // with no "what is this" context. costTotalLabel() bundles the whole figure
  // (and its /mo unit) into one programmatic accessible name, mirroring the
  // analytics/seo KPI group pattern.
  it('costTotalLabel() names the figure + monthly unit for AT', () => {
    const { c } = make(undefined, 'umami');
    c.ngOnInit();
    const label = c.costTotalLabel();
    expect(label).toContain('Total');
    expect(label).toContain('$' + c.totalCost());
    expect(label).toMatch(/per month/i);
  });
});

/**
 * a11y: full-render assertions for the cost-total group. Renders the real
 * template (no override) so the role=group + aria-label wiring is exercised.
 */
describe('AppDetailComponent (cost-total a11y group)', () => {
  afterEach(() => TestBed.resetTestingModule());

  function render(appId = 'umami') {
    const post = jasmine.createSpy('post').and.returnValue(of({ instance_id: 'i1' }));
    TestBed.configureTestingModule({
      imports: [AppDetailComponent],
      providers: [
        { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ id: appId })) } },
        { provide: Router, useValue: { navigate: jasmine.createSpy('navigate') } },
        { provide: ApiService, useValue: { post, get: () => of({ available: true, valid: true, suggestion: 'auto-sub' }) } },
        { provide: ToastService, useValue: { success: jasmine.createSpy('s'), error: jasmine.createSpy('e') } },
        { provide: AdminStateService, useValue: { selectedSite: signal({ id: 's1', slug: 'demo' }) } },
      ],
    });
    const fx = TestBed.createComponent(AppDetailComponent);
    fx.detectChanges();
    return fx;
  }

  it('renders the About feature checklist for an app that lists features (umami)', () => {
    const fx = render('umami');
    const list: HTMLElement | null = fx.nativeElement.querySelector('[data-testid="apps-feature-list"]');
    expect(list).withContext('umami documents features → checklist renders').toBeTruthy();
    const items = list!.querySelectorAll('.feature-item');
    expect(items.length).withContext('one <li> per feature').toBe(fx.componentInstance.app()!.features!.length);
  });

  it('renders the cost total as a labelled group (role=group + aria-label)', () => {
    const fx = render();
    const total: HTMLElement | null = fx.nativeElement.querySelector('.cost-total');
    expect(total).toBeTruthy();
    expect(total!.getAttribute('role')).toBe('group');
    const label = total!.getAttribute('aria-label') ?? '';
    expect(label).toContain('Total');
    expect(label).toMatch(/per month/i);
  });

  it('marks the deploy button aria-busy while provisioning', () => {
    const fx = render();
    const c = fx.componentInstance;
    c.onSubdomainChange('my-cool-app');
    c.subdomain = 'my-cool-app';
    c.deploying.set(true);
    fx.detectChanges();
    const btn: HTMLElement | null = fx.nativeElement.querySelector('[data-testid="apps-deploy-cta"]');
    expect(btn).toBeTruthy();
    expect(btn!.getAttribute('aria-busy')).toBe('true');
  });
});

/**
 * "AI Recommends" cross-link section + the full-width prev/next pager, plus the
 * ←/→ keyboard navigation. The detail page now re-resolves on param change
 * (paramMap subscribe, not snapshot) so pager nav reuses the component cleanly.
 */
describe('AppDetailComponent (AI Recommends + prev/next pager)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('recommends exactly 2 OTHER apps (never the current one)', () => {
    const { c } = make(undefined, 'umami');
    c.ngOnInit();
    const recs = c.recommendations();
    expect(recs.length).toBe(2);
    expect(recs.every((r) => r.id !== 'umami')).withContext('excludes self').toBeTrue();
  });

  it('recommendations rank the most-related app first (shared tags + category)', () => {
    // open-webui + lobe-chat share the 'ai' category AND the 'llm'/'chat' tags,
    // so lobe-chat is the single strongest match and must rank first. The 2nd slot
    // fills with the alphabetical-first unrelated app so the section is never
    // half-empty even in a small, diverse catalog.
    const { c } = make(undefined, 'open-webui');
    c.ngOnInit();
    const recs = c.recommendations();
    expect(recs.length).toBe(2);
    expect(recs.every((r) => r.id !== 'open-webui')).withContext('excludes self').toBeTrue();
    expect(recs[0]?.id).withContext('most-related app ranked first').toBe('lobe-chat');
  });

  it('prevApp/nextApp resolve catalog neighbours and wrap around', () => {
    const { c } = make(undefined, APPS_CATALOG[0].id);
    c.ngOnInit();
    expect(c.nextApp()?.id).toBe(APPS_CATALOG[1].id);
    expect(c.prevApp()?.id).withContext('first wraps to last').toBe(APPS_CATALOG[APPS_CATALOG.length - 1].id);
  });

  it('ArrowRight → next app, ArrowLeft → previous app', () => {
    const { c, nav } = make(undefined, APPS_CATALOG[0].id);
    c.ngOnInit();
    c.onArrowNav({ key: 'ArrowRight', preventDefault() {}, target: document.body } as unknown as KeyboardEvent);
    expect(nav).toHaveBeenCalledWith(['/admin/apps', APPS_CATALOG[1].id]);
    c.onArrowNav({ key: 'ArrowLeft', preventDefault() {}, target: document.body } as unknown as KeyboardEvent);
    expect(nav).toHaveBeenCalledWith(['/admin/apps', APPS_CATALOG[APPS_CATALOG.length - 1].id]);
  });

  it('arrow keys are ignored while typing in a form control', () => {
    const { c, nav } = make(undefined, APPS_CATALOG[0].id);
    c.ngOnInit();
    const input = document.createElement('input');
    c.onArrowNav({ key: 'ArrowRight', preventDefault() {}, target: input } as unknown as KeyboardEvent);
    expect(nav).not.toHaveBeenCalled();
  });

  it('re-resolves the app when the route param changes (pager reuse)', () => {
    // paramMap emits 'umami' then 'listmonk' — the component must reflect the last.
    const nav = jasmine.createSpy('navigate');
    TestBed.configureTestingModule({
      imports: [AppDetailComponent],
      providers: [
        { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ id: 'umami' }), convertToParamMap({ id: 'listmonk' })) } },
        { provide: Router, useValue: { navigate: nav } },
        { provide: ApiService, useValue: { post: jasmine.createSpy('post'), get: () => of({ available: true, valid: true, suggestion: 'auto-sub' }) } },
        { provide: ToastService, useValue: { success: () => 0, error: () => 0 } },
        { provide: AdminStateService, useValue: { selectedSite: signal({ id: 's1', slug: 'demo' }) } },
      ],
    });
    TestBed.overrideComponent(AppDetailComponent, { set: { template: '<div></div>', imports: [] } });
    const c = TestBed.createComponent(AppDetailComponent).componentInstance;
    c.ngOnInit();
    expect(c.app()?.id).withContext('reflects the latest param emission').toBe('listmonk');
  });
});

/**
 * Customize environment variables before deploy. The user-provided (non-auto)
 * env vars become editable inputs seeded with their defaults; required ones gate
 * deploy; only non-empty values ride along as `env_overrides` in the POST.
 */
describe('AppDetailComponent (customize env vars before deploy)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('seeds the editable env inputs from each non-auto var default on load', () => {
    const { c } = make(undefined, 'umami');
    c.ngOnInit();
    const a = c.app()!;
    for (const e of a.env) {
      if (!e.auto && e.default) {
        expect(c.envValue(e.key)).withContext(`${e.key} seeded with its default`).toBe(e.default);
      }
    }
  });

  it('setEnvOverride updates the value the user types', () => {
    const { c } = make(undefined, 'umami');
    c.ngOnInit();
    const key = c.app()!.env.find((e) => !e.auto)?.key;
    if (!key) return; // umami always has user vars, but stay defensive
    c.setEnvOverride(key, 'my-custom-value');
    expect(c.envValue(key)).toBe('my-custom-value');
  });

  it('readyToDeploy stays false until every REQUIRED user-provided env has a value', () => {
    const { c } = make(undefined, 'umami');
    c.ngOnInit();
    setValidSubdomain(c, 'valid-subdomain'); // subdomain side is valid + available
    const reqUserVar = c.app()!.env.find((e) => e.required && !e.auto);
    if (reqUserVar) {
      c.setEnvOverride(reqUserVar.key, '');
      expect(c.missingRequiredEnv()).toContain(reqUserVar.key);
      expect(c.readyToDeploy()).withContext('blocked on missing required env').toBeFalse();
      c.setEnvOverride(reqUserVar.key, 'now-set');
      expect(c.readyToDeploy()).withContext('unblocks once provided').toBeTrue();
    } else {
      // No required user var → readiness mirrors the subdomain validity.
      expect(c.readyToDeploy()).toBe(c.canDeploy());
    }
  });

  it('deploy() POSTs the customized env_overrides (non-empty values only)', async () => {
    const post = jasmine.createSpy('post').and.returnValue(of({ instance_id: 'i1' }));
    const { c } = make(post, 'umami');
    c.ngOnInit();
    setValidSubdomain(c, 'my-umami-site');
    const a = c.app()!;
    // Satisfy every required user var so deploy isn't blocked.
    for (const e of a.env) {
      if (e.required && !e.auto && !c.envValue(e.key).trim()) c.setEnvOverride(e.key, 'req-val');
    }
    const userVar = a.env.find((e) => !e.auto);
    if (userVar) c.setEnvOverride(userVar.key, 'custom-value');
    await c.deploy(a);
    expect(post).toHaveBeenCalled();
    const body = post.calls.mostRecent().args[1] as { env_overrides: Record<string, string> };
    if (userVar) expect(body.env_overrides[userVar.key]).toBe('custom-value');
    // No empty-string values leak into the payload.
    expect(Object.values(body.env_overrides).every((v) => v.trim().length > 0)).toBeTrue();
  });

  it('Postgres apps surface Hyperdrive in the provisioning checklist + cost lines', () => {
    const { c } = make(undefined, 'umami'); // umami → infra ['postgres']
    c.ngOnInit();
    expect(c.app()!.infra).withContext('umami uses postgres').toContain('postgres');
    expect(c.provisioning().some((p) => p.key === 'hyperdrive'))
      .withContext('Hyperdrive auto-included with Postgres').toBeTrue();
    expect(c.costLines().some((l) => l.key === 'hyperdrive')).toBeTrue();
  });

  it('non-Postgres apps do NOT show Hyperdrive', () => {
    // find an app whose infra has no postgres
    const noPg = APPS_CATALOG.find((a) => !a.infra.includes('postgres'));
    if (!noPg) return;
    const { c } = make(undefined, noPg.id);
    c.ngOnInit();
    expect(c.provisioning().some((p) => p.key === 'hyperdrive')).toBeFalse();
  });

  it('deploy() is blocked while a required user-provided env is empty', () => {
    const post = jasmine.createSpy('post').and.returnValue(of({ instance_id: 'i1' }));
    const { c } = make(post, 'umami');
    c.ngOnInit();
    c.onSubdomainChange('my-umami-site');
    c.subdomain = 'my-umami-site';
    const reqUserVar = c.app()!.env.find((e) => e.required && !e.auto);
    if (!reqUserVar) return; // only meaningful for apps with a required user var
    c.setEnvOverride(reqUserVar.key, '');
    c.deploy(c.app()!);
    expect(post).not.toHaveBeenCalled();
  });
});

/**
 * Screenshot carousel — regression for the Apps visual-sweep rework: single full-width
 * snap frames with pagination dots whose active index tracks the live scroll position,
 * and dot clicks that jump the track to exactly that frame. Uses make() WITHOUT ngOnInit,
 * so no api.get fires — the carousel logic is independent of app resolution.
 */
describe('AppDetailComponent (screenshot carousel)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('onShotsScroll derives the active frame index from scrollLeft / clientWidth', () => {
    const { c } = make();
    c.onShotsScroll({ scrollLeft: 0, clientWidth: 320 } as HTMLElement);
    expect(c.activeShot()).withContext('frame 0 at rest').toBe(0);
    c.onShotsScroll({ scrollLeft: 640, clientWidth: 320 } as HTMLElement);
    expect(c.activeShot()).withContext('two frames scrolled').toBe(2);
  });

  it('goToShot scrolls the track to exactly frame i (i × clientWidth)', () => {
    const { c } = make();
    const calls: Array<{ left: number }> = [];
    const track = {
      clientWidth: 300,
      scrollTo: (o: { left: number }) => calls.push(o),
    } as unknown as HTMLElement;
    c.goToShot(track, 2);
    expect(calls[0]?.left).withContext('frame 2 = 2 × clientWidth').toBe(600);
  });
});

/**
 * Display-correctness: a CF-native app (image `cf-native:*`) is a real Worker on
 * D1 + R2 — NO container. `isCfNative()` centralizes that branch (was an inline
 * `a.image?.startsWith('cf-native:')` repeated across the template) so the detail
 * page never shows a Port / Memory / Dockerfile field or "booting container" copy
 * for a serverless app.
 */
describe('AppDetailComponent (CF-native display gating)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('isCfNative() is true for the Payload CF-native entry, false for a container app', () => {
    const { c } = make();
    const cfNative = APPS_CATALOG.find((a) => a.image.startsWith('cf-native:'))!;
    const container = APPS_CATALOG.find((a) => !a.image.startsWith('cf-native:'))!;
    expect(c.isCfNative(cfNative)).toBeTrue();
    expect(c.isCfNative(container)).toBeFalse();
  });

  it('costLines for a CF-native app carry NO container line (Worker + D1 + R2 only)', () => {
    const cfNative = APPS_CATALOG.find((a) => a.image.startsWith('cf-native:'))!;
    const { c } = make(); // set the app signal directly — avoids the ngOnInit api.get round-trip
    c.app.set(cfNative);
    const keys = c.costLines().map((l) => l.key);
    expect(keys).not.toContain('container');
    expect(keys).toContain('worker');
  });

  it('costLines for a container app DO carry a container line', () => {
    const container = APPS_CATALOG.find((a) => !a.image.startsWith('cf-native:'))!;
    const { c } = make();
    c.app.set(container);
    expect(c.costLines().map((l) => l.key)).toContain('container');
  });
});
