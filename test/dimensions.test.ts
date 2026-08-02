/**
 * Runtime verification of driving dimensions. Run: npx tsx test/dimensions.test.ts
 * Confirms a dimension's value actually drives the geometry through the solver.
 */

import { CADDocument } from "../src/model/document";
import { LineEntity, CircleEntity } from "../src/model/entities";
import {
  makeDimension,
  dimensionMeasure,
  dimensionAnchorsFromCursor,
  dimensionOffsetFromCursor,
  dimensionLayout,
  chainProjectAnchors,
} from "../src/model/dimensions";
import { solve } from "../src/solver/solver";
import { type Geo, makeConstraint } from "../src/model/constraints";
import { dist } from "../src/core/vec2";
import { test, expect } from "vitest";

function check(name: string, ok: boolean, detail = ""): void {
  test(name, () => {
    expect(ok, detail).toBe(true);
  });
}
/**
 * KNOWN LIMITATION: when a length-locked endpoint is dragged PAST its reach, the
 * dragged end lands on the reachable circle but lags the cursor's angle slightly
 * (the soft pin is kept weak so the anchored end can't creep — see PIN_WEIGHT in
 * solver.ts). The anchored-end creep itself is fixed; this is a cosmetic angular
 * lag of the dragged end only. test.fails keeps the suite honest and will flag if
 * the behaviour ever improves enough to promote to check().
 */
function checkKnownFail(name: string, ok: boolean, detail = ""): void {
  test.fails(`[known-fail] ${name}`, () => {
    expect(ok, detail).toBe(true);
  });
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
  doc.addDimension(
    makeDimension("distance", { points: [pr(l, "a"), pr(l, "b")], value: 50, offset: 12 }),
  );
  const r = solve(doc);
  check(
    "distance dim drives length to 50",
    Math.abs(l.length - 50) < 1e-3,
    `len=${l.length.toFixed(4)}`,
  );
  check("distance dim converged", r.converged);
}

// 2) Horizontal distance dimension -----------------------------------------
{
  const doc = new CADDocument({ width: 300, height: 200 });
  const l = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 100, y: 30 })) as LineEntity;
  doc.addDimension(
    makeDimension("horizontal", { points: [pr(l, "a"), pr(l, "b")], value: 40, offset: 12 }),
  );
  solve(doc);
  check(
    "horizontal dim drives Δx to 40",
    Math.abs(Math.abs(l.a.x - l.b.x) - 40) < 1e-3,
    `dx=${Math.abs(l.a.x - l.b.x).toFixed(4)}`,
  );
}

// 3) Vertical distance dimension -------------------------------------------
{
  const doc = new CADDocument({ width: 300, height: 200 });
  const l = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 100, y: 30 })) as LineEntity;
  doc.addDimension(
    makeDimension("vertical", { points: [pr(l, "a"), pr(l, "b")], value: 75, offset: 12 }),
  );
  solve(doc);
  check(
    "vertical dim drives Δy to 75",
    Math.abs(Math.abs(l.a.y - l.b.y) - 75) < 1e-3,
    `dy=${Math.abs(l.a.y - l.b.y).toFixed(4)}`,
  );
}

// 4) Radius dimension ------------------------------------------------------
{
  const doc = new CADDocument({ width: 300, height: 200 });
  const c = doc.add(new CircleEntity({ x: 50, y: 50 }, 20)) as CircleEntity;
  doc.addDimension(makeDimension("radius", { entities: [c.id], value: 12, offset: 0.7 }));
  solve(doc);
  check(
    "radius dim drives radius to 12",
    Math.abs(c.radius - 12) < 1e-3,
    `r=${c.radius.toFixed(4)}`,
  );
}

// 5) Diameter dimension ----------------------------------------------------
{
  const doc = new CADDocument({ width: 300, height: 200 });
  const c = doc.add(new CircleEntity({ x: 50, y: 50 }, 20)) as CircleEntity;
  doc.addDimension(makeDimension("diameter", { entities: [c.id], value: 50, offset: 0.7 }));
  solve(doc);
  check(
    "diameter dim drives radius to 25",
    Math.abs(c.radius - 25) < 1e-3,
    `r=${c.radius.toFixed(4)}`,
  );
}

