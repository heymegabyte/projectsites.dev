import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { AdminUserSettingsComponent } from './user-settings.component';
import { ApiService } from '../../../services/api.service';
import { ToastService } from '../../../services/toast.service';
import { AuthService } from '../../../services/auth.service';
import { ConfirmService } from '../../../services/confirm.service';
import { HttpClient } from '@angular/common/http';

/**
 * First coverage for User Settings — focus on the SECURITY-critical destructive
 * account-deletion guard (the "verify destructive actions" mandate) + the
 * notification-pref toggle. The guarantee: performDelete() fires NO request
 * unless the user typed exactly "delete" (case-insensitive) — a misclick or a
 * partial word can't delete the account. overrideComponent strips the template.
 */
function make(del = jasmine.createSpy('delete').and.returnValue(throwError(() => ({ status: 404 })))): {
  c: AdminUserSettingsComponent;
  http: { get: jasmine.Spy; delete: jasmine.Spy; post: jasmine.Spy };
  toast: { error: jasmine.Spy; success: jasmine.Spy };
} {
  const http = { get: jasmine.createSpy('get').and.returnValue(of({})), post: jasmine.createSpy('post').and.returnValue(of({})), put: () => of({}), delete: del };
  const toast = { error: jasmine.createSpy('error'), success: jasmine.createSpy('success') };
  TestBed.configureTestingModule({
    imports: [AdminUserSettingsComponent],
    providers: [
      { provide: ApiService, useValue: http },
      { provide: ToastService, useValue: toast },
      { provide: AuthService, useValue: { email: () => 'test@megabyte.space', user: () => ({}), signOut: () => undefined } },
      { provide: ConfirmService, useValue: { confirm: () => Promise.resolve(true) } },
      { provide: HttpClient, useValue: http },
    ],
  });
  TestBed.overrideComponent(AdminUserSettingsComponent, { set: { template: '<div></div>', imports: [] } });
  return { c: TestBed.createComponent(AdminUserSettingsComponent).componentInstance, http, toast };
}

