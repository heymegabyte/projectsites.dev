import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { EnvVarsManagerComponent } from './env-vars-manager.component';
import { ApiService } from '../../services/api.service';
import { ToastService } from '../../services/toast.service';
import { ConfirmService } from '../../services/confirm.service';
import { Dialog } from '@angular/cdk/dialog';

/**
 * First coverage for EnvVarsManagerComponent — the per-scope AI Env Vars CRUD.
 * Validation contract: an env-var KEY is consumed by resolveEnvVarsForAI() at
 * inference time, so it MUST be a POSIX identifier ([A-Za-z_][A-Za-z0-9_]*).
 * The client previously relied solely on the (bypassable) native input pattern;
 * saveDraft now rejects a malformed key before the POST with a useful toast, and
 * the valid key is trimmed in the payload.
 */
function setup(): {
  fixture: ComponentFixture<EnvVarsManagerComponent>;
  cmp: EnvVarsManagerComponent;
  post: jasmine.Spy;
  toastErr: jasmine.Spy;
} {
  const post = jasmine.createSpy('post').and.returnValue(of({ var: { id: 'v1' } }));
  const get = jasmine.createSpy('get').and.returnValue(of({ data: [] }));
  const patch = jasmine.createSpy('patch').and.returnValue(of({ var: { id: 'v1' } }));
  const toastErr = jasmine.createSpy('error');
  TestBed.configureTestingModule({
    imports: [EnvVarsManagerComponent],
    providers: [
      { provide: ApiService, useValue: { get, post, patch, delete: () => of({}) } },
      { provide: ToastService, useValue: { error: toastErr, success: jasmine.createSpy('success') } },
      { provide: ConfirmService, useValue: { confirm: () => of(true) } },
      { provide: Dialog, useValue: { open: () => ({ closed: of(undefined) }) } },
    ],
  });
  const fixture = TestBed.createComponent(EnvVarsManagerComponent);
  fixture.componentRef.setInput('scope', 'org');
  const cmp = fixture.componentInstance;
  return { fixture, cmp, post, toastErr };
}

const noopEvent = { preventDefault() {} } as Event;

describe('EnvVarsManagerComponent (env-var key validation)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('rejects a key with spaces — toasts + no POST', () => {
    const { cmp, post, toastErr } = setup();
    cmp.draft.key = 'my key';
    cmp.draft.value = 'x';
    cmp.saveDraft(noopEvent);
    expect(post).not.toHaveBeenCalled();
    expect(toastErr).toHaveBeenCalled();
  });

  it('rejects a key starting with a digit', () => {
    const { cmp, post, toastErr } = setup();
    cmp.draft.key = '123token';
    cmp.draft.value = 'x';
    cmp.saveDraft(noopEvent);
    expect(post).not.toHaveBeenCalled();
    expect(toastErr).toHaveBeenCalled();
  });

  it('rejects a key with a hyphen / special char', () => {
    const { cmp, post, toastErr } = setup();
    cmp.draft.key = 'foo-bar';
    cmp.draft.value = 'x';
    cmp.saveDraft(noopEvent);
    expect(post).not.toHaveBeenCalled();
    expect(toastErr).toHaveBeenCalled();
  });

  it('still rejects an empty key/value (required)', () => {
    const { cmp, post, toastErr } = setup();
    cmp.draft.key = '';
    cmp.draft.value = '';
    cmp.saveDraft(noopEvent);
    expect(post).not.toHaveBeenCalled();
    expect(toastErr).toHaveBeenCalled();
  });

  it('accepts a valid POSIX key — POSTs with the trimmed key', () => {
    const { cmp, post } = setup();
    cmp.draft.key = '  API_TOKEN  ';
    cmp.draft.value = 'sk_live_x';
    cmp.saveDraft(noopEvent);
    expect(post).toHaveBeenCalledTimes(1);
    const [url, body] = post.calls.mostRecent().args as [string, { key: string }];
    expect(url).toBe('/env-vars');
    expect(body.key).toBe('API_TOKEN'); // trimmed
  });

  it('keyValid() / keyError() reflect the typed key', () => {
    const { cmp } = setup();
    cmp.draft.key = '';
    expect(cmp.keyValid()).toBe(false);
    expect(cmp.keyError()).toBeNull(); // empty → "required" path, not "invalid"
    cmp.draft.key = 'foo bar';
    expect(cmp.keyValid()).toBe(false);
    expect(cmp.keyError()).not.toBeNull();
    cmp.draft.key = '_internalKey9';
    expect(cmp.keyValid()).toBe(true);
    expect(cmp.keyError()).toBeNull();
  });

  // Empty-state-is-launchpad: with zero vars the empty state must offer a real
  // primary CTA (not instruct the owner to hunt for a header button), and that
  // CTA must open the inline add form via startAdd().
  it('renders a launchpad CTA in the empty state that opens the add form', () => {
    const { fixture, cmp } = setup();
    fixture.detectChanges(); // GET returns [] → vars().length === 0 → empty state
    const cta = fixture.nativeElement.querySelector(
      '[data-testid="ev-empty-cta"]',
    ) as HTMLButtonElement | null;
    expect(cta).withContext('empty-state CTA button must render').not.toBeNull();
    expect(cta!.textContent).toContain('Add your first variable');
    expect(cmp.addingOpen()).toBe(false);
    cta!.click();
    expect(cmp.addingOpen()).withContext('CTA opens the inline add form').toBe(true);
  });
});
