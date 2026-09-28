/**
 * Project snapshots — a self-contained, per-site restore-point store for the
 * bolt.diy editor's Code workspace.
 *
 * Distinct from:
 *  - `persistence/db.ts`'s single-slot per-chat `snapshots` store (ONE auto
 *    snapshot per chat, used by the chat-rewind flow), and
 *  - the DATABASE time-travel panel (Cloudflare D1 point-in-time restore).
 *
 * This is a MULTI-snapshot store of the PROJECT'S source files so a user can
 * "take a snapshot", "restore a previous snapshot", and "delete a snapshot"
 * from the Code › Project hub — entirely client-side (its OWN IndexedDB
 * database), needing no parent/admin round-trip. Snapshots are keyed by an
 * opaque id and indexed by site slug so each site sees only its own.
 *
 * @module persistence/projectSnapshots
 */
import { z } from 'zod';

const DB_NAME = 'ps_project_snapshots';
const DB_VERSION = 1;
const STORE = 'snapshots';
const SLUG_INDEX = 'by_slug';

/** Cap kept per site so a runaway loop can't exhaust the origin's storage quota. */
export const MAX_SNAPSHOTS_PER_SITE = 25;

/** A stored project snapshot — validated at the IndexedDB boundary. */
export const projectSnapshotSchema = z.object({
  id: z.string(),
  slug: z.string(),
  label: z.string(),

  /** ISO 8601 UTC — sortable, timezone-safe. */
  createdAt: z.string(),
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),

  /** Absolute workbench path (`/home/project/...`) → UTF-8 text content. */
  files: z.record(z.string(), z.string()),
});

export type ProjectSnapshot = z.infer<typeof projectSnapshotSchema>;

/** A snapshot without its (potentially large) file payload — for list UIs. */
export type ProjectSnapshotMeta = Omit<ProjectSnapshot, 'files'>;

function stripFiles(snapshot: ProjectSnapshot): ProjectSnapshotMeta {
  const { files: _files, ...meta } = snapshot;
  return meta;
}

let dbPromise: Promise<IDBDatabase> | undefined;

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('Snapshots need a browser — IndexedDB is unavailable here.'));
  }

  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex(SLUG_INDEX, 'slug', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open the snapshot store.'));
  });

  return dbPromise;
}

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `snap_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/**
 * A friendly default label ("Snapshot • Sep 28, 12:15 PM") for one-click
 * snapshots that need no naming step.
 *
 * @param now - the instant to format; defaults to the current time.
 * @returns a human-readable label in the viewer's locale + timezone.
 * @example
 * defaultSnapshotLabel(new Date('2026-09-28T16:15:00Z')); // "Snapshot • Sep 28, 12:15 PM" (EDT)
 */
export function defaultSnapshotLabel(now: Date = new Date()): string {
  return `Snapshot • ${now.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })}`;
}

/**
 * List a site's snapshots (metadata only), newest first.
 *
 * @param slug - the site slug whose snapshots to list.
 * @returns snapshot metadata, newest → oldest; `[]` when none / on a fresh DB.
 */
export async function listProjectSnapshots(slug: string): Promise<ProjectSnapshotMeta[]> {
  const db = await openDb();

  return new Promise<ProjectSnapshotMeta[]>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const index = tx.objectStore(STORE).index(SLUG_INDEX);
    const request = index.getAll(IDBKeyRange.only(slug || 'untitled'));

    request.onsuccess = () => {
      const rows: ProjectSnapshotMeta[] = [];

      for (const raw of (request.result ?? []) as unknown[]) {
        const parsed = projectSnapshotSchema.safeParse(raw);

        if (parsed.success) {
          rows.push(stripFiles(parsed.data));
        }
      }

      rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      resolve(rows);
    };

    request.onerror = () => reject(request.error ?? new Error('Failed to list snapshots.'));
  });
}

/**
 * Read one snapshot in full (including its file payload) — used by restore.
 *
 * @param id - the snapshot id.
 * @returns the full snapshot, or `undefined` when not found / invalid.
 */
export async function getProjectSnapshot(id: string): Promise<ProjectSnapshot | undefined> {
  const db = await openDb();

  return new Promise<ProjectSnapshot | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).get(id);

    request.onsuccess = () => {
      const parsed = projectSnapshotSchema.safeParse(request.result);
      resolve(parsed.success ? parsed.data : undefined);
    };

    request.onerror = () => reject(request.error ?? new Error('Failed to read the snapshot.'));
  });
}

/**
 * Persist the current project files as a new snapshot, then prune the oldest
 * beyond {@link MAX_SNAPSHOTS_PER_SITE}.
 *
 * @param slug - the owning site slug.
 * @param label - a display label; blank falls back to {@link defaultSnapshotLabel}.
 * @param files - absolute workbench path → text content (from `getTextFiles()`).
 * @returns the created snapshot's metadata.
 * @throws when IndexedDB is unavailable or the write transaction fails.
 */
export async function createProjectSnapshot(
  slug: string,
  label: string,
  files: Record<string, string>,
): Promise<ProjectSnapshotMeta> {
  const totalBytes = Object.values(files).reduce((sum, content) => sum + content.length, 0);
  const snapshot: ProjectSnapshot = projectSnapshotSchema.parse({
    id: newId(),
    slug: slug || 'untitled',
    label: label.trim() || defaultSnapshotLabel(),
    createdAt: new Date().toISOString(),
    fileCount: Object.keys(files).length,
    totalBytes,
    files,
  });

  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(snapshot);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Failed to save the snapshot.'));
  });

  await pruneOld(snapshot.slug);

  return stripFiles(snapshot);
}

/**
 * Re-insert a previously-deleted snapshot verbatim — powers "Undo delete".
 *
 * @param snapshot - the full snapshot record captured before deletion.
 */
export async function restoreDeletedSnapshot(snapshot: ProjectSnapshot): Promise<void> {
  const valid = projectSnapshotSchema.parse(snapshot);
  const db = await openDb();

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(valid);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Failed to restore the snapshot.'));
  });
}

/**
 * Delete one snapshot by id.
 *
 * @param id - the snapshot id to remove.
 */
export async function deleteProjectSnapshot(id: string): Promise<void> {
  const db = await openDb();

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Failed to delete the snapshot.'));
  });
}

async function pruneOld(slug: string): Promise<void> {
  const all = await listProjectSnapshots(slug);
  const excess = all.slice(MAX_SNAPSHOTS_PER_SITE);

  for (const snapshot of excess) {
    await deleteProjectSnapshot(snapshot.id).catch(() => {
      /* best-effort prune — a failed delete must never fail the create. */
    });
  }
}