describe('AdminUserSettingsComponent (destructive delete guard + notifications)', () => {
  afterEach(() => { try { localStorage.clear(); } catch { /* */ } TestBed.resetTestingModule(); });

  it('performDelete is a NO-OP unless the confirm text is exactly "delete my account"', () => {
    const { c, http } = make();
    c.deleteConfirm = '';
    c.performDelete();
    c.deleteConfirm = 'del';
    c.performDelete();
    // The bare word "delete" is now insufficient — the deliberate full phrase
    // is required so a destructive irreversible action can't be typed reflexively.
    c.deleteConfirm = 'delete';
    c.performDelete();
    c.deleteConfirm = 'delete account';
    c.performDelete();
    expect(http.delete).not.toHaveBeenCalled();
  });

  it('fires the delete only with an exact (case-insensitive, trimmed) "delete my account" confirm', () => {
    const { c, http } = make();
    c.deleteConfirm = '  DELETE MY ACCOUNT  ';
    c.performDelete();
    // Passed `{ silent: true }` so the generic ApiService toast is suppressed —
    // performDelete owns the user-facing message, so this avoids a double-toast.
    expect(http.delete).toHaveBeenCalledWith('/admin/account', { silent: true });
  });

  it('on a delete failure, surfaces ONE specific error (silent api call → no generic double-toast) + clears deleting', () => {
    const { c, http, toast } = make();
    c.deleteConfirm = 'delete my account';
    c.performDelete();
    // The destructive call is silenced at the ApiService layer…
    expect(http.delete).toHaveBeenCalledWith('/admin/account', { silent: true });
    // …and the component surfaces its own single, actionable message.
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error.calls.mostRecent().args[0]).toContain('hey@megabyte.space');
    expect(c.deleting()).toBe(false);
  });

  it('openDeleteAccount opens the dialog and resets the confirm text', () => {
    const { c } = make();
    c.deleteConfirm = 'stale';
    c.openDeleteAccount();
    expect(c.deleteOpen()).toBe(true);
    expect(c.deleteConfirm).toBe('');
  });

  it('closeDeleteDialog is blocked mid-deletion (cannot dismiss while a delete is in flight)', () => {
    const { c } = make();
    c.deleteOpen.set(true);
    c.deleting.set(true);
    c.closeDeleteDialog();
    expect(c.deleteOpen()).toBe(true); // still open
    c.deleting.set(false);
    c.closeDeleteDialog();
    expect(c.deleteOpen()).toBe(false);
  });

  it('toggleNotification flips the target pref and fires a DEBOUNCED fire-and-forget sync', () => {
    jasmine.clock().install();
    try {
      const { c, http } = make();
      const g = c.notificationGroups()[0];
      const p = g.prefs[0];
      const before = p.enabled;
      c.toggleNotification(g.id, p.id);
      const after = c.notificationGroups()[0].prefs[0].enabled;
      expect(after).toBe(!before);
      expect(http.post).withContext('sync is debounced — nothing on the click tick').not.toHaveBeenCalled();
      jasmine.clock().tick(800);
      expect(http.post).toHaveBeenCalled();
    } finally {
      jasmine.clock().uninstall();
    }
  });

  it('toggleNotification is a NO-OP on locked security prefs (stay on by design — cannot be muted)', () => {
    const { c } = make();
    const sec = c.notificationGroups().find((g) => g.id === 'security');
    expect(sec).withContext('security group exists').toBeTruthy();
    for (const p of sec!.prefs) {
      expect(p.locked).withContext(`${p.id} is locked`).toBe(true);
      expect(p.enabled).withContext(`${p.id} starts on`).toBe(true);
      c.toggleNotification('security', p.id);
      const after = c
        .notificationGroups()
        .find((g) => g.id === 'security')!
        .prefs.find((x) => x.id === p.id)!.enabled;
      expect(after).withContext(`${p.id} stays on after a mute attempt`).toBe(true);
    }
  });

  it('toggleNotification surfaces a visible "Saved" confirmation (no silent save)', () => {
    const { c } = make();
    const g = c.notificationGroups()[0];
    expect(c.notifSaved()).toBe(false);
    c.toggleNotification(g.id, g.prefs[0].id);
    expect(c.notifSaved()).toBe(true);
  });

  it('writes the choice to localStorage SYNCHRONOUSLY (device-local source of truth lands before the debounce)', () => {
    jasmine.clock().install();
    try {
      const { c } = make();
      const g = c.notificationGroups()[0];
      const p = g.prefs[0];
      const wasEnabled = p.enabled;
      c.toggleNotification(g.id, p.id); // NO tick — the local write must not wait on the debounce
      const stored = JSON.parse(localStorage.getItem('ps_notification_prefs') ?? '{}') as Record<string, boolean>;
      expect(stored[p.id]).withContext('localStorage persists on the click, not after the debounced sync').toBe(!wasEnabled);
    } finally {
      jasmine.clock().uninstall();
    }
  });

  it('coalesces a BURST of toggles into a SINGLE server sync (debounce, not one request per click)', () => {
    jasmine.clock().install();
    try {
      const { c, http } = make();
      const g = c.notificationGroups()[0];
      c.toggleNotification(g.id, g.prefs[0].id);
      c.toggleNotification(g.id, g.prefs[1].id);
      c.toggleNotification(g.id, g.prefs[0].id);
      jasmine.clock().tick(800);
      expect(http.post).withContext('three rapid toggles → one coalesced request').toHaveBeenCalledTimes(1);
    } finally {
      jasmine.clock().uninstall();
    }
  });

  it('STOPS re-firing the sync after it fails once (no silent guaranteed-404 on every later toggle)', () => {
    jasmine.clock().install();
    try {
      const { c, http } = make();
      http.post.and.returnValue(throwError(() => ({ status: 404 })));
      const g = c.notificationGroups()[0];
      c.toggleNotification(g.id, g.prefs[0].id);
      jasmine.clock().tick(800); // first sync fires → 404 → latches unavailable
      expect(http.post).toHaveBeenCalledTimes(1);
      c.toggleNotification(g.id, g.prefs[1].id);
      jasmine.clock().tick(800); // must NOT fire again
      expect(http.post).withContext('a missing/erroring sync route is not hammered on every later toggle').toHaveBeenCalledTimes(1);
    } finally {
      jasmine.clock().uninstall();
    }
  });

  it('the debounced sync still posts the FULL pref map (forward-compatible), not just {group,pref}', () => {
    jasmine.clock().install();
    try {
      const { c, http } = make();
      const g = c.notificationGroups()[0];
      const p = g.prefs[0];
      const wasEnabled = p.enabled;
      c.toggleNotification(g.id, p.id);
      jasmine.clock().tick(800);
      const body = http.post.calls.mostRecent().args[1] as { prefs?: Record<string, boolean> };
      expect(body.prefs).toEqual(jasmine.any(Object));
      // The toggled pref's NEW state is present in the synced map.
      expect(body.prefs?.[p.id]).toBe(!wasEnabled);
    } finally {
      jasmine.clock().uninstall();
    }
  });

  it('the debounced sync is SILENT (never toasts the user on a forward-compat 404)', () => {
    jasmine.clock().install();
    try {
      const { c, http } = make();
      const g = c.notificationGroups()[0];
      c.toggleNotification(g.id, g.prefs[0].id);
      jasmine.clock().tick(800);
      const opts = http.post.calls.mostRecent().args[2] as { silent?: boolean } | undefined;
      expect(opts?.silent).withContext('fire-and-forget sync must pass { silent: true } so a 404 never nags').toBe(true);
    } finally {
      jasmine.clock().uninstall();
    }
  });

  // ── Cross-device hydrate (GET /admin/notifications on load) ──
  const hydrate = (c: AdminUserSettingsComponent) =>
    (c as unknown as { hydrateNotificationPrefs(): void }).hydrateNotificationPrefs();

  it('hydrate applies the server pref map over the groups (cross-device) + refreshes localStorage', () => {
    const { c, http } = make();
    const p = c.notificationGroups()[0].prefs[0];
    const flipped = !p.enabled;
    http.get.and.returnValue(of({ data: { prefs: { [p.id]: flipped } } }));
    hydrate(c);
    expect(c.notificationGroups()[0].prefs[0].enabled).withContext('server value wins on load').toBe(flipped);
    const stored = JSON.parse(localStorage.getItem('ps_notification_prefs') ?? '{}') as Record<string, boolean>;
    expect(stored[p.id]).withContext('local cache refreshed to match the server').toBe(flipped);
  });

  it('hydrate reads the server route SILENTLY (no toast if the route is not live)', () => {
    const { c, http } = make();
    hydrate(c);
    const opts = http.get.calls.mostRecent().args[2] as { silent?: boolean } | undefined;
    expect(opts?.silent).toBe(true);
  });

  it('hydrate is a NO-OP when the server returns no prefs (keeps local state)', () => {
    const { c, http } = make();
    const before = c.notificationGroups()[0].prefs[0].enabled;
    http.get.and.returnValue(of({ data: { prefs: {} } }));
    hydrate(c);
    expect(c.notificationGroups()[0].prefs[0].enabled).toBe(before);
  });

  it('hydrate leaves local prefs UNTOUCHED when the route errors (not-yet-deployed / offline)', () => {
    const { c, http } = make();
    const before = c.notificationGroups()[0].prefs[0].enabled;
    http.get.and.returnValue(throwError(() => ({ status: 404 })));
    hydrate(c);
    expect(c.notificationGroups()[0].prefs[0].enabled).withContext('a 404 must not wipe the local choices').toBe(before);
  });

  it('hydrate keeps the LOCAL value for pref ids the server has not seen (forward-compatible)', () => {
    const { c, http } = make();
    const all = c.notificationGroups().flatMap((g) => g.prefs);
    const known = all[0];
    const unseen = all[1];
    const unseenBefore = unseen.enabled;
    // Server only knows about `known` — `unseen` must retain its local value.
    http.get.and.returnValue(of({ data: { prefs: { [known.id]: !known.enabled } } }));
    hydrate(c);
    const after = c.notificationGroups().flatMap((g) => g.prefs);
    expect(after.find((p) => p.id === known.id)?.enabled).toBe(!known.enabled);
    expect(after.find((p) => p.id === unseen.id)?.enabled).withContext('a pref the server has not seen stays at its local value').toBe(unseenBefore);
  });

  it('showKeyExpiry hides a REVOKED key\'s future expiry (a dead key must not advertise a future date)', () => {
    const { c } = make();
    expect(c.showKeyExpiry({ active: false, expires_at: '2026-11-24T00:00:00Z' }))
      .withContext('revoked key → its future expiry is moot, render — not a date')
      .toBe(false);
    expect(c.showKeyExpiry({ active: true, expires_at: '2026-11-24T00:00:00Z' }))
      .withContext('active key with an expiry → show the date')
      .toBe(true);
    expect(c.showKeyExpiry({ active: true, expires_at: null }))
      .withContext('active key that never expires → dash')
      .toBe(false);
  });
});

