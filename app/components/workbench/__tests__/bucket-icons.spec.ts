/**
 * @file bucket-icons — the Buckets object-browser file-type icon map (fire-B5).
 *
 * Asserts `iconForObject` returns a DISTINCT Phosphor duotone glyph per file-type family (incl. the
 * folder-prefix shape), and that `isImageKey` recognises previewable images. The map is the single
 * source of truth shared by the live panel + the `/_preview` gallery, so pinning it here guards the
 * visual proof against silent coalescing back to a coarse one-glyph map.
 */
import { describe, expect, it } from 'vitest';
import { iconForObject, isImageKey, colorForObject, objectTypeLabel } from '~/components/workbench/bucket-icons';

describe('iconForObject — distinct glyph per file type', () => {
  // Each tuple: a representative key → the expected DISTINCT duotone class.
  const cases: [string, string][] = [
    ['images/', 'i-ph:folder-duotone'], // prefix/folder shape
    ['photos/2026/', 'i-ph:folder-duotone'], // nested prefix
    ['hero.webp', 'i-ph:image-duotone'],
    ['portrait.JPG', 'i-ph:image-duotone'], // case-insensitive
    ['logo.svg', 'i-ph:image-duotone'],
    ['promo.mp4', 'i-ph:file-video-duotone'],
    ['track.mp3', 'i-ph:file-audio-duotone'],
    ['report.pdf', 'i-ph:file-pdf-duotone'],
    ['README.md', 'i-ph:file-md-duotone'],
    ['data.csv', 'i-ph:file-csv-duotone'],
    ['budget.xlsx', 'i-ph:file-xls-duotone'],
    ['proposal.docx', 'i-ph:file-doc-duotone'],
    ['deck.pptx', 'i-ph:file-ppt-duotone'],
    ['config.json', 'i-ph:brackets-curly-duotone'],
    ['data.yaml', 'i-ph:brackets-curly-duotone'],
    ['index.html', 'i-ph:file-html-duotone'],
    ['feed.xml', 'i-ph:file-html-duotone'],
    ['app.tsx', 'i-ph:file-ts-duotone'],
    ['server.ts', 'i-ph:file-ts-duotone'],
    ['bundle.js', 'i-ph:file-js-duotone'],
    ['legacy.jsx', 'i-ph:file-js-duotone'],
    ['styles.css', 'i-ph:file-css-duotone'],
    ['theme.scss', 'i-ph:file-css-duotone'],
    ['bundle.zip', 'i-ph:file-zip-duotone'],
    ['archive.tar.gz', 'i-ph:file-zip-duotone'],
    ['font.woff2', 'i-ph:text-aa-duotone'],
    ['heading.ttf', 'i-ph:text-aa-duotone'],
    ['dump.sql', 'i-ph:database-duotone'],
    ['notes.txt', 'i-ph:file-text-duotone'],
    ['server.log', 'i-ph:file-text-duotone'],
    ['mystery.xyz', 'i-ph:file-duotone'], // unknown → generic fallback
    ['no-extension', 'i-ph:file-duotone'],
  ];

  it.each(cases)('maps %s → %s', (key, expected) => {
    expect(iconForObject(key)).toBe(expected);
  });

  it('returns ≥16 DISTINCT glyph classes across the full case set (proves per-type differentiation)', () => {
    const distinct = new Set(cases.map(([key]) => iconForObject(key)));
    expect(distinct.size).toBeGreaterThanOrEqual(16);
  });

  it('never returns a non-duotone class (every glyph is a duotone family member)', () => {
    for (const [key] of cases) {
      expect(iconForObject(key)).toMatch(/^i-ph:[a-z0-9-]+-duotone$/);
    }
  });

  it('distinguishes a folder prefix from a same-named file', () => {
    expect(iconForObject('images/')).toBe('i-ph:folder-duotone');
    expect(iconForObject('images.zip')).toBe('i-ph:file-zip-duotone');
  });
});

describe('isImageKey — previewable-image recognition', () => {
  it.each(['hero.webp', 'a.PNG', 'b.jpeg', 'c.gif', 'd.avif', 'e.svg', 'f.bmp', 'g.ico'])(
    'treats %s as a previewable image',
    (key) => {
      expect(isImageKey(key)).toBe(true);
    },
  );

  it.each(['report.pdf', 'track.mp3', 'app.tsx', 'images/', 'data.csv'])('treats %s as NOT an image', (key) => {
    expect(isImageKey(key)).toBe(false);
  });
});

describe('colorForObject — color-coded file-type tint', () => {
  // Each tuple: a representative key → the expected restrained brand-coherent tint.
  const cases: [string, string][] = [
    ['images/', 'text-cyan-300'], // folder — brand accent
    ['hero.webp', 'text-sky-300'], // image
    ['promo.mp4', 'text-violet-300'], // video
    ['track.mp3', 'text-fuchsia-300'], // audio
    ['report.pdf', 'text-rose-300'], // pdf
    ['data.csv', 'text-emerald-300'], // tabular
    ['budget.xlsx', 'text-emerald-300'], // spreadsheet shares tabular tint
    ['proposal.docx', 'text-blue-300'], // word doc
    ['deck.pptx', 'text-orange-300'], // slides
    ['bundle.zip', 'text-amber-300'], // archive
    ['font.woff2', 'text-pink-300'], // font
    ['dump.sql', 'text-teal-300'], // database
    ['README.md', 'text-slate-300'], // prose
    ['notes.txt', 'text-slate-300'], // prose
    ['config.json', 'text-cyan-200'], // code/config family
    ['app.tsx', 'text-cyan-200'], // code/config family
    ['styles.css', 'text-cyan-200'], // code/config family
  ];

  it.each(cases)('tints %s → %s', (key, expected) => {
    expect(colorForObject(key)).toBe(expected);
  });

  it('falls back to the muted tertiary token for an unknown type', () => {
    expect(colorForObject('mystery.xyz')).toBe('text-bolt-elements-textTertiary');
    expect(colorForObject('no-extension')).toBe('text-bolt-elements-textTertiary');
  });

  it('returns ≥10 DISTINCT tints across the case set (proves color differentiation by type)', () => {
    const distinct = new Set(cases.map(([key]) => colorForObject(key)));
    expect(distinct.size).toBeGreaterThanOrEqual(10);
  });
});

describe('objectTypeLabel — compact type badge for the grid tile hover chip', () => {
  const cases: [string, string][] = [
    ['images/', 'DIR'], // folder shape
    ['photos/2026/', 'DIR'], // nested prefix
    ['hero.webp', 'WEBP'], // extension uppercased
    ['portrait.JPG', 'JPG'], // already-upper extension stays
    ['report.pdf', 'PDF'],
    ['images/nested/logo.svg', 'SVG'], // deepest segment's extension
    ['archive.tar.gz', 'GZ'], // only the LAST extension
    ['no-extension', 'FILE'], // no dot → FILE
    ['.gitignore', 'FILE'], // leading-dot dotfile is not an extension
    ['trailing.', 'FILE'], // dot with no extension chars → FILE
    ['data.jsonc', 'JSON'], // truncated to 4 chars
  ];

  it.each(cases)('labels %s → %s', (key, expected) => {
    expect(objectTypeLabel(key)).toBe(expected);
  });

  it('never returns a label longer than 4 characters', () => {
    for (const [key] of cases) {
      expect(objectTypeLabel(key).length).toBeLessThanOrEqual(4);
    }
    expect(objectTypeLabel('a.markdown')).toBe('MARK'); // long extension is capped at 4
  });
});
