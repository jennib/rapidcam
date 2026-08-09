import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { RcamFile } from "../src/io/fileio";

/**
 * Covers the recents payload store — the IndexedDB half of the Recent Files
 * list.
 *
 * Same shape as the autosave draft's bug, one store over: the localStorage copy
 * that renders the list is `stripEmbeddedFonts`'d to fit the ~5 MB quota, and
 * that stripped copy used to be what got OPENED too. Reopening an image-bearing
 * design from Recents in a fresh session therefore produced an image entity with
 * no pixels behind it — drawn as an empty dashed rect, no warning — and the next
 * save wrote that hollow document to disk, destroying the picture silently.
 *
 * So the pixels are pinned here: `saveRecentPayload` must keep `images` and
 * `fonts` intact, because dropping them is the entire bug. The end-to-end round
 * trip through the real app is `e2e/recentsImageLoss.e2e.ts`.
 *
 * `fake-indexeddb` supplies the API this environment lacks; a fresh
 * `IDBFactory` per test keeps databases isolated.
 */

function sampleFile(name: string): RcamFile {
  return {
    version: 3,
    name,
    displayUnit: "mm",
    canvas: { width: 100, height: 80 },
    entities: [{ id: "e1", type: "image", imageId: "img-1" }],
    fonts: [{ family: "Foo", data: "AAAA" }],
    images: [{ id: "img-1", name: "pic", width: 2, height: 2, data: "BBBB" }],
  } as unknown as RcamFile;
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("indexedDB", new IDBFactory());
});

describe("recentsStore", () => {
  test("a saved payload round-trips with its embedded images and fonts intact", async () => {
    const { saveRecentPayload, loadRecentPayload } = await import("../src/io/recentsStore");
    await saveRecentPayload("widget", sampleFile("widget"));
    const back = await loadRecentPayload("widget");
    expect(back?.name).toBe("widget");
    // The whole point: these are what the localStorage copy has to throw away.
    expect(back?.images).toHaveLength(1);
    expect(back?.fonts).toHaveLength(1);
    expect(back?.entities).toHaveLength(1);
  });

  test("payloads are keyed per recent, so one design never returns another's pixels", async () => {
    const { saveRecentPayload, loadRecentPayload } = await import("../src/io/recentsStore");
    await saveRecentPayload("a", sampleFile("a"));
    await saveRecentPayload("b", sampleFile("b"));
    expect((await loadRecentPayload("a"))?.name).toBe("a");
    expect((await loadRecentPayload("b"))?.name).toBe("b");
  });

  test("an entry with no stored payload reads back null, so the caller can fall back", async () => {
    const { loadRecentPayload } = await import("../src/io/recentsStore");
    // Exactly the pre-upgrade case: a recent written before this store existed.
    expect(await loadRecentPayload("never-saved")).toBeNull();
  });

  test("pruning drops payloads whose entry has aged out and keeps the rest", async () => {
    const { saveRecentPayload, loadRecentPayload, pruneRecentPayloads } = await import(
      "../src/io/recentsStore"
    );
    await saveRecentPayload("keep", sampleFile("keep"));
    await saveRecentPayload("drop", sampleFile("drop"));
    await pruneRecentPayloads(["keep"]);
    expect(await loadRecentPayload("keep")).not.toBeNull();
    expect(await loadRecentPayload("drop")).toBeNull();
  });

  test("without IndexedDB every call degrades quietly instead of throwing", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const { saveRecentPayload, loadRecentPayload, pruneRecentPayloads } = await import(
      "../src/io/recentsStore"
    );
    // A save that cannot persist must not fail the File ▸ Save that triggered it.
    await expect(saveRecentPayload("widget", sampleFile("widget"))).resolves.toBeUndefined();
    await expect(loadRecentPayload("widget")).resolves.toBeNull();
    await expect(pruneRecentPayloads([])).resolves.toBeUndefined();
  });
});