/**
 * API-key rotate/revoke are now MODAL-confirm-gated (not auto-dismissing toasts):
 * both break live API clients immediately + irreversibly (old secret dies / 401),
 * so they must go through ConfirmService — deliberate, focus-trapped, no
 * auto-dismiss. Matches account-delete + apps-instances destroy.
 */
describe('AdminUserSettingsComponent (API-key rotate/revoke are modal-confirm-gated)', () => {
  function makeKeys(confirm: () => Promise<boolean>): { c: AdminUserSettingsComponent; del: jasmine.Spy; post: jasmine.Spy } {
    const del = jasmine.createSpy('delete').and.returnValue(of({}));
    const post = jasmine.createSpy('post').and.returnValue(of({ data: { token: 'k', id: 'new' } }));
    const http = { get: () => of({}), post, put: () => of({}), delete: del };
    TestBed.configureTestingModule({
      imports: [AdminUserSettingsComponent],
      providers: [
        { provide: ApiService, useValue: http },
        { provide: ToastService, useValue: { error: () => 0, success: () => 0, warning: () => 0 } },
        { provide: AuthService, useValue: { email: () => 'test@megabyte.space', user: () => ({}), signOut: () => undefined } },
        { provide: ConfirmService, useValue: { confirm } },
        { provide: HttpClient, useValue: http },
      ],
    });
    TestBed.overrideComponent(AdminUserSettingsComponent, { set: { template: '<div></div>', imports: [] } });
    return { c: TestBed.createComponent(AdminUserSettingsComponent).componentInstance, del, post };
  }
  afterEach(() => TestBed.resetTestingModule());

  it('revokeKey does NOT DELETE when the confirm is cancelled', async () => {
    const { c, del } = makeKeys(() => Promise.resolve(false));
    await c.revokeKey({ id: 'k1', name: 'CI key' });
    expect(del).not.toHaveBeenCalled();
  });

  it('revokeKey DELETEs {silent} after the modal confirm (its own toast is the sole message)', async () => {
    const { c, del } = makeKeys(() => Promise.resolve(true));
    await c.revokeKey({ id: 'k1', name: 'CI key' });
    // {silent}: performRevoke owns 'Could not revoke …' on failure — without it
    // ApiService's generic toast double-fires.
    expect(del).toHaveBeenCalledWith('/admin/api-keys/k1', { silent: true });
  });

  it('rotateKey does NOT mint a new key when the confirm is cancelled', async () => {
    const { c, post } = makeKeys(() => Promise.resolve(false));
    await c.rotateKey({ id: 'k1', name: 'CI key', scopes: [], created_at: '' } as never);
    expect(post).not.toHaveBeenCalled();
  });

  it('rotateKey revokes the OLD key {silent} (its own warning is the sole message)', async () => {
    const { c, del } = makeKeys(() => Promise.resolve(true));
    await c.rotateKey({ id: 'k1', name: 'CI key', scopes: [], created_at: '' } as never);
    // The inner revoke-old-key DELETE surfaces its own toast.warning on failure;
    // {silent} stops the generic error toast double-firing over it.
    expect(del).toHaveBeenCalledWith('/admin/api-keys/k1', { silent: true });
  });
});

