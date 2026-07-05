import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { RectEntity } from "../src/model/entities";
import { generateGCode } from "../src/cam/gcode";
import type { CAMOperation } from "../src/cam/types";

// Signed area of the ordered cut-move XY path: > 0 = CCW travel, < 0 = CW.
function cutSignedArea(code: string): number {
  const pts = code.split("\n")
    .filter((l) => /^G[123] /.test(l) && /X/.test(l) && /Y/.test(l))
    .map((l) => ({ x: parseFloat(l.match(/X(-?[\d.]+)/)![1]), y: parseFloat(l.match(/Y(-?[\d.]+)/)![1]) }));
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a;
}

function profileOp(doc: CADDocument, side: "outside" | "inside", cutDirection?: "climb" | "conventional"): CAMOperation {
  const r = doc.add(new RectEntity({ x: 20, y: 20 }, { x: 80, y: 60 }));
  return {
    id: "op", name: "cut", type: "profile", side, entityIds: [r.id],
    toolType: "end-mill", toolNumber: 1, diameter: 6,
    feedrate: 1000, plungeRate: 300, spindleSpeed: 18000,
    safeZ: 5, depth: -2, stepdown: 2, stepover: 0.4, cutDirection,
  };
}

test("outside profile: climb travels CW, conventional CCW", () => {
  const d1 = new CADDocument({ width: 200, height: 200 });
  const d2 = new CADDocument({ width: 200, height: 200 });
  const gClimb = generateGCode([profileOp(d1, "outside", "climb")], d1);
  const gConv = generateGCode([profileOp(d2, "outside", "conventional")], d2);
  expect(cutSignedArea(gClimb)).toBeLessThan(0);    // CW
  expect(cutSignedArea(gConv)).toBeGreaterThan(0);  // CCW
});

test("inside profile: climb travels CCW, conventional CW (flipped vs outside)", () => {
  const d1 = new CADDocument({ width: 200, height: 200 });
  const d2 = new CADDocument({ width: 200, height: 200 });
  const gClimb = generateGCode([profileOp(d1, "inside", "climb")], d1);
  const gConv = generateGCode([profileOp(d2, "inside", "conventional")], d2);
  expect(cutSignedArea(gClimb)).toBeGreaterThan(0); // CCW
  expect(cutSignedArea(gConv)).toBeLessThan(0);     // CW
});

test("unset cutDirection leaves the toolpath byte-identical (back-compat)", () => {
  const d1 = new CADDocument({ width: 200, height: 200 });
  const d2 = new CADDocument({ width: 200, height: 200 });
  const gUnset = generateGCode([profileOp(d1, "outside", undefined)], d1);
  // The raw offset winding is CCW, which for an outside profile is conventional —
  // so explicitly asking for conventional must reproduce the unset output exactly.
  const gConv = generateGCode([profileOp(d2, "outside", "conventional")], d2);
  expect(gUnset).toBe(gConv);
});
