/**
 * Shared IndexedDB plumbing for the local document caches (autosave draft,
 * recents).
 *
 * ONE database, ONE version, opened from ONE place. Two modules opening the same
 * database name at different versions deadlock each other: the higher-version
 * open blocks until every lower-version connection closes, and a lower-version
 * open fails outright once the upgrade has landed. So adding a store means
 * bumping `DB_VERSION` here and creating it in `onupgradeneeded` alongside the
 * existing ones — never calling `indexedDB.open("rapidcam")` anywhere else.
 *
 * Every helper degrades rather than throws: `openDb()` resolves null when
 * IndexedDB is unavailable (private mode, disabled, blocked) and each caller
 * falls back to its localStorage path. These are caches — a failure here must
 * never break a save or an open.
 */

const DB_NAME = "rapidcam";
/**
 * v1 — `drafts` (autosave).
 * v2 — `recents`, added so a recent keeps its embedded fonts and images. The
 *      localStorage copy has to strip them to fit the ~5 MB origin quota, which
 *      is what made an image-bearing design come back from Recents with its
 *      picture gone.
 */
const DB_VERSION = 2;

export const STORE_DRAFTS = "drafts";
export const STORE_RECENTS = "recents";

/** Resolves to the open DB, or null when IndexedDB is unavailable/blocked. */
export function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      // Guarded individually so this handles both a fresh install (creates both)
      // and a v1 → v2 upgrade (creates only `recents`).
      if (!db.objectStoreNames.contains(STORE_DRAFTS)) db.createObjectStore(STORE_DRAFTS);
      if (!db.objectStoreNames.contains(STORE_RECENTS)) db.createObjectStore(STORE_RECENTS);
    };
    req.onsuccess = () => resolve(req.result);
    // Blocked (e.g. private mode) or errored — degrade to the localStorage path.
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

export function idbPut(db: IDBDatabase, store: string, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function idbGet<T>(db: IDBDatabase, store: string, key: string): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
}

/** Best-effort delete: a failed delete is not worth surfacing to the user. */
export function idbDelete(db: IDBDatabase, store: string, key: string): Promise<void> {
  return new Promise((resolve) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

/** Every key in a store — used to prune payloads whose owner has aged out. */
export function idbKeys(db: IDBDatabase, store: string): Promise<string[]> {
  return new Promise((resolve) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).getAllKeys();
    req.onsuccess = () => resolve((req.result as IDBValidKey[]).map(String));
    req.onerror = () => resolve([]);
  });
}
