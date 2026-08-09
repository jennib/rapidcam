/**
 * Facing / surfacing. Run with: npx vitest run test/facing.test.ts
 *
 * The whole point of a facing pass is the one line of geometry that separates it
 * from pocketing a rectangle: a pocket insets the tool CENTRE by a radius so the
 * cutting edge stops at the boundary, while facing puts the centre ON the
 * boundary so the edge runs a radius past it. Most of what follows measures that
 * — where the cutter's edge actually sweeps — rather than the shape of the code.
 *
 * The rest is about the spoilboard, which is a different job wearing the same
 * clothes: no workpiece on the machine, and a different Z (and X/Y) datum.
 */

import { test, expect, describe } from "vitest";
import { facePlan, growRect } from "../src/cam/facing";
import { generateGCode } from "../src/cam/gcode";
import { lintGCode, buildLintContext } from "../src/cam/lint";
import { rasterizeStock } from "../src/cam/stockRasterizer";
import { CADDocument } from "../src/model/document";
import { RectEntity } from "../src/model/entities";
import type { CAMOperation } from "../src/cam/types";

const STOCK = { x: 30, y: 25, width: 120, height: 80 };

function faceOp(extra: Partial<CAMOperation> = {}): CAMOperation {
  return {
    id: "f1",
    name: "Face",
    type: "face",
    side: "inside",
    entityIds: [],
    diameter: 25,
    depth: -1,
    stepdown: 0.5,
    stepover: 0.6,
    feedrate: 2500,
    plungeRate: 500,
    spindleSpeed: 12000,
    safeZ: 5,
    ...extra,
  } as CAMOperation;
}

function facedDoc(extra: Partial<CAMOperation> = {}): CADDocument {
  const doc = new CADDocument({ width: 200, height: 150 });
  doc.stockThickness = 20;
  doc.stockRect = { ...STOCK };
  doc.operations = [faceOp(extra)];
  return doc;
}

/** Tool-centre extremes of the cutting moves in a program. */
function centreRange(g: string) {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const l of g.split("\n")) {
    if (!/^G[0-3] /.test(l)) continue;
    const mx = /X(-?\d+(?:\.\d+)?)/.exec(l);
    const my = /Y(-?\d+(?:\.\d+)?)/.exec(l);
    if (mx) xs.push(Number(mx[1]));
    if (my) ys.push(Number(my[1]));
  }
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

// --- the geometry ------------------------------------------------------------
describe("the rows", () => {
  const target = { x: 0, y: 0, width: 100, height: 60 };

  test("the cutter's edge sweeps a full radius past every side", () => {
    // This is the difference from a pocket, and the reason facing exists: a
    // blank a millimetre over size, or a degree out of square, still cleans up.
    const R = 12.5;
    const plan = facePlan(target, R, 15)!;
    expect(plan.swept).toEqual(growRect(target, R));
    // ...which is exactly the tool centres reaching the boundary itself.
    const xs = plan.rows.flat().map((p) => p.x);
    const ys = plan.rows.flat().map((p) => p.y);
    expect(Math.min(...xs)).toBeCloseTo(target.x, 6);
    expect(Math.max(...xs)).toBeCloseTo(target.x + target.width, 6);
    expect(Math.min(...ys)).toBeCloseTo(target.y, 6);
    expect(Math.max(...ys)).toBeCloseTo(target.y + target.height, 6);
  });

  test("the last row lands on the far edge, not a stepover short of it", () => {
    // 60mm of travel at a 25mm step is 2.4 steps. Stopping at the third would
    // leave a 10mm strip standing down one side.
    const plan = facePlan(target, 12.5, 25)!;
    const ys = plan.rows.map((r) => r[0].y);
    expect(Math.max(...ys)).toBeCloseTo(60, 6);
    expect(plan.rows.length).toBe(4); // 0, 20, 40, 60 — evenly redistributed
  });

  test("rows alternate direction, so nothing lifts between them", () => {
    const plan = facePlan(target, 12.5, 15)!;
    for (let i = 1; i < plan.rows.length; i++) {
      const prevEnd = plan.rows[i - 1][1];
      const thisStart = plan.rows[i][0];
      // Each row starts at the side the previous one finished on.
      expect(Math.abs(thisStart.x - prevEnd.x)).toBeLessThan(1e-6);
    }
  });

  test("extra overhang pushes the centres out further still", () => {
    const plain = facePlan(target, 12.5, 15)!;
    const extra = facePlan(target, 12.5, 15, 5)!;
    expect(extra.swept.width).toBeCloseTo(plain.swept.width + 10, 6);
    expect(extra.swept.height).toBeCloseTo(plain.swept.height + 10, 6);
  });

  test("rows can run along Y instead", () => {
    const alongX = facePlan(target, 12.5, 15, 0, "x")!;
    const alongY = facePlan(target, 12.5, 15, 0, "y")!;
    // A row along X holds y constant; along Y it holds x constant.
    expect(alongX.rows[0][0].y).toBeCloseTo(alongX.rows[0][1].y, 6);
    expect(alongY.rows[0][0].x).toBeCloseTo(alongY.rows[0][1].x, 6);
    // The wider side needs fewer rows when swept along its length.
    expect(alongX.rows.length).toBeLessThan(alongY.rows.length);
  });

  test("degenerate inputs produce nothing rather than throwing", () => {
    expect(facePlan(target, 0, 15)).toBeNull();
    expect(facePlan(target, 12.5, 0)).toBeNull();
    expect(facePlan({ x: 0, y: 0, width: 0, height: 10 }, 12.5, 15)).toBeNull();
  });
});

