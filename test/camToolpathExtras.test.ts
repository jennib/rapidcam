import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { CircleEntity, RectEntity } from "../src/model/entities";
import { generateGCode } from "../src/cam/gcode";
import { rasterizeStock } from "../src/cam/stockRasterizer";
import { selectedOpsInOrder, type CAMOperation } from "../src/cam/types";

const baseOp = (over: Partial<CAMOperation>): CAMOperation => ({
  id: "x", name: "op", type: "profile", entityIds: [], side: "outside",
  toolType: "end-mill", toolNumber: 1, diameter: 6, feedrate: 900, plungeRate: 250,
  spindleSpeed: 18000, safeZ: 5, depth: -3, stepdown: 3, stepover: 0.4, ...over,
});

// --- export-selected: ordering -----------------------------------------------

test("selectedOpsInOrder returns selected ops in document order, not tick order", () => {
  const ops = [
    baseOp({ id: "a", name: "A" }),
    baseOp({ id: "b", name: "B" }),
    baseOp({ id: "c", name: "C" }),
  ];
  // Ticked c then a (out of order); a Set preserves that insertion order.
  const ids = new Set(["c", "a"]);
  const picked = selectedOpsInOrder(ops, ids);
  expect(picked.map((o) => o.id)).toEqual(["a", "c"]); // document order
});

test("selectedOpsInOrder ignores unknown / deleted ids", () => {
  const ops = [baseOp({ id: "a" }), baseOp({ id: "b" })];
  expect(selectedOpsInOrder(ops, new Set(["b", "ghost"])).map((o) => o.id)).toEqual(["b"]);
});

test("a combined export of a subset contains only those toolpaths", () => {
  const doc = new CADDocument({ width: 100, height: 100 });
  const a = doc.add(new CircleEntity({ x: 20, y: 20 }, 3));
  const b = doc.add(new CircleEntity({ x: 50, y: 50 }, 3));
  const drillA = baseOp({ id: "da", name: "Drill A", type: "drill", toolType: "drill", entityIds: [a.id] });
  const drillB = baseOp({ id: "db", name: "Drill B", type: "drill", toolType: "drill", entityIds: [b.id] });
  doc.operations.push(drillA, drillB);

  const out = generateGCode(selectedOpsInOrder(doc.operations, new Set(["da"])), doc);
  expect(out).toContain('"Drill A"');
  expect(out).not.toContain('"Drill B"');
});

// --- preview mirrors lead-in/out ---------------------------------------------

test("stock preview carves more material when a lead-in is present", () => {
  const doc = new CADDocument({ width: 100, height: 100 });
  const rect = doc.add(new RectEntity({ x: 30, y: 30 }, { x: 70, y: 70 }));
  const profile = baseOp({ id: "p", type: "profile", side: "outside", entityIds: [rect.id], depth: -3, stepdown: 3 });

  const cutCells = (op: CAMOperation): number => {
    const hm = rasterizeStock([op], doc);
    let cut = 0;
    for (let i = 0; i < hm.data.length; i++) if (hm.data[i] < hm.stockT - 1e-6) cut++;
    return cut;
  };

  const withoutLead = cutCells(profile);
  const withLead = cutCells({ ...profile, leadIn: { type: "linear", length: 4 } });
  // The lead groove removes extra stock beyond the contour.
  expect(withLead).toBeGreaterThan(withoutLead);
});

// --- too-small pocket: no finishing wall lap ---------------------------------

test("a pocket too small for the tool emits a NOTE and no finishing lap", () => {
  const doc = new CADDocument({ width: 100, height: 100 });
  // 4x4 rect, ⌀6 tool (toolR 3) → cannot be cleared.
  const rect = doc.add(new RectEntity({ x: 48, y: 48 }, { x: 52, y: 52 }));
  const op = baseOp({
    id: "tiny", type: "pocket", entityIds: [rect.id], diameter: 6,
    depth: -3, stepdown: 3, finishPass: true,
  });
  const out = generateGCode([op], doc);
  expect(out).toMatch(/NOTE:.*too small/);
  expect(out).not.toMatch(/finishing pass \(full-depth wall\)/);
});
