/**
 * Autosave-draft store, backed by IndexedDB.
 *
 * A draft can be several MB — a design with an embedded engrave/relief image
 * carries the base64 pixels inline. The old localStorage-only cache dodged its
 * ~5 MB origin quota by stripping the embedded fonts *and images* before caching,
 * so an image-bearing design came back from "Restore draft" with its picture
 * gone. IndexedDB is the same kind of thing as localStorage (a local, on-disk,
 * per-origin store — nothing ever leaves the browser) but with a far larger,
 * browser-managed quota, so the whole document — images included — lives there
 * and restores faithfully.
 *
 * A tiny `{ name, savedAt }` *pointer* still lives in localStorage under the
 * historical `autosaveDraft` key. That lets the welcome screen decide
 * **synchronously**, at first paint, whether to offer "Restore draft" without
 * awaiting an async DB open — the full payload is only read (async) if the user
 * actually clicks restore.
 *
 * Degradations, all non-fatal:
 *   - IndexedDB unavailable (private mode / disabled): fall back to writing the
 *     whole draft into the localStorage pointer via `trySetItem` — exactly the
 *     old behaviour, so image-free drafts still autosave and large ones fail the
 *     same way they used to (no regression).
 *   - A pre-IndexedDB draft (whole draft in localStorage): `loadDraftData` falls
 *     back to the pointer's inline `data`, so an in-flight upgrade doesn't drop a
 *     draft the user left open.
 */

import { StorageKeys } from "../core/storageKeys";
import { trySetItem, stripEmbeddedFonts, type RcamFile } from "./fileio";

const DB_NAME = "rapidcam";
const DB_VERSION = 1;
const STORE = "drafts";
/** Single-draft store: one row, always under this key. */
const DRAFT_KEY = "current";
/** localStorage pointer key — reused from the pre-IndexedDB design so existing
 *  drafts and the welcome screen's synchronous read keep working. */
const POINTER_KEY = StorageKeys.autosaveDraft;

/** Lightweight metadata the welcome screen reads synchronously at first paint. */
export interface DraftMeta {
  name: string;
  savedAt: number;
}

/** The full persisted draft: metadata plus the structured `.rcam` document. */
interface DraftRecord extends DraftMeta {
  data: RcamFile;
}

/** Resolves to the open DB, or null when IndexedDB is unavailable/blocked. */
function openDb(): Promise<IDBDatabase | null> {
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
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    // Blocked (e.g. private mode) or errored — degrade to the localStorage path.
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

function idbPut(db: IDBDatabase, value: DraftRecord): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, DRAFT_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function idbGet(db: IDBDatabase): Promise<DraftRecord | null> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(DRAFT_KEY);
    req.onsuccess = () => resolve((req.result as DraftRecord | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
}

function idbDelete(db: IDBDatabase): Promise<void> {
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(DRAFT_KEY);
    // Best-effort: a failed delete is not worth surfacing.
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

function writePointer(meta: DraftMeta): void {
  trySetItem(POINTER_KEY, JSON.stringify(meta));
}

/**
 * The draft's metadata, read synchronously from the localStorage pointer.
 * Returns null when there is no draft (or the pointer is corrupt). Tolerates a
 * legacy full-draft value (which also carries `name`/`savedAt`).
 */
export function getDraftMeta(): DraftMeta | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(POINTER_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.name === "string" && typeof parsed.savedAt === "number") {
      return { name: parsed.name, savedAt: parsed.savedAt };
    }
  } catch {
    /* corrupt pointer — treat as no draft */
  }
  return null;
}

/**
 * Persist the current working document as the autosave draft: the full document
 * — embedded fonts and images included — to IndexedDB, a small pointer to
 * localStorage. IndexedDB's roomy quota is what lets the draft keep its image
 * pixels, so an image-bearing design restores faithfully.
 *
 * Falls back to a whole-draft localStorage write when IndexedDB is unavailable;
 * there the embedded fonts/images are stripped (`stripEmbeddedFonts`) to fit the
 * ~5 MB quota — a lossy-but-non-fatal degradation, exactly the pre-existing
 * behaviour.
 */
export async function saveDraft(name: string, data: RcamFile): Promise<void> {
  const meta: DraftMeta = { name, savedAt: Date.now() };
  const db = await openDb();
  if (db) {
    try {
      await idbPut(db, { ...meta, data });
      writePointer(meta);
      return;
    } catch {
      /* IndexedDB write failed mid-flight — fall through to localStorage */
    } finally {
      db.close();
    }
  }
  // No IndexedDB: stash a font/image-stripped draft in the pointer (old
  // behaviour). May still fail for a large geometry-only draft, and non-fatal.
  trySetItem(POINTER_KEY, JSON.stringify({ ...meta, data: stripEmbeddedFonts(data) }));
}

/**
 * The full draft document, or null when there's nothing to restore. Reads
 * IndexedDB first, then falls back to a legacy inline-`data` pointer so a draft
 * left open across the upgrade isn't lost.
 */
export async function loadDraftData(): Promise<RcamFile | null> {
  const db = await openDb();
  if (db) {
    try {
      const rec = await idbGet(db);
      if (rec?.data) return rec.data;
    } catch {
      /* fall through to the legacy pointer */
    } finally {
      db.close();
    }
  }
  try {
    const raw = localStorage.getItem(POINTER_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.data && typeof parsed.data === "object") return parsed.data as RcamFile;
    }
  } catch {
    /* no legacy payload */
  }
  return null;
}

/**
 * Drop the draft — pointer and payload both. Synchronous return (the localStorage
 * pointer, which gates the welcome-screen card, clears immediately); the
 * IndexedDB delete runs best-effort in the background.
 */
export function clearDraft(): void {
  try {
    localStorage.removeItem(POINTER_KEY);
  } catch {
    /* storage disabled — nothing to clear */
  }
  void openDb().then((db) => {
    if (!db) return;
    void idbDelete(db).finally(() => db.close());
  });
}