// --- as an operation ---------------------------------------------------------
describe("as an operation", () => {
  test("skims the blank without any geometry selected", () => {
    // The one operation with nothing drawn to point at.
    const doc = facedDoc();
    expect(doc.operations[0].entityIds).toEqual([]);
    const g = generateGCode(doc.operations, doc);
    expect(g).toMatch(/; facing stock:/);
    expect(g.split("\n").filter((l) => /^G1 /.test(l)).length).toBeGreaterThan(5);
  });

  test("its centres span the blank, measured from the blank", () => {
    // The stock sits at (30,25) and the work origin follows it, so the program
    // runs 0..120 by 0..80 — the blank's own size, from its own corner.
    const doc = facedDoc();
    const r = centreRange(generateGCode(doc.operations, doc));
    expect(r.x0).toBeCloseTo(0, 3);
    expect(r.x1).toBeCloseTo(STOCK.width, 3);
    expect(r.y0).toBeCloseTo(0, 3);
    expect(r.y1).toBeCloseTo(STOCK.height, 3);
  });

  test("steps down to depth like any other roughing pass", () => {
    const doc = facedDoc({ depth: -1, stepdown: 0.5 });
    const g = generateGCode(doc.operations, doc);
    const passes = g.split("\n").filter((l) => /^; facing pass Z/.test(l));
    expect(passes).toHaveLength(2);
    expect(passes[0]).toContain("Z-0.5");
    expect(passes[1]).toContain("Z-1");
  });

  test("is refused on a rotary job rather than wrapped round the dowel", () => {
    // There is no flat surface on a cylinder. Unrefused it emitted 46 moves of
    // facing rows wrapped round the workpiece — valid G-code for something
    // nobody asked for.
    const doc = facedDoc();
    doc.machineKind = "mill-rotary";
    doc.rotary = { axisWord: "A", diameter: 100, wrapAxis: "y" };
    const g = generateGCode(doc.operations, doc);
    expect(g).toMatch(/facing has no meaning on a rotary job/);
    expect(g.split("\n").filter((l) => /^G1 .*X/.test(l))).toEqual([]);
  });

  test("an empty toolpath warning is not raised for it", () => {
    // Facing has no geometry BY DESIGN; the "cuts nothing" check would
    // otherwise fire on every facing pass and teach people to ignore it.
    const doc = facedDoc();
    const codes = lintGCode(
      generateGCode(doc.operations, doc),
      buildLintContext(doc, {}),
    ).map((f) => f.code);
    expect(codes).not.toContain("empty-toolpath");
  });

  test("the 3D preview takes the top off the blank", () => {
    const doc = facedDoc();
    const hm = rasterizeStock(doc.operations, doc);
    let removed = 0;
    for (const h of hm.data) removed += hm.stockT - h;
    expect(removed).toBeGreaterThan(0);
    // Essentially the whole top: a facing pass that previewed as a few stripes
    // would mean the rows aren't overlapping.
    const cut = [...hm.data].filter((h) => h < hm.stockT - 1e-6).length;
    expect(cut / hm.data.length).toBeGreaterThan(0.95);
  });
});

