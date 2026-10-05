import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of, throwError } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import { DomSanitizer } from '@angular/platform-browser';
import { BoltEmbedService } from './bolt-embed.service';
import { ApiService } from './api.service';
import { ToastService } from './toast.service';

/**
 * Security boundary for the bolt.diy iframe bridge: BoltEmbedService listens for
 * postMessage events from the embedded editor, but MUST only act on messages from
 * the trusted origins (editor.projectsites.dev / localhost:5173) — a message from
 * any other origin is a cross-frame injection vector (it could trigger uploads,
 * deploys, or veil-dismissal). It also only honors the `PS_`-prefixed protocol.
 * loadingStage() is the observable proxy for "the handler acted".
 */
type Testable = {
  attachMessageListener(): void;
  messageHandler: (e: MessageEvent) => void;
  loadingStage(): string;
  loadingPhase(): number;
};

function setup(): { svc: Testable; fire: (origin: string, data: unknown) => void; error: jasmine.Spy } {
  const error = jasmine.createSpy('error');
  TestBed.configureTestingModule({
    providers: [
      BoltEmbedService,
      { provide: DomSanitizer, useValue: { bypassSecurityTrustResourceUrl: (u: string) => u } },
      { provide: ApiService, useValue: { get: () => of({}), post: () => of({}) } },
      { provide: ToastService, useValue: { toasts: signal([]), error, success: jasmine.createSpy('success') } },
    ],
  });
  const svc = TestBed.inject(BoltEmbedService) as unknown as Testable;
  svc.attachMessageListener();
  const fire = (origin: string, data: unknown): void => svc.messageHandler(new MessageEvent('message', { origin, data }));
  return { svc, fire, error };
}

describe('BoltEmbedService (postMessage origin security)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('IGNORES a PS_BOLT_READY from a disallowed origin (cross-frame injection guard)', () => {
    const { svc, fire } = setup();
    const before = svc.loadingStage();
    fire('https://evil.example.com', { type: 'PS_BOLT_READY' });
    expect(svc.loadingStage()).toBe(before); // untrusted origin → handler no-ops
  });

  it('PROCESSES a PS_BOLT_READY from the trusted editor origin', () => {
    const { svc, fire } = setup();
    fire('https://editor.projectsites.dev', { type: 'PS_BOLT_READY' });
    expect(svc.loadingStage()).toBe('Starting the workspace');
  });

  it('also trusts the localhost:5173 dev origin', () => {
    const { svc, fire } = setup();
    fire('http://localhost:5173', { type: 'PS_BOLT_READY' });
    expect(svc.loadingStage()).toBe('Starting the workspace');
  });

  it('ignores a non-PS_ message even from a trusted origin', () => {
    const { svc, fire } = setup();
    const before = svc.loadingStage();
    fire('https://editor.projectsites.dev', { type: 'EVIL_INJECT' });
    expect(svc.loadingStage()).toBe(before);
  });

  it('ignores a null / malformed payload from a trusted origin', () => {
    const { svc, fire } = setup();
    const before = svc.loadingStage();
    fire('https://editor.projectsites.dev', null);
    expect(svc.loadingStage()).toBe(before);
  });

  it('surfaces a trusted-origin PS_ERROR as a toast', () => {
    const { fire, error } = setup();
    fire('https://editor.projectsites.dev', { type: 'PS_ERROR', message: 'boom' });
    expect(error).toHaveBeenCalled();
  });

  it('does NOT surface a PS_ERROR from an untrusted origin', () => {
    const { fire, error } = setup();
    fire('https://evil.example.com', { type: 'PS_ERROR', message: 'boom' });
    expect(error).not.toHaveBeenCalled();
  });
});

