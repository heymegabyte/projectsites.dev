/**
 * Unit tests for the pure audit functions of the crawler-manifest quality probe
 * (`verify-llms-txt-quality.mjs`). Runs under the primary Jest `test:unit` gate — the `.mjs`
 * transform (jest.config.cjs) lets a `.test.ts` import the pure ESM sibling. These are the
 * regression anchors for AL-753 (blank/malformed llms.txt) + AL-793 (doubled-scheme across
 * humans.txt/security.txt), the exact defects caught LIVE on the-aviary-chicago (2026-09-19).
 */
import { auditDoubledScheme, auditKeyedBlank, auditLlms, MANIFESTS } from './verify-llms-txt-quality.mjs';

describe('auditDoubledScheme (AL-793)', () => {
  it('flags the live Aviary humans.txt Site line — the exact bug', () => {
    const d = auditDoubledScheme('Site: https://https://the-aviary-chicago.projectsites.dev/');
    expect(d).toHaveLength(1);
    expect(d[0]).toContain('doubled scheme');
  });

  it('passes a correct single-scheme URL (the AL-793 fix output)', () => {
    expect(auditDoubledScheme('Site: https://the-aviary-chicago.projectsites.dev/')).toHaveLength(0);
  });

  it('flags both security.txt Canonical + Policy doubled-scheme lines', () => {
    const txt =
      'Canonical: https://https://x.projectsites.dev/.well-known/security.txt\n' +
      'Policy: https://https://x.projectsites.dev/security';
    expect(auditDoubledScheme(txt)).toHaveLength(2);
  });

  it('ignores a bare domain with no scheme at all', () => {
    expect(auditDoubledScheme('Site: x.projectsites.dev/')).toHaveLength(0);
  });
});

describe('auditKeyedBlank', () => {
  it('flags a blank Site field (AL-793 humans.txt class)', () => {
    expect(auditKeyedBlank('Site: ', ['Site'])).toEqual(['Site blank']);
  });

  it('passes a populated field', () => {
    expect(auditKeyedBlank('Site: https://x.projectsites.dev/', ['Site'])).toHaveLength(0);
  });

  it('only checks the requested keys — ignores an unlisted blank line', () => {
    expect(auditKeyedBlank('Last update: \nSite: https://x/', ['Site'])).toHaveLength(0);
  });

  it('flags multiple blank keyed fields', () => {
    expect(auditKeyedBlank('Owner: \nSite: ', ['Owner', 'Site'])).toEqual(['Owner blank', 'Site blank']);
  });
});

describe('auditLlms (AL-753)', () => {
  it('flags a blank Tagline + a dangling-| Contact', () => {
    const d = auditLlms('Tagline: \nContact:  | (312) 555-1212');
    expect(d).toContain('Tagline blank');
    expect(d.some((x) => x.includes('Contact malformed'))).toBe(true);
  });

  it('passes a clean llms.txt block', () => {
    const txt =
      'Tagline: Best cocktail bar\nHours: 5pm-2am\nAddress: 1 Main St\n' +
      'Site: https://x.projectsites.dev/\nContact: hey@x.com | (312) 555-1212';
    expect(auditLlms(txt)).toHaveLength(0);
  });

  it('does not double-count the doubled-scheme Site line (that is auditDoubledScheme’s job)', () => {
    // auditLlms only cares about blank/malformed; the URL shape is a separate audit.
    expect(auditLlms('Site: https://https://x/')).toHaveLength(0);
  });
});

describe('MANIFESTS wiring', () => {
  it('covers all three crawler manifests', () => {
    expect(MANIFESTS.map((m) => m.path)).toEqual(['/llms.txt', '/humans.txt', '/.well-known/security.txt']);
  });

  it('each manifest runs the doubled-scheme audit (a doubled Site line is caught everywhere)', () => {
    for (const mf of MANIFESTS) {
      expect(mf.audit('Site: https://https://x.projectsites.dev/').some((d) => d.includes('doubled scheme'))).toBe(true);
    }
  });
});