// 5b) Circle-gap dimension (inner/outer offset) ----------------------------
{
  const doc = new CADDocument({ width: 300, height: 200 });
  const outer = doc.add(new CircleEntity({ x: 50, y: 50 }, 40)) as CircleEntity;
  const inner = doc.add(new CircleEntity({ x: 50, y: 50 }, 30)) as CircleEntity;
  // Concentric gap is the radial difference: 40 − 30 = 10.
  const gap = makeDimension("circle-gap", { entities: [outer.id, inner.id], value: 0, offset: 0 });
  check(
    "circle-gap measures radial gap",
    Math.abs((dimensionMeasure(gap, geoOf(doc)) ?? 0) - 10) < 1e-6,
  );

  // With the circles held concentric and the outer radius pinned, driving the
  // gap to 4 must come out of the inner radius → 36.
  doc.constraints.push(makeConstraint("concentric", { entities: [outer.id, inner.id] }));
  doc.addDimension(makeDimension("radius", { entities: [outer.id], value: 40, offset: 0.7 }));
  doc.addDimension(
    makeDimension("circle-gap", { entities: [outer.id, inner.id], value: 4, offset: 0 }),
  );
  solve(doc);
  check(
    "circle-gap drives inner radius to 36",
    Math.abs(inner.radius - 36) < 1e-3,
    `r=${inner.radius.toFixed(4)}`,
  );
}

// 5c) Linear dimension anchored to a circle edge ---------------------------
{
  const doc = new CADDocument({ width: 300, height: 200 });
  const c = doc.add(new CircleEntity({ x: 0, y: 0 }, 10)) as CircleEntity;
  const l = doc.add(new LineEntity({ x: 30, y: 0 }, { x: 40, y: 0 })) as LineEntity;
  // Edge point at θ=0 is (10,0); distance from line endpoint a (30,0) is 20.
  const edgeRef = { entityId: c.id, key: "edge@0" };
  const dim = makeDimension("distance", { points: [pr(l, "a"), edgeRef], value: 0, offset: 5 });
  check(
    "circle-edge anchor measures to the rim",
    Math.abs((dimensionMeasure(dim, geoOf(doc)) ?? 0) - 20) < 1e-6,
  );

  // Drive it to 8: the solver must satisfy the rim-to-point distance.
  doc.addDimension(
    makeDimension("distance", { points: [pr(l, "a"), edgeRef], value: 8, offset: 5 }),
  );
  const r = solve(doc);
  check("circle-edge dim converged", r.converged);
  check(
    "circle-edge dim drives distance to 8",
    Math.abs((dimensionMeasure(doc.dimensions[doc.dimensions.length - 1], geoOf(doc)) ?? 0) - 8) <
      1e-3,
  );
}

// 6) Measure correctness --------------------------------------------------
{
  const doc = new CADDocument({ width: 300, height: 200 });
  const l = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 30, y: 40 })) as LineEntity;
  const geo = geoOf(doc);
  const dist = makeDimension("distance", { points: [pr(l, "a"), pr(l, "b")], value: 0, offset: 0 });
  const horiz = makeDimension("horizontal", {
    points: [pr(l, "a"), pr(l, "b")],
    value: 0,
    offset: 0,
  });
  const vert = makeDimension("vertical", { points: [pr(l, "a"), pr(l, "b")], value: 0, offset: 0 });
  check("measure distance = 50", Math.abs((dimensionMeasure(dist, geo) ?? 0) - 50) < 1e-9);
  check("measure horizontal = 30", Math.abs((dimensionMeasure(horiz, geo) ?? 0) - 30) < 1e-9);
  check("measure vertical = 40", Math.abs((dimensionMeasure(vert, geo) ?? 0) - 40) < 1e-9);
}

// 7) Editing a dimension value re-drives geometry --------------------------
{
  const doc = new CADDocument({ width: 300, height: 200 });
  const l = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 100, y: 0 })) as LineEntity;
  const d = doc.addDimension(
    makeDimension("distance", { points: [pr(l, "a"), pr(l, "b")], value: 100, offset: 12 }),
  );
  solve(doc);
  check("dim @100 keeps length", Math.abs(l.length - 100) < 1e-3, `len=${l.length.toFixed(4)}`);
  d.value = 250; // user edits the value
  solve(doc);
  check(
    "editing dim to 250 stretches line",
    Math.abs(l.length - 250) < 1e-3,
    `len=${l.length.toFixed(4)}`,
  );
}

