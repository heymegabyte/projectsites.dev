import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { FormFunnelCardComponent, type FormFunnel } from './form-funnel-card.component';

/**
 * FormFunnelCardComponent — the contact-form lead funnel card. Load-bearing properties: it renders
 * the real starts→submits funnel with a completion rate, shows an honest empty state (never a
 * fabricated 0%), renders "—" (not 0%) when the rate is null, surfaces the lost-lead gap, and only
 * shows the per-form breakdown when more than one form has activity.
 */
function render(funnel: FormFunnel | null, windowDays = 30) {
  TestBed.configureTestingModule({ imports: [FormFunnelCardComponent] });
  const fixture = TestBed.createComponent(FormFunnelCardComponent);
  fixture.componentRef.setInput('funnel', funnel);
  fixture.componentRef.setInput('windowDays', windowDays);
  fixture.detectChanges();
  return fixture;
}

function rateText(f: ReturnType<typeof render>): string {
  return (
    f.debugElement.query(By.css('[data-testid="an-form-funnel-rate"]'))?.nativeElement as HTMLElement
  )?.textContent?.trim();
}

describe('FormFunnelCardComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders the completion rate + started/submitted counts when there is activity', () => {
    const f = render({
      starts: 10,
      submits: 6,
      completionRatePercent: 60,
      byForm: [{ form: 'contact', starts: 10, submits: 6, completionRatePercent: 60 }],
    });
    expect(rateText(f)).toBe('60%');
    const text = f.nativeElement.textContent as string;
    expect(text).toContain('Started');
    expect(text).toContain('10');
    expect(text).toContain('Submitted');
    expect(text).toContain('6');
  });

  it('shows an honest empty state when there is no form activity — NEVER a fabricated 0%', () => {
    const f = render({ starts: 0, submits: 0, completionRatePercent: null, byForm: [] });
    expect(f.debugElement.query(By.css('[data-testid="an-form-funnel-empty"]'))).toBeTruthy();
    expect(f.debugElement.query(By.css('[data-testid="an-form-funnel-rate"]'))).toBeNull();
    expect(f.nativeElement.textContent).not.toContain('0%');
  });

  it('treats a null/absent funnel as the empty state', () => {
    const f = render(null);
    expect(f.debugElement.query(By.css('[data-testid="an-form-funnel-empty"]'))).toBeTruthy();
  });

  it('shows "—" (never 0%) for the rate when completion is null (submits without tracked starts)', () => {
    const f = render({
      starts: 0,
      submits: 3,
      completionRatePercent: null,
      byForm: [{ form: 'contact', starts: 0, submits: 3, completionRatePercent: null }],
    });
    expect(rateText(f)).toBe('—');
    expect(f.nativeElement.textContent).not.toContain('0%');
  });

  it('surfaces the count of leads that started but did not get through', () => {
    const f = render({ starts: 10, submits: 6, completionRatePercent: 60, byForm: [] });
    const lost = f.debugElement.query(By.css('[data-testid="an-form-funnel-lost"]'));
    expect(lost).toBeTruthy();
    expect((lost.nativeElement as HTMLElement).textContent).toContain('4'); // 10 − 6
  });

  it('hides the lost-leads note when every start submitted', () => {
    const f = render({ starts: 5, submits: 5, completionRatePercent: 100, byForm: [] });
    expect(f.debugElement.query(By.css('[data-testid="an-form-funnel-lost"]'))).toBeNull();
  });

  it('shows the per-form breakdown ONLY when more than one form has activity', () => {
    const one = render({
      starts: 10,
      submits: 6,
      completionRatePercent: 60,
      byForm: [{ form: 'contact', starts: 10, submits: 6, completionRatePercent: 60 }],
    });
    expect(one.debugElement.queryAll(By.css('[data-testid="an-form-funnel-form"]')).length).toBe(0);

    // Reset before the second render — render() re-configures TestBed, which throws once
    // the module has been instantiated by the first render in this same test.
    TestBed.resetTestingModule();
    const two = render({
      starts: 14,
      submits: 10,
      completionRatePercent: 71,
      byForm: [
        { form: 'contact', starts: 10, submits: 6, completionRatePercent: 60 },
        { form: 'newsletter', starts: 4, submits: 4, completionRatePercent: 100 },
      ],
    });
    const rows = two.debugElement.queryAll(By.css('[data-testid="an-form-funnel-form"]'));
    expect(rows.length).toBe(2);
    const text = two.nativeElement.textContent as string;
    expect(text).toContain('contact');
    expect(text).toContain('newsletter');
  });
});
