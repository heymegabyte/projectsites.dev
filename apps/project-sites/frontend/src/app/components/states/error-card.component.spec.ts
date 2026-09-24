import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ErrorCardComponent } from './error-card.component';

/**
 * Regression guard for the admin-wide error-state primitive. Locks the a11y
 * contract (host role=alert + aria-live=assertive so AT announces failures
 * immediately) and the conditional render contract (message / correlationId +
 * copy / retry), so a refactor can't silently regress error UX or the
 * support-handoff reference id.
 */
describe('ErrorCardComponent', () => {
  let fixture: ComponentFixture<ErrorCardComponent>;
  let host: HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [ErrorCardComponent] }).compileComponents();
    fixture = TestBed.createComponent(ErrorCardComponent);
    host = fixture.nativeElement as HTMLElement;
  });

  const q = (sel: string): HTMLElement | null => host.querySelector(sel);

  it('creates', () => {
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('announces failures assertively (host role=alert, aria-live=assertive)', () => {
    expect(host.getAttribute('role')).toBe('alert');
    expect(host.getAttribute('aria-live')).toBe('assertive');
  });

  it('renders the required title', () => {
    fixture.componentRef.setInput('title', 'Could not load sites');
    fixture.detectChanges();
    expect(q('[data-testid="error-title"]')?.textContent?.trim()).toBe('Could not load sites');
  });

  it('renders the message only when provided', () => {
    fixture.componentRef.setInput('title', 'Error');
    fixture.detectChanges();
    expect(q('.ec-msg')).toBeNull();

    fixture.componentRef.setInput('message', 'The server returned 500.');
    fixture.detectChanges();
    expect(q('.ec-msg')?.textContent?.trim()).toBe('The server returned 500.');
  });

  it('shows the correlation id + copy button only when a correlationId is set', () => {
    fixture.componentRef.setInput('title', 'Error');
    fixture.detectChanges();
    expect(q('[data-testid="error-correlation"]')).toBeNull();
    expect(q('[data-testid="error-copy"]')).toBeNull();

    fixture.componentRef.setInput('correlationId', 'req_abc123');
    fixture.detectChanges();
    expect(q('[data-testid="error-correlation"]')?.textContent?.trim()).toBe('req_abc123');
    expect(q('[data-testid="error-copy"]')).not.toBeNull();
  });

  // The default hint must not promise a reference that isn't shown. When NO
  // correlationId is set, the reference block is hidden — so the hint must not
  // say "copy the reference below" (a false promise, seen live on marketplace /
  // apps-instances / site-mcp error states). It only makes that promise when a
  // reference actually renders.
  it('default hint does NOT promise a reference when no correlationId is shown', () => {
    fixture.componentRef.setInput('title', 'Error');
    fixture.detectChanges();
    const hint = q('.ec-hint')?.textContent?.trim() ?? '';
    expect(hint).withContext('no false promise of a missing reference').not.toContain('reference below');
    expect(hint).toContain('support'); // still points to recovery
    expect(q('[data-testid="error-correlation"]')).toBeNull(); // confirm no reference is rendered
  });

  it('default hint promises the reference once a correlationId IS shown', () => {
    fixture.componentRef.setInput('title', 'Error');
    fixture.componentRef.setInput('correlationId', 'req_xyz789');
    fixture.detectChanges();
    expect(q('.ec-hint')?.textContent?.trim() ?? '').toContain('reference below');
    expect(q('[data-testid="error-correlation"]')?.textContent?.trim()).toBe('req_xyz789');
  });

  it('an explicit hint override is respected verbatim (regardless of correlationId)', () => {
    fixture.componentRef.setInput('title', 'Error');
    fixture.componentRef.setInput('hint', 'Check your connection and retry.');
    fixture.detectChanges();
    expect(q('.ec-hint')?.textContent?.trim()).toBe('Check your connection and retry.');
  });

  // The default hint is a signal `computed()` (migrated from a getter) → it must react
  // when a correlationId arrives AFTER first render, not stay stale.
  it('default hint reactively flips to promise the reference when a correlationId arrives later', () => {
    fixture.componentRef.setInput('title', 'Error');
    fixture.detectChanges();
    expect(q('.ec-hint')?.textContent ?? '').not.toContain('reference below'); // none yet
    fixture.componentRef.setInput('correlationId', 'req_late');
    fixture.detectChanges();
    expect(q('.ec-hint')?.textContent ?? '').toContain('reference below'); // computed updated
  });

  it('emits retry when the retry button is activated', () => {
    fixture.componentRef.setInput('title', 'Error');
    fixture.detectChanges();
    const retry = q('[data-testid="error-retry"]') as HTMLButtonElement | null;
    expect(retry).not.toBeNull();
    expect(retry?.tagName).toBe('BUTTON');

    let emitted = 0;
    fixture.componentInstance.retry.subscribe(() => (emitted += 1));
    retry?.click();
    expect(emitted).toBe(1);
  });
});
