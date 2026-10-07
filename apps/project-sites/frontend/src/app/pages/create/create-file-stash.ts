/**
 * @module pages/create/create-file-stash
 *
 * @description
 * IndexedDB stash for the `/create` file uploads so they SURVIVE the signed-out → `/signin` →
 * OAuth/magic-link reload bounce.
 *
 * The signed-out submit persists the business IDENTITY to `localStorage` (via `AuthService`), but
 * `localStorage` can only hold strings — a `File`/`FileList` cannot round-trip through it, so an
 * owner who attached a logo + photos before signing in used to LOSE them silently (the returning
 * auto-submit sent a text-only brief). IndexedDB stores `File`/`Blob` natively (structured clone)
 * AND persists across the full-page OAuth reload, so we stash the Files here, bounce through signin,
 * then the post-signin auto-submit rehydrates them and runs the NORMAL authed upload path
 * (`uploadAssets` → `upload_id` → `createSiteFromSearch`). No backend change — the upload still
 * happens once, after auth.
 *
 * Every op is BEST-EFFORT: private mode / no-IndexedDB / quota / blocked all resolve to a no-op
 * (never throw / reject), so the text-only path keeps working exactly as before when IDB is absent.
 */

const DB_NAME = 'ps-create-stash';
const STORE = 'files';
const RECORD_KEY = 'pending';

/** The set of `/create` uploads held across the signin bounce. */
export interface StashedCreateFiles {
  logo: File | null;
  favicon: File | null;
  additional: File[];
}

/** Open (or create) the stash DB. Resolves `null` when IndexedDB is unavailable/blocked. */
function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined' || !indexedDB) {
        resolve(null);
        return;
      }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** Run a transaction to completion, resolving (never rejecting) regardless of outcome. */
function runTx(db: IDBDatabase, mode: IDBTransactionMode, op: (store: IDBObjectStore) => void): Promise<void> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, mode);
      op(tx.objectStore(STORE));
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

/**
 * Stash the current `/create` uploads so they survive the signin bounce. Overwrites any prior
 * stash (single-slot). Best-effort — a storage failure never blocks the signin redirect.
 */
export async function stashCreateFiles(files: StashedCreateFiles): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await runTx(db, 'readwrite', (store) =>
    store.put({ logo: files.logo, favicon: files.favicon, additional: files.additional }, RECORD_KEY),
  );
  db.close();
}

/**
 * Read back the stashed uploads (or `null` when none / unavailable). Defensively normalizes the
 * record so a corrupt / partially-cloned entry can never crash the returning auto-submit.
 */
export async function restoreCreateFiles(): Promise<StashedCreateFiles | null> {
  const db = await openDb();
  if (!db) return null;
  const rec = await new Promise<Partial<StashedCreateFiles> | null>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(RECORD_KEY);
      req.onsuccess = () => resolve((req.result as Partial<StashedCreateFiles>) ?? null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  db.close();
  if (!rec) return null;
  const normalized: StashedCreateFiles = {
    logo: rec.logo instanceof File ? rec.logo : null,
    favicon: rec.favicon instanceof File ? rec.favicon : null,
    additional: Array.isArray(rec.additional) ? rec.additional.filter((f): f is File => f instanceof File) : [],
  };
  // A record with zero usable files is equivalent to no stash.
  if (!normalized.logo && !normalized.favicon && normalized.additional.length === 0) return null;
  return normalized;
}

/** Drop the stash (on consume + on draft discard / successful create). Best-effort. */
export async function clearCreateFiles(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await runTx(db, 'readwrite', (store) => store.delete(RECORD_KEY));
  db.close();
}
