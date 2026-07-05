import { test, expect } from "vitest";
import { repairImportedEntities, summarizeRepairs } from "../src/io/dxfRepair";
import { collectClosedLoops } from "../src/cam/loops";
import {
  Entity, LineEntity, CircleEntity, ArcEntity, PolylineEntity,
} from "../src/model/entities";

const line = (ax: number, ay: number, bx: number, by: number) =>
  new LineEntity({ x: ax, y: ay }, { x: bx, y: by });

const len = (l: LineEntity) => Math.hypot(l.a.x - l.b.x, l.a.y - l.b.y);

// A square whose corners are jittered by ≤0.02 mm — well above CAM's 1e-4 mm
// chaining threshold, so it will NOT form a loop until Babel welds the corners.
const gappySquare = (): Entity[] => [
  line(0, 0, 10, 0),
  line(10.02, 0.01, 10, 10),
  line(10.01, 10.02, 0, 10),
  line(0.02, 10.0, 0.01, 0.02),
];

test("welds sub-tolerance corner gaps so a broken square chains into a loop", () => {
  const ents = gappySquare();
  expect(collectClosedLoops(ents)).toHaveLength(0); // gaps too wide to chain

  const { entities, report } = repairImportedEntities(ents);
  expect(report.endpointsWelded).toBe(8); // 2 endpoints × 4 corners
  expect(collectClosedLoops(entities)).toHaveLength(1); // now it closes
});

test("leaves gaps wider than the weld tolerance alone", () => {
  const ents = [line(0, 0, 10, 0), line(10.2, 0, 20, 0)]; // 0.2 mm gap > 0.05
  const { report } = repairImportedEntities(ents);
  expect(report.endpointsWelded).toBe(0);
});

test("never collapses the two ends of one short segment", () => {
  // A 0.03 mm line: both endpoints sit within the 0.05 mm weld tolerance of each
  // other, but they belong to the same entity — welding them would delete it.
  const short = line(0, 0, 0.03, 0);
  const { entities, report } = repairImportedEntities([short]);
  expect(report.endpointsWelded).toBe(0);
  expect(entities).toHaveLength(1);
  expect(len(entities[0] as LineEntity)).toBeCloseTo(0.03, 6);
});

test("snaps a loose endpoint onto an arc endpoint, leaving the arc exact", () => {
  const arc = new ArcEntity({ x: 0, y: 0 }, 10, 0, Math.PI / 2); // endpoints (10,0),(0,10)
  const l = line(10.02, 0.01, 20, 0); // l.a is ~0.022 mm from the arc's (10,0)
  const { report } = repairImportedEntities([arc, l]);

  expect(report.endpointsWelded).toBe(1);
  expect(l.a).toEqual({ x: 10, y: 0 }); // moved to the arc's exact endpoint
  expect(arc.center).toEqual({ x: 0, y: 0 }); // arc untouched
  expect(arc.radius).toBe(10);
});

test("removes exact duplicate lines regardless of direction", () => {
  const ents = [line(0, 0, 10, 0), line(10, 0, 0, 0), line(0, 0, 10, 0)];
  const { entities, report } = repairImportedEntities(ents);
  expect(report.duplicatesRemoved).toBe(2);
  expect(entities).toHaveLength(1);
});

test("removes duplicate circles and arcs", () => {
  const c = () => new CircleEntity({ x: 1, y: 2 }, 5);
  const a = () => new ArcEntity({ x: 0, y: 0 }, 3, 0, 1);
  const { entities, report } = repairImportedEntities([c(), c(), a(), a()]);
  expect(report.duplicatesRemoved).toBe(2);
  expect(entities).toHaveLength(2);
});

test("drops degenerate zero-length lines and zero-radius circles/arcs", () => {
  const ents = [
    line(5, 5, 5, 5),
    new CircleEntity({ x: 0, y: 0 }, 0),
    new ArcEntity({ x: 0, y: 0 }, 0, 0, 1),
    line(0, 0, 10, 0), // survivor
  ];
  const { entities, report } = repairImportedEntities(ents);
  expect(report.degenerateRemoved).toBe(3);
  expect(entities).toHaveLength(1);
});

test("auto-closes an open polyline whose ends already meet", () => {
  const pl = new PolylineEntity(
    [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0.01, y: 0.0 }],
    false,
  );
  const { report } = repairImportedEntities([pl]);
  expect(report.polylinesClosed).toBe(1);
  expect(pl.closed).toBe(true);
});

test("reports nothing for already-clean geometry", () => {
  const clean = [line(0, 0, 10, 0), new CircleEntity({ x: 0, y: 0 }, 5)];
  const { report } = repairImportedEntities(clean);
  expect(summarizeRepairs(report)).toEqual([]);
});

test("summary reads naturally", () => {
  expect(summarizeRepairs({
    endpointsWelded: 1, polylinesClosed: 2, duplicatesRemoved: 1, degenerateRemoved: 3,
  })).toEqual([
    "welded 1 gap",
    "closed 2 open contours",
    "removed 1 duplicate",
    "removed 3 empty entities",
  ]);
});
