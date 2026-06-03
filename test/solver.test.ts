/**
 * Runtime verification of the constraint solver. Run with: npx tsx test/solver.test.ts
 * Exercises each constraint type end-to-end and checks the residual is driven to 0.
 */

import { CADDocument } from "../src/model/document";
import { LineEntity, CircleEntity } from "../src/model/entities";
import { makeConstraint, constraintResiduals, Geo } from "../src/model/constraints";
import { solve } from "../src/solver/solver";
import { dist, sub, cross, dot, normalize, len } from "../src/core/vec2";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  PASS" : "✗ FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
}
const geoOf = (doc: CADDocument): Geo => {
  const m = new Map(doc.entities.map((e) => [e.id, e]));
  return (id) => m.get(id);
};

// 1) Horizontal ------------------------------------------------------------
{
  const doc = new CADDocument({ width: 200, height: 150 });
  const l = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 100, y: 37 })) as LineEntity;
  doc.addConstraint(makeConstraint("horizontal", { entities: [l.id] }));
  const r = solve(doc);
  check("horizontal makes endpoints level", Math.abs(l.a.y - l.b.y) < 1e-4, `Δy=${(l.a.y - l.b.y).toExponential(2)}`);
  check("horizontal converged", r.converged);
}

// 2) Vertical --------------------------------------------------------------
{
  const doc = new CADDocument({ width: 200, height: 150 });
  const l = doc.add(new LineEntity({ x: 5, y: 0 }, { x: 40, y: 90 })) as LineEntity;
  doc.addConstraint(makeConstraint("vertical", { entities: [l.id] }));
  solve(doc);
  check("vertical makes endpoints aligned in x", Math.abs(l.a.x - l.b.x) < 1e-4);
}

// 3) Perpendicular ---------------------------------------------------------
{
  const doc = new CADDocument({ width: 200, height: 150 });
  const l1 = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 100, y: 0 })) as LineEntity;
  const l2 = doc.add(new LineEntity({ x: 10, y: 10 }, { x: 80, y: 14 })) as LineEntity;
  doc.addConstraint(makeConstraint("perpendicular", { entities: [l1.id, l2.id] }));
  solve(doc);
  const d = Math.abs(dot(normalize(sub(l1.b, l1.a)), normalize(sub(l2.b, l2.a))));
  check("perpendicular: dot of unit dirs ≈ 0", d < 1e-3, `dot=${d.toExponential(2)}`);
}

// 4) Parallel --------------------------------------------------------------
{
  const doc = new CADDocument({ width: 200, height: 150 });
  const l1 = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 100, y: 10 })) as LineEntity;
  const l2 = doc.add(new LineEntity({ x: 0, y: 50 }, { x: 90, y: 40 })) as LineEntity;
  doc.addConstraint(makeConstraint("parallel", { entities: [l1.id, l2.id] }));
  solve(doc);
  const c = Math.abs(cross(normalize(sub(l1.b, l1.a)), normalize(sub(l2.b, l2.a))));
  check("parallel: cross of unit dirs ≈ 0", c < 1e-3, `cross=${c.toExponential(2)}`);
}

// 5) Coincident ------------------------------------------------------------
{
  const doc = new CADDocument({ width: 200, height: 150 });
  const l1 = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 100, y: 0 })) as LineEntity;
  const l2 = doc.add(new LineEntity({ x: 130, y: 20 }, { x: 200, y: 20 })) as LineEntity;
  doc.addConstraint(
    makeConstraint("coincident", {
      points: [
        { entityId: l1.id, key: "b" },
        { entityId: l2.id, key: "a" },
      ],
    }),
  );
  solve(doc);
  check("coincident: endpoints meet", dist(l1.b, l2.a) < 1e-4, `gap=${dist(l1.b, l2.a).toExponential(2)}`);
}

// 6) Equal length ----------------------------------------------------------
{
  const doc = new CADDocument({ width: 200, height: 150 });
  const l1 = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 100, y: 0 })) as LineEntity;
  const l2 = doc.add(new LineEntity({ x: 0, y: 30 }, { x: 40, y: 30 })) as LineEntity;
  doc.addConstraint(makeConstraint("equal", { entities: [l1.id, l2.id] }));
  solve(doc);
  check("equal length", Math.abs(l1.length - l2.length) < 1e-3, `Δlen=${(l1.length - l2.length).toExponential(2)}`);
}

