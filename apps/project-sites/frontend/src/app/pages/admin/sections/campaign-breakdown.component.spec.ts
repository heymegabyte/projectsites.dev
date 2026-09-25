import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { CampaignBreakdownComponent, type CampaignCount } from './campaign-breakdown.component';

/**
 * CampaignBreakdownComponent — utm_source / utm_campaign attribution over TAGGED visits.
 * Untagged direct/organic traffic is excluded server-side, so for most sites this is the
 * empty state — which must TEACH how to tag links (utm_source/utm_campaign), never a
 * fabricated 0 or a giant "unknown" bucket.
 */
function render(
  sources: CampaignCount[] = [],
  campaigns: CampaignCount[] = [],
  windowDays = 30,
  mediums: CampaignCount[] = [],
) {
  TestBed.configureTestingModule({ imports: [CampaignBreakdownComponent] });
  const fixture = TestBed.createComponent(CampaignBreakdownComponent);
  fixture.componentRef.setInput('sources', sources);
  fixture.componentRef.setInput('mediums', mediums);
  fixture.componentRef.setInput('campaigns', campaigns);
  fixture.componentRef.setInput('windowDays', windowDays);
  fixture.detectChanges();
  return fixture;
}

describe('CampaignBreakdownComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders both dimensions (source + campaign) when each has tagged data', () => {
    const fixture = render(
      [
        { label: 'instagram', count: 40 },
        { label: 'newsletter', count: 12 },
      ],
      [
        { label: 'spring-sale', count: 30 },
        { label: 'launch', count: 22 },
      ],
    );
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[data-testid="an-campaigns-source"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="an-campaigns-campaign"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="an-campaigns-source"]')!.textContent).toContain(
      'instagram',
    );
    expect(host.querySelector('[data-testid="an-campaigns-campaign"]')!.textContent).toContain(
      'spring-sale',
    );
    expect(host.querySelector('[data-testid="an-campaigns-empty"]')).toBeNull();
  });

  it('renders the utm_medium dimension (the raw medium, distinct from the coarse channel card)', () => {
    const fixture = render(
      [{ label: 'instagram', count: 40 }],
      [{ label: 'spring-sale', count: 30 }],
      30,
      [
        { label: 'cpc', count: 20 },
        { label: 'email', count: 8 },
      ],
    );
    const host = fixture.nativeElement as HTMLElement;
    const medium = host.querySelector('[data-testid="an-campaigns-medium"]');
    expect(medium).toBeTruthy();
    expect(medium!.textContent).toContain('cpc');
    expect(fixture.componentInstance.groups().find((g) => g.key === 'medium')!.rows.length).toBe(2);
  });

  it('sorts each dimension by count desc, filters zero counts, and caps at 6', () => {
    const many: CampaignCount[] = [
      { label: 'a', count: 1 },
      { label: 'b', count: 9 },
      { label: 'c', count: 3 },
      { label: 'd', count: 7 },
      { label: 'e', count: 5 },
      { label: 'f', count: 8 },
      { label: 'g', count: 2 },
      { label: 'zero', count: 0 },
    ];
    const c = render(many).componentInstance;
    const source = c.groups().find((g) => g.key === 'source')!;
    expect(source.rows.length).toBe(6); // 7 non-zero → top 6
    expect(source.rows.map((r) => r.label)).toEqual(['b', 'f', 'd', 'e', 'c', 'g']);
  });

  it('renders ONLY the dimensions that have data (empty ones omitted, not shown blank)', () => {
    const fixture = render([{ label: 'google', count: 5 }], []);
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[data-testid="an-campaigns-source"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="an-campaigns-campaign"]')).toBeNull();
    expect(host.querySelector('[data-testid="an-campaigns-empty"]')).toBeNull();
  });

  it('shows the honest empty state (and TEACHES how to tag) when there is no tagged traffic', () => {
    const fixture = render([], []);
    const empty = fixture.debugElement.query(By.css('[data-testid="an-campaigns-empty"]'));
    expect(empty).toBeTruthy();
    const text = (empty.nativeElement as HTMLElement).textContent ?? '';
    // The empty state must explain HOW to populate it (the epic's "insight explains its evidence").
    expect(text).toContain('utm_source');
    expect(text).toContain('utm_medium');
    expect(text).toContain('utm_campaign');
    // Also empty when every row is zero (never a 0-count breakdown).
    TestBed.resetTestingModule();
    const zero = render([{ label: 'google', count: 0 }]);
    expect(zero.debugElement.query(By.css('[data-testid="an-campaigns-empty"]'))).toBeTruthy();
  });

  it('scales bar width to the group max (min 4% so a small bar stays visible)', () => {
    const c = render().componentInstance;
    expect(c.barWidth(50, 50)).toBe(100);
    expect(c.barWidth(1, 100)).toBe(4);
    expect(c.barWidth(25, 50)).toBe(50);
    expect(c.barWidth(5, 0)).toBe(0);
  });

  it('labels the window + says "tagged visits only" (never conflates with all traffic)', () => {
    const fixture = render([{ label: 'instagram', count: 3 }], [], 7);
    const note = fixture.debugElement.query(By.css('[data-testid="an-campaigns-note"]'))
      .nativeElement as HTMLElement;
    expect(note.textContent).toContain('last 7 days');
    expect(note.textContent).toContain('tagged visits only');
  });
});
