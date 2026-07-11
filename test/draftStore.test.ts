import { beforeEach, describe, expect, test, vi } from "vitest";
import type { RcamFile } from "../src/io/fileio";

/**
 * Covers the autosave-draft store's localStorage-backed path — the fallback used
 * when IndexedDB is unavailable (private mode, or a non-DOM environment like this
 * one, where `indexedDB` is undefined). The IndexedDB happy path (which keeps
 * embedded images so an image-bearing design restores faithfully) is exercised
 * live in the browser; here we pin the metadata pointer, the quota-safe strip on
 * the fallback write, round-trip load, and corruption tolerance.
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