// 8) Drag one end of a length-dimensioned line → the OTHER end stays put ----
//    (regression for: "the other node should remain stationary").
{
  const doc = new CADDocument({ width: 400, height: 300 });
  const l = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 100, y: 0 })) as LineEntity;
  doc.addDimension(
    makeDimension("distance", { points: [pr(l, "a"), pr(l, "b")], value: 100, offset: 12 }),
  );
  solve(doc); // settle

  // Drag endpoint b toward a point beyond the fixed length; a must not move.
  solve(doc, new Map([[`${l.id}:b`, { x: 100, y: 50 }]]));
  check(
    "dragging b leaves a stationary",
    dist(l.a, { x: 0, y: 0 }) < 0.5,
    `a=(${l.a.x.toFixed(3)}, ${l.a.y.toFixed(3)})`,
  );
  check(
    "length dimension still satisfied",
    Math.abs(l.length - 100) < 1e-2,
    `len=${l.length.toFixed(4)}`,
  );
  // b stays on the reachable circle (length holds) but may lag the cursor's angle
  // slightly when dragged past reach — cosmetic; see PIN_WEIGHT note in solver.ts.
  checkKnownFail(
    "b slid to the reachable point (~89.4, 44.7)",
    dist(l.b, { x: 89.44, y: 44.72 }) < 0.5,
    `b=(${l.b.x.toFixed(2)}, ${l.b.y.toFixed(2)})`,
  );
  check(
    "b stays on the reachable circle (length 100 from a)",
    Math.abs(dist(l.a, l.b) - 100) < 1e-2,
    `|ab|=${dist(l.a, l.b).toFixed(3)}`,
  );
}

// 9) Continuous drag must not let the anchored end CREEP over many steps -----
{
  const doc = new CADDocument({ width: 400, height: 300 });
  const l = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 100, y: 0 })) as LineEntity;
  doc.addDimension(
    makeDimension("distance", { points: [pr(l, "a"), pr(l, "b")], value: 100, offset: 12 }),
  );
  solve(doc);
  // Sweep the cursor for b through 60 steps (always "beyond" the reachable length).
  for (let i = 0; i <= 60; i++) {
    solve(doc, new Map([[`${l.id}:b`, { x: 100, y: i * 1.5 }]]));
  }
  check(
    "anchored end does not creep over 60 drag steps",
    dist(l.a, { x: 0, y: 0 }) < 0.5,
    `a drift=${dist(l.a, { x: 0, y: 0 }).toFixed(3)} mm`,
  );
  check(
    "length held through the whole drag",
    Math.abs(l.length - 100) < 1e-2,
    `len=${l.length.toFixed(4)}`,
  );
}

// 10) Chain propagation: anchored points DO move when a hard constraint forces it,
//     and the coupling constraints stay tight (no anchor "lag" gaps).
{
  const doc = new CADDocument({ width: 400, height: 300 });
  const l1 = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 100, y: 0 })) as LineEntity;
  const l2 = doc.add(new LineEntity({ x: 100, y: 0 }, { x: 100, y: 50 })) as LineEntity;
  doc.addConstraint(makeConstraint("coincident", { points: [pr(l1, "b"), pr(l2, "a")] }));
  doc.addDimension(
    makeDimension("distance", { points: [pr(l1, "a"), pr(l1, "b")], value: 100, offset: 12 }),
  );
  doc.addDimension(
    makeDimension("distance", { points: [pr(l2, "a"), pr(l2, "b")], value: 50, offset: 12 }),
  );
  solve(doc);
  // Drag the free end of the chain; everything downstream must reflow.
  solve(doc, new Map([[`${l1.id}:a`, { x: 0, y: 60 }]]));
  check(
    "chain: coincident joint stays tight",
    dist(l1.b, l2.a) < 0.05,
    `gap=${dist(l1.b, l2.a).toFixed(4)}`,
  );
  check("chain: l1 length held", Math.abs(l1.length - 100) < 0.1, `len1=${l1.length.toFixed(3)}`);
  check("chain: l2 length held", Math.abs(l2.length - 50) < 0.1, `len2=${l2.length.toFixed(3)}`);
}

