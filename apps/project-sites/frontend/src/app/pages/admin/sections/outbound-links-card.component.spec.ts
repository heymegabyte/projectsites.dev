import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import {
  OutboundLinksCardComponent,
  outboundLinkLabel,
  type OutboundClicksBlock,
} from './outbound-links-card.component';

function render(outboundClicks?: OutboundClicksBlock) {
  const fixture = TestBed.createComponent(OutboundLinksCardComponent);
  fixture.componentRef.setInput('outboundClicks', outboundClicks);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

describe('OutboundLinksCardComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders the top links (humanized) + total + per-row bar', () => {
    const { fixture, el } = render({
      total: 57,
      byLink: [
        { href: 'tel:+15551234567', kind: 'call', count: 40 },
        { href: 'https://instagram.com/biz', kind: 'outbound', count: 12 },
        { href: 'mailto:hi@biz.com', kind: 'email', count: 5 },
      ],
    });
    expect(el.textContent).toContain('57 link clicks');
    const rows = fixture.debugElement.queryAll(By.css('[data-testid="an-outbound-row"]'));
    expect(rows.length).toBe(3);
    // scheme stripped for display
    expect(rows[0].nativeElement.textContent).toContain('+15551234567');
    expect(rows[1].nativeElement.textContent).toContain('instagram.com/biz');
    expect(rows[2].nativeElement.textContent).toContain('hi@biz.com');
    expect(el.querySelector('[data-testid="an-outbound-empty"]')).toBeNull();
  });

  it('shows "no link clicks tracked yet" when empty (never a fabricated 0)', () => {
    const { el } = render({ total: 0, byLink: [] });
    const empty = el.querySelector('[data-testid="an-outbound-empty"]');
    expect(empty).toBeTruthy();
    expect(empty!.textContent).toContain('No link clicks tracked yet');
  });

  it('treats an undefined block (older payload) as empty — never crashes', () => {
    const { el } = render(undefined);
    expect(el.querySelector('[data-testid="an-outbound-empty"]')).toBeTruthy();
  });

  it('outboundLinkLabel strips the scheme + trailing slash', () => {
    expect(outboundLinkLabel('tel:+15551234567')).toBe('+15551234567');
    expect(outboundLinkLabel('mailto:hi@biz.com')).toBe('hi@biz.com');
    expect(outboundLinkLabel('https://book.me/slot/')).toBe('book.me/slot');
    expect(outboundLinkLabel('https://instagram.com/biz')).toBe('instagram.com/biz');
  });
});
