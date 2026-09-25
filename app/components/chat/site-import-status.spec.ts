import { describe, expect, it } from 'vitest';
import type { FileMap } from '~/lib/stores/files';
import { countProjectFiles, parseSiteImport, siteImportStatusView } from './site-import-status';

/**
 * The initial imported-site assistant message, exactly as the worker emits it
 * (parsed form — the `<boltArtifact>` tag has already become a `__boltArtifact__`
 * div, and the file list is preserved as leading markdown).
 */
const SITE_IMPORT_CONTENT = [
  "I've built a professional website for Russ & Daughters with 49 files. The project files are:",
  '- package.json',
  '- index.html',
  '- src/App.tsx',
  '<div class="__boltArtifact__" data-message-id="msg-asst-russ" data-artifact-id="site-russ"></div>',
].join('\n');

describe('parseSiteImport', () => {
  it('detects the imported-site message and extracts the name + file count', () => {
    const result = parseSiteImport(SITE_IMPORT_CONTENT);
    expect(result.isSiteImport).toBe(true);
    expect(result.businessName).toBe('Russ & Daughters');
    expect(result.expectedFileCount).toBe(49);
  });

  it('handles a business name with numbers, ampersands, and apostrophes', () => {
    const content = "I've built a professional website for Vito's Mens Salon with 8 files. The project files are:";
    const result = parseSiteImport(content);
    expect(result.isSiteImport).toBe(true);
    expect(result.businessName).toBe("Vito's Mens Salon");
    expect(result.expectedFileCount).toBe(8);
  });

  it('does not match an ordinary assistant reply', () => {
    expect(parseSiteImport('Sure — I updated the hero copy and redeployed.').isSiteImport).toBe(false);
  });

  it('does not match when the count is zero (nothing to load)', () => {
    const content = "I've built a professional website for Empty Co with 0 files. The project files are:";
    expect(parseSiteImport(content).isSiteImport).toBe(false);
  });

  it('is safe on empty / undefined content', () => {
    expect(parseSiteImport('').isSiteImport).toBe(false);
    expect(parseSiteImport(undefined as unknown as string).isSiteImport).toBe(false);
  });
});

describe('countProjectFiles', () => {
  it('counts files only — folders and empty slots are ignored', () => {
    const files: FileMap = {
      '/home/project/package.json': { type: 'file', content: '{}', isBinary: false },
      '/home/project/src': { type: 'folder' },
      '/home/project/src/App.tsx': { type: 'file', content: 'x', isBinary: false },
      '/home/project/gone': undefined,
    };
    expect(countProjectFiles(files)).toBe(2);
  });

  it('returns 0 for an empty map', () => {
    expect(countProjectFiles({})).toBe(0);
  });
});

describe('siteImportStatusView', () => {
  it('reports the loading state with a live sub-count while files are still arriving', () => {
    const view = siteImportStatusView(49, 12);
    expect(view.done).toBe(false);
    expect(view.loaded).toBe(12);
    expect(view.headline).toBe('Loading 49 files…');
    expect(view.detail).toContain('12 of 49');
  });

  it('reports the loaded state once the editor holds every project file', () => {
    const view = siteImportStatusView(49, 49);
    expect(view.done).toBe(true);
    expect(view.headline).toBe('Loaded 49 files');
  });

  it('stays loaded and clamps the sub-count when the store grows past the total (node_modules)', () => {
    const view = siteImportStatusView(49, 4200);
    expect(view.done).toBe(true);
    expect(view.loaded).toBe(49);
    expect(view.headline).toBe('Loaded 49 files');
  });

  it('pluralizes correctly for a single-file project', () => {
    expect(siteImportStatusView(1, 0).headline).toBe('Loading 1 file…');
    expect(siteImportStatusView(1, 1).headline).toBe('Loaded 1 file');
  });
});
