import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import {
  ArcEntity,
  CircleEntity,
  type Entity,
  RectEntity,
  LineEntity,
  PolylineEntity,
  RasterImageEntity,
} from "../src/model/entities";
import {
  comboOf,
  isValidFor,
  describeEntity,
  findContiguousChain,
  defaultCombo,
  checkOpSelection,
} from "../src/ui/camBarHelpers";
import type { CAMOperation } from "../src/cam/types";

const img = () => new RasterImageEntity("img-x", { x: 0, y: 0 }, 10, 10, 0);
const doc = () => new CADDocument({ width: 100, height: 80 });

test("isValidFor: an image is engrave-only (not profile/pocket/vcarve/drill)", () => {
  const e = img();
  expect(isValidFor(e, "engrave")).toBe(true);
  expect(isValidFor(e, "profile-outside")).toBe(false);
  expect(isValidFor(e, "pocket")).toBe(false);
  expect(isValidFor(e, "vcarve")).toBe(false);
  expect(isValidFor(e, "drill")).toBe(false);
});

test("defaultCombo: a new op with an image selected starts on 3-D Relief", () => {
  // This is the regression guard: defaulting to a profile op would strip the
  // image as invalid-for-profile and leave the op with no geometry.
  expect(defaultCombo(null, [img()], true, doc())).toBe("relief");
  expect(defaultCombo(null, [img()], false, doc())).toBe("relief");
  // Mixed selection that includes an image still defaults to relief.
  expect(defaultCombo(null, [new CircleEntity({ x: 0, y: 0 }, 5), img()], true, doc())).toBe(
    "relief",
  );
});

test("defaultCombo: a new op without an image starts on Cut (profile-outside)", () => {
  expect(defaultCombo(null, [new CircleEntity({ x: 0, y: 0 }, 5)], true, doc())).toBe(
    "profile-outside",
  );
  expect(defaultCombo(null, [], false, doc())).toBe("profile-outside");
});

test("checkOpSelection: filters to the valid subset, keeping invalid entities selectable elsewhere", () => {
  const circle = new CircleEntity({ x: 0, y: 0 }, 5);
  const image = img();
  const entities = [circle, image];
  const ids = [circle.id, image.id];

  // Engrave accepts both; profile accepts only the circle (image filtered, not error).
  expect(checkOpSelection(entities, ids, "engrave").validIds.sort()).toEqual(
    [circle.id, image.id].sort(),
  );
  const prof = checkOpSelection(entities, ids, "profile-outside");
  expect(prof.validIds).toEqual([circle.id]);
  expect(prof.error).toBeNull();
});

test("checkOpSelection: an image-only selection on a non-image op explains why", () => {
  const image = img();
  const r = checkOpSelection([image], [image.id], "profile-outside");
  expect(r.validIds).toEqual([]);
  expect(r.error).toMatch(/image can only be a relief/i);
  // …and is fine on Engrave and 3-D Relief.
  expect(checkOpSelection([image], [image.id], "engrave").error).toBeNull();
  expect(checkOpSelection([image], [image.id], "relief").error).toBeNull();
});

test("checkOpSelection: distinguishes 'nothing selected' from 'nothing usable'", () => {
  expect(checkOpSelection([], [], "engrave").error).toMatch(/select at least one/i);
  // Drill is the narrowest op — only a circle is a hole. (This used to use an
  // open polyline on profile, which is now a legitimate contour target.)
  const line = new LineEntity({ x: 0, y: 0 }, { x: 10, y: 0 });
  const r = checkOpSelection([line], [line.id], "drill");
  expect(r.error).toMatch(/none of the selected geometry/i);
});

test("defaultCombo: editing an existing op keeps its own type (image default is new-op only)", () => {
  const pocket = { type: "pocket", entityIds: [] as string[] } as CAMOperation;
  expect(defaultCombo(pocket, [img()], false, doc())).toBe("pocket");
  // …but a laser doc coerces a non-beam existing op to a beam-capable one.
  expect(defaultCombo(pocket, [], true, doc())).toBe("profile-outside");
  const eng = { type: "engrave", entityIds: [] as string[] } as CAMOperation;
  expect(defaultCombo(eng, [], true, doc())).toBe("engrave");
});

test("comboOf splits profile by side", () => {
  const base = { type: "profile" } as CAMOperation;
  expect(comboOf({ ...base, side: "outside" } as CAMOperation)).toBe("profile-outside");
  expect(comboOf({ ...base, side: "inside" } as CAMOperation)).toBe("profile-inside");
  expect(comboOf({ type: "pocket" } as CAMOperation)).toBe("pocket");
});

test("comboOf: a relief rough and an image engrave both present as 3-D Relief", () => {
  const d = doc();
  const image = d.add(new RasterImageEntity("img-y", { x: 0, y: 0 }, 10, 10, 0));
  const rough = { type: "relief-rough", entityIds: [image.id] } as CAMOperation;
  const finish = { type: "engrave", entityIds: [image.id] } as CAMOperation;
  const lineEngrave = { type: "engrave", entityIds: [] as string[] } as CAMOperation;
  expect(comboOf(rough, d)).toBe("relief");
  expect(comboOf(finish, d)).toBe("relief");
  expect(comboOf(lineEngrave, d)).toBe("engrave");
  expect(comboOf(lineEngrave)).toBe("engrave"); // no doc → a plain engrave
});

test("isValidFor: drill accepts only circles", () => {
  const c = new CircleEntity({ x: 0, y: 0 }, 5);
  const r = new RectEntity({ x: 0, y: 0 }, { x: 10, y: 10 });
  expect(isValidFor(c, "drill")).toBe(true);
  expect(isValidFor(r, "drill")).toBe(false);
});

test("isValidFor: an open polyline is a contour target, like a line or arc", () => {
  // It used to be rejected for requiring `closed`, which broke imported DXF
  // outlines: they arrive as open-polyline runs joined by separate arcs, so the
  // check dropped the polylines and left the op an unclosable chain that cut
  // nothing. The generator chains open curves, and a line is no more closed
  // than this is — see isContourTarget.
  const open = new PolylineEntity(
    [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ],
    false,
  );
  const line = new LineEntity({ x: 0, y: 0 }, { x: 10, y: 0 });
  for (const combo of ["profile-outside", "profile-inside", "pocket", "vcarve"] as const) {
    expect(isValidFor(open, combo)).toBe(isValidFor(line, combo));
    expect(isValidFor(open, combo)).toBe(true);
  }
  expect(isValidFor(open, "engrave")).toBe(true);
  // Still not drillable — that one really does need a circle.
  expect(isValidFor(open, "drill")).toBe(false);
});

test("a DXF-style outline (open polylines + arcs) survives the selection check", () => {
  // The exact shape of the reported bug: an outline chained from open polyline
  // runs and fillet arcs must reach the generator whole. Dropping any member
  // breaks the chain, and a broken chain cuts nothing with no error shown.
  const outline: Entity[] = [
    new PolylineEntity(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      false,
    ),
    new ArcEntity({ x: 10, y: 5 }, 5, -Math.PI / 2, Math.PI / 2),
    new PolylineEntity(
      [
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ],
      false,
    ),
    new ArcEntity({ x: 0, y: 5 }, 5, Math.PI / 2, (3 * Math.PI) / 2),
  ];
  const check = checkOpSelection(
    outline,
    outline.map((e) => e.id),
    "profile-outside",
  );
  expect(check.error).toBeNull();
  expect(check.validIds).toHaveLength(4); // nothing silently dropped
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
