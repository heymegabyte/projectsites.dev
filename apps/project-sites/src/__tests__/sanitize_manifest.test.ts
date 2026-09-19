import { sanitizeManifestText } from '../../scripts/sanitize-manifest.mjs';

/**
 * AL-791 — the pure llms.txt / llms-full.txt manifest sanitizer wired into
 * container-server.mjs fillTemplateTokens. fillTemplateTokens fills an absent token with an
 * empty string (so a UI section self-hides), which on the flat "Label: A or B" AI-crawler
 * manifest lines left a blank "Tagline:" or a dangling "Contact:   |" — read verbatim by an
 * LLM crawler (found live on a fresh build by verify-llms-txt-quality.mjs). These lock the
 * root fix: defective metadata lines are dropped/collapsed, clean lines are byte-preserved.
 */
describe('sanitizeManifestText — AI-crawler manifest hygiene', () => {
  it('DROPS a metadata line whose value came out entirely empty', () => {
    expect(sanitizeManifestText('Tagline: ')).toBe('');
    expect(sanitizeManifestText('Hours:    ')).toBe('');
    expect(sanitizeManifestText('Tagline: \nSite: https://x.com')).toBe('Site: https://x.com');
  });

  it('DROPS a dangling Contact line when BOTH sides of the separator are empty', () => {
    expect(sanitizeManifestText('Contact:   |')).toBe('');
    expect(sanitizeManifestText('Contact:  | ')).toBe('');
  });

  it('COLLAPSES a two-part field to the non-empty side when one side is blank', () => {
    expect(sanitizeManifestText('Contact:  hi@acme.com |')).toBe('Contact: hi@acme.com');
    expect(sanitizeManifestText('Contact:   | 555-1234')).toBe('Contact: 555-1234');
  });

  it('leaves an already-clean line BYTE-FOR-BYTE untouched (alignment preserved)', () => {
    expect(sanitizeManifestText('Contact:  hi@acme.com | 555-1234')).toBe(
      'Contact:  hi@acme.com | 555-1234',
    );
    expect(sanitizeManifestText('Site:     https://x.com')).toBe('Site:     https://x.com');
  });

  it('never touches headings, link lists, or filled blockquotes; drops only an EMPTY blockquote', () => {
    expect(sanitizeManifestText('# Acme Co')).toBe('# Acme Co');
    expect(sanitizeManifestText('## Primary pages')).toBe('## Primary pages');
    expect(sanitizeManifestText('- [Home](https://x.com/)')).toBe('- [Home](https://x.com/)');
    expect(sanitizeManifestText('> A real one-line description.')).toBe(
      '> A real one-line description.',
    );
    expect(sanitizeManifestText('> ')).toBe('');
  });

  it('cleans a realistic partially-empty llms.txt head into a tight, valid manifest', () => {
    const filled = [
      '# Acme Dental',
      '> ', // empty description
      '',
      'Tagline: ', // absent
      'Site:     https://acme.projectsites.dev',
      'Contact:  hi@acme.com |', // phone absent
      'Address:  1 Main St',
      'Hours:    ', // absent
      '',
      '## Primary pages',
      '- [Home](https://acme.projectsites.dev/)',
    ].join('\n');
    const cleaned = sanitizeManifestText(filled);
    expect(cleaned).not.toMatch(/Tagline:/); // dropped
    expect(cleaned).not.toMatch(/Hours:/); // dropped
    expect(cleaned).not.toMatch(/\|\s*$/m); // no dangling separator anywhere
    expect(cleaned).toContain('Contact: hi@acme.com'); // collapsed, no dangling separator
    expect(cleaned).toContain('Site:     https://acme.projectsites.dev'); // clean line preserved
    expect(cleaned).toContain('## Primary pages'); // structure intact
    expect(cleaned).not.toMatch(/\n{3,}/); // no 3+ blank-line gaps from drops
  });

  it('is fail-soft: non-string / empty input returns unchanged', () => {
    expect(sanitizeManifestText('')).toBe('');
    expect(sanitizeManifestText(undefined as unknown as string)).toBe(undefined);
    expect(sanitizeManifestText(null as unknown as string)).toBe(null);
  });
});