/**
 * Active-sessions security surface: the "Revoke all other sessions" affordance
 * must reflect the real count of OTHER (non-current) sessions — gating on it
 * (not a raw length > 1) so the button can't show when the only "other" rows
 * are stale duplicates of the current device, and the label tells the operator
 * exactly how many sign-outs the click triggers.
 */
describe('AdminUserSettingsComponent (active sessions — other-session count)', () => {
  afterEach(() => { try { localStorage.clear(); } catch { /* */ } TestBed.resetTestingModule(); });

  it('otherSessionsCount() counts only non-current sessions', () => {
    const { c } = make();
    c.sessions.set([
      { id: 'a', current: true },
      { id: 'b', current: false },
      { id: 'c' }, // undefined current === not current
    ]);
    expect(c.otherSessionsCount()).toBe(2);
  });

  it('otherSessionsCount() is 0 when only the current device is signed in (button hidden)', () => {
    const { c } = make();
    c.sessions.set([{ id: 'a', current: true }]);
    expect(c.otherSessionsCount()).toBe(0);
  });
});

/**
 * API-keys load resilience against a STALE worker route.
 *
 * A not-yet-deployed `/api/admin/api-keys` returns 200 with the marketing/SPA
 * HTML body, NOT a 4xx — so the request SUCCEEDS but `r.data` is `undefined`
 * (no array). The old `next: r => apiKeys.set(r.data ?? [])` collapsed that into
 * an empty list, rendering the misleading "No API keys yet" empty state — it
 * tells the operator they have zero keys when the route simply isn't live.
 *
 * The graceful contract (mirrors site-features.component's Array.isArray guard):
 * a non-array body is treated as "couldn't load — route not available yet" so
 * the honest, retryable error card shows instead of a fake-empty panel.
 */