// 11) Multi-entity linear dimensioning between two entities ----------------
{
  const doc = new CADDocument({ width: 400, height: 300 });
  const rect = doc.add(new LineEntity({ x: 50, y: 50 }, { x: 50, y: 250 })) as LineEntity;
  const line = doc.add(new LineEntity({ x: 240, y: 100 }, { x: 240, y: 200 })) as LineEntity;
  // Measuring horizontal distance (Δx = 190) from vertical line rect to line.
  // Starting from a vertical edge must not lock the dimension to "vertical".
  const dim = makeDimension("horizontal", {
    points: [{ entityId: rect.id, key: "a" }, { entityId: line.id, key: "a" }],
    value: 190,
    offset: 10,
  });
  doc.addDimension(dim);
  solve(doc);
  check(
    "horizontal dimension correctly measures Δx between two vertical entities",
    Math.abs(Math.abs(line.a.x - rect.a.x) - 190) < 1e-3,
    `dx=${Math.abs(line.a.x - rect.a.x).toFixed(4)}`,
  );
}

// 12) line-distance anchors slide along the lines, not just the perpendicular
//     offset — dragging a dim between two vertical lines up/down used to do
//     nothing, since only dimensionOffsetFromCursor (perpendicular) was wired
//     into the drag handlers.
{
  const doc = new CADDocument({ width: 400, height: 300 });
  const l1 = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 0, y: 100 })) as LineEntity;
  const l2 = doc.add(new LineEntity({ x: 50, y: 0 }, { x: 50, y: 100 })) as LineEntity;
  const geo = geoOf(doc);
  const dim = makeDimension("line-distance", {
    entities: [l1.id, l2.id],
    anchors: [0.5, 0.5],
    value: 0,
    offset: 20,
  });

  const near = dimensionAnchorsFromCursor(dim, geo, { x: 25, y: 90 });
  check(
    "dragging near the top slides both anchors near t=0.9",
    near !== null && Math.abs(near[0] - 0.9) < 1e-6 && Math.abs(near[1] - 0.9) < 1e-6,
    `anchors=${JSON.stringify(near)}`,
  );

  const far = dimensionAnchorsFromCursor(dim, geo, { x: 25, y: -50 });
  check(
    "cursor beyond the line's end clamps the anchor to 0, not negative",
    far !== null && far[0] === 0 && far[1] === 0,
    `anchors=${JSON.stringify(far)}`,
  );

  // Offset (perpendicular standoff) still works independently of anchor drag.
  dim.anchors = near ?? [0.5, 0.5];
  const offset = dimensionOffsetFromCursor(dim, geo, { x: 60, y: 90 });
  check("perpendicular offset drag is unaffected by the anchor fix", offset > 0, `offset=${offset}`);

  const other = makeDimension("distance", {
    points: [
      { entityId: l1.id, key: "a" },
      { entityId: l1.id, key: "b" },
    ],
    value: 0,
    offset: 5,
  });
  check(
    "non line-distance dimensions get no anchors from the cursor",
    dimensionAnchorsFromCursor(other, geo, { x: 25, y: 90 }) === null,
  );
}

// 13) line-distance renders a straight dimension even when the two anchors
//     sit at DIFFERENT positions along their lines (t1 != t2) -- e.g. after
//     dragging just one end. q2 used to be derived from p2 and the p->q gap,
//     ignoring any tangential offset between the anchors, so it could land
//     far from q and draw a long, wrongly-angled second extension line —
//     reported live as "dimension lines should be straight lines. Not
//     whatever this is" against production geometry with mismatched anchors.
{
  const doc = new CADDocument({ width: 400, height: 300 });
  const l1 = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 0, y: 100 })) as LineEntity;
  const l2 = doc.add(new LineEntity({ x: 50, y: 0 }, { x: 50, y: 100 })) as LineEntity;
  const geo = geoOf(doc);
  // Mismatched anchors: t1=0.2 (near the bottom of l1), t2=0.9 (near the top of l2).
  const dim = makeDimension("line-distance", {
    entities: [l1.id, l2.id],
    anchors: [0.2, 0.9],
    value: 50,
    offset: 20,
  });
  const layout = dimensionLayout(dim, geo, "mm");
  check("mismatched-anchor line-distance still lays out", layout !== null);
  if (layout) {
    const [p, p2] = layout.segments[0];
    const [q, q2] = layout.segments[1];
    check(
      "extension line 1 (p to p2) is exactly the offset long",
      Math.abs(dist(p, p2) - 20) < 1e-6,
      `len=${dist(p, p2).toFixed(4)}`,
    );
    check(
      "extension line 2 (q to q2) is ALSO exactly the offset long, not a long stray diagonal",
      Math.abs(dist(q, q2) - 20) < 1e-6,
      `len=${dist(q, q2).toFixed(4)}`,
    );
    // p2 and q2 sit directly across from p and q (same tangential coordinate,
    // shifted only along the perpendicular n=(±1,0)) -- a straight offset copy
    // of the p-q line, not a shape bent back on itself.
    check("p2 keeps p's y", Math.abs(p2.y - p.y) < 1e-6, `p.y=${p.y} p2.y=${p2.y}`);
    check("q2 keeps q's y", Math.abs(q2.y - q.y) < 1e-6, `q.y=${q.y} q2.y=${q2.y}`);
  }
}

