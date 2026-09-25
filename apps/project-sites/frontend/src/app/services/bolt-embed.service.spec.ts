import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of } from 'rxjs';
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
