import { expect, test } from "vitest";
import { generateGCode } from "../src/cam/gcode";
import type { CAMOperation } from "../src/cam/types";
import { CADDocument } from "../src/model/document";
import { CORNER_TYPES, PolylineEntity, RectEntity } from "../src/model/entities";

/**
 * The end of the chain: a shaped polyline reaching the actual G-code.
 *
 * The failure this whole two-pass structure exists to prevent is the toolpath
 * cutting sharp corners while the canvas draws round ones. Pass A's seam and its
 * drift guard make that very unlikely; this makes it checked.
 *
 * The strongest assertion available is an IDENTITY against the rectangle, which
 * shipped first and has its own toolpath tests: at 90° the two shapes have the
 * same boundary, so they must produce the same program. That settles the whole
 * chain — offsetting, tessellation, lead-ins, winding — in one comparison, and
 * it settles attribution too: anything odd near a cove is the shared polygon
 * offsetter's treatment of concave geometry, not something polyline corners
 * introduced.
 */

const W = 80;
const H = 60;
const R = 12;
const TOOL_D = 6;

function op(entityId: string, over: Partial<CAMOperation> = {}): CAMOperation {
  return {
    id: "op",
    name: "cut",
    type: "profile",
    side: "outside",
    entityIds: [entityId],
    toolType: "end-mill",
    toolNumber: 1,
    diameter: TOOL_D,
    feedrate: 1000,
    plungeRate: 300,
    spindleSpeed: 18000,
    safeZ: 5,
    depth: -2,
    stepdown: 2,
    stepover: 0.4,
    ...over,
  };
}

/** Every cutting move's XY, in order. */
function cutPath(code: string): { x: number; y: number }[] {
  return code
    .split("\n")
    .filter((l) => /^G[123] /.test(l) && /X/.test(l) && /Y/.test(l))
    .map((l) => ({
      x: parseFloat(l.match(/X(-?[\d.]+)/)![1]),
      y: parseFloat(l.match(/Y(-?[\d.]+)/)![1]),
    }));
}

function polyDoc(type: (typeof CORNER_TYPES)[number], value = R) {
  const doc = new CADDocument({ width: 200, height: 200 }, "mm");
  const pl = doc.add(
    new PolylineEntity(
      [
        { x: 20, y: 20 },
        { x: 20 + W, y: 20 },
        { x: 20 + W, y: 20 + H },
        { x: 20, y: 20 + H },
      ],
      true,
      "pl",
    ),
  );
  pl.cornerType = type;
  pl.setAllCornerValues(value);
  return { doc, pl };
}

function rectDoc(type: (typeof CORNER_TYPES)[number], value = R) {
  const doc = new CADDocument({ width: 200, height: 200 }, "mm");
  const rect = doc.add(new RectEntity({ x: 20, y: 20 }, { x: 20 + W, y: 20 + H }, "rc"));
  rect.cornerType = type;
  rect.cornerRadii = [value, value, value, value];
  return { doc, rect };
}

for (const type of CORNER_TYPES) {
  test(`a ${type} polyline corner cuts exactly as the same rectangle corner does`, () => {
    const a = cutPath(generateGCode([op("pl")], polyDoc(type).doc));
    const b = cutPath(generateGCode([op("rc")], rectDoc(type).doc));
    expect(a.length).toBeGreaterThan(8);
    expect(a).toEqual(b);
  });
}

test("an outside profile follows the ROUND, not the sharp vertex", () => {
  // Stated in the toolpath's own geometry rather than against another shape: an
  // outside profile of a corner of radius r, cut with a tool of radius R, runs
  // on an arc of radius r+R about the SAME centre. That pins the corner's shape,
  // size and position at once.
  const path = cutPath(generateGCode([op("pl")], polyDoc("round").doc));
  const c = { x: 20 + R, y: 20 + R };
  const want = R + TOOL_D / 2;

  const inCorner = path.filter((p) => p.x < c.x && p.y < c.y);
  expect(inCorner.length, "the corner region must contain cutting moves").toBeGreaterThan(2);
  for (const p of inCorner) expect(Math.hypot(p.x - c.x, p.y - c.y)).toBeCloseTo(want, 1);

  // Where the tool would go if CAM had seen the sharp vertex.
  const sharp = { x: 20 - TOOL_D / 2, y: 20 - TOOL_D / 2 };
  expect(Math.min(...path.map((p) => Math.hypot(p.x - sharp.x, p.y - sharp.y)))).toBeGreaterThan(2);
});

test("a sharp polyline still cuts a sharp corner — the positive control", () => {
  // Without this, the assertion above passes for a toolpath that is simply
  // never near anything.
  const path = cutPath(generateGCode([op("pl")], polyDoc("round", 0).doc));
  const sharp = { x: 20 - TOOL_D / 2, y: 20 - TOOL_D / 2 };
  expect(Math.min(...path.map((p) => Math.hypot(p.x - sharp.x, p.y - sharp.y)))).toBeLessThan(0.5);
});

test("a corner at an angle that is not 90° reaches the toolpath at its true radius", () => {
  // The rectangle identity can only ever check 90°. This is the case a rectangle
  // cannot express at all: a fillet whose setback is NOT its radius.
  const doc = new CADDocument({ width: 200, height: 200 }, "mm");
  const pl = doc.add(
    new PolylineEntity(
      [
        { x: 20, y: 20 },
        { x: 140, y: 20 },
        { x: 80, y: 120 },
      ],
      true,
      "pl",
    ),
  );
  pl.setAllCornerValues(10);
  const arcs = pl.outlineParts()!.filter((p) => p.kind === "arc");
  expect(arcs).toHaveLength(3);

  const path = cutPath(generateGCode([op("pl")], doc));
  // The apex corner is the sharpest, so its fillet is the one a radius/setback
  // mix-up would place most obviously wrong.
  const apex = arcs.find((a) => a.kind === "arc" && a.center.y > 90);
  if (apex?.kind !== "arc") throw new Error("expected an arc near the apex");
  const near = path.filter(
    (p) => Math.hypot(p.x - apex.center.x, p.y - apex.center.y) < 10 + TOOL_D / 2 + 3,
  );
  expect(near.length, "the apex fillet must actually be traced").toBeGreaterThan(2);
  for (const p of near) {
    expect(Math.hypot(p.x - apex.center.x, p.y - apex.center.y)).toBeCloseTo(10 + TOOL_D / 2, 1);
  }
});

test("the toolpath keeps its winding — the kerf side does not flip on a shaped corner", () => {
  // CAM takes which side to compensate from the ring's winding. A corner that
  // reversed it would cut the part to the wrong size, silently.
  const area = (p: { x: number; y: number }[]) => {
    let a = 0;
    for (let i = 0; i < p.length; i++) {
      const q = p[i];
      const r = p[(i + 1) % p.length];
      a += q.x * r.y - r.x * q.y;
    }
    return a;
  };
  const sharp = area(cutPath(generateGCode([op("pl")], polyDoc("round", 0).doc)));
  for (const type of CORNER_TYPES) {
    const shaped = area(cutPath(generateGCode([op("pl")], polyDoc(type).doc)));
    expect(Math.sign(shaped), type).toBe(Math.sign(sharp));
  }
});
