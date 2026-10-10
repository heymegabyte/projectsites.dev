/**
 * @file bucket-icons — the Buckets object-browser file-type icon map (fire-B5).
 *
 * Asserts `iconForObject` returns a DISTINCT Phosphor duotone glyph per file-type family (incl. the
 * folder-prefix shape), and that `isImageKey` recognises previewable images. The map is the single
 * source of truth shared by the live panel + the `/_preview` gallery, so pinning it here guards the
 * visual proof against silent coalescing back to a coarse one-glyph map.
 */
import { describe, expect, it } from 'vitest';
import { iconForObject, isImageKey } from '~/components/workbench/bucket-icons';

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
