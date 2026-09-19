/**
 * Unit tests for the lead-notification feature (flag: lead_notifications).
 * Covers the security-critical + contract logic without the SES rail:
 *   • escapeLeadHtml — XSS escaping of user-supplied lead fields (public, unauthenticated surface)
 *   • buildLeadEmailHtml — escaped rendering, field cap, leadEmail row, empty-fields fallback
 *   • LeadNotificationSchema — the boundary contract (zod-everywhere)
 * FOUR `../` reach src/ from libs/features/<slug>/__tests__/ (repo jest path gotcha).
 */
import { buildLeadEmailHtml, escapeLeadHtml } from '../../../../src/services/notifications.js';
import { LeadNotificationSchema } from '../schemas.js';

describe('escapeLeadHtml', () => {
  it('escapes all five HTML-significant characters', () => {
    expect(escapeLeadHtml(`<b>&"'`)).toBe('&lt;b&gt;&amp;&quot;&#39;');
  });

  it('neutralizes a script-tag XSS payload', () => {
    const out = escapeLeadHtml('<script>alert(1)</script>');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('leaves benign text untouched', () => {
    expect(escapeLeadHtml('Do you take walk-ins?')).toBe('Do you take walk-ins?');
  });
});

describe('buildLeadEmailHtml', () => {
  const base = {
    siteName: "Vito's Salon",
    formName: 'contact',
    fields: { message: 'Hi there' },
    adminUrl: 'https://projectsites.dev/admin/forms',
  };

  it('escapes a malicious field value in the rendered body (no raw script tag)', () => {
    const html = buildLeadEmailHtml({ ...base, fields: { message: '<img src=x onerror=alert(1)>' } });
    expect(html).not.toContain('<img src=x onerror');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('renders a mailto row when the lead provided an email', () => {
    const html = buildLeadEmailHtml({ ...base, leadEmail: 'jo@example.com' });
    expect(html).toContain('mailto:jo@example.com');
  });

  it('omits the mailto row when no lead email is present', () => {
    expect(buildLeadEmailHtml(base)).not.toContain('mailto:');
  });

  it('caps rendered fields at 6 rows', () => {
    const fields: Record<string, string> = {};
    for (let i = 0; i < 12; i++) fields[`field_${i}`] = `value ${i}`;
    const html = buildLeadEmailHtml({ ...base, fields });
    // Each rendered field carries the capitalize span marker once.
    const rendered = (html.match(/text-transform:capitalize/g) || []).length;
    expect(rendered).toBe(6);
  });

  it('shows a fallback line when there are no non-empty fields', () => {
    const html = buildLeadEmailHtml({ ...base, fields: { blank: '   ' } });
    expect(html).toContain('A new submission was recorded on your site.');
  });

  it('includes the dashboard CTA URL', () => {
    expect(buildLeadEmailHtml(base)).toContain('https://projectsites.dev/admin/forms');
  });
});

describe('LeadNotificationSchema', () => {
  const valid = {
    email: 'owner@vitos.com',
    siteName: "Vito's Salon",
    slug: 'vitos',
    formName: 'contact',
    fields: { message: 'Hi' },
    adminUrl: 'https://projectsites.dev/admin/forms',
  };

  it('accepts a well-formed payload (optional leadEmail absent)', () => {
    expect(LeadNotificationSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts an optional valid leadEmail', () => {
    expect(LeadNotificationSchema.safeParse({ ...valid, leadEmail: 'jo@example.com' }).success).toBe(true);
  });

  it('rejects an invalid owner email', () => {
    expect(LeadNotificationSchema.safeParse({ ...valid, email: 'not-an-email' }).success).toBe(false);
  });

  it('rejects an unknown extra key (.strict)', () => {
    expect(LeadNotificationSchema.safeParse({ ...valid, sneaky: true }).success).toBe(false);
  });
});