describe('AdminUserSettingsComponent (API-keys load — stale-route resilience)', () => {
  afterEach(() => { try { localStorage.clear(); } catch { /* */ } TestBed.resetTestingModule(); });

  it('a 200 with a NON-array body (stale SPA-HTML route) surfaces a retryable error, NOT a fake-empty list', () => {
    const { c, http } = make();
    // Stale route → 200 but the JSON parse yields the SPA shape (no `data` array).
    http.get.and.returnValue(of({}));
    c.loadApiKeys();
    expect(c.apiKeys()).withContext('must NOT render the "No API keys yet" empty state').toEqual([]);
    expect(c.keysError()).withContext('honest "not available" message → Retry card shows').toBeTruthy();
    expect(c.loadingKeys()).toBe(false);
  });

  it('a healthy JSON response ({ data: [...] }) populates the table and clears any error', () => {
    const { c, http } = make();
    http.get.and.returnValue(of({ data: [{ id: 'k1', name: 'CI', prefix: 'psk_abc', scopes: ['read'], last_used_at: null, expires_at: null, active: true }] }));
    c.loadApiKeys();
    expect(c.apiKeys().length).toBe(1);
    expect(c.keysError()).toBeNull();
    expect(c.loadingKeys()).toBe(false);
  });

  it('an EMPTY-but-valid array ({ data: [] }) is an honest empty state, NOT an error', () => {
    const { c, http } = make();
    http.get.and.returnValue(of({ data: [] }));
    c.loadApiKeys();
    expect(c.apiKeys()).toEqual([]);
    expect(c.keysError()).withContext('a real empty list is not an error — show "No API keys yet"').toBeNull();
  });

  it('a hard error still surfaces the retryable error card', () => {
    const { c, http } = make();
    http.get.and.returnValue(throwError(() => ({ status: 500, error: { error: { message: 'boom' } } })));
    c.loadApiKeys();
    expect(c.keysError()).toBe('boom');
    expect(c.apiKeys()).toEqual([]);
  });

  // The shared <app-error-card> surfaces a copyable worker request_id so a stuck
  // operator can hand it to support — capture it from the failed response body.
  it('captures the worker request_id into keysErrorRef on a hard error', () => {
    const { c, http } = make();
    http.get.and.returnValue(throwError(() => ({ status: 500, error: { error: { request_id: 'req-keys-7' } } })));
    c.loadApiKeys();
    expect(c.keysErrorRef()).toBe('req-keys-7');
  });

  it('keysErrorRef is empty for a stale-route shapeless 200 (no err object) + clears on a healthy reload', () => {
    const { c, http } = make();
    http.get.and.returnValue(of({})); // stale SPA-HTML → keysError set, but no err → no ref
    c.loadApiKeys();
    expect(c.keysError()).toBeTruthy();
    expect(c.keysErrorRef()).toBe('');
    http.get.and.returnValue(of({ data: [] }));
    c.loadApiKeys();
    expect(c.keysError()).toBeNull();
    expect(c.keysErrorRef()).toBe('');
  });
});

