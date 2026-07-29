import { beforeEach, describe, expect, test, vi } from "vitest";
import { getBed, setBed } from "../src/core/prefs";
import { lintGCode, type LintContext } from "../src/cam/lint";

/**
 * The optional machine bed, and the one check it buys.
 *
 * "Unset" is the DEFAULT and must stay fully usable — requiring a bed size
 * before you can draw is the setup friction this app exists to avoid — so
 * "no bed configured means no finding" is a behaviour worth pinning, not an
 * implementation detail.
 */

function fakeLocalStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

const ctx = (bed: { width: number; height: number } | null): LintContext => ({
  bounds: { xMin: -1e6, xMax: 1e6, yMin: -1e6, yMax: 1e6 }, // never trip out-of-bounds
  zTop: 0,
  zBottom: -100,
  bed,
  machineKind: "mill",
});

/** A program that cuts a straight line spanX long at Y=0, engaged in the material. */
const program = (spanX: number, spanY = 0) =>
  ["G21", "G90", "G0 X0 Y0", "G1 Z-1 F100", `G1 X${spanX} Y${spanY} F500`, "G0 Z5", "M30"].join("\n");

const codes = (gcode: string, bed: { width: number; height: number } | null) =>
  lintGCode(gcode, ctx(bed)).map((f) => f.code);

beforeEach(() => {
  vi.stubGlobal("localStorage", fakeLocalStorage());
});

describe("machine bed preference", () => {
  test("unset by default — no size is invented for the user", () => {
    expect(getBed()).toBeNull();
  });

  test("round-trips a configured envelope", () => {
    setBed({ width: 800, height: 400 });
    expect(getBed()).toEqual({ width: 800, height: 400 });
  });

  test("clearing returns it to unset", () => {
    setBed({ width: 800, height: 400 });
    setBed(null);
    expect(getBed()).toBeNull();
  });

  test("a non-positive size is refused rather than stored as a real bed", () => {
    setBed({ width: 0, height: 400 });
    expect(getBed()).toBeNull();
  });

  test("a corrupt stored value reads as unset, not as NaN travel", () => {
    localStorage.setItem("rapidcam:machine:bed", "not-a-size");
    expect(getBed()).toBeNull();
  });
});

describe("pre-flight travel check", () => {
  test("no bed configured means no finding — the default stays quiet", () => {
    // A 5-metre job must not warn just because the user never filled the field in.
    expect(codes(program(5000), null)).not.toContain("exceeds-machine-travel");
  });

  test("flags a job that needs more X travel than the machine has", () => {
    expect(codes(program(900), { width: 800, height: 400 })).toContain("exceeds-machine-travel");
  });

  test("flags a job that needs more Y travel", () => {
    expect(codes(program(10, 500), { width: 800, height: 400 })).toContain(
      "exceeds-machine-travel",
    );
  });

  test("a job that fits is silent", () => {
    expect(codes(program(700, 300), { width: 800, height: 400 })).not.toContain(
      "exceeds-machine-travel",
    );
  });

  test("travel is measured FROM the work origin, not as a free-floating span", () => {
    // Two points only 100mm apart, but 5m out from zero. The move stream is
    // anchored at the work origin, so reaching X5100 really does demand 5100mm
    // of travel — no choice of touch-off point changes that. It must warn.
    const far = ["G21", "G0 X5000 Y0", "G1 Z-1 F100", "G1 X5100 Y0 F500", "M30"].join("\n");
    expect(codes(far, { width: 800, height: 400 })).toContain("exceeds-machine-travel");
  });

  test("the message names both the need and the machine, and how to proceed", () => {
    const f = lintGCode(program(900), ctx({ width: 800, height: 400 })).find(
      (x) => x.code === "exceeds-machine-travel",
    );
    expect(f?.severity).toBe("error");
    expect(f?.message).toMatch(/900/);
    expect(f?.message).toMatch(/800/);
    expect(f?.message).toMatch(/Tile|Machine Settings/);
  });
});
