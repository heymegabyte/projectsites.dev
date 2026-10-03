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
  diffWorkingTree,
  countChanges,
  statusBadge,
  statusLabel,
  summarizePreviewSync,
  syncLabel,
  releaseOutcomeLabel,
  promoteGate,
  type CodeFileEntry,
  type WorkingFile,
  type PreviewWorkingTree,
  type ReleaseRecord,
  type SyncSummary,
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

// ── Source Control — Slice 4 ──────────────────────────────────────────────────

/** Working-tree file factory (the `PS_LIST_FILES` shape). */
function wf(path: string, size = 100): WorkingFile {
  return { path, size };
}

describe('git-browser-logic · diffWorkingTree (Preview vs main base)', () => {
  it('classifies added / modified / deleted vs the base, grouped modified→added→deleted', () => {
    const working: WorkingFile[] = [
      wf('index.html', 1200), // modified (base 1000)
      wf('src/App.tsx', 500), // added (not in base)
      wf('styles.css', 300), // unchanged (same size)
    ];
    const base: CodeFileEntry[] = [
      f('index.html', 1000),
      f('styles.css', 300),
      f('old.js', 200), // deleted (not in working)
    ];

    const changes = diffWorkingTree(working, base);

    // Unchanged file is absent; the three real changes are present, modified first, deleted last.
    expect(changes.map((c) => `${c.status}:${c.path}`)).toEqual([
      'modified:index.html',
      'added:src/App.tsx',
      'deleted:old.js',
    ]);

    const modified = changes.find((c) => c.path === 'index.html');
    expect(modified).toMatchObject({ status: 'modified', size: 1200, baseSize: 1000 });
  });

  it('returns an EMPTY change set when Preview matches the base (honest in-sync)', () => {
    const files = [wf('index.html', 1000), wf('styles.css', 300)];
    const base = [f('index.html', 1000), f('styles.css', 300)];
    expect(diffWorkingTree(files, base)).toEqual([]);
  });

  it('normalizes a leading ./ or / so identical files are not falsely "changed"', () => {
    const working = [wf('./index.html', 1000), wf('/assets/app.js', 500)];
    const base = [f('index.html', 1000), f('assets/app.js', 500)];
    expect(diffWorkingTree(working, base)).toEqual([]);
  });

  it('collapses a same-basename same-size add+delete into a single rename', () => {
    const working = [wf('src/App.tsx', 500)];
    const base = [f('App.tsx', 500)];

    const changes = diffWorkingTree(working, base);

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ status: 'renamed', path: 'src/App.tsx', fromPath: 'App.tsx' });
  });

  it('countChanges tallies per-status counts + total', () => {
    const working = [wf('a.txt', 2), wf('b.txt', 3), wf('c.txt', 9)];
    const base = [f('a.txt', 1), f('d.txt', 4)]; // a modified, b+c added, d deleted
    const counts = countChanges(diffWorkingTree(working, base));

    expect(counts).toEqual({ total: 4, added: 2, modified: 1, deleted: 1, renamed: 0 });
  });

  it('statusBadge / statusLabel map each status to a letter + word', () => {
    expect(statusBadge('added')).toBe('A');
    expect(statusBadge('modified')).toBe('M');
    expect(statusBadge('deleted')).toBe('D');
    expect(statusBadge('renamed')).toBe('R');
    expect(statusLabel('modified')).toBe('Modified');
    expect(statusLabel('renamed')).toBe('Renamed');
  });
});

/** Working-tree record factory (the `PS_PREVIEW_STATE` shape). */
function tree(overrides: Partial<PreviewWorkingTree> = {}): PreviewWorkingTree {
  return {
    base_main_sha: 'aaaaaaa',
    draft_revision: 5,
    tree_digest: 'digest',
    preview_deploy_revision: null,
    last_error: null,
    updated_at: '2026-05-11T14:00:00Z',
    ...overrides,
  };
}

/** Release-record factory (the `PS_RELEASES` shape). */
function rel(overrides: Partial<ReleaseRecord> = {}): ReleaseRecord {
  return {
    id: crypto.randomUUID(),
    commit_sha: 'aaaaaaa',
    artifact_digest: 'digest',
    deployment_id: 'dep-1',
    actor: 'owner@example.com',
    draft_revision: 5,
    outcome: 'success',
    created_at: '2026-05-11T13:00:00Z',
    ...overrides,
  };
}