// 14) dimensionAnchorsFromCursor now chain-projects (t1 on l1, then l1's point
//     dropped onto l2 for t2) instead of projecting the cursor onto each line
//     independently. For parallel lines the two give the SAME result whenever
//     neither projection clamps (dropping a perpendicular from one shared
//     cursor onto two parallel lines always lands at the same tangential
//     coordinate) -- they only diverge once t1 ITSELF gets clamped against
//     l1's short extent, which independent projection doesn't know about
//     when it separately (and unclampedly, relative to l1) projects onto l2.
{
  const doc = new CADDocument({ width: 400, height: 300 });
  // l1 is SHORT (y 0..50); l2 is much longer (y 0..120).
  const l1 = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 0, y: 50 })) as LineEntity;
  const l2 = doc.add(new LineEntity({ x: 50, y: 0 }, { x: 50, y: 120 })) as LineEntity;
  const geo = geoOf(doc);
  const dim = makeDimension("line-distance", {
    entities: [l1.id, l2.id],
    anchors: [0.5, 0.5],
    value: 0,
    offset: 20,
  });

  // Cursor at y=100 -- past l1's y=50 end (clamps t1 to 1, landing p1 at
  // y=50), but well within l2's range on its own.
  const anchors = dimensionAnchorsFromCursor(dim, geo, { x: 0, y: 100 });
  check("chain-projected anchors exist past l1's short end", anchors !== null);
  if (anchors) {
    check("t1 clamps to l1's far end", anchors[0] === 1, `t1=${anchors[0]}`);
    const p1y = 0 + anchors[0] * 50;
    const p2y = 0 + anchors[1] * 120;
    check(
      "t2 follows l1's CLAMPED point (y=50), not the raw cursor (y=100) — a straight crossing",
      Math.abs(p1y - p2y) < 1e-6,
      `l1.y=${p1y.toFixed(3)} l2.y=${p2y.toFixed(3)}`,
    );
  }

  // The resulting dimension must still lay out as a clean, straight shape.
  const created = makeDimension("line-distance", {
    entities: [l1.id, l2.id],
    anchors: anchors ?? [1, 0.5],
    value: 50,
    offset: 15,
  });
  const layout = dimensionLayout(created, geo, "mm");
  check("clamped-anchor dimension still lays out (no crash / null)", layout !== null);
}

// 15) Creation-time mismatch is the MAIN production scenario: two separate
//     raw clicks (not a drag) at different heights on two parallel edges,
//     which chainProjectAnchors must resolve to a directly-across pair
//     using only the FIRST click as the tangential reference.
{
  const l1 = { a: { x: 0, y: 0 }, b: { x: 0, y: 100 } };
  const l2 = { a: { x: 50, y: 0 }, b: { x: 50, y: 100 } };
  // Simulates a click near the bottom of l1; a second, unrelated click near
  // the top of l2 no longer has any say over l2's anchor position.
  const [t1, t2] = chainProjectAnchors({ x: 0, y: 15 }, l1, l2);
  check("t1 reflects the first click (y=15 -> t=0.15)", Math.abs(t1 - 0.15) < 1e-6, `t1=${t1}`);
  check(
    "t2 is DERIVED from t1's crossing, not an independent second click",
    Math.abs(t2 - 0.15) < 1e-6,
    `t2=${t2}`,
  );
}
