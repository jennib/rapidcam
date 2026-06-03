/**
 * Runtime verification of driving dimensions. Run: npx tsx test/dimensions.test.ts
 * Confirms a dimension's value actually drives the geometry through the solver.
 */

import { CADDocument } from "../src/model/document";
import { LineEntity, CircleEntity } from "../src/model/entities";
import { makeDimension, dimensionMeasure } from "../src/model/dimensions";
import { solve } from "../src/solver/solver";
import { Geo, makeConstraint } from "../src/model/constraints";
import { dist } from "../src/core/vec2";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  PASS" : "✗ FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
}
const geoOf = (doc: CADDocument): Geo => {
  const m = new Map(doc.entities.map((e) => [e.id, e]));
  return (id) => m.get(id);
};
const pr = (e: LineEntity, k: "a" | "b") => ({ entityId: e.id, key: k });

// 1) Driving distance sets line length -------------------------------------
{
  const doc = new CADDocument({ width: 300, height: 200 });
  const l = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 100, y: 0 })) as LineEntity;
  doc.addDimension(makeDimension("distance", { points: [pr(l, "a"), pr(l, "b")], value: 50, offset: 12 }));
  const r = solve(doc);
  check("distance dim drives length to 50", Math.abs(l.length - 50) < 1e-3, `len=${l.length.toFixed(4)}`);
  check("distance dim converged", r.converged);
}

// 2) Horizontal distance dimension -----------------------------------------
{
  const doc = new CADDocument({ width: 300, height: 200 });
  const l = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 100, y: 30 })) as LineEntity;
  doc.addDimension(makeDimension("horizontal", { points: [pr(l, "a"), pr(l, "b")], value: 40, offset: 12 }));
  solve(doc);
  check("horizontal dim drives Δx to 40", Math.abs(Math.abs(l.a.x - l.b.x) - 40) < 1e-3, `dx=${Math.abs(l.a.x - l.b.x).toFixed(4)}`);
}

// 3) Vertical distance dimension -------------------------------------------
{
  const doc = new CADDocument({ width: 300, height: 200 });
  const l = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 100, y: 30 })) as LineEntity;
  doc.addDimension(makeDimension("vertical", { points: [pr(l, "a"), pr(l, "b")], value: 75, offset: 12 }));
  solve(doc);
  check("vertical dim drives Δy to 75", Math.abs(Math.abs(l.a.y - l.b.y) - 75) < 1e-3, `dy=${Math.abs(l.a.y - l.b.y).toFixed(4)}`);
}

// 4) Radius dimension ------------------------------------------------------
{
  const doc = new CADDocument({ width: 300, height: 200 });
  const c = doc.add(new CircleEntity({ x: 50, y: 50 }, 20)) as CircleEntity;
  doc.addDimension(makeDimension("radius", { entities: [c.id], value: 12, offset: 0.7 }));
  solve(doc);
  check("radius dim drives radius to 12", Math.abs(c.radius - 12) < 1e-3, `r=${c.radius.toFixed(4)}`);
}

// 5) Diameter dimension ----------------------------------------------------
{
  const doc = new CADDocument({ width: 300, height: 200 });
  const c = doc.add(new CircleEntity({ x: 50, y: 50 }, 20)) as CircleEntity;
  doc.addDimension(makeDimension("diameter", { entities: [c.id], value: 50, offset: 0.7 }));
  solve(doc);
  check("diameter dim drives radius to 25", Math.abs(c.radius - 25) < 1e-3, `r=${c.radius.toFixed(4)}`);
}

// 6) Measure correctness --------------------------------------------------
{
  const doc = new CADDocument({ width: 300, height: 200 });
  const l = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 30, y: 40 })) as LineEntity;
  const geo = geoOf(doc);
  const dist = makeDimension("distance", { points: [pr(l, "a"), pr(l, "b")], value: 0, offset: 0 });
  const horiz = makeDimension("horizontal", { points: [pr(l, "a"), pr(l, "b")], value: 0, offset: 0 });
  const vert = makeDimension("vertical", { points: [pr(l, "a"), pr(l, "b")], value: 0, offset: 0 });
  check("measure distance = 50", Math.abs((dimensionMeasure(dist, geo) ?? 0) - 50) < 1e-9);
  check("measure horizontal = 30", Math.abs((dimensionMeasure(horiz, geo) ?? 0) - 30) < 1e-9);
  check("measure vertical = 40", Math.abs((dimensionMeasure(vert, geo) ?? 0) - 40) < 1e-9);
}