describe('git-browser-logic · summarizePreviewSync (Preview ↔ Production)', () => {
  it('reports no_release when there is no deployed release yet', () => {
    const s = summarizePreviewSync(tree(), []);
    expect(s.state).toBe('no_release');
    expect(s.productionSha).toBeNull();
    expect(syncLabel(s.state)).toBe('Not yet published');
  });

  it('reports in_sync when Preview SHA == the latest release SHA and no newer draft', () => {
    const s = summarizePreviewSync(tree({ base_main_sha: 'sha1', draft_revision: 5 }), [
      rel({ commit_sha: 'sha1', draft_revision: 5 }),
    ]);
    expect(s.state).toBe('in_sync');
    expect(s.previewSha).toBe('sha1');
    expect(s.productionSha).toBe('sha1');
  });

  it('reports preview_ahead when the SHAs differ', () => {
    const s = summarizePreviewSync(tree({ base_main_sha: 'sha2' }), [rel({ commit_sha: 'sha1' })]);
    expect(s.state).toBe('preview_ahead');
    expect(syncLabel(s.state)).toBe('Preview ahead of Production');
  });

  it('reports preview_ahead when the draft revision is newer than the release, even at the same SHA', () => {
    const s = summarizePreviewSync(tree({ base_main_sha: 'sha1', draft_revision: 8 }), [
      rel({ commit_sha: 'sha1', draft_revision: 5 }),
    ]);
    expect(s.state).toBe('preview_ahead');
  });

  it('skips a failed release for the live SHA but still surfaces deploy-failed from the newest', () => {
    const s = summarizePreviewSync(tree({ base_main_sha: 'sha2' }), [
      rel({ commit_sha: 'sha2', outcome: 'commit_ok_deploy_failed', created_at: '2026-05-11T14:00:00Z' }),
      rel({ commit_sha: 'sha1', outcome: 'success', created_at: '2026-05-11T12:00:00Z' }),
    ]);

    // Newest deployed-or-attempted release wins the live SHA (commit_ok_deploy_failed counts as committed).
    expect(s.productionSha).toBe('sha2');
    expect(s.deployFailed).toBe(true);
    expect(s.lastOutcome).toBe('commit_ok_deploy_failed');
  });

  it('releaseOutcomeLabel maps each outcome to an honest label', () => {
    expect(releaseOutcomeLabel('success')).toBe('Deployed');
    expect(releaseOutcomeLabel('commit_ok_deploy_failed')).toBe('Deploy failed');
    expect(releaseOutcomeLabel('failed')).toBe('Failed');
  });
});

describe('git-browser-logic · promoteGate (Promote → Production offer + reason)', () => {
  const ahead: SyncSummary = {
    state: 'preview_ahead',
    previewSha: 'sha2',
    productionSha: 'sha1',
    lastOutcome: 'success',
    deployFailed: false,
  };
  const inSync: SyncSummary = {
    state: 'in_sync',
    previewSha: 'sha1',
    productionSha: 'sha1',
    lastOutcome: 'success',
    deployFailed: false,
  };

  it('offers Promote when Preview is ahead of Production', () => {
    const g = promoteGate(true, true, false, tree(), ahead);
    expect(g.canPromote).toBe(true);
    expect(g.reason).toBe('');
  });

  it('disables WITH a reason when not embedded (never a dead control)', () => {
    const g = promoteGate(false, true, false, tree(), ahead);
    expect(g.canPromote).toBe(false);
    expect(g.reason).toMatch(/admin/i);
  });

  it('disables WITH a reason while state is still loading', () => {
    const g = promoteGate(true, false, false, null, null);
    expect(g.canPromote).toBe(false);
    expect(g.reason).toMatch(/loading/i);
  });

  it('disables WITH a reason when the durable_preview flag is dark', () => {
    const g = promoteGate(true, true, true, tree(), ahead);
    expect(g.canPromote).toBe(false);
    expect(g.reason).toMatch(/coming soon/i);
  });

  it('disables WITH a reason when nothing is saved in Preview yet', () => {
    const g = promoteGate(true, true, false, null, null);
    expect(g.canPromote).toBe(false);
    expect(g.reason).toMatch(/save an edit/i);
  });

  it('disables WITH a reason when Production already matches Preview', () => {
    const g = promoteGate(true, true, false, tree(), inSync);
    expect(g.canPromote).toBe(false);
    expect(g.reason).toMatch(/already matches/i);
  });

  it('OFFERS Promote even when in sync IF the last deploy failed (retry path)', () => {
    const g = promoteGate(true, true, false, tree(), { ...inSync, deployFailed: true });
    expect(g.canPromote).toBe(true);
  });
});
