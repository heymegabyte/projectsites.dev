import { describe, it, expect } from 'vitest';

import { projectSnapshotSchema, defaultSnapshotLabel, MAX_SNAPSHOTS_PER_SITE } from './projectSnapshots';

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
