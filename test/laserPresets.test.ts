import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  addPreset,
  loadPresets,
  newPresetId,
  presetsFor,
  removePreset,
  savePresets,
  type LaserPreset,
} from "../src/cam/laserPresets";

/**
 * The laser-preset store. Deliberately unlike `toolLibrary.ts` in one respect:
 * it seeds NOTHING. Power/speed are properties of a specific machine and a
 * specific material batch, so a shipped default is a number a user might trust
 * and get a fire from. "Starts empty" is therefore a behaviour worth pinning,
 * not an implementation detail.
 */

const KEY = "rapidcam:laser-presets";

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

function preset(over: Partial<LaserPreset> = {}): LaserPreset {
  return {
    id: "p1",
    name: "3mm ply",
    kind: "cut",
    feedrate: 300,
    laserPower: 100,
    laserPasses: 2,
    ...over,
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", fakeLocalStorage());
});

describe("laserPresets store", () => {
  test("starts empty — no builtin recipes are seeded", () => {
    expect(loadPresets()).toEqual([]);
    // And nothing was written as a side effect of reading.
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  test("addPreset round-trips a saved recipe", () => {
    addPreset(preset());
    expect(loadPresets()).toEqual([preset()]);
  });

  test("addPreset replaces in place when the id already exists", () => {
    addPreset(preset());
    addPreset(preset({ name: "3mm ply v2", laserPower: 85 }));

    const all = loadPresets();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("3mm ply v2");
    expect(all[0].laserPower).toBe(85);
  });

  test("removePreset drops only the named recipe", () => {
    addPreset(preset({ id: "a", name: "ply" }));
    addPreset(preset({ id: "b", name: "acrylic" }));
    removePreset("a");

    expect(loadPresets().map((p) => p.id)).toEqual(["b"]);
  });

  test("presetsFor offers only the matching job kind", () => {
    // Cutting, engraving and scoring the same material are different recipes;
    // offering a cut recipe on a score op suggests ~5x the correct power.
    addPreset(preset({ id: "cut", kind: "cut", laserPower: 100, feedrate: 300 }));
    addPreset(preset({ id: "eng", kind: "engrave", laserPower: 20, feedrate: 3000 }));
    addPreset(preset({ id: "scr", kind: "score", laserPower: 15, feedrate: 1200 }));

    expect(presetsFor("cut").map((p) => p.id)).toEqual(["cut"]);
    expect(presetsFor("engrave").map((p) => p.id)).toEqual(["eng"]);
    expect(presetsFor("score").map((p) => p.id)).toEqual(["scr"]);
  });

  test("a corrupt store reads as empty rather than throwing", () => {
    localStorage.setItem(KEY, "{not json");
    expect(loadPresets()).toEqual([]);
  });

  test("entries with unusable numbers are dropped, not surfaced as NaN", () => {
    savePresets([
      preset({ id: "good" }),
      { id: "bad", name: "junk", kind: "cut", laserPower: Number.NaN } as LaserPreset,
      { id: "worse", name: "no kind" } as unknown as LaserPreset,
    ]);
    expect(loadPresets().map((p) => p.id)).toEqual(["good"]);
  });

  test("newPresetId does not collide across rapid calls", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newPresetId()));
    expect(ids.size).toBe(200);
  });
});