// 7) Editing a dimension value re-drives geometry --------------------------
{
  const doc = new CADDocument({ width: 300, height: 200 });
  const l = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 100, y: 0 })) as LineEntity;
  const d = doc.addDimension(makeDimension("distance", { points: [pr(l, "a"), pr(l, "b")], value: 100, offset: 12 }));
  solve(doc);
  check("dim @100 keeps length", Math.abs(l.length - 100) < 1e-3, `len=${l.length.toFixed(4)}`);
  d.value = 250; // user edits the value
  solve(doc);
  check("editing dim to 250 stretches line", Math.abs(l.length - 250) < 1e-3, `len=${l.length.toFixed(4)}`);
}

// 8) Drag one end of a length-dimensioned line → the OTHER end stays put ----
//    (regression for: "the other node should remain stationary").
{
  const doc = new CADDocument({ width: 400, height: 300 });
  const l = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 100, y: 0 })) as LineEntity;
  doc.addDimension(makeDimension("distance", { points: [pr(l, "a"), pr(l, "b")], value: 100, offset: 12 }));
  solve(doc); // settle

  // Drag endpoint b toward a point beyond the fixed length; a must not move.
  solve(doc, new Map([[`${l.id}:b`, { x: 100, y: 50 }]]));
  check("dragging b leaves a stationary", dist(l.a, { x: 0, y: 0 }) < 0.5, `a=(${l.a.x.toFixed(3)}, ${l.a.y.toFixed(3)})`);
  check("length dimension still satisfied", Math.abs(l.length - 100) < 1e-2, `len=${l.length.toFixed(4)}`);
  check("b slid to the reachable point (~89.4, 44.7)", dist(l.b, { x: 89.44, y: 44.72 }) < 0.5, `b=(${l.b.x.toFixed(2)}, ${l.b.y.toFixed(2)})`);
}

// 9) Continuous drag must not let the anchored end CREEP over many steps -----
{
  const doc = new CADDocument({ width: 400, height: 300 });
  const l = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 100, y: 0 })) as LineEntity;
  doc.addDimension(makeDimension("distance", { points: [pr(l, "a"), pr(l, "b")], value: 100, offset: 12 }));
  solve(doc);
  // Sweep the cursor for b through 60 steps (always "beyond" the reachable length).
  for (let i = 0; i <= 60; i++) {
    solve(doc, new Map([[`${l.id}:b`, { x: 100, y: i * 1.5 }]]));
  }
  check("anchored end does not creep over 60 drag steps", dist(l.a, { x: 0, y: 0 }) < 0.5, `a drift=${dist(l.a, { x: 0, y: 0 }).toFixed(3)} mm`);
  check("length held through the whole drag", Math.abs(l.length - 100) < 1e-2, `len=${l.length.toFixed(4)}`);
}

// 10) Chain propagation: anchored points DO move when a hard constraint forces it,
//     and the coupling constraints stay tight (no anchor "lag" gaps).
{
  const doc = new CADDocument({ width: 400, height: 300 });
  const l1 = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 100, y: 0 })) as LineEntity;
  const l2 = doc.add(new LineEntity({ x: 100, y: 0 }, { x: 100, y: 50 })) as LineEntity;
  doc.addConstraint(makeConstraint("coincident", { points: [pr(l1, "b"), pr(l2, "a")] }));
  doc.addDimension(makeDimension("distance", { points: [pr(l1, "a"), pr(l1, "b")], value: 100, offset: 12 }));
  doc.addDimension(makeDimension("distance", { points: [pr(l2, "a"), pr(l2, "b")], value: 50, offset: 12 }));
  solve(doc);
  // Drag the free end of the chain; everything downstream must reflow.
  solve(doc, new Map([[`${l1.id}:a`, { x: 0, y: 60 }]]));
  check("chain: coincident joint stays tight", dist(l1.b, l2.a) < 0.05, `gap=${dist(l1.b, l2.a).toFixed(4)}`);
  check("chain: l1 length held", Math.abs(l1.length - 100) < 0.1, `len1=${l1.length.toFixed(3)}`);
  check("chain: l2 length held", Math.abs(l2.length - 50) < 0.1, `len2=${l2.length.toFixed(3)}`);
}

console.log(failures === 0 ? "\nALL DIMENSION TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
