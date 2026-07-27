import { expect, test } from "vitest";
import { normalizeRcam, RCAM_VERSION } from "../src/io/fileio";

/**
 * v2 → v3 dropped machine configuration from the file: a `.rcam` is a drawing,
 * so it must not carry the author's controller (SETTINGS_MODEL.md). Everything
 * removed here is recoverable from the opener's own machine profile.
 */

const v2 = () => ({
  version: 2,
  name: "T",
  canvas: { width: 100, height: 100 },
  displayUnit: "mm",
  entities: [{ type: "circle", id: "c1", center: { x: 5, y: 5 }, radius: 2 }],
  postProcessor: "grbl",
  hasToolChanger: true,
  rotary: { axisWord: "B", diameter: 50, wrapAxis: "x", zero: "center", arcTolerance: 0.05 },
});

test("v2 file upgrades to v3 with the machine fields dropped", () => {
  const f = normalizeRcam(v2()) as unknown as Record<string, unknown>;
  expect(f.version).toBe(RCAM_VERSION);
  expect(f.postProcessor).toBeUndefined();
  expect(f.hasToolChanger).toBeUndefined();
});

test("the JOB half of a v2 rotary block survives the upgrade intact", () => {
  const f = normalizeRcam(v2()) as { rotary: Record<string, unknown> };
  // The cylinder is the stock, so these are the design and must not be lost.
  expect(f.rotary).toEqual({ diameter: 50, wrapAxis: "x", zero: "center" });
});

test("the design itself is untouched by the upgrade", () => {
  const f = normalizeRcam(v2()) as { name: string; entities: unknown[] };
  expect(f.name).toBe("T");
  expect(f.entities).toEqual([{ type: "circle", id: "c1", center: { x: 5, y: 5 }, radius: 2 }]);
});

test("a flat v2 file (no rotary block) upgrades without inventing one", () => {
  const { rotary: _r, ...flat } = v2();
  const f = normalizeRcam(flat) as unknown as Record<string, unknown>;
  expect(f.version).toBe(RCAM_VERSION);
  expect("rotary" in f).toBe(false);
});

test("a v1 file chains all the way to v3", () => {
  // Migrations chain, so adding a version only ever means adding one step.
  const v1 = { ...v2(), version: 1, isConstructionMode: false };
  const f = normalizeRcam(v1) as unknown as Record<string, unknown>;
  expect(f.version).toBe(RCAM_VERSION);
  expect(f.postProcessor).toBeUndefined();
  expect(f.isConstructionMode).toBeUndefined(); // the v1 step still applies
});

test("an unknown version is refused rather than guessed at", () => {
  expect(() => normalizeRcam({ ...v2(), version: 99 })).toThrow(/version/i);
});