import { NEVER } from 'rxjs';

/**
 * Session revoke / revoke-all are toast-armed (7s action, re-clickable
 * mid-async). A re-entrant revoke must NOT fire a duplicate DELETE/POST.
 */
describe('AdminUserSettingsComponent (session-revoke in-flight guards)', () => {
  afterEach(() => TestBed.resetTestingModule());

  function mk(del: jasmine.Spy, post: jasmine.Spy): AdminUserSettingsComponent {
    const http = { get: () => of({}), post, put: () => of({}), delete: del };
    TestBed.configureTestingModule({
      imports: [AdminUserSettingsComponent],
      providers: [
        { provide: ApiService, useValue: http },
        { provide: ToastService, useValue: { error: () => 0, success: () => 0, warning: () => 0, info: () => 0 } },
        { provide: AuthService, useValue: { email: () => 'x', user: () => ({}), signOut: () => undefined } },
        { provide: ConfirmService, useValue: { confirm: () => Promise.resolve(true) } },
        { provide: HttpClient, useValue: http },
      ],
    });
    TestBed.overrideComponent(AdminUserSettingsComponent, { set: { template: '<div></div>', imports: [] } });
    return TestBed.createComponent(AdminUserSettingsComponent).componentInstance;
  }

  it('per-session revoke: a re-entrant revoke of the same session fires one DELETE', () => {
    const del = jasmine.createSpy('delete').and.returnValue(NEVER);
    const c = mk(del, jasmine.createSpy('post').and.returnValue(NEVER));
    const pr = (c as unknown as { performRevokeSession: (s: unknown) => void }).performRevokeSession.bind(c);
    pr({ id: 'sess1' });
    pr({ id: 'sess1' });
    expect(del).withContext('no duplicate DELETE').toHaveBeenCalledTimes(1);
    expect((c as unknown as { isRevokingSession: (id: string) => boolean }).isRevokingSession('sess1')).toBeTrue();
  });

  it('revoke-all: a re-entrant revoke-all fires one POST', () => {
    const post = jasmine.createSpy('post').and.returnValue(NEVER);
    const c = mk(jasmine.createSpy('delete').and.returnValue(NEVER), post);
    const pa = (c as unknown as { performRevokeAll: () => void }).performRevokeAll.bind(c);
    pa();
    pa();
    expect(post).withContext('no duplicate POST').toHaveBeenCalledTimes(1);
    expect((c as unknown as { revokingAll: () => boolean }).revokingAll()).toBeTrue();
  });
});

/**
 * Delete-account confirm UX (the most destructive action). The confirm-by-typing
 * input needs (a) a programmatic accessible NAME — placeholder + a sibling <p> is
 * not a label for a screen reader — and (b) a VISIBLE cue the moment the exact
 * phrase matches, so the user understands WHY the disabled "Delete forever" button
 * just became active. Full-render (the `make` harness strips the template).
 */
