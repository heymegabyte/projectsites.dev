/**
 * @file Pure, testable logic for the per-site Code / Git browser (FIRE 7).
 *
 * @remarks
 * The React surfaces that consume this ({@link SourceControlPanel} + the Code-view Project hub) stay
 * thin — all the branchy logic that's worth a unit test
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

/*
 * ── Source Control: working-tree diff (Preview vs main base) — Slice 4 ─────────
 *
 * The Source Control view shows what's changed in PREVIEW (the uncommitted working tree, based on
 * main) relative to the last-published MAIN BASE. Both sides already arrive over existing bridges —
 * the workbench working tree (`PS_LIST_FILES` → path+size) is Preview; the published R2 build
 * (`PS_CODE_TREE_REQUEST` → `CodeFileEntry[]`) is the main base. This module turns those two flat
 * lists into a per-file change set + a headline count, purely + deterministically, so the panel stays
 * thin and the diff logic is unit-tested. It NEVER mutates anything — status is inspect-only; the
 * panel's "restore to Preview" acts through the workbench, never a commit or a Production change.
 */

/** A file's change status vs the main base (git-style single letters map to these). */
export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

/** One entry in the working-tree change set. */
export interface FileChange {
  /** The working-tree-relative path (for `renamed`, the NEW path). */
  path: string;

  /** `added` (not in base) · `modified` (in both, different) · `deleted` (base only) · `renamed`. */
  status: ChangeStatus;

  /** Working-tree byte size (undefined for a pure `deleted`). */
  size?: number;

  /** Base byte size when known (drives a size-delta hint; undefined for a pure `added`). */
  baseSize?: number;

  /** For `renamed`: the OLD (base) path the file moved from. */
  fromPath?: string;
}

/** One working-tree file as the `PS_LIST_FILES` bridge returns it (path + UTF-8 byte size). */
export interface WorkingFile {
  /** Path relative to the workbench root (no leading slash), e.g. `src/App.tsx`. */
  path: string;

  /** UTF-8 byte length of the file's text content. */
  size: number;
}

/** The single-letter badge shown per change row (`A`/`M`/`D`/`R`). */
export function statusBadge(status: ChangeStatus): string {
  switch (status) {
    case 'added':
      return 'A';
    case 'modified':
      return 'M';
    case 'deleted':
      return 'D';
    case 'renamed':
      return 'R';
    default:
      return '?';
  }
}

/** A human label for a change status (used in `aria-label` + tooltips). */
export function statusLabel(status: ChangeStatus): string {
  switch (status) {
    case 'added':
      return 'Added';
    case 'modified':
      return 'Modified';
    case 'deleted':
      return 'Deleted';
    case 'renamed':
      return 'Renamed';
    default:
      return 'Unknown';
  }
}

/** Normalize a path for comparison — strip a leading `./` or `/` (the two lists can differ on that). */
function normalizePath(path: string): string {
  return path.replace(/^\.?\/+/, '');
}

/**
 * Diff the PREVIEW working tree against the published MAIN BASE and return the per-file change set,
 * grouped by status priority (modified → added → renamed → deleted) so the most common edits surface
 * first, each group sorted by path.
 *
 * A file present in BOTH with a DIFFERENT byte size is `modified` (size is the only signal the flat
 * bridge lists carry — content hashing would need a heavier bridge; size-difference is an honest,
 * conservative "changed" indicator and never claims a change when sizes match). A file only in the
 * working tree is `added`; only in the base is `deleted`. A same-size add+delete pair sharing a
 * basename is collapsed into a single `renamed` (a cheap exact-move heuristic).
 *
 * Pure + deterministic; no bridge/DOM imports so it runs in plain Vitest.
 *
 * @param working - The Preview working-tree files (`PS_LIST_FILES`).
 * @param base - The published main-base files (`PS_CODE_TREE_REQUEST` tree entries).
 * @returns The change set (empty when Preview matches the base — honest "in sync").
 */
