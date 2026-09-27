import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ScriptErrorsCardComponent, type JsErrorsBlock } from './script-errors-card.component';

function render(jsErrors?: JsErrorsBlock) {
  const fixture = TestBed.createComponent(ScriptErrorsCardComponent);
  fixture.componentRef.setInput('jsErrors', jsErrors);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

describe('ScriptErrorsCardComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders the total, distinct-count, and a row per grouped message with count + sample path', () => {
    const { fixture, el } = render({
      total: 15,
      byMessage: [
        { message: "Cannot read properties of undefined (reading 'x')", count: 12, samplePath: '/pricing' },
        { message: 'ChunkLoadError', count: 3 },
      ],
    });
    const total = el.querySelector('[data-testid="an-script-errors-total"]')!.textContent ?? '';
    expect(total).toContain('15 errors');
    expect(total).toContain('2 distinct');
    const rows = fixture.debugElement.queryAll(By.css('[data-testid="an-script-error-row"]'));
    expect(rows.length).toBe(2);
    expect(rows[0].nativeElement.textContent).toContain("Cannot read properties of undefined");
    expect(rows[0].nativeElement.textContent).toContain('12×');
    expect(rows[0].nativeElement.textContent).toContain('/pricing'); // sample path shown
    // The clean state is NOT shown when errors exist.
    expect(el.querySelector('[data-testid="an-script-errors-clean"]')).toBeNull();
  });

  it('singularizes a single error', () => {
    const { el } = render({ total: 1, byMessage: [{ message: 'boom', count: 1 }] });
    expect(el.querySelector('[data-testid="an-script-errors-total"]')!.textContent).toContain('1 error ');
  });

  it('shows a green "running clean" state (a real 0, never "not measured") when there are no errors', () => {
    const { el } = render({ total: 0, byMessage: [] });
    const clean = el.querySelector('[data-testid="an-script-errors-clean"]');
    expect(clean).toBeTruthy();
    expect(clean!.textContent).toContain('running clean');
    expect(el.querySelector('[data-testid="an-script-errors-total"]')).toBeNull();
  });

  it('treats an undefined block (older payload) as clean — never crashes', () => {
    const { el } = render(undefined);
    expect(el.querySelector('[data-testid="an-script-errors-clean"]')).toBeTruthy();
  });
});
