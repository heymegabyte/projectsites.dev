import type { FileMap } from '~/lib/stores/files';

/**
 * Result of inspecting an assistant message for the initial imported-site
 * greeting the worker emits from `GET /api/sites/by-slug/:slug/chat`.
 */
export interface ParsedSiteImport {
  /** True when the content is the initial "I've built … The project files are:" message. */
  isSiteImport: boolean;

  /** Business name pulled from the message, when present. */
  businessName?: string;

  /** File count the server reported ("with N files"). 0 when not an import message. */
  expectedFileCount: number;
}

/**
 * Matches the imported-site assistant message. The count is authoritative
 * (the worker sets it to `files.length`). The name is captured lazily so a
 * business name with spaces/ampersands/apostrophes round-trips intact.
 *
 * @example
 * // "I've built a professional website for Russ & Daughters with 49 files. The project files are:"
 * //   → { businessName: "Russ & Daughters", count: "49" }
 */
const SITE_IMPORT_RE = /I've built a professional website for (.+?) with (\d+) files\. The project files are:/;

/**
 * Detect + parse the imported-site assistant message.
 *
 * @param content - Parsed assistant message content (the `<boltArtifact>` tag is
 *   already a `__boltArtifact__` div; the leading file-list markdown is preserved).
 * @returns A {@link ParsedSiteImport}. `isSiteImport` is false for any non-import
 *   reply or a degenerate "with 0 files" message, so callers fall through to the
 *   normal render (fail-soft).
 * @example
 * parseSiteImport(content).isSiteImport; // true for the greeting, false otherwise
 */
export function parseSiteImport(content: string): ParsedSiteImport {
  const match = content?.match(SITE_IMPORT_RE);

  if (!match) {
    return { isSiteImport: false, expectedFileCount: 0 };
  }

  const expectedFileCount = Number.parseInt(match[2], 10);

  if (!Number.isFinite(expectedFileCount) || expectedFileCount <= 0) {
    return { isSiteImport: false, expectedFileCount: 0 };
  }

  return { isSiteImport: true, businessName: match[1].trim(), expectedFileCount };
}

/**
 * Count the real files (not folders) currently loaded in the editor's file map.
 *
 * @param files - The workbench file map (`workbenchStore.files`).
 * @returns The number of `type: 'file'` entries; folders and empty slots are ignored.
 * @example
 * countProjectFiles({ '/p/a.ts': { type: 'file', content: '', isBinary: false }, '/p/src': { type: 'folder' } }); // 1
 */
export function countProjectFiles(files: FileMap): number {
  let count = 0;

  for (const dirent of Object.values(files)) {
    if (dirent?.type === 'file') {
      count++;
    }
  }

  return count;
}

/** View-model for the site-import status card. */
export interface SiteImportStatusView {
  /** True once the editor holds every expected project file. */
  done: boolean;

  /** Files loaded so far, clamped to the expected total (so node_modules never inflates it). */
  loaded: number;

  /** Primary status line: "Loading N files…" → "Loaded N files". */
  headline: string;

  /** Live secondary detail: "12 of 49 files loaded into the editor…". */
  detail: string;
}

/**
 * Derive the status card's view-model from the expected count and the live
 * editor file count.
 *
 * @param expectedFileCount - The count the worker reported ("with N files").
 * @param loadedCount - Files currently in the editor (from {@link countProjectFiles}).
 * @returns A {@link SiteImportStatusView}. `done` flips once `loadedCount` reaches
 *   the expected total; `loaded` is clamped so a post-`npm install` store (thousands
 *   of files) still reads "Loaded N files", not a runaway number.
 * @example
 * siteImportStatusView(49, 12).headline; // "Loading 49 files…"
 * siteImportStatusView(49, 49).headline; // "Loaded 49 files"
 */
export function siteImportStatusView(expectedFileCount: number, loadedCount: number): SiteImportStatusView {
  const total = Math.max(0, expectedFileCount);
  const loaded = Math.max(0, Math.min(loadedCount, total));
  const done = total > 0 && loadedCount >= total;
  const noun = total === 1 ? 'file' : 'files';

  return {
    done,
    loaded,
    headline: done ? `Loaded ${total} ${noun}` : `Loading ${total} ${noun}…`,
    detail: done
      ? `All ${total} project ${noun} are in the editor.`
      : `${loaded} of ${total} ${noun} loaded into the editor…`,
  };
}
