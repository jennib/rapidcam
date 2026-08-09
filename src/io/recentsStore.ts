/**
 * Faithful payloads for the Recent Files list, backed by IndexedDB.
 *
 * Recents live in localStorage so the welcome screen and File menu can render
 * the list **synchronously** at first paint. That store has a ~5 MB origin quota
 * shared with everything else, so `pushRecent` caches a `stripEmbeddedFonts`'d
 * copy — fonts and images removed. For the *list* that is fine: it only shows a
 * name and the canvas size.
 *
 * It was not fine for *opening*. The stripped copy was also what got loaded, so
 * reopening an image-bearing design from Recents in a fresh session produced a
 * document whose image entity referenced pixels nothing had registered: the
 * canvas drew an empty dashed placement rect, no warning fired, and saving from
 * that state wrote a .rcam with the image entity intact and no pixels behind it
 * — the picture destroyed, silently. (`e2e/recentsImageLoss.e2e.ts` is that
 * round trip.)
 *
 * So the same split the autosave draft already uses: a lightweight index in
 * localStorage for first paint, the whole document — fonts and images included —
 * in IndexedDB's roomier, browser-managed quota, read only when the user
 * actually opens the entry. Keyed by recent name, which is what `pushRecent`
 * already dedupes on.
 *
 * Degradations, all non-fatal:
 *   - IndexedDB unavailable: `loadRecentPayload` returns null and the caller
 *     falls back to the stripped localStorage copy — the old behaviour.
 *   - An entry written before this existed has no payload; same fallback.
 */

import { openDb, idbPut, idbGet, idbDelete, idbKeys, STORE_RECENTS as STORE } from "./idb";
import type { RcamFile } from "./fileio";

/**
 * Store the faithful document for a recent. Best-effort: recents are a
 * convenience cache, so a failure here degrades to the stripped localStorage
 * copy rather than failing the save that triggered it.
 */
export async function saveRecentPayload(name: string, data: RcamFile): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    await idbPut(db, STORE, name, data);
  } catch {
    /* quota or transaction failure — the localStorage copy still covers the list */
  } finally {
    db.close();
  }
}

/**
 * The faithful document for a recent, or null when there isn't one (IndexedDB
 * unavailable, or an entry saved before this store existed). Callers must fall
 * back to the localStorage copy on null.
 */
export async function loadRecentPayload(name: string): Promise<RcamFile | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    return await idbGet<RcamFile>(db, STORE, name);
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/**
 * Drop payloads whose entry is no longer in the list — the list is capped, and
 * entries also get evicted when localStorage is full, so without this the DB
 * would grow without bound as designs age out.
 */
export async function pruneRecentPayloads(keep: readonly string[]): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const live = new Set(keep);
    for (const key of await idbKeys(db, STORE)) {
      if (!live.has(key)) await idbDelete(db, STORE, key);
    }
  } catch {
    /* best-effort housekeeping */
  } finally {
    db.close();
  }
}
