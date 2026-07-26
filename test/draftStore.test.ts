import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { RcamFile } from "../src/io/fileio";

/**
 * Covers both of the autosave-draft store's paths.
 *
 * The localStorage fallback (IndexedDB unavailable — private mode) strips fonts
 * and images to fit the ~5 MB quota, which is lossy but non-fatal and matches
 * the pre-upgrade behaviour.
 *
 * The IndexedDB happy path is the one that exists to FIX that loss: it keeps the
 * whole document, pixels included, so an image-bearing design restores
 * faithfully. That was a real data-loss bug — a relief/engrave design came back
 * from "Restore draft" with its picture gone — so it is pinned here rather than
 * left to live browser checks. `fake-indexeddb` supplies the API this
 * environment lacks; a fresh `IDBFactory` per test keeps databases isolated.
 */

function fakeLocalStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

const POINTER_KEY = "rapidcam:autosave-draft";

function sampleFile(): RcamFile {
  return {
    version: 2,
    name: "widget",
    displayUnit: "mm",
    canvas: { width: 100, height: 80 },
    entities: [{ id: 1, type: "circle" }],
    fonts: [{ family: "Foo", data: "AAAA" }],
    images: [{ id: "img1", data: "BBBBBBBB" }],
  } as unknown as RcamFile;
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("localStorage", fakeLocalStorage());
  // No IndexedDB in this environment — force the localStorage fallback path.
  vi.stubGlobal("indexedDB", undefined);
});

describe("draftStore (localStorage fallback)", () => {
  test("saveDraft writes a metadata pointer that getDraftMeta reads back", async () => {
    const { saveDraft, getDraftMeta } = await import("../src/io/draftStore");
    const before = Date.now();
    await saveDraft("widget", sampleFile());
    const meta = getDraftMeta();
    expect(meta?.name).toBe("widget");
    expect(meta?.savedAt).toBeGreaterThanOrEqual(before);
  });

  test("the fallback write strips embedded fonts and images to fit the quota", async () => {
    const { saveDraft } = await import("../src/io/draftStore");
    await saveDraft("widget", sampleFile());
    const raw = localStorage.getItem(POINTER_KEY);
    expect(raw).toBeTruthy();
    const stored = JSON.parse(raw as string);
    // Geometry survives; the heavy embedded blobs are dropped on this path.
    expect(stored.data.entities).toHaveLength(1);
    expect(stored.data.fonts).toBeUndefined();
    expect(stored.data.images).toBeUndefined();
  });

  test("loadDraftData round-trips the stored document", async () => {
    const { saveDraft, loadDraftData } = await import("../src/io/draftStore");
    await saveDraft("widget", sampleFile());
    const data = await loadDraftData();
    expect(data?.name).toBe("widget");
    expect(data?.canvas.width).toBe(100);
  });

  test("getDraftMeta is null when there is no draft", async () => {
    const { getDraftMeta } = await import("../src/io/draftStore");
    expect(getDraftMeta()).toBeNull();
  });

  test("getDraftMeta tolerates a corrupt pointer", async () => {
    const { getDraftMeta } = await import("../src/io/draftStore");
    localStorage.setItem(POINTER_KEY, "{not json");
    expect(getDraftMeta()).toBeNull();
  });

  test("clearDraft removes the draft", async () => {
    const { saveDraft, clearDraft, getDraftMeta } = await import("../src/io/draftStore");
    await saveDraft("widget", sampleFile());
    clearDraft();
    expect(getDraftMeta()).toBeNull();
    expect(localStorage.getItem(POINTER_KEY)).toBeNull();
  });

  test("loadDraftData reads a legacy whole-draft pointer (pre-IndexedDB upgrade)", async () => {
    const { loadDraftData } = await import("../src/io/draftStore");
    // Simulate a draft left in localStorage by the old code path.
    localStorage.setItem(
      POINTER_KEY,
      JSON.stringify({ name: "legacy", savedAt: Date.now(), data: sampleFile() }),
    );
    const data = await loadDraftData();
    expect(data?.name).toBe("widget");
  });
});

describe("draftStore (IndexedDB happy path)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("localStorage", fakeLocalStorage());
    // A fresh factory per test: isolated databases, no cross-test leakage.
    vi.stubGlobal("indexedDB", new IDBFactory());
  });

  test("an image-bearing draft restores with its pixels intact", async () => {
    const { saveDraft, loadDraftData } = await import("../src/io/draftStore");
    await saveDraft("widget", sampleFile());

    const data = await loadDraftData();
    // The whole point of the IndexedDB upgrade. On the localStorage fallback
    // these are stripped to fit the quota, which is what silently ate a
    // relief/engrave design's picture on restore.
    expect(data?.images).toEqual([{ id: "img1", data: "BBBBBBBB" }]);
    expect(data?.fonts).toEqual([{ family: "Foo", data: "AAAA" }]);
    expect(data?.entities).toHaveLength(1);
    expect(data?.name).toBe("widget");
  });

  test("a multi-megabyte image is stored whole, not truncated to a quota", async () => {
    const { saveDraft, loadDraftData } = await import("../src/io/draftStore");
    // Comfortably past the ~5 MB localStorage ceiling the old cache stripped for.
    const pixels = "x".repeat(6 * 1024 * 1024);
    const file = { ...sampleFile(), images: [{ id: "big", data: pixels }] } as RcamFile;

    await saveDraft("huge", file);
    const data = await loadDraftData();
    expect((data?.images as { data: string }[])?.[0].data).toHaveLength(pixels.length);
  });

  test("the payload goes to IndexedDB, and only a small pointer to localStorage", async () => {
    const { saveDraft, getDraftMeta } = await import("../src/io/draftStore");
    await saveDraft("widget", sampleFile());

    // The welcome screen reads this synchronously at first paint, so it must
    // still be written on the IndexedDB path.
    expect(getDraftMeta()?.name).toBe("widget");
    // ...but carry no document: the pointer stays small by design.
    const pointer = JSON.parse(localStorage.getItem(POINTER_KEY) as string);
    expect(pointer.data).toBeUndefined();
  });

  test("IndexedDB wins over a stale legacy pointer", async () => {
    const { saveDraft, loadDraftData } = await import("../src/io/draftStore");
    await saveDraft("current", { ...sampleFile(), name: "from-idb" } as RcamFile);
    // A pre-upgrade draft left behind in localStorage must not shadow it.
    localStorage.setItem(
      POINTER_KEY,
      JSON.stringify({
        name: "stale",
        savedAt: 1,
        data: { ...sampleFile(), name: "from-localstorage" },
      }),
    );
    expect((await loadDraftData())?.name).toBe("from-idb");
  });

  test("clearDraft drops the IndexedDB payload, not just the pointer", async () => {
    const { saveDraft, clearDraft, loadDraftData } = await import("../src/io/draftStore");
    await saveDraft("widget", sampleFile());
    clearDraft();

    // The pointer clears synchronously; the IndexedDB delete is best-effort in
    // the background, so poll rather than assuming it has landed.
    await vi.waitFor(async () => {
      expect(await loadDraftData()).toBeNull();
    });
  });
});
