import { describe, it, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import type { LineEntity } from "../src/model/entities";
import { seedConstraintPoints } from "../src/model/constraints";
import { solve } from "../src/solver/solver";
import { buildConstraintsFor } from "../src/ui/constraintBar";

const userDocJson = {
  version: 3,
  name: "Cabinet Hinge Bore",
  canvas: { width: 963.6, height: 963.6 },
  displayUnit: "mm",
  stockThickness: 19.05,
  stockRect: { x: 50, y: 50, width: 863.6, height: 863.6 },
  origin: { x: "left", y: "front", z: "top" },
  groups: [],
  layers: [{ id: "layer-0", name: "Default", color: "#cdd2da", visible: true, locked: false }],
  activeLayerId: "layer-0",
  entities: [
    {
      type: "line",
      id: "ent3",
      a: { x: 79.70195041258322, y: 435.8167862596993 },
      b: { x: 79.70195041258322, y: -4.183954200424218 },
      isConstruction: true,
      layerId: "layer-0",
    },
    {
      type: "line",
      id: "ent4",
      a: { x: 72.57688814559197, y: 572.3081585846584 },
      b: { x: 72.42311185440803, y: -159.23067286957658 },
      isConstruction: true,
      layerId: "layer-0",
    },
    {
      type: "line",
      id: "ent5",
      a: { x: 50.0000000657602, y: 108.15292817367549 },
      b: { x: 80.00000004140456, y: 108.15292817367549 },
      isConstruction: true,
      layerId: "layer-0",
    },
    {
      type: "line",
      id: "ent6",
      a: { x: 49.98203537831353, y: 132.1529281736755 },
      b: { x: 79.98125410293027, y: 132.1529281736755 },
      isConstruction: true,
      layerId: "layer-0",
    },
    {
      type: "line",
      id: "ent7",
      a: { x: 50.012939880789766, y: 84.15292817367549 },
      b: { x: 80.00373808945925, y: 84.15292817367549 },
      isConstruction: true,
      layerId: "layer-0",
    },
    {
      type: "circle",
      id: "ent8",
      center: { x: 79.70195041258322, y: 110.00027258640107 },
      radius: 19,
      isConstruction: false,
      layerId: "layer-0",
    },
    {
      type: "circle",
      id: "ent9",
      center: { x: 72.48436340737231, y: 132.1529281736755 },
      radius: 1.5000002996137602,
      isConstruction: false,
      layerId: "layer-0",
    },
    {
      type: "circle",
      id: "ent10",
      center: { x: 72.47427335929906, y: 84.15292817367549 },
      radius: 1.5000000000000897,
      isConstruction: false,
      layerId: "layer-0",
    },
  ],
  constraints: [
    { id: "con2578", type: "vertical", points: [], entities: ["ent3"] },
    { id: "con3635", type: "horizontal", points: [], entities: ["ent5"] },
    { id: "con3657", type: "horizontal", points: [], entities: ["ent6"] },
    { id: "con3664", type: "horizontal", points: [], entities: ["ent7"] },
    { id: "con3808", type: "pointOnLine", points: [{ entityId: "ent8", key: "c" }], entities: ["ent3"] },
    { id: "con4650", type: "pointOnLine", points: [{ entityId: "ent9", key: "c" }], entities: ["ent4"] },
    { id: "con4676", type: "pointOnLine", points: [{ entityId: "ent9", key: "c" }], entities: ["ent6"] },
    { id: "con4727", type: "pointOnLine", points: [{ entityId: "ent10", key: "c" }], entities: ["ent4"] },
    { id: "con4960", type: "pointOnLine", points: [{ entityId: "ent10", key: "c" }], entities: ["ent7"] },
  ],
  dimensions: [
    {
      id: "dim273",
      type: "line-distance",
      points: [],
      entities: ["ent3", "ent4"],
      value: 7.2,
      driving: true,
      offset: 112.63611964667484,
      anchors: [0.5, 0.5],
    },
    {
      id: "dim357",
      type: "horizontal",
      points: [{ entityId: "ent4", key: "mid" }, { entityId: "__stock__", key: "mid_l" }],
      entities: [],
      value: 22.5,
      driving: true,
      offset: -50.89999999794287,
    },
    {
      id: "dim529",
      type: "line-distance",
      points: [],
      entities: ["ent6", "ent5"],
      value: 24,
      driving: true,
      offset: 11,
      anchors: [0.15899643418190812, 0.14300825312908738],
      expr: "Drill_Distance / 2",
    },
    {
      id: "dim683",
      type: "line-distance",
      points: [],
      entities: ["ent6", "ent7"],
      value: 48,
      driving: true,
      offset: 50.13660724633828,
      anchors: [0.3440033880652024, 0.3051747616603836],
      expr: "Drill_Distance",
    },
  ],
  variables: [
    { id: "var1", name: "Cup_Diameter", expr: "38", value: 38 },
    { id: "var2", name: "Drill_Diameter", expr: "3", value: 3 },
    { id: "var3", name: "Drill_Distance", expr: "48", value: 48 },
  ],
  bindings: [
    { id: "bind1", entityId: "ent8", scalarKey: "r", expr: "Cup_Diameter / 2" },
    { id: "bind2", entityId: "ent10", scalarKey: "r", expr: "Drill_Diameter / 2" },
    { id: "bind3", entityId: "ent9", scalarKey: "r", expr: "Drill_Diameter / 2" },
  ],
  patterns: [],
  operations: [],
  tools: [],
};

describe("User Cabinet Hinge Bore Document test", () => {
  it("constrains ent5.b to ent3 (right vertical line)", () => {
    const doc = new CADDocument({ width: 963.6, height: 963.6 });
    const snap = doc.snapshot();
    doc.restore({
      ...snap,
      ...userDocJson,
    } as any);

    // Ent5 is middle horizontal line: a=(50, 108.153), b=(80, 108.153)
    // Ent3 is right vertical line at X=79.702
    doc.selectedPoints = [{ entityId: "ent5", key: "b" }];
    const ent3 = doc.entities.find((e) => e.id === "ent3")!;
    ent3.selected = true;

    const build = buildConstraintsFor("pointOnLine", doc);
    console.log("Build Result for ent5.b on ent3:", build);

    expect(build.ok).toBe(true);
    if (!build.ok) return;

    seedConstraintPoints(doc, build.constraints);
    for (const c of build.constraints) doc.addConstraint(c);

    const res = solve(doc);
    console.log("Solve Result:", res);

    const ent5 = doc.entities.find((e) => e.id === "ent5") as LineEntity;
    console.log("ent5 new position:", ent5.a, ent5.b);
    console.log("ent3 new position:", ent3.bounds());

    expect(res.converged).toBe(true);
  });
});