export function diffWorkingTree(working: readonly WorkingFile[], base: readonly CodeFileEntry[]): FileChange[] {
  const workingByPath = new Map<string, number>();

  for (const wf of working) {
    workingByPath.set(normalizePath(wf.path), wf.size);
  }

  const baseByPath = new Map<string, number>();

  for (const bf of base) {
    baseByPath.set(normalizePath(bf.name), bf.size);
  }

  const added: FileChange[] = [];
  const modified: FileChange[] = [];
  const deleted: FileChange[] = [];

  for (const [path, size] of workingByPath) {
    if (!baseByPath.has(path)) {
      added.push({ path, status: 'added', size });
    } else if (baseByPath.get(path) !== size) {
      modified.push({ path, status: 'modified', size, baseSize: baseByPath.get(path) });
    }
  }

  for (const [path, size] of baseByPath) {
    if (!workingByPath.has(path)) {
      deleted.push({ path, status: 'deleted', baseSize: size });
    }
  }

  // Collapse an exact add+delete of the same basename+size into a single rename (cheap move heuristic).
  const renamed: FileChange[] = [];
  const basename = (p: string): string => p.split('/').pop() ?? p;

  for (let i = added.length - 1; i >= 0; i--) {
    const a = added[i];
    const match = deleted.findIndex((d) => basename(d.path) === basename(a.path) && d.baseSize === a.size);

    if (match !== -1) {
      const d = deleted[match];
      renamed.push({ path: a.path, status: 'renamed', size: a.size, baseSize: d.baseSize, fromPath: d.path });
      added.splice(i, 1);
      deleted.splice(match, 1);
    }
  }

  const byPath = (a: FileChange, b: FileChange) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' });

  return [...modified.sort(byPath), ...added.sort(byPath), ...renamed.sort(byPath), ...deleted.sort(byPath)];
}

/** Per-status counts + total, for the header badge + the summary line. */
export interface ChangeCounts {
  total: number;
  added: number;
  modified: number;
  deleted: number;
  renamed: number;
}

/** Tally a change set into per-status counts (drives the "N changes" header + colored pills). */
export function countChanges(changes: readonly FileChange[]): ChangeCounts {
  const counts: ChangeCounts = { total: changes.length, added: 0, modified: 0, deleted: 0, renamed: 0 };

  for (const c of changes) {
    counts[c.status] += 1;
  }

  return counts;
}

/*
 * ── Source Control: Preview ↔ Production sync indicator — Slice 4 ──────────────
 *
 * Preview = the latest durably-saved working tree (its `draft_revision` + `base_main_sha`).
 * Production = the last DEPLOYED release SHA (the newest `success` / `commit_ok_deploy_failed` release).
 * The indicator compares them so the owner sees, at a glance, whether Preview is ahead of what's live.
 */

/** The working-tree record as the `PS_PREVIEW_STATE` bridge returns it (mirrors the worker `WorkingTree`). */
export interface PreviewWorkingTree {
  base_main_sha: string | null;
  draft_revision: number;
  tree_digest: string | null;
  preview_deploy_revision: string | null;
  last_error: string | null;
  updated_at: string;
}

/** One immutable release as the `PS_RELEASES` bridge returns it (mirrors the worker `Release`). */
export interface ReleaseRecord {
  id: string;
  commit_sha: string | null;
  artifact_digest: string | null;
  deployment_id: string | null;
  actor: string | null;
  draft_revision: number | null;
  outcome: 'success' | 'commit_ok_deploy_failed' | 'failed';
  created_at: string;
}

/** The computed Preview↔Production relationship the header badge renders. */
export type SyncState = 'in_sync' | 'preview_ahead' | 'no_release' | 'unknown';

/** The full sync summary — state + the two SHAs it was derived from + the last deploy's outcome. */
export interface SyncSummary {
  state: SyncState;
  previewSha: string | null;
  productionSha: string | null;
  lastOutcome: ReleaseRecord['outcome'] | null;

  /** True when the newest release recorded a deploy failure (commit landed, deploy didn't) — honest retry surface. */
  deployFailed: boolean;
}

/** A short, plain-language label for a {@link SyncState} (the header pill text). */
export function syncLabel(state: SyncState): string {
  switch (state) {
    case 'in_sync':
      return 'Preview matches Production';
    case 'preview_ahead':
      return 'Preview ahead of Production';
    case 'no_release':
      return 'Not yet published';
    default:
      return 'Sync status unknown';
  }
}

/**
 * Pick the newest release that actually reached (or attempted) Production. A `failed` (commit didn't
 * even land) is skipped for the "what's live" SHA; a `commit_ok_deploy_failed` still counts as the
 * live commit (the bytes are committed) but flags the deploy failure.
 */
function latestProductionRelease(releases: readonly ReleaseRecord[]): ReleaseRecord | null {
  for (const r of releases) {
    if (r.outcome === 'success' || r.outcome === 'commit_ok_deploy_failed') {
      return r;
    }
  }

  return null;
}

