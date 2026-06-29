import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { CircleEntity, RectEntity, LineEntity, PolylineEntity, RasterImageEntity } from "../src/model/entities";
import { comboOf, isValidFor, describeEntity, findContiguousChain, defaultCombo } from "../src/ui/camBarHelpers";
import type { CAMOperation } from "../src/cam/types";

const img = () => new RasterImageEntity("img-x", { x: 0, y: 0 }, 10, 10, 0);

test("isValidFor: an image is engrave-only (not profile/pocket/vcarve/drill)", () => {
  const e = img();
  expect(isValidFor(e, "engrave")).toBe(true);
  expect(isValidFor(e, "profile-outside")).toBe(false);
  expect(isValidFor(e, "pocket")).toBe(false);
  expect(isValidFor(e, "vcarve")).toBe(false);
  expect(isValidFor(e, "drill")).toBe(false);
});

test("defaultCombo: a new op with an image selected starts on Engrave", () => {
  // This is the regression guard: defaulting to a profile op would strip the
  // image as invalid-for-profile and leave the op with no geometry.
  expect(defaultCombo(null, [img()], true)).toBe("engrave");
  expect(defaultCombo(null, [img()], false)).toBe("engrave");
  // Mixed selection that includes an image still defaults to engrave.
  expect(defaultCombo(null, [new CircleEntity({ x: 0, y: 0 }, 5), img()], true)).toBe("engrave");
});

test("defaultCombo: a new op without an image starts on Cut (profile-outside)", () => {
  expect(defaultCombo(null, [new CircleEntity({ x: 0, y: 0 }, 5)], true)).toBe("profile-outside");
  expect(defaultCombo(null, [], false)).toBe("profile-outside");
});

test("defaultCombo: editing an existing op keeps its own type (image default is new-op only)", () => {
  const pocket = { type: "pocket" } as CAMOperation;
  expect(defaultCombo(pocket, [img()], false)).toBe("pocket");
  // …but a laser doc coerces a non-beam existing op to a beam-capable one.
  expect(defaultCombo(pocket, [], true)).toBe("profile-outside");
  const eng = { type: "engrave" } as CAMOperation;
  expect(defaultCombo(eng, [], true)).toBe("engrave");
});

test("comboOf splits profile by side", () => {
  const base = { type: "profile" } as CAMOperation;
  expect(comboOf({ ...base, side: "outside" } as CAMOperation)).toBe("profile-outside");
  expect(comboOf({ ...base, side: "inside" } as CAMOperation)).toBe("profile-inside");
  expect(comboOf({ type: "pocket" } as CAMOperation)).toBe("pocket");
});

test("isValidFor: drill accepts only circles", () => {
  const c = new CircleEntity({ x: 0, y: 0 }, 5);
  const r = new RectEntity({ x: 0, y: 0 }, { x: 10, y: 10 });
  expect(isValidFor(c, "drill")).toBe(true);
  expect(isValidFor(r, "drill")).toBe(false);
});

test("isValidFor: open polyline rejected for profile, accepted for engrave", () => {
  const open = new PolylineEntity([{ x: 0, y: 0 }, { x: 10, y: 0 }], false);
  expect(isValidFor(open, "profile-outside")).toBe(false);
  expect(isValidFor(open, "engrave")).toBe(true);
});

test("isValidFor: construction geometry is never valid", () => {
  const c = new CircleEntity({ x: 0, y: 0 }, 5);
  c.isConstruction = true;
  expect(isValidFor(c, "drill")).toBe(false);
  expect(isValidFor(c, "engrave")).toBe(false);
});

test("describeEntity labels a circle with its radius", () => {
  const doc = new CADDocument({ width: 100, height: 100 });
  const c = new CircleEntity({ x: 0, y: 0 }, 5);
  expect(describeEntity(c, doc)).toMatch(/Circle/);
});

test("findContiguousChain walks connected line segments", () => {
  const doc = new CADDocument({ width: 100, height: 100 });
  const l1 = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 10, y: 0 })) as LineEntity;
  const l2 = doc.add(new LineEntity({ x: 10, y: 0 }, { x: 10, y: 10 })) as LineEntity;
  const l3 = doc.add(new LineEntity({ x: 50, y: 50 }, { x: 60, y: 50 })) as LineEntity; // disjoint
  const chain = findContiguousChain(l1.id, doc, "profile-outside");
  expect(chain).toContain(l1.id);
  expect(chain).toContain(l2.id);
  expect(chain).not.toContain(l3.id);
});
