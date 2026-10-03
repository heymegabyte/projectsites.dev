// @vitest-environment jsdom
/**
 * Security + contract tests for the admin↔editor postMessage bridge.
 *
 * `embedded-mode.ts` is the trust boundary between the projectsites.dev admin
 * (parent) and the bolt.diy editor (child iframe). It underpins the persistent
 * editor embed + the model-fetch / chat-import console-hygiene guards. The two
 * load-bearing guarantees, previously untested:
 *
 *   1. Origin allowlist — a `message` from a NON-allowlisted origin is dropped
 *      (an attacker page embedding/opening the editor must not drive it).
 *   2. PS_ protocol filter — only `{type: 'PS_*'}` messages reach handlers.
 *   3. `isEmbedded` detection gates the whole module: outside an embedded
 *      iframe, `postToParent` is a no-op and no listener drives the editor.
 *
 * The module computes `isEmbedded` at import time from `window`, so each block
 * stubs `window.parent` + `?embedded` BEFORE a `vi.resetModules()` dynamic
 * import.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PromoteReleaseRecord, ReleaseHistoryRecord } from './embedded-mode';

type EmbedModule = typeof import('./embedded-mode');

describe('embedded-mode — release bridge carries serving_sha (Slice 6b)', () => {
  /*
   * Type-contract test: the release-history + promote bridge records MUST type the worker's
   * proof-of-serving `serving_sha` (a nullable string, matching durable_preview `ReleaseSchema`), so
   * use-promote reads it WITHOUT a narrowed local cast. If the field is dropped from either interface,
   * these object literals fail `tsc --noEmit` (the real gate); the runtime asserts keep them live cases.
   */
  it('ReleaseHistoryRecord types serving_sha as a nullable string', () => {
    const served: ReleaseHistoryRecord = {
      id: 'r1',
      commit_sha: 'abc1234',
      artifact_digest: 'art',
      deployment_id: 'v1',
      serving_sha: 'deadbeef1234feedface5678',
      actor: 'owner@example.com',
      draft_revision: 3,
      outcome: 'success',
      created_at: '2026-09-29T13:00:00Z',
    };
    const unserved: ReleaseHistoryRecord = {
      ...served,
      id: 'r2',
      serving_sha: null,
      outcome: 'commit_ok_deploy_failed',
    };

    expect(served.serving_sha).toBe('deadbeef1234feedface5678');
    expect(unserved.serving_sha).toBeNull();
  });

  it('PromoteReleaseRecord types serving_sha as a nullable string', () => {
    const record: PromoteReleaseRecord = {
      id: 'r3',
      commit_sha: 'abc1234',
      artifact_digest: 'art',
      deployment_id: 'v2',
      serving_sha: 'cafebabe0000111122223333',
      actor: 'owner@example.com',
      draft_revision: 7,
      outcome: 'success',
      created_at: '2026-09-29T13:05:00Z',
    };

    expect(record.serving_sha).toBe('cafebabe0000111122223333');
  });
});

/** Stub the window so `detectEmbedded()` returns the desired value, then import fresh. */
async function importWith(opts: { embedded: boolean }): Promise<{
  mod: EmbedModule;
  parentPostMessage: ReturnType<typeof vi.fn>;
}> {
  vi.resetModules();

  /*
   * detectEmbedded() stamps localStorage.ps_embedded='1' when it sees ?embedded,
   * then on a param-less reload FALLS BACK to that stamp. Without clearing it the
   * embedded block's stamp leaks into the standalone block → isEmbedded wrongly
   * true (the whole module gates on it), so postToParent posts + the message
   * listener fires when it shouldn't. Remove the stamp per import so each block is
   * truly independent regardless of describe/file order. GUARDED because jsdom's
   * opaque origin throws on localStorage locally (where the stamp never persists,
   * so tests passed) — the clear only matters in CI, where storage works and this
   * leak was masked for months by the red lint step short-circuiting `Run tests`.
   */
  try {
    window.localStorage.removeItem('ps_embedded');
  } catch {
    // localStorage unavailable (jsdom opaque origin) — nothing persisted to leak.
  }

  const parentPostMessage = vi.fn();

  /*
   * Always present a DISTINCT parent (parent !== window) so the only variable
   * under test is the `?embedded` query param. detectEmbedded() requires BOTH
   * parent !== window AND ?embedded — so toggling the param alone flips it.
   */
  Object.defineProperty(window, 'parent', {
    value: { postMessage: parentPostMessage },
    configurable: true,
  });
  window.history.replaceState(null, '', opts.embedded ? '/?embedded=true' : '/');

  const mod = (await import('./embedded-mode')) as EmbedModule;

  return { mod, parentPostMessage };
}

function fireMessage(data: unknown, origin: string): void {
  window.dispatchEvent(new MessageEvent('message', { data, origin }));
}

const ALLOWED = 'https://projectsites.dev';
const FOREIGN = 'https://evil.example.com';

