import { describe, it, expect } from 'vitest';

import {
  buildFileTree,
  languageForFile,
  isBinaryPath,
  isImagePath,
  extensionOf,
  formatBytes,
  shortSha,
  formatCommitDate,
  type CodeFileEntry,
} from './git-browser-logic';

/** Minimal file-entry factory for tree tests. */
function f(name: string, size = 100): CodeFileEntry {
  return { key: `sites/acme/${name}`, name, size, uploaded: '2026-05-11T14:23:00Z', content_type: null };
}

describe('git-browser-logic · buildFileTree', () => {
  it('nests folders from flat paths and keeps files at the right depth', () => {
    const tree = buildFileTree([f('index.html'), f('assets/app.js'), f('assets/img/logo.svg')]);

    // Folders sort before files → assets folder first, then index.html file.
    expect(tree.map((n) => `${n.kind}:${n.name}`)).toEqual(['folder:assets', 'file:index.html']);

    const assets = tree[0];
    expect(assets.children?.map((n) => `${n.kind}:${n.name}`)).toEqual(['folder:img', 'file:app.js']);

    const img = assets.children?.[0];
    expect(img?.path).toBe('assets/img');
    expect(img?.children?.[0]).toMatchObject({ kind: 'file', name: 'logo.svg', path: 'assets/img/logo.svg' });
  });

  it('sorts siblings folders-first then case-insensitively alphabetical', () => {
    const tree = buildFileTree([f('Zebra.txt'), f('apple.txt'), f('sub/one.txt'), f('Beta/two.txt')]);
    expect(tree.map((n) => n.name)).toEqual(['Beta', 'sub', 'apple.txt', 'Zebra.txt']);
  });

  it('attaches the underlying file entry to leaf nodes', () => {
    const tree = buildFileTree([f('robots.txt', 42)]);
    expect(tree[0].file?.size).toBe(42);
    expect(tree[0].kind).toBe('file');
  });

  it('returns an empty array for no files (honest empty)', () => {
    expect(buildFileTree([])).toEqual([]);
  });
});

describe('git-browser-logic · languageForFile', () => {
  it.each([
    ['index.html', 'html'],
    ['app.tsx', 'typescript'],
    ['main.js', 'javascript'],
    ['styles.css', 'css'],
    ['data.json', 'json'],
    ['README.md', 'markdown'],
    ['sitemap.xml', 'xml'],
    ['logo.svg', 'xml'],
    ['config.yaml', 'yaml'],
  ])('maps %s → %s', (name, lang) => {
    expect(languageForFile(name)).toBe(lang);
  });

  it('falls back to text for unknown/extensionless files', () => {
    expect(languageForFile('Dockerfile')).toBe('text');
    expect(languageForFile('notes.weird')).toBe('text');
  });
});

describe('git-browser-logic · isBinaryPath / isImagePath', () => {
  it('flags images, fonts, media, archives as binary', () => {
    expect(isBinaryPath('hero.png')).toBe(true);
    expect(isBinaryPath('font.woff2')).toBe(true);
    expect(isBinaryPath('demo.mp4')).toBe(true);
    expect(isBinaryPath('bundle.wasm')).toBe(true);
  });

  it('does NOT flag text sources as binary', () => {
    expect(isBinaryPath('app.tsx')).toBe(false);
    expect(isBinaryPath('index.html')).toBe(false);
    expect(isBinaryPath('data.json')).toBe(false);
  });

  it('recognizes previewable images (incl. svg) but not fonts/media', () => {
    expect(isImagePath('hero.png')).toBe(true);
    expect(isImagePath('logo.svg')).toBe(true);
    expect(isImagePath('font.woff2')).toBe(false);
    expect(isImagePath('clip.mp4')).toBe(false);
  });
});

describe('git-browser-logic · extensionOf', () => {
  it('extracts the lower-cased extension', () => {
    expect(extensionOf('assets/App.TSX')).toBe('tsx');
    expect(extensionOf('a/b/c.min.js')).toBe('js');
  });

  it('returns empty for dotfiles and extensionless names', () => {
    expect(extensionOf('.gitignore')).toBe('');
    expect(extensionOf('LICENSE')).toBe('');
    expect(extensionOf('trailing.')).toBe('');
  });
});

describe('git-browser-logic · formatBytes', () => {
  it('formats bytes / KB / MB', () => {
    expect(formatBytes(820)).toBe('820 B');
    expect(formatBytes(12_698)).toBe('12.4 KB');
    expect(formatBytes(3_250_000)).toBe('3.1 MB');
  });

  it('returns a dash for invalid sizes', () => {
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
  });
});

describe('git-browser-logic · shortSha / formatCommitDate', () => {
  it('truncates a long sha to 7 chars, passes short ids through', () => {
    expect(shortSha('a1b2c3d4e5f6')).toBe('a1b2c3d');
    expect(shortSha('abc')).toBe('abc');
  });

  it('formats an ISO timestamp to YYYY-MM-DD HH:MM (UTC)', () => {
    expect(formatCommitDate('2026-05-11T14:23:01Z')).toBe('2026-05-11 14:23');
  });

  it('returns the raw string for an unparseable date', () => {
    expect(formatCommitDate('not-a-date')).toBe('not-a-date');
  });
});