// 7) Concentric ------------------------------------------------------------
{
  const doc = new CADDocument({ width: 200, height: 150 });
  const c1 = doc.add(new CircleEntity({ x: 20, y: 20 }, 15)) as CircleEntity;
  const c2 = doc.add(new CircleEntity({ x: 60, y: 50 }, 8)) as CircleEntity;
  doc.addConstraint(makeConstraint("concentric", { entities: [c1.id, c2.id] }));
  solve(doc);
  check("concentric: centres meet", dist(c1.center, c2.center) < 1e-4);
}

// 8) Tangent (line + circle) ----------------------------------------------
{
  const doc = new CADDocument({ width: 200, height: 150 });
  const l = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 100, y: 0 })) as LineEntity;
  const c = doc.add(new CircleEntity({ x: 50, y: 30 }, 10)) as CircleEntity;
  doc.addConstraint(makeConstraint("tangent", { entities: [l.id, c.id] }));
  solve(doc);
  const d = sub(l.b, l.a);
  const distToLine = Math.abs(cross(d, sub(c.center, l.a)) / len(d));
  check("tangent: dist(center,line) ≈ radius", Math.abs(distToLine - c.radius) < 1e-3, `Δ=${(distToLine - c.radius).toExponential(2)}`);
}

// 9) Point-on-line ---------------------------------------------------------
{
  const doc = new CADDocument({ width: 200, height: 150 });
  const l1 = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 100, y: 0 })) as LineEntity;
  const l2 = doc.add(new LineEntity({ x: 40, y: 25 }, { x: 70, y: 60 })) as LineEntity;
  doc.addConstraint(makeConstraint("pointOnLine", { points: [{ entityId: l2.id, key: "a" }], entities: [l1.id] }));
  solve(doc);
  const d = sub(l1.b, l1.a);
  const sd = Math.abs(cross(d, sub(l2.a, l1.a)) / len(d));
  check("point-on-line: point lies on line", sd < 1e-3, `dist=${sd.toExponential(2)}`);
}

// 10) Fixed + drag pin: classic "follow" scenario --------------------------
{
  const doc = new CADDocument({ width: 200, height: 150 });
  const l1 = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 100, y: 0 })) as LineEntity;
  const l2 = doc.add(new LineEntity({ x: 100, y: 0 }, { x: 100, y: 60 })) as LineEntity;
  doc.addConstraint(makeConstraint("fixed", { entities: [l1.id] }));
  doc.addConstraint(makeConstraint("vertical", { entities: [l2.id] }));
  doc.addConstraint(
    makeConstraint("coincident", {
      points: [
        { entityId: l1.id, key: "b" },
        { entityId: l2.id, key: "a" },
      ],
    }),
  );
  // Drag l2's top endpoint toward a slanted target. Because l2 is vertical and
  // l2.a is coincident with the FIXED l1.b, x is locked to 100 — the soft pin only
  // moves the free Y. So l2.b should end near (100, 80), not (140, 80).
  const pins = new Map([[`${l2.id}:b`, { x: 140, y: 80 }]]);
  const r = solve(doc, pins);
  check("fixed: l1 unchanged", l1.a.x === 0 && l1.b.x === 100 && l1.b.y === 0);
  check("coincident maintained under drag", dist(l1.b, l2.a) < 1e-3, `gap=${dist(l1.b, l2.a).toExponential(2)}`);
  check("vertical maintained under drag", Math.abs(l2.a.x - l2.b.x) < 1e-3, `Δx=${(l2.a.x - l2.b.x).toExponential(2)}`);
  check("constraint holds X (~100)", Math.abs(l2.b.x - 100) < 1e-2, `x=${l2.b.x.toFixed(4)}`);
  check("free Y follows cursor (~80)", Math.abs(l2.b.y - 80) < 1e-2, `y=${l2.b.y.toFixed(4)}`);
  check("DOF reported", r.dof >= 0, `dof=${r.dof}`);
}

// 11) Free drag (no constraints): point lands exactly on the cursor ---------
{
  const doc = new CADDocument({ width: 200, height: 150 });
  const l = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 100, y: 0 })) as LineEntity;
  solve(doc, new Map([[`${l.id}:b`, { x: 120, y: 40 }]]));
  check("free drag: endpoint reaches cursor", dist(l.b, { x: 120, y: 40 }) < 1e-2, `gap=${dist(l.b, { x: 120, y: 40 }).toExponential(2)}`);
  check("free drag: other endpoint unmoved", dist(l.a, { x: 0, y: 0 }) < 1e-9);
}

console.log(failures === 0 ? "\nALL SOLVER TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