describe('embedded-mode — embedded iframe', () => {
  let mod: EmbedModule;
  let parentPostMessage: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    ({ mod, parentPostMessage } = await importWith({ embedded: true }));
    parentPostMessage.mockClear(); // ignore the init PS_BOLT_READY rAF
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('detects embedded mode', () => {
    expect(mod.isEmbedded).toBe(true);
  });

  it('delivers a PS_ message from an allowlisted origin to handlers', () => {
    const handler = vi.fn();
    const off = mod.onParentMessage(handler);
    fireMessage({ type: 'PS_OPEN_FILE', file: 'x.ts', correlationId: '1' }, ALLOWED);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ type: 'PS_OPEN_FILE' }));
    off();
  });

  it('DROPS a message from a non-allowlisted origin (security boundary)', () => {
    const handler = vi.fn();
    const off = mod.onParentMessage(handler);
    fireMessage({ type: 'PS_OPEN_FILE', file: 'x.ts', correlationId: '1' }, FOREIGN);
    expect(handler).not.toHaveBeenCalled();
    off();
  });

  it('ignores a non-PS message even from an allowlisted origin', () => {
    const handler = vi.fn();
    const off = mod.onParentMessage(handler);
    fireMessage({ type: 'NOT_OURS', payload: 1 }, ALLOWED);
    expect(handler).not.toHaveBeenCalled();
    off();
  });

  it('unsubscribe stops further delivery', () => {
    const handler = vi.fn();
    const off = mod.onParentMessage(handler);
    off();
    fireMessage({ type: 'PS_OPEN_FILE', file: 'x.ts', correlationId: '1' }, ALLOWED);
    expect(handler).not.toHaveBeenCalled();
  });

  it('postToParent posts to the parent with a wildcard target', () => {
    mod.postToParent({ type: 'PS_BOLT_READY' });
    expect(parentPostMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'PS_BOLT_READY' }), '*');
  });

  it('postToastToParent sends both kind + level aliases', () => {
    mod.postToastToParent('success', 'Saved');
    expect(parentPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'PS_TOAST', kind: 'success', level: 'success', message: 'Saved' }),
      '*',
    );
  });
});

describe('embedded-mode — standalone (not embedded)', () => {
  let mod: EmbedModule;
  let parentPostMessage: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    ({ mod, parentPostMessage } = await importWith({ embedded: false }));
  });

  it('reports not embedded', () => {
    expect(mod.isEmbedded).toBe(false);
  });

  it('postToParent is a no-op outside an embedded iframe', () => {
    // Delta-check: robust against any stray rAF from the embedded block above.
    const before = parentPostMessage.mock.calls.length;
    mod.postToParent({ type: 'PS_BOLT_READY' });
    expect(parentPostMessage.mock.calls.length).toBe(before);
  });

  it('does not drive handlers from window messages when standalone', () => {
    const handler = vi.fn();
    mod.onParentMessage(handler);
    fireMessage({ type: 'PS_OPEN_FILE', file: 'x.ts', correlationId: '1' }, ALLOWED);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('materializeImportedFiles', () => {
  const FILES_MESSAGE = (extra: string) =>
    'Intro text <boltArtifact id="a" title="Site"><boltAction type="file" filePath="index.html">' +
    '<html><h1>Hello</h1></html></boltAction><boltAction type="shell">npm install</boltAction>' +
    extra +
    '</boltArtifact>';

  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('stashes parsed file actions into sessionStorage under the materialization key', async () => {
    const { mod } = await importWith({ embedded: true });
    const count = mod.materializeImportedFiles([{ content: FILES_MESSAGE('') }]);
    expect(count).toBe(1);

    const raw = window.sessionStorage.getItem('ps_materialized_files');
    expect(raw).toBeTruthy();

    const files = JSON.parse(raw ?? '{}');
    expect(files['index.html']).toContain('<html><h1>Hello</h1></html>');
  });

  it('skips shell actions (only type=file counts) and returns 0 for a shell-only artifact', async () => {
    const { mod } = await importWith({ embedded: true });
    const count = mod.materializeImportedFiles([
      { content: '<boltArtifact><boltAction type="shell">npm install</boltAction></boltArtifact>' },
    ]);
    expect(count).toBe(0);
    expect(window.sessionStorage.getItem('ps_materialized_files')).toBeNull();
  });

  it('drains the stash exactly once (single-consumption) — the restore handoff contract', async () => {
    const { mod } = await importWith({ embedded: true });
    window.sessionStorage.setItem('ps_materialized_files', JSON.stringify({ 'index.html': '<h1>x</h1>' }));
    mod.restoreMaterializedFiles();
    expect(window.sessionStorage.getItem('ps_materialized_files')).toBeNull();

    // A second restore is a no-op — nothing left to drain.
    expect(() => mod.restoreMaterializedFiles()).not.toThrow();
  });
});