// --- the spoilboard, which is a different job --------------------------------
describe("surfacing the spoilboard", () => {
  const bed = { width: 600, height: 400 };

  test("needs a configured bed, and says so when there isn't one", () => {
    const doc = facedDoc({ faceTarget: "bed" });
    expect(generateGCode(doc.operations, doc)).toMatch(/needs the machine's bed size/);
  });

  test("is zeroed on the bed's own corner, not on the blank's", () => {
    // The blank sits at (30,25) and the work origin follows it. Emitting the bed
    // through that offset posted a 600mm bed as X-30..570 — telling the operator
    // to drive 30mm off the front of their own machine.
    const doc = facedDoc({ faceTarget: "bed" });
    const r = centreRange(generateGCode(doc.operations, doc, { bed }));
    expect(r.x0).toBeCloseTo(0, 3);
    expect(r.x1).toBeCloseTo(bed.width, 3);
    expect(r.y0).toBeCloseTo(0, 3);
    expect(r.y1).toBeCloseTo(bed.height, 3);
  });

  test("says in the program what it is and how to set up for it", () => {
    const doc = facedDoc({ faceTarget: "bed" });
    const g = generateGCode(doc.operations, doc, { bed });
    expect(g).toMatch(/SPOILBOARD SURFACING/);
    expect(g).toMatch(/ZERO ON THE SPOILBOARD/);
    expect(g).toMatch(/workpiece OFF the machine/i);
    expect(g).toMatch(/clamp/i);
  });

  test("is an ERROR when mixed with cutting toolpaths — the datums contradict", () => {
    // Surfacing is zeroed on the board with the machine empty; everything else
    // is zeroed on a workpiece that has to be clamped down. One Z zero cannot be
    // right for both, and both halves are valid G-code, so nothing downstream
    // could catch it.
    const doc = facedDoc({ faceTarget: "bed" });
    const r = doc.add(new RectEntity({ x: 40, y: 40 }, { x: 90, y: 80 }));
    doc.operations = [
      ...doc.operations,
      {
        id: "p1",
        name: "Pocket",
        type: "pocket",
        side: "inside",
        entityIds: [r.id],
        diameter: 6,
        depth: -3,
        stepdown: 1.5,
        stepover: 0.4,
        feedrate: 900,
        plungeRate: 300,
        spindleSpeed: 14000,
        safeZ: 5,
      } as CAMOperation,
    ];
    const finding = lintGCode(
      generateGCode(doc.operations, doc, { bed }),
      buildLintContext(doc, {}),
    ).find((f) => f.code === "spoilboard-mixed-program");
    expect(finding?.severity).toBe("error");

    // Positive control: on its own it is fine.
    doc.operations = [faceOp({ faceTarget: "bed" })];
    const alone = lintGCode(
      generateGCode(doc.operations, doc, { bed }),
      buildLintContext(doc, {}),
    ).map((f) => f.code);
    expect(alone).not.toContain("spoilboard-mixed-program");
  });

  test("is judged against the BED at pre-flight, not against the blank", () => {
    // It spans the whole table on purpose. Measured against the blank's bounds
    // every row reads as off-stock, and pre-flight failed a correct program
    // with "102 moves travel outside the stock. Check the toolpath fits."
    const doc = facedDoc({ faceTarget: "bed" });
    const findings = lintGCode(
      generateGCode(doc.operations, doc, { bed }),
      buildLintContext(doc, { bed }),
    );
    expect(findings.map((f) => f.code)).not.toContain("out-of-bounds");

    // Positive control: the check still works: a stock job that really does run
    // off the blank is still caught.
    const over = facedDoc({ faceOverhang: 400 });
    const overFindings = lintGCode(
      generateGCode(over.operations, over, { bed }),
      buildLintContext(over, { bed }),
    );
    expect(overFindings.map((f) => f.code)).toContain("out-of-bounds");
  });

  test("on a LASER it is flagged as cutting nothing, exemption or not", () => {
    // A beam can't face. The empty-geometry exemption exists so facing isn't
    // nagged about on a mill; on a laser the toolpath genuinely produces no
    // motion, and that exemption would have been the only thing hiding it.
    const doc = facedDoc();
    doc.machineKind = "laser";
    const codes = lintGCode(
      generateGCode(doc.operations, doc),
      buildLintContext(doc, {}),
    ).map((f) => f.code);
    expect(codes).toContain("empty-toolpath");
  });

  test("previews nothing, because the machine is empty", () => {
    // There is no workpiece for the simulation to show anything happening to.
    // Drawing the cut on the blank would be a picture of something the program
    // does not do.
    const doc = facedDoc({ faceTarget: "bed" });
    const hm = rasterizeStock(doc.operations, doc);
    let removed = 0;
    for (const h of hm.data) removed += hm.stockT - h;
    expect(removed).toBe(0);
  });
});