describe('BoltEmbedService — importChatFrom gating (publish-aware, no 404 console noise)', () => {
  afterEach(() => TestBed.resetTestingModule());

  function bootSvc(): { bootForSite: (s: unknown) => void; iframeUrl: () => unknown } {
    TestBed.configureTestingModule({
      providers: [
        BoltEmbedService,
        { provide: DomSanitizer, useValue: { bypassSecurityTrustResourceUrl: (u: string) => u } },
        { provide: ApiService, useValue: { get: () => of({}), post: () => of({}) } },
        { provide: ToastService, useValue: { toasts: signal([]), error: jasmine.createSpy('error'), success: jasmine.createSpy('success') } },
      ],
    });
    return TestBed.inject(BoltEmbedService) as unknown as { bootForSite: (s: unknown) => void; iframeUrl: () => unknown };
  }

  it('sets importChatFrom for a PUBLISHED, BUILT site (warm chat/version import)', () => {
    const svc = bootSvc();
    // A real Live site has a build → its _manifest.json + chat export exist in R2.
    svc.bootForSite({
      id: 's1',
      slug: 'live-site',
      business_name: 'Live',
      status: 'published',
      current_build_version: '2026-05-04T23-09-02-051Z',
    });
    const url = String(svc.iframeUrl() ?? '');
    expect(url).toContain('importChatFrom=');
    expect(url).toContain('live-site');
  });

  it("importChatFrom MUST point at the public API origin (https://projectsites.dev), never the embedding admin origin — the editor iframe's own CSP connect-src has no http: scheme, so a local-admin-origin URL is refused at fetch time (regression: fire-80, case-001 Phase D)", () => {
    const svc = bootSvc();
    svc.bootForSite({
      id: 's1',
      slug: 'live-site',
      business_name: 'Live',
      status: 'published',
      current_build_version: '2026-05-04T23-09-02-051Z',
    });
    const url = String(svc.iframeUrl() ?? '');
    const match = /importChatFrom=([^&]+)/.exec(url);
    expect(match).withContext('importChatFrom param must be present').not.toBeNull();
    const decoded = decodeURIComponent(match ? match[1] : '');
    expect(decoded).toContain('https://projectsites.dev/api/sites/by-slug/live-site/chat');
    expect(decoded).not.toContain('localhost');
    expect(decoded.startsWith('http://')).toBe(false);
  });

  it('OMITS importChatFrom for an UNPUBLISHED site (no R2 manifest → would 404 on every admin route)', () => {
    const svc = bootSvc();
    svc.bootForSite({ id: 's2', slug: 'draft-site', business_name: 'Draft', status: 'draft' });
    const url = String(svc.iframeUrl() ?? '');
    expect(url).not.toContain('importChatFrom');
    expect(url).withContext('still boots the editor for the draft site').toContain('draft-site');
  });

  it('OMITS importChatFrom for a PUBLISHED-but-UNBUILT site (published + null build = no manifest → 404)', () => {
    const svc = bootSvc();
    // A `published` row whose build never finished (current_build_version=null)
    // serves a 503 and has NO _manifest.json — importing its chat would 404. The
    // guard must key on the build, not status alone.
    svc.bootForSite({
      id: 's3',
      slug: 'unbuilt-site',
      business_name: 'Unbuilt',
      status: 'published',
      current_build_version: null,
    });
    const url = String(svc.iframeUrl() ?? '');
    expect(url).not.toContain('importChatFrom');
    expect(url).withContext('still boots the editor for the unbuilt site').toContain('unbuilt-site');
  });
});

/**
 * Veil-dismiss → editorReady. The editor shows a cinematic loading veil until
 * the iframe signals it's interactive; if that transition regressed, users would
 * stare at a permanent veil (a broken editor). Locks the dismiss paths AND the
 * security boundary: an UNTRUSTED origin must never force the veil away.
 */
