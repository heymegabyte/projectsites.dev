import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  projectSnapshotSchema,
  defaultSnapshotLabel,
  MAX_SNAPSHOTS_PER_SITE,
  pruneExcessSnapshots,
  type ProjectSnapshotMeta,
} from './projectSnapshots';

/**
 * Boundary + helper contract for the editor's project-snapshot store. The
 * IndexedDB CRUD is exercised in a real browser post-deploy (jsdom has no
 * IndexedDB); here we lock the Zod boundary + the label format that the Project
 * hub relies on, so a shape drift fails the build.
 */
describe('projectSnapshotSchema', () => {
  const valid = {
    id: 'snap_1',
    slug: 'acme',
    label: 'Snapshot • Sep 28, 12:15 PM',
    createdAt: '2026-09-28T16:15:00.000Z',
    fileCount: 3,
    totalBytes: 120,
    files: { '/home/project/index.html': '<h1>hi</h1>', '/home/project/app.js': 'export {}' },
  };

  it('accepts a well-formed snapshot', () => {
    const parsed = projectSnapshotSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
  });

  it('rejects a negative fileCount', () => {
    const parsed = projectSnapshotSchema.safeParse({ ...valid, fileCount: -1 });
    expect(parsed.success).toBe(false);
  });

  it('rejects non-string file contents (files must be path → text)', () => {
    const parsed = projectSnapshotSchema.safeParse({ ...valid, files: { '/a': 123 } });
    expect(parsed.success).toBe(false);
  });

  it('rejects a missing createdAt', () => {
    const { createdAt: _drop, ...withoutDate } = valid;
    const parsed = projectSnapshotSchema.safeParse(withoutDate);
    expect(parsed.success).toBe(false);
  });

  it('accepts an empty file set (a snapshot of a blank project)', () => {
    const parsed = projectSnapshotSchema.safeParse({ ...valid, files: {}, fileCount: 0, totalBytes: 0 });
    expect(parsed.success).toBe(true);
  });
});

describe('defaultSnapshotLabel', () => {
  it('produces a friendly, prefixed label', () => {
    const label = defaultSnapshotLabel(new Date('2026-09-28T16:15:00.000Z'));
    expect(label.startsWith('Snapshot • ')).toBe(true);
    expect(label.length).toBeGreaterThan('Snapshot • '.length);
  });

  it('is deterministic for a fixed instant', () => {
    const at = new Date('2026-01-02T09:30:00.000Z');
    expect(defaultSnapshotLabel(at)).toBe(defaultSnapshotLabel(at));
  });
});

describe('MAX_SNAPSHOTS_PER_SITE', () => {
  it('caps retained snapshots at a sane positive bound', () => {
    expect(MAX_SNAPSHOTS_PER_SITE).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_SNAPSHOTS_PER_SITE)).toBe(true);
  });
});

/**
 * The prune loop enforces the per-site cap by deleting the excess. A failed
 * IndexedDB delete must NEVER fail the snapshot create (best-effort), but it also
 * must NOT be swallowed silently — an unbounded, unobservable store is exactly the
 * quota-balloon the cap exists to prevent. So a failed prune-delete logs a
 * structured warn naming the breached id, then keeps going.
 */
describe('pruneExcessSnapshots', () => {
  const meta = (id: string): ProjectSnapshotMeta => ({
    id,
    slug: 'acme',
    label: `Snapshot ${id}`,
    createdAt: '2026-09-28T16:15:00.000Z',
    fileCount: 1,
    totalBytes: 10,
  });

  let warnSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    warnSpy?.mockRestore();
  });

  it('warns (naming the id) but does not throw when a prune-delete fails', async () => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deleteFn = vi.fn(async (_id: string) => {
      throw new Error('IndexedDB delete failed');
    });

    // Best-effort: the create must not fail, so this must resolve, not reject.
    await expect(pruneExcessSnapshots([meta('old-a'), meta('old-b')], deleteFn)).resolves.toBeUndefined();

    // Every failed delete is observable and names the specific breached id.
    expect(deleteFn).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(String(warnSpy.mock.calls[0][0])).toContain('old-a');
    expect(String(warnSpy.mock.calls[1][0])).toContain('old-b');
  });

  it('deletes every excess snapshot and stays silent when deletes succeed', async () => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deleteFn = vi.fn(async (_id: string) => {});

    await pruneExcessSnapshots([meta('x'), meta('y'), meta('z')], deleteFn);

    expect(deleteFn).toHaveBeenCalledTimes(3);
    expect(deleteFn).toHaveBeenCalledWith('x');
    expect(deleteFn).toHaveBeenCalledWith('z');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('is a no-op on an empty excess list', async () => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deleteFn = vi.fn(async (_id: string) => {});

    await pruneExcessSnapshots([], deleteFn);

    expect(deleteFn).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