/**
 * Summarize the Preview↔Production relationship from the working-tree record + the (newest-first)
 * release list. Preview's SHA is the working tree's `base_main_sha`; Production's is the newest
 * deployed release's `commit_sha`. Equal → `in_sync`; differ (or Preview has unsaved edits past the
 * release's `draft_revision`) → `preview_ahead`; no deployed release yet → `no_release`; missing data
 * → `unknown` (never a false "in sync").
 *
 * @param workingTree - The Preview working-tree record (or null when none saved yet).
 * @param releases - Immutable releases, newest first (the `PS_RELEASES` payload).
 * @returns The sync summary the header badge + retry banner render.
 */
export function summarizePreviewSync(
  workingTree: PreviewWorkingTree | null,
  releases: readonly ReleaseRecord[],
): SyncSummary {
  const prod = latestProductionRelease(releases);
  const previewSha = workingTree?.base_main_sha ?? null;
  const productionSha = prod?.commit_sha ?? null;
  const lastOutcome = releases.length > 0 ? releases[0].outcome : null;
  const deployFailed = releases.length > 0 && releases[0].outcome === 'commit_ok_deploy_failed';

  if (!prod) {
    return { state: 'no_release', previewSha, productionSha: null, lastOutcome, deployFailed };
  }

  // Preview carries unsaved work beyond the release it was cut from → ahead, even if the SHA matches.
  const draftAhead =
    typeof workingTree?.draft_revision === 'number' &&
    typeof prod.draft_revision === 'number' &&
    workingTree.draft_revision > prod.draft_revision;

  if (!previewSha || !productionSha) {
    // Can't compare SHAs — fall back to the draft-revision signal, else honest "unknown".
    if (draftAhead) {
      return { state: 'preview_ahead', previewSha, productionSha, lastOutcome, deployFailed };
    }

    return { state: 'unknown', previewSha, productionSha, lastOutcome, deployFailed };
  }

  if (previewSha === productionSha && !draftAhead) {
    return { state: 'in_sync', previewSha, productionSha, lastOutcome, deployFailed };
  }

  return { state: 'preview_ahead', previewSha, productionSha, lastOutcome, deployFailed };
}

/** A human label for a release outcome (the release-history row status). */
export function releaseOutcomeLabel(outcome: ReleaseRecord['outcome']): string {
  switch (outcome) {
    case 'success':
      return 'Deployed';
    case 'commit_ok_deploy_failed':
      return 'Deploy failed';
    case 'failed':
      return 'Failed';
    default:
      return 'Unknown';
  }
}

/** Whether the Promote → Production button is offered, and — when not — the plain-language reason. */
export interface PromoteGate {
  canPromote: boolean;

  /** Empty when `canPromote`; else a plain-language reason shown on the disabled control (never a dead end). */
  reason: string;
}

/**
 * Decide whether Promote → Production is offered right now (Slice 5). A control that would fail must be
 * disabled WITH a reason, never a dead/doomed button (embarrassingly-easy-to-use). Promotable ONLY when:
 * embedded + the `durable_preview` flag is on + a Preview working tree exists + Production is behind
 * Preview (or the last release's deploy failed → retry). Otherwise disabled with the reason.
 *
 * @param embedded - Whether the editor is running inside the ProjectSites admin (the authed bridge exists).
 * @param ready - Whether the release/preview state has finished loading.
 * @param disabled - Whether the `durable_preview` flag is dark (feature not available yet).
 * @param previewTree - The Preview working-tree record (null when nothing saved yet).
 * @param sync - The computed Preview↔Production sync summary (null while unknown).
 * @returns Whether Promote is offered + the reason to show when it isn't.
 */
export function promoteGate(
  embedded: boolean,
  ready: boolean,
  disabled: boolean,
  previewTree: PreviewWorkingTree | null,
  sync: SyncSummary | null,
): PromoteGate {
  if (!embedded) {
    return { canPromote: false, reason: 'Open from the ProjectSites admin to publish.' };
  }

  if (!ready) {
    return { canPromote: false, reason: 'Loading your Preview state…' };
  }

  if (disabled) {
    return { canPromote: false, reason: 'Publishing to Production is coming soon for your site.' };
  }

  if (!previewTree) {
    return { canPromote: false, reason: 'Save an edit first — nothing in Preview to publish yet.' };
  }

  // In sync AND the last deploy succeeded → nothing new to promote.
  if (sync?.state === 'in_sync' && !sync.deployFailed) {
    return { canPromote: false, reason: 'Production already matches your Preview.' };
  }

  // Preview ahead, never published, a failed last deploy, or a present-but-unknown tree → promotable.
  return { canPromote: true, reason: '' };
}