describe('BoltEmbedService (PS_FILES_READY dedupe — module + route responders both reply)', () => {
  afterEach(() => TestBed.resetTestingModule());

  function dedupeSetup(): {
    svc: Testable;
    boot: (site: unknown) => void;
    fire: (origin: string, data: unknown) => void;
    publish: jasmine.Spy;
  } {
    const publish = jasmine.createSpy('publishFromBolt').and.returnValue(
      of({ data: { slug: 'dup-site', version: 'v1', url: 'u' } }),
    );
    TestBed.configureTestingModule({
      providers: [
        BoltEmbedService,
        { provide: DomSanitizer, useValue: { bypassSecurityTrustResourceUrl: (u: string) => u } },
        { provide: ApiService, useValue: { get: () => of({}), post: () => of({}), publishFromBolt: publish } },
        { provide: ToastService, useValue: { toasts: signal([]), error: jasmine.createSpy('error'), success: jasmine.createSpy('success') } },
      ],
    });
    const svc = TestBed.inject(BoltEmbedService) as unknown as Testable;
    svc.attachMessageListener();
    const boot = (site: unknown): void =>
      (svc as unknown as { bootForSite: (s: unknown) => void }).bootForSite(site);
    const fire = (origin: string, data: unknown): void =>
      svc.messageHandler(new MessageEvent('message', { origin, data }));
    return { svc, boot, fire, publish };
  }

  it('publishes exactly ONCE when the same PS_FILES_READY reply arrives twice (the journey duplicate)', async () => {
    const { boot, fire, publish } = dedupeSetup();
    boot({ id: 's1', slug: 'dup-site', business_name: 'Dup', status: 'published', current_build_version: 'v1' });
    const files = { 'index.html': '<h1>dup</h1>' };
    const reply = { type: 'PS_FILES_READY', files, correlationId: 'dup-1' };
    fire('https://editor.projectsites.dev', reply);
    fire('https://editor.projectsites.dev', reply);
    await new Promise((r) => setTimeout(r, 80));
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('publishes DISTINCT replies separately (different correlationIds are different saves)', async () => {
    const { boot, fire, publish } = dedupeSetup();
    boot({ id: 's1', slug: 'dup-site', business_name: 'Dup', status: 'published', current_build_version: 'v1' });
    const files = { 'index.html': '<h1>a</h1>' };
    fire('https://editor.projectsites.dev', { type: 'PS_FILES_READY', files, correlationId: 'save-1' });
    fire('https://editor.projectsites.dev', { type: 'PS_FILES_READY', files, correlationId: 'save-2' });
    await new Promise((r) => setTimeout(r, 80));
    expect(publish).toHaveBeenCalledTimes(2);
  });
});

/**
 * Bridge response-shape parity: the editor (`app/lib/embed/embedded-mode.ts`) consumes specific
 * top-level fields; the admin handlers must emit EXACTLY those (not a nested `{data}` envelope, not
 * the worker's raw column names). These lock the 5 aligned contracts + the added upload handler so a
 * future refactor can't silently re-introduce the divergence. Each fires a request from the trusted
 * editor origin, stubs the worker call, and asserts the exact reply posted back to the iframe.
 */
describe('BoltEmbedService (bridge response-shape parity — editor is the contract)', () => {
  afterEach(() => TestBed.resetTestingModule());

  interface ParitySetup {
    fire: (origin: string, data: unknown) => void;
    posted: Array<Record<string, unknown>>;
  }

  function paritySetup(api: Partial<Record<string, unknown>>): ParitySetup {
    const posted: Array<Record<string, unknown>> = [];
    TestBed.configureTestingModule({
      providers: [
        BoltEmbedService,
        { provide: DomSanitizer, useValue: { bypassSecurityTrustResourceUrl: (u: string) => u } },
        { provide: ApiService, useValue: { get: () => of({}), post: () => of({}), postFormData: () => of({}), delete: () => of({}), ...api } },
        { provide: ToastService, useValue: { toasts: signal([]), error: jasmine.createSpy('error'), success: jasmine.createSpy('success') } },
      ],
    });
    const svc = TestBed.inject(BoltEmbedService) as unknown as Testable & {
      registerIframe: (el: unknown) => void;
      bootForSite: (s: unknown) => void;
    };
    // Fake iframe: capture every message the handler posts back to the editor.
    svc.registerIframe({ contentWindow: { postMessage: (m: Record<string, unknown>) => posted.push(m) } });
    svc.bootForSite({ id: 's1', slug: 'acme', business_name: 'Acme', status: 'published', current_build_version: 'v1' });
    svc.attachMessageListener();
    const fire = (origin: string, data: unknown): void =>
      svc.messageHandler(new MessageEvent('message', { origin, data }));
    return { fire, posted };
  }

  const TRUSTED = 'https://editor.projectsites.dev';
  const last = (posted: Array<Record<string, unknown>>, type: string): Record<string, unknown> | undefined =>
    [...posted].reverse().find((m) => m['type'] === type);

  it('PS_DB_LOAD_SAMPLE → top-level {tablesCreated, rowsInserted, tables} (not nested data)', async () => {
    const { fire, posted } = paritySetup({
      post: () => of({ ok: true, data: { tables: ['customers', 'orders'], rowCounts: { customers: 5, orders: 8 } } }),
    });
    fire(TRUSTED, { type: 'PS_DB_LOAD_SAMPLE', correlationId: 'c1' });
    await new Promise((r) => setTimeout(r, 0));
    const reply = last(posted, 'PS_DB_LOAD_SAMPLE_RESULT')!;
    expect(reply).toBeDefined();
    expect(reply['tablesCreated']).toBe(2);
    expect(reply['rowsInserted']).toBe(13);
    expect(reply['tables']).toEqual(['customers', 'orders']);
    expect(reply['data']).toBeUndefined(); // no nested envelope
  });

  it('PS_DB_AI_SEED → top-level {table, rowsInserted} mapped from worker {inserted} (preserves ok)', async () => {
    const { fire, posted } = paritySetup({
      post: () => of({ ok: true, data: { table: 'menu', inserted: 12, previewRows: [], createdTable: true } }),
    });
    fire(TRUSTED, { type: 'PS_DB_AI_SEED', correlationId: 'c2', table: 'menu' });
    await new Promise((r) => setTimeout(r, 0));
    const reply = last(posted, 'PS_DB_AI_SEED_RESULT')!;
    expect(reply['table']).toBe('menu');
    expect(reply['rowsInserted']).toBe(12);
    expect(reply['ok']).toBeTrue();
    expect(reply['data']).toBeUndefined();
  });

  it('PS_RES_MEDIA list → top-level {assets, usage}; assets mapped to editor shape, usage renamed', async () => {
    const { fire, posted } = paritySetup({
      get: (path: string) =>
        path === '/media/assets'
          ? of({ ok: true, assets: [{ id: 'a1', r2_key: 'k', mime: 'image/png', size_bytes: 900, name: 'hero.png', kind: 'image', source: 'uploaded', created_at: 123 }] })
          : of({ ok: true, data: { totalSizeBytes: 900, totalCount: 1, countByKind: { image: 1 } } }),
    });
    fire(TRUSTED, { type: 'PS_RES_MEDIA', correlationId: 'c3', mediaAction: 'list' });
    await new Promise((r) => setTimeout(r, 0));
    const reply = last(posted, 'PS_RES_MEDIA_RESULT')!;
    const assets = reply['assets'] as Array<Record<string, unknown>>;
    expect(assets.length).toBe(1);
    expect(assets[0]['id']).toBe('a1');
    expect(assets[0]['url']).toBe('/api/media/assets/a1/raw'); // authed raw-stream route
    expect(assets[0]['contentType']).toBe('image/png'); // mime → contentType
    expect(assets[0]['size']).toBe(900); // size_bytes → size
    expect(assets[0]['uploaded']).toBe('123'); // created_at → uploaded
    const usage = reply['usage'] as Record<string, unknown>;
    expect(usage['totalBytes']).toBe(900); // totalSizeBytes → totalBytes (what the header reads)
    expect(usage['totalCount']).toBe(1);
    expect(reply['data']).toBeUndefined();
  });

  it('PS_RES_MEDIA list → carries filteredTotal from the assets response `total` (honest "N of total" under a filter; MEDIA-UI-1)', async () => {
    // fire-124 made /media/assets return a FILTERED `total` (respects kind/source/q). The reply MUST
    // surface it as `filteredTotal` so the editor header shows "N of <filtered total>", not the
    // org-wide usage.totalCount (which ignores the active filter and misreports under a filter).
    const { fire, posted } = paritySetup({
      get: (path: string) =>
        path === '/media/assets'
          ? of({
              ok: true,
              assets: [{ id: 'a1', r2_key: 'k', mime: 'image/png', size_bytes: 900, name: 'hero.png', kind: 'image', source: 'uploaded', created_at: 123 }],
              total: 7, // 7 images match the filter; only 1 returned on this page
            })
          : of({ ok: true, data: { totalSizeBytes: 9000, totalCount: 42, countByKind: { image: 7 } } }),
    });
    fire(TRUSTED, { type: 'PS_RES_MEDIA', correlationId: 'cft', mediaAction: 'list', mediaKind: 'image' });
    await new Promise((r) => setTimeout(r, 0));
    const reply = last(posted, 'PS_RES_MEDIA_RESULT')!;
    expect(reply['filteredTotal']).toBe(7); // the FILTERED total, not the org-wide 42
    const usage = reply['usage'] as Record<string, unknown>;
    expect(usage['totalCount']).toBe(42); // org-wide rollup still preserved for the fallback
  });

  it('PS_RES_MEDIA_UPLOAD (NEW handler) → decodes dataUrl, posts FormData, replies {ok, asset mapped}', async () => {
    let sentForm: FormData | null = null;
    const { fire, posted } = paritySetup({
      postFormData: (path: string, form: FormData) => {
        sentForm = form;
        expect(path).toBe('/media/upload');
        return of({ ok: true, asset: { id: 'u1', r2_key: 'k', mime: 'image/png', size_bytes: 3, name: 'p.png', kind: 'image', source: 'uploaded', created_at: 9 } });
      },
    });
    // 1x1 transparent-ish base64 PNG payload (content irrelevant — we assert decode + map).
    fire(TRUSTED, {
      type: 'PS_RES_MEDIA_UPLOAD',
      correlationId: 'c4',
      name: 'p.png',
      contentType: 'image/png',
      dataUrl: 'data:image/png;base64,AAAA',
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(sentForm).withContext('multipart FormData was built + posted').not.toBeNull();
    expect((sentForm as unknown as FormData).get('file')).withContext('file field present').not.toBeNull();
    const reply = last(posted, 'PS_RES_MEDIA_UPLOAD_RESULT')!;
    expect(reply['ok']).toBeTrue();
    const asset = reply['asset'] as Record<string, unknown>;
    expect(asset['id']).toBe('u1');
    expect(asset['url']).toBe('/api/media/assets/u1/raw');
    expect(asset['contentType']).toBe('image/png');
  });

  it('PS_RES_MEDIA_UPLOAD malformed dataUrl → {ok:false, error} (never throws)', async () => {
    const { fire, posted } = paritySetup({});
    fire(TRUSTED, { type: 'PS_RES_MEDIA_UPLOAD', correlationId: 'c5', name: 'x', contentType: 'image/png', dataUrl: 'not-a-data-url' });
    await new Promise((r) => setTimeout(r, 0));
    const reply = last(posted, 'PS_RES_MEDIA_UPLOAD_RESULT')!;
    expect(reply['ok']).toBeFalse();
    expect(reply['error']).toBeTruthy();
  });

  it('PS_RES_SITE_FILES → top-level {files, version, prefix} (not nested data, no dead assets)', async () => {
    const { fire, posted } = paritySetup({
      get: (path: string) =>
        path === '/sites/s1/build-files'
          ? of({ ok: true, data: { files: [{ key: 'sites/acme/v1/index.html', name: 'index.html', size: 10, uploaded: 't', url: 'u' }], totalSize: 10, version: 'v1' } })
          : of({}),
    });
    fire(TRUSTED, { type: 'PS_RES_SITE_FILES', correlationId: 'c6' });
    await new Promise((r) => setTimeout(r, 0));
    const reply = last(posted, 'PS_RES_SITE_FILES_RESULT')!;
    expect((reply['files'] as unknown[]).length).toBe(1);
    expect(reply['version']).toBe('v1');
    expect(reply['prefix']).toBe('sites/acme/v1/');
    expect(reply['data']).toBeUndefined();
  });

  it('PS_RES_MUTATE_REQUEST {kind:"d1"} reaches the worker mutate route — regression: the handler read `msg.resourceKind`, a field the editor NEVER sends (its `ResMutateRequestMessage` declares `kind`), so an inline Data-tab cell UPDATE short-circuited "Failed to perform action" before the UPDATE ever left the admin', async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const { fire, posted } = paritySetup({
      post: (path: string, body: unknown) => {
        calls.push({ path, body });
        return of({ data: { result: { ok: true, data: { rowsWritten: 1 } } } });
      },
    });
    // The EXACT payload the editor's SiteTablesPanel cell-save sends (field name `kind`, not `resourceKind`).
    fire(TRUSTED, {
      type: 'PS_RES_MUTATE_REQUEST',
      correlationId: 'm1',
      kind: 'd1',
      action: 'exec',
      confirm: true,
      input: { sql: 'UPDATE "posts" SET "title" = ?1 WHERE rowid = ?2', params: ['Hi', 1] },
    });
    await new Promise((r) => setTimeout(r, 0));
    // The worker mutate route is hit with the resolved kind — NOT short-circuited to an error reply.
    expect(calls.some((c) => c.path === '/sites/s1/resources/d1/mutate'))
      .withContext('kind resolved from msg.kind → the d1 mutate route was called')
      .toBeTrue();
    const reply = last(posted, 'PS_RES_MUTATE_RESPONSE')!;
    expect(reply).toBeDefined();
    expect(reply['ok']).toBeTrue();
    expect(reply['error'])
      .withContext('must NOT be the "Failed to perform action" short-circuit')
      .toBeUndefined();
  });

  it('PS_RES_DETAIL_REQUEST {kind:"d1"} reaches the worker detail route — same `resourceKind`→`kind` drift fix (detail drill-in short-circuited "Failed to load resource")', async () => {
    const calls: Array<{ path: string }> = [];
    const { fire, posted } = paritySetup({
      get: (path: string) => {
        calls.push({ path });
        return of({ data: { result: { ok: true, data: { rows: [] } } } });
      },
    });
    fire(TRUSTED, { type: 'PS_RES_DETAIL_REQUEST', correlationId: 'dt1', kind: 'd1', action: 'list' });
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.some((c) => c.path === '/sites/s1/resources/d1/detail'))
      .withContext('kind resolved from msg.kind → the d1 detail route was called')
      .toBeTrue();
    const reply = last(posted, 'PS_RES_DETAIL_RESPONSE')!;
    expect(reply['ok']).toBeTrue();
    expect(reply['error'])
      .withContext('must NOT be the "Failed to load resource" short-circuit')
      .toBeUndefined();
  });
});

/**
 * PS_RESOLVE_REQUEST bridge (WLK-39 S7): the embedded editor's Resolution mode runs `/api/resolve`
 * THROUGH the admin (the editor origin has no cross-origin session + CORS blocks a direct worker
 * call; a relative `fetch('/api/resolve')` from the editor 404s). The admin POSTs
 * `/api/resolve {prompt, siteId}` and replies `PS_RESOLVE_RESPONSE` — the worker's TOP-LEVEL
 * `{research, synthesis}` on a 200, `{ok:false, dark:true}` on a 404 (DARK flag / foreign site),
 * `{ok:false}` on any other failure. Mirrors the PS_CLAUDE_FLAG_REQUEST failure translation.
 */
describe('BoltEmbedService (PS_RESOLVE_REQUEST bridge — Resolution mode goes through the admin)', () => {
  afterEach(() => TestBed.resetTestingModule());

  const TRUSTED = 'https://editor.projectsites.dev';
  const last = (posted: Array<Record<string, unknown>>, type: string): Record<string, unknown> | undefined =>
    [...posted].reverse().find((m) => m['type'] === type);

  interface ResolveSetup {
    fire: (origin: string, data: unknown) => void;
    posted: Array<Record<string, unknown>>;
    calls: Array<{ path: string; body: unknown }>;
  }

  /** Boot site `s1` + capture both the worker POSTs and every message posted back to the iframe. */
  function resolveSetup(post: (path: string, body: unknown) => unknown, bootSite = true): ResolveSetup {
    const posted: Array<Record<string, unknown>> = [];
    const calls: Array<{ path: string; body: unknown }> = [];
    TestBed.configureTestingModule({
      providers: [
        BoltEmbedService,
        { provide: DomSanitizer, useValue: { bypassSecurityTrustResourceUrl: (u: string) => u } },
        {
          provide: ApiService,
          useValue: {
            get: () => of({}),
            post: (path: string, body: unknown) => {
              calls.push({ path, body });
              return post(path, body);
            },
          },
        },
        { provide: ToastService, useValue: { toasts: signal([]), error: jasmine.createSpy('error'), success: jasmine.createSpy('success') } },
      ],
    });
    const svc = TestBed.inject(BoltEmbedService) as unknown as {
      registerIframe: (el: unknown) => void;
      bootForSite: (s: unknown) => void;
      attachMessageListener: () => void;
      messageHandler: (e: MessageEvent) => void;
    };
    svc.registerIframe({ contentWindow: { postMessage: (m: Record<string, unknown>) => posted.push(m) } });
    if (bootSite) {
      svc.bootForSite({ id: 's1', slug: 'acme', business_name: 'Acme', status: 'published', current_build_version: 'v1' });
    }
    svc.attachMessageListener();
    const fire = (origin: string, data: unknown): void =>
      svc.messageHandler(new MessageEvent('message', { origin, data }));
    return { fire, posted, calls };
  }

  it('POSTs /api/resolve with {prompt, siteId} and replies PS_RESOLVE_RESPONSE with the worker body on 200', async () => {
    const body = {
      research: [
        { provider: 'openai', ok: true, model: 'gpt-5', content: 'leg A' },
        { provider: 'anthropic', ok: true, model: 'claude-fable-5', content: 'leg B' },
      ],
      synthesis: { provider: 'anthropic', model: 'claude-fable-5', content: 'the combined answer' },
    };
    const { fire, posted, calls } = resolveSetup(() => of(body));

    fire(TRUSTED, { type: 'PS_RESOLVE_REQUEST', correlationId: 'r1', prompt: 'research Acme Co' });
    await new Promise((r) => setTimeout(r, 0));

    // The worker POST carried {prompt, siteId} to the authed /resolve route.
    const call = calls.find((c) => c.path === '/resolve');
    expect(call).withContext('POST /resolve was called').toBeDefined();
    expect(call!.body).toEqual({ prompt: 'research Acme Co', siteId: 's1' });

    // The reply carries the worker's TOP-LEVEL research + synthesis (not a nested data envelope).
    const reply = last(posted, 'PS_RESOLVE_RESPONSE')!;
    expect(reply).toBeDefined();
    expect(reply['ok']).toBeTrue();
    expect(reply['research']).toEqual(body.research);
    expect(reply['synthesis']).toEqual(body.synthesis);
    expect(reply['dark']).toBeUndefined();
    expect(reply['data']).toBeUndefined();
  });

  it('replies {ok:false, dark:true} on a worker 404 (resolution_engine DARK flag / foreign site) — not an error', async () => {
    const err = new HttpErrorResponse({ status: 404, error: { error: { code: 'NOT_FOUND', message: 'Resource not found.' } } });
    const { fire, posted } = resolveSetup(() => throwError(() => err));

    fire(TRUSTED, { type: 'PS_RESOLVE_REQUEST', correlationId: 'r2', prompt: 'try when dark' });
    await new Promise((r) => setTimeout(r, 0));

    const reply = last(posted, 'PS_RESOLVE_RESPONSE')!;
    expect(reply['ok']).toBeFalse();
    expect(reply['dark']).withContext('404 → dark so the panel snaps to Single, not an error').toBeTrue();
    expect(reply['error']).toBeUndefined();
  });

  it('replies {ok:false} (NOT dark) on a non-404 transport failure (a real run failure)', async () => {
    const err = new HttpErrorResponse({ status: 502, error: { error: { code: 'ALL_PROVIDERS_FAILED' } } });
    const { fire, posted } = resolveSetup(() => throwError(() => err));

    fire(TRUSTED, { type: 'PS_RESOLVE_REQUEST', correlationId: 'r3', prompt: 'both legs down' });
    await new Promise((r) => setTimeout(r, 0));

    const reply = last(posted, 'PS_RESOLVE_RESPONSE')!;
    expect(reply['ok']).toBeFalse();
    expect(reply['dark']).withContext('a 502 is a genuine failure, not the dark flag').toBeUndefined();
    expect(reply['error']).toBeTruthy();
  });

  it('replies {ok:false} with no worker call when no site is selected (cannot scope the resolve)', async () => {
    const { fire, posted, calls } = resolveSetup(() => of({}), /* bootSite */ false);

    fire(TRUSTED, { type: 'PS_RESOLVE_REQUEST', correlationId: 'r4', prompt: 'no site' });
    await new Promise((r) => setTimeout(r, 0));

    expect(calls.some((c) => c.path === '/resolve')).withContext('no site → never calls the worker').toBeFalse();
    const reply = last(posted, 'PS_RESOLVE_RESPONSE')!;
    expect(reply['ok']).toBeFalse();
    expect(reply['error']).toBeTruthy();
    expect(reply['dark']).withContext('no-site is a plain failure, not the dark flag').toBeUndefined();
  });

  it('IGNORES a PS_RESOLVE_REQUEST from an untrusted origin (cross-frame injection guard)', async () => {
    const { fire, posted, calls } = resolveSetup(() => of({ research: [], synthesis: {} }));

    fire('https://evil.example.com', { type: 'PS_RESOLVE_REQUEST', correlationId: 'r5', prompt: 'inject' });
    await new Promise((r) => setTimeout(r, 0));

    expect(calls.some((c) => c.path === '/resolve')).withContext('untrusted origin → handler no-ops').toBeFalse();
    expect(last(posted, 'PS_RESOLVE_RESPONSE')).toBeUndefined();
  });
});

describe('BoltEmbedService (veil dismiss → editorReady)', () => {
  afterEach(() => TestBed.resetTestingModule());
  const ready = (svc: unknown): boolean => (svc as { editorReady(): boolean }).editorReady();
  const TRUSTED = 'https://editor.projectsites.dev';

  it('editorReady starts false (veil shown) and PS_APP_RUNNING from the trusted editor dismisses it', () => {
    const { svc, fire } = setup();
    expect(ready(svc)).withContext('veil shown until the iframe is interactive').toBeFalse();
    fire(TRUSTED, { type: 'PS_APP_RUNNING' });
    expect(ready(svc)).toBeTrue();
  });

  it('PS_BOLT_CHAT_READY advances the phase but does NOT dismiss early (no flicker — waits for true preview-ready)', () => {
    const { svc, fire } = setup();
    fire(TRUSTED, { type: 'PS_BOLT_CHAT_READY' });
    // The chat placeholder painting is NOT the ready signal. Dismissing here reveals bolt's
    // still-booting WebContainer underneath — the exact show→hide→show flicker we killed.
    // The veil stays up; the phase advances so the single progress bar fills.
    expect(ready(svc)).withContext('veil stays up until preview-ready').toBeFalse();
    expect(svc.loadingStage()).toBe('Preparing your site');
    expect(svc.loadingPhase()).toBe(2);
    // The TRUE ready signal still dismisses it cleanly.
    fire(TRUSTED, { type: 'PS_APP_RUNNING' });
    expect(ready(svc)).toBeTrue();
  });

  it('PS_GENERATION_STATUS preview_ready dismisses the veil', () => {
    const { svc, fire } = setup();
    fire(TRUSTED, { type: 'PS_GENERATION_STATUS', status: 'preview_ready' });
    expect(ready(svc)).toBeTrue();
  });

  it('PS_BOLT_FILES_LOADED dismisses the veil the instant files are in — synced with the in-iframe loader, not the blind chat-grace', () => {
    const { svc, fire } = setup();
    // The in-iframe editor loader fades on files-loaded; the parent veil must
    // dismiss on the SAME signal (accurate) instead of a fixed 10s guess, so the
    // hand-off is seamless.
    fire(TRUSTED, { type: 'PS_BOLT_FILES_LOADED' });
    expect(ready(svc)).withContext('all files loaded → editor is usable → reveal it now').toBeTrue();
  });

  it('a PS_BOLT_FILES_LOADED from an UNTRUSTED origin must NOT dismiss the veil (injection guard)', () => {
    const { svc, fire } = setup();
    fire('https://evil.example.com', { type: 'PS_BOLT_FILES_LOADED' });
    expect(ready(svc)).withContext('an untrusted frame cannot force the veil away').toBeFalse();
  });

  it('a veil-dismiss message from an UNTRUSTED origin must NOT force the editor ready (injection guard)', () => {
    const { svc, fire } = setup();
    fire('https://evil.example.com', { type: 'PS_APP_RUNNING' });
    expect(ready(svc)).withContext('an untrusted frame cannot dismiss the veil').toBeFalse();
  });
});