describe('AdminUserSettingsComponent (delete-account confirm: a11y name + visible match cue)', () => {
  afterEach(() => TestBed.resetTestingModule());

  function render(): { fx: ReturnType<typeof TestBed.createComponent<AdminUserSettingsComponent>>; c: AdminUserSettingsComponent } {
    const http = { get: () => of({}), post: () => of({}), put: () => of({}), delete: () => of({}) };
    TestBed.configureTestingModule({
      imports: [AdminUserSettingsComponent],
      providers: [
        { provide: ApiService, useValue: http },
        { provide: ToastService, useValue: { error: () => 0, success: () => 0 } },
        { provide: AuthService, useValue: { email: () => 'test@megabyte.space', user: () => ({}), signOut: () => undefined, getToken: () => 'test-token', session: () => ({ role: 'owner', user_id: 'u1' }) } },
        { provide: ConfirmService, useValue: { confirm: () => Promise.resolve(true) } },
        { provide: HttpClient, useValue: http },
      ],
    });
    const fx = TestBed.createComponent(AdminUserSettingsComponent);
    fx.detectChanges();
    return { fx, c: fx.componentInstance };
  }

  it('the confirm input carries a programmatic accessible name (aria-label)', () => {
    const { fx, c } = render();
    c.deleteOpen.set(true);
    fx.detectChanges();
    const input = (fx.nativeElement as HTMLElement).querySelector('[data-testid="delete-account-confirm-input"]') as HTMLInputElement;
    expect(input).withContext('delete-confirm input renders').not.toBeNull();
    expect((input.getAttribute('aria-label') || '').trim().length).withContext('input has a non-empty accessible name').toBeGreaterThan(0);
  });

  it('shows the cyan "phrase confirmed" cue ONLY once the exact phrase is typed', () => {
    const { fx, c } = render();
    c.deleteOpen.set(true);
    c.deleteConfirm = 'delete';
    fx.detectChanges();
    expect((fx.nativeElement as HTMLElement).querySelector('[data-testid="delete-confirm-ready"]'))
      .withContext('no cue while the phrase is incomplete').toBeNull();
    c.deleteConfirm = 'Delete My Account'; // case-insensitive match
    fx.detectChanges();
    expect((fx.nativeElement as HTMLElement).querySelector('[data-testid="delete-confirm-ready"]'))
      .withContext('cue appears when the phrase matches (case-insensitive)').not.toBeNull();
  });

  // Heading-hierarchy regression (2026-08-26): /admin/user rendered with ZERO
  // <h1> — its outline started at h2 "User settings" — while sibling sections
  // (settings/social) expose their page heading as `<h1 class="section-h">`. A
  // view that opens at h2 with no h1 breaks WCAG 1.3.1 / 2.4.6. This guards the
  // account view keeps exactly one h1 as its first heading. Runs in CI (Karma).
  it('renders exactly one <h1> as its first heading (no h2-first / zero-h1 regression)', () => {
    const { fx } = render();
    const host = fx.nativeElement as HTMLElement;
    const h1s = Array.from(host.querySelectorAll('h1'));
    expect(h1s.length).withContext('the account view must expose exactly one h1').toBe(1);
    expect((h1s[0]?.textContent || '').trim()).withContext('the h1 is the page heading').toContain('User settings');
    const headings = Array.from(host.querySelectorAll('h1, h2, h3, h4, h5, h6'));
    expect(headings[0]?.tagName).withContext('the FIRST heading in the view must be the h1, not an h2').toBe('H1');
    // No heading-level skips (h1→h3 is a WCAG 1.3.1 order violation): each heading
    // may descend at most one level below the previous. Guards the h3→h2/h4→h3
    // promotion that removed the h1→h3 skip left by adding the h1.
    const levels = headings.map((h) => Number(h.tagName[1]));
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i] - levels[i - 1])
        .withContext(`heading #${i} (h${levels[i]}) must not skip a level after h${levels[i - 1]}`)
        .toBeLessThanOrEqual(1);
    }
  });
});
