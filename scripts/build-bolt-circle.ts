/**
 * Programmatic builder for the bolt-circle example.
 *
 * Patterns and variable-driven geometry are produced by interactive tools, so
 * they're fragile to hand-author as raw .rcam JSON. This script builds the
 * document with the real model API (the same `duplicate()` + `applyRotate` path
 * the circular-pattern dialog uses) and writes the serialized project.
 *
 * Run:  npx tsx scripts/build-bolt-circle.ts
 */
import { writeFileSync } from "node:fs";
import { CADDocument } from "../src/model/document";
import { CircleEntity, type Entity } from "../src/model/entities";
import { makeConstraint } from "../src/model/constraints";
import { makeDimension } from "../src/model/dimensions";
import { makeVariable } from "../src/model/variables";
import { makeCircularPattern, computeSourceSnapshot, type CircularPatternParams } from "../src/model/patterns";
import { applyRotate } from "../src/core/transform";
import { serializeDoc } from "../src/io/fileio";

const CX = 75, CY = 65;          // bolt-circle centre
const PCD = 80, HOLE_DIA = 8;    // pitch-circle diameter, hole diameter
const COUNT = 6;

const doc = new CADDocument({ width: 150, height: 130 }, "mm");
doc.stockThickness = 8;
doc.postProcessor = "grbl";

// Variables drive the source hole's radius-from-centre and its diameter.
doc.variables.push(makeVariable("pcd", String(PCD), "mm"));
doc.variables.push(makeVariable("holeDia", String(HOLE_DIA), "mm"));

// Geometry (auto-generated ids so the pattern copies never collide).
const outer = doc.add(new CircleEntity({ x: CX, y: CY }, 55));        // flange OD
const bore  = doc.add(new CircleEntity({ x: CX, y: CY }, 15));        // centre bore
const hole  = doc.add(new CircleEntity({ x: CX + PCD / 2, y: CY }, HOLE_DIA / 2)); // source bolt hole

// Constraints: pin the flange, keep the bore concentric, hold the source hole on
// the bore's horizontal axis. (Pattern copies are regenerated, not constrained.)
doc.addConstraint(makeConstraint("fixedPoint", { points: [{ entityId: outer.id, key: "c" }], params: [CX, CY] }));
doc.addConstraint(makeConstraint("concentric", { entities: [outer.id, bore.id] }));
doc.addConstraint(makeConstraint("horizontal", { points: [{ entityId: bore.id, key: "c" }, { entityId: hole.id, key: "c" }] }));

// Dimensions. The two variable-driven ones carry an `expr`.
doc.addDimension(makeDimension("diameter", { entities: [outer.id], value: 110, offset: -0.7 }));
doc.addDimension(makeDimension("diameter", { entities: [bore.id], value: 30, offset: 2.2 }));
doc.addDimension(makeDimension("horizontal", {
  points: [{ entityId: bore.id, key: "c" }, { entityId: hole.id, key: "c" }],
  value: PCD / 2, offset: -42, expr: "pcd / 2",
}));
doc.addDimension(makeDimension("diameter", { entities: [hole.id], value: HOLE_DIA, offset: 0.6, expr: "holeDia" }));

// Circular pattern — same generation the dialog's spawnCircularInstances uses.
const params: CircularPatternParams = { count: COUNT, cx: CX, cy: CY, totalAngle: Math.PI * 2 };
const step = params.totalAngle / params.count;
const instanceIds: string[][] = [];
for (let k = 1; k < params.count; k++) {
  const copies: Entity[] = [hole.duplicate()];
  applyRotate(copies, CX, CY, k * step);
  const ids: string[] = [];
  for (const c of copies) { doc.add(c); ids.push(c.id); }
  instanceIds.push(ids);
}
doc.addPattern(makeCircularPattern([hole.id], instanceIds, params, computeSourceSnapshot(doc.entities, [hole.id])));

const file = serializeDoc(doc, "Bolt Circle Flange");
writeFileSync("examples/bolt-circle.rcam", JSON.stringify(file, null, 2) + "\n");
console.log(`Wrote examples/bolt-circle.rcam — ${doc.entities.length - 1} entities, ${doc.patterns.length} pattern, ${doc.variables.length} variables`);
