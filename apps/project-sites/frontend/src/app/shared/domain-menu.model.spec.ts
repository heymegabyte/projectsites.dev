/**
 * Karma/Jasmine spec for the navbar domain-menu model. Pins the URL-menu behaviour Brian asked for:
 * a synthesized default `{slug}.projectsites.dev` row, per-domain primary/activate + ⋯ actions, the
 * merged "$17/mo" connect CTA, and safe primary-URL resolution.
 */
import { buildDomainMenu, defaultSubdomain } from './domain-menu.model';

describe('defaultSubdomain', () => {
  it('synthesizes a valid subdomain and rejects bad slugs', () => {
    expect(defaultSubdomain('acme')).toBe('acme.projectsites.dev');
    expect(defaultSubdomain('Acme Co!')).toBe(''); // invalid → empty (no unsafe host)
    expect(defaultSubdomain('a')).toBe('a.projectsites.dev');
  });
});

describe('buildDomainMenu', () => {
  it('always includes the default subdomain row (home glyph, primary when no custom primary)', () => {
    const m = buildDomainMenu('acme', []);
    expect(m.rows[0].kind).toBe('default');
    expect(m.rows[0].label).toBe('acme.projectsites.dev');
    expect(m.rows[0].homeGlyph).toBe(true);
    expect(m.rows[0].isPrimary).toBe(true);
    expect(m.primaryUrl).toBe('https://acme.projectsites.dev');
  });

  it('surfaces the $17/mo connect-custom CTA when there is no active custom primary', () => {
    const m = buildDomainMenu('acme', []);
    expect(m.showConnectCta).toBe(true);
    const cta = m.rows.find((r) => r.kind === 'cta');
    expect(cta?.priceMonthly).toBe(17);
    expect(cta?.actions).toEqual(['connect_custom']);
  });

  it('an ACTIVE custom primary becomes the primary URL + hides the CTA', () => {
    const m = buildDomainMenu('acme', [{ id: 'h1', hostname: 'acme.com', isPrimary: true, status: 'active' }]);
    expect(m.primaryUrl).toBe('https://acme.com');
    expect(m.showConnectCta).toBe(false);
    expect(m.rows.some((r) => r.kind === 'cta')).toBe(false);
    // default row is no longer primary but can be re-activated
    expect(m.rows[0].isPrimary).toBe(false);
    expect(m.rows[0].actions).toEqual(['set_primary']);
  });

  it('offers set-primary only for an active, non-primary custom host; always unsubscribe + remove', () => {
    const m = buildDomainMenu('acme', [
      { id: 'h1', hostname: 'acme.com', isPrimary: false, status: 'active' },
      { id: 'h2', hostname: 'pending.com', isPrimary: false, status: 'pending' },
    ]);
    const active = m.rows.find((r) => r.key === 'h1');
    const pending = m.rows.find((r) => r.key === 'h2');
    expect(active?.actions).toEqual(['set_primary', 'unsubscribe', 'remove']);
    expect(pending?.actions).toEqual(['unsubscribe', 'remove']); // pending → no set-primary yet
  });

  it('drops malformed hostnames + tolerates empty/undefined input', () => {
    const m = buildDomainMenu('acme', [{ id: 'bad', hostname: 'not a host!!', status: 'active' }]);
    expect(m.rows.some((r) => r.kind === 'custom')).toBe(false);
    expect(buildDomainMenu('acme', undefined).rows[0].kind).toBe('default');
  });
});
