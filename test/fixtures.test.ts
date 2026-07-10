/**
 * Fixtures / workholding (Phase 2.4): closed shapes on a `fixture` layer are
 * keep-outs. Pre-flight (buildLintContext + lintGCode) flags any move that would
 * drive the tool over a clamp below its height. No fixture layer → no change.
 */
import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { RectEntity, CircleEntity } from "../src/model/entities";
import { generateGCode } from "../src/cam/gcode";
import { fixturePolygons } from "../src/cam/fixtures";
import { buildLintContext, lintGCode } from "../src/cam/lint";
import type { CAMOperation } from "../src/cam/types";

/** Add a fixture layer with a clamp rectangle on it; returns the doc. */
function withClamp(
  doc: CADDocument,
  rect: [number, number, number, number],
  height?: number,
): void {
  doc.layers.push({
    id: "clamps",
    name: "Clamps",
    color: "#e05a5a",
    visible: true,
    locked: false,
    fixture: true,
    ...(height ? { fixtureHeight: height } : {}),
  });
  const [x0, y0, x1, y1] = rect;
  const c = doc.add(new RectEntity({ x: x0, y: y0 }, { x: x1, y: y1 }));
  c.layerId = "clamps";
}

function profileOp(entityIds: string[]): CAMOperation {
  return {
    id: "op",
    name: "cut",
    type: "profile",
    side: "outside",
    entityIds,
    toolType: "end-mill",
    toolNumber: 1,
    diameter: 6,
    feedrate: 1000,
    plungeRate: 300,
    spindleSpeed: 18000,
    safeZ: 5,
    depth: -3,
    stepdown: 3,
    stepover: 0.4,
  };
}

function drillOp(entityIds: string[], safeZ = 5): CAMOperation {
  return {
    id: "op",
    name: "drill",
    type: "drill",
    side: "inside",
    entityIds,
    toolType: "end-mill",
    toolNumber: 1,
    diameter: 6,
    feedrate: 1000,
    plungeRate: 300,
    spindleSpeed: 18000,
    safeZ,
    depth: -5,
    stepdown: 5,
    stepover: 0.4,
  };
}

test("fixturePolygons collects closed shapes on fixture layers only", () => {
  const doc = new CADDocument({ width: 200, height: 150 });
  doc.add(new RectEntity({ x: 20, y: 20 }, { x: 180, y: 130 })); // a part (default layer) — not a fixture
  withClamp(doc, [90, 10, 110, 30], 20);
  const fx = fixturePolygons(doc);
  expect(fx).toHaveLength(1);
  expect(fx[0].height).toBe(20);
  expect(fx[0].poly.length).toBeGreaterThanOrEqual(4);
});

test("a cut passing over a clamp is flagged as a collision", () => {
  const doc = new CADDocument({ width: 200, height: 150 });
  const part = doc.add(new RectEntity({ x: 20, y: 20 }, { x: 180, y: 130 }));
  withClamp(doc, [90, 8, 110, 30], 20); // straddles the bottom cut line (~y17)
  doc.operations = [profileOp([part.id])];
  const g = generateGCode(doc.operations, doc);
  const findings = lintGCode(g, buildLintContext(doc));
  const hit = findings.find((f) => f.code === "fixture-collision");
  expect(hit).toBeDefined();
  expect(hit!.severity).toBe("error");
});

test("no fixture layer → no fixture finding", () => {
  const doc = new CADDocument({ width: 200, height: 150 });
  const part = doc.add(new RectEntity({ x: 20, y: 20 }, { x: 180, y: 130 }));
  doc.operations = [profileOp([part.id])];
  const findings = lintGCode(generateGCode(doc.operations, doc), buildLintContext(doc));
  expect(findings.some((f) => f.code === "fixture-collision")).toBe(false);
});

test("a rapid clears a clamp shorter than safe Z, but collides when it's taller", () => {
  // Two holes either side of a clamp bar; the XY rapid between them flies over the
  // clamp at safe Z. A 3mm clamp (< safeZ 5) is cleared; a 10mm clamp is not.
  const build = (clampHeight: number) => {
    const doc = new CADDocument({ width: 200, height: 150 });
    const h1 = doc.add(new CircleEntity({ x: 30, y: 75 }, 2));
    const h2 = doc.add(new CircleEntity({ x: 170, y: 75 }, 2));
    withClamp(doc, [90, 60, 110, 90], clampHeight); // bar between the holes
    doc.operations = [drillOp([h1.id, h2.id], 5)];
    return lintGCode(generateGCode(doc.operations, doc), buildLintContext(doc));
  };
  expect(build(3).some((f) => f.code === "fixture-collision")).toBe(false); // rapid clears
  expect(build(10).some((f) => f.code === "fixture-collision")).toBe(true); // rapid hits
});

test("laser jobs skip the fixture (Z-collision) check", () => {
  const doc = new CADDocument({ width: 200, height: 150 });
  doc.machineKind = "laser";
  const part = doc.add(new RectEntity({ x: 20, y: 20 }, { x: 180, y: 130 }));
  withClamp(doc, [90, 8, 110, 30], 20);
  doc.operations = [{ ...profileOp([part.id]), laserPower: 80 }];
  const findings = lintGCode(generateGCode(doc.operations, doc), buildLintContext(doc));
  expect(findings.some((f) => f.code === "fixture-collision")).toBe(false);
});
