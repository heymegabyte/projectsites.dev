/**
 * @file Pure, testable logic for the per-site Code / Git browser (FIRE 7).
 *
 * @remarks
 * The {@link GitPanel} React surface stays thin — all the branchy logic that's worth a unit test
 * lives here: turning a FLAT list of R2 keys into a nested tree, mapping a filename to a CodeMirror
 * language + a display label, deciding whether a path is binary (so the viewer never dumps garbled
 * bytes), and formatting the git commit timeline. Zero React / DOM / bridge imports so it runs in a
 * plain Vitest process.
 *
 * All of it operates on the site's OWN code only — the caller resolves the site server-side; this
 * module never sees a slug/id it could tamper with.
 */

/** One file entry as returned by the worker's `GET /api/sites/:id/files` tree endpoint. */
export interface CodeFileEntry {
  /** Full R2 key (e.g. `sites/acme/2026-05-11/index.html`). */
  key: string;

  /** Path relative to the site's R2 prefix (e.g. `index.html`, `assets/app.js`) — the display path. */
  name: string;

  /** Byte size. */
  size: number;

  /** ISO upload timestamp. */
  uploaded: string;

  /** Stored content type, when known. */
  content_type: string | null;
}

/** A node in the built file tree — either a folder (has `children`) or a file (has `file`). */
export interface TreeNode {
  /** The segment name shown in the tree row (the last path segment). */
  name: string;

  /** The full relative path from the site root (`assets/img/logo.svg`). */
  path: string;

  /** `folder` → expandable; `file` → openable in the viewer. */
  kind: 'folder' | 'file';

  /** Child nodes (folders first, then files, each alphabetized) — only for folders. */
  children?: TreeNode[];

  /** The underlying file entry — only for files. */
  file?: CodeFileEntry;
}

/**
 * Build a nested folder/file tree from a FLAT list of file entries (as R2 returns them). Folders are
 * synthesized from the path segments; siblings are sorted folders-first then alphabetically so the
 * tree reads like a real file explorer. Pure + deterministic.
 *
 * @param files - Flat file entries (each with a `name` like `assets/app.js`).
 * @returns The root-level nodes (folders + files), recursively populated.
 *
 * @example
 * buildFileTree([{ name: 'index.html', ... }, { name: 'assets/app.js', ... }])
 * // → [ { kind:'folder', name:'assets', children:[{kind:'file', name:'app.js'}] },
 * //     { kind:'file', name:'index.html' } ]
 */
export function buildFileTree(files: readonly CodeFileEntry[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', kind: 'folder', children: [] };

  for (const file of files) {
    const segments = file.name.split('/').filter((s) => s.length > 0);

    if (segments.length === 0) {
      continue;
    }

    let cursor = root;

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const isLeaf = i === segments.length - 1;
      const path = segments.slice(0, i + 1).join('/');

      if (isLeaf) {
        // Guard against a folder/file name collision — keep the first-seen kind.
        const existing = cursor.children?.find((c) => c.name === segment && c.kind === 'file');

        if (!existing) {
          cursor.children = cursor.children ?? [];
          cursor.children.push({ name: segment, path, kind: 'file', file });
        }
      } else {
        let folder = cursor.children?.find((c) => c.name === segment && c.kind === 'folder');

        if (!folder) {
          folder = { name: segment, path, kind: 'folder', children: [] };
          cursor.children = cursor.children ?? [];
          cursor.children.push(folder);
        }

        cursor = folder;
      }
    }
  }

  sortTree(root);

  return root.children ?? [];
}

/** Recursively sort a node's children: folders before files, each group alphabetized (case-insensitive). */
function sortTree(node: TreeNode): void {
  if (!node.children) {
    return;
  }

  node.children.sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === 'folder' ? -1 : 1;
    }

    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  for (const child of node.children) {
    if (child.kind === 'folder') {
      sortTree(child);
    }
  }
}

/** Extension → CodeMirror language id map (drives syntax highlighting in the viewer). */
const LANGUAGE_BY_EXT: Record<string, string> = {
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'css',
  less: 'css',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  md: 'markdown',
  markdown: 'markdown',
  xml: 'xml',
  svg: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  txt: 'text',
  toml: 'text',
  csv: 'text',
};

/**
 * Map a file path to a CodeMirror language id for syntax highlighting.
 *
 * @param path - The file path or name.
 * @returns A CodeMirror language id (e.g. `typescript`, `html`), or `text` for unknown/extensionless.
 */
export function languageForFile(path: string): string {
  const ext = extensionOf(path);
  return LANGUAGE_BY_EXT[ext] ?? 'text';
}

/** Binary / non-text extensions — the viewer shows an honest "binary file" placeholder for these. */
const BINARY_EXTS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'ico',
  'bmp',
  'tiff',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'pdf',
  'zip',
  'gz',
  'tar',
  'br',
  'mp4',
  'webm',
  'mov',
  'mp3',
  'wav',
  'ogg',
  'wasm',
]);

/**
 * Decide whether a path is a binary asset (image/font/media/archive) that shouldn't be rendered as
 * text. The viewer uses this to show a preview-or-placeholder instead of garbled bytes.
 *
 * @param path - The file path or name.
 * @returns `true` for a known binary extension.
 */
export function isBinaryPath(path: string): boolean {
  return BINARY_EXTS.has(extensionOf(path));
}

/** Image extensions the viewer CAN preview inline (a subset of binary) — served via the raw file URL. */
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp', 'svg']);

/**
 * Decide whether a path is an image the viewer can render inline.
 *
 * @param path - The file path or name.
 * @returns `true` for a previewable image extension.
 */
export function isImagePath(path: string): boolean {
  return IMAGE_EXTS.has(extensionOf(path));
}

/** Lower-cased extension without the dot, or `''` when the name has none. */
export function extensionOf(path: string): string {
  const base = path.split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');

  if (dot <= 0 || dot === base.length - 1) {
    return '';
  }

  return base.slice(dot + 1).toLowerCase();
}

/** Format a byte count into a short human label (`820 B`, `12.4 KB`, `3.1 MB`). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '—';
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** One commit as returned by the worker's `git/history` endpoint (mirrors {@link CommitSummary}). */
export interface CommitEntry {
  id: string;
  parent?: string | null;
  message: string;
  timestamp: string;
  author: string;
  files?: { path: string; size: number }[];
}

/**
 * Short 7-char SHA for a commit id (git-style). Non-hex or short ids pass through unchanged.
 *
 * @param sha - The commit id.
 * @returns The first 7 characters, or the whole id when shorter.
 */
export function shortSha(sha: string): string {
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}

/**
 * Format an ISO timestamp into a compact, locale-agnostic label for the commit timeline
 * (`2026-05-11 14:23`). Invalid input returns the raw string so a bad date never blanks the row.
 *
 * @param iso - ISO 8601 timestamp.
 * @returns `YYYY-MM-DD HH:MM` (UTC), or the input unchanged when unparseable.
 */
export function formatCommitDate(iso: string): string {
  const d = new Date(iso);

  if (Number.isNaN(d.getTime())) {
    return iso;
  }

  const pad = (n: number) => String(n).padStart(2, '0');

  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
