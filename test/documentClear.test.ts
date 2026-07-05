import { test, expect } from "vitest";
import { CADDocument, ORIGIN_ENTITY_ID } from "../src/model/document";
import { RectEntity } from "../src/model/entities";
import type { CAMOperation } from "../src/cam/types";

// Regression guard for the "New Project inherits the old drawing's CAM state"
// bug: clear() must reset EVERY mutable field, not just geometry. If a new
// persisted field is added to the document without being reset in clear(), this
// test should fail (add the field below when you add it to snapshot()).
test("clear() resets every mutable document field", () => {
  const doc = new CADDocument({ width: 100, height: 100 });

  // Populate everything a real project could carry.
  const rect = new RectEntity({ x: 0, y: 0 }, { x: 50, y: 50 });
  doc.add(rect);
  doc.constraints.push({ id: "c1", type: "horizontal", points: [], entities: [rect.id] } as any);
  doc.dimensions.push({ id: "d1", type: "distance", points: [], entities: [rect.id], value: 50 } as any);
  doc.variables.push({ id: "v1", name: "pcd", expr: "80", value: 80 } as any);
  doc.bindings.push({ id: "b1", entityId: rect.id, scalarKey: "w", expr: "pcd" } as any);
  doc.groups.push({ id: "g1", name: "grp", entityIds: [rect.id] });
  doc.patterns.push({ id: "pat1", type: "linear", sourceIds: [rect.id], instanceIds: [], params: {} } as any);
  doc.layers.push({ id: "layer-1", name: "Extra", color: "#fff", visible: true, locked: false });
  doc.activeLayerId = "layer-1";
  const op: CAMOperation = {
    id: "op1", name: "cut", type: "profile", entityIds: [rect.id], side: "outside",
    toolType: "end-mill", toolNumber: 1, diameter: 6, feedrate: 1000, plungeRate: 300,
    spindleSpeed: 18000, safeZ: 5, depth: -3, stepdown: 1.5, stepover: 0.4,
  };
  doc.operations.push(op);
  doc.tools.push({ id: "t1", name: "6mm", type: "end-mill", diameter: 6 } as any);
  doc.endPosition = { x: 0, y: 0 };
  doc.metadata = { job: "Bracket", revision: "A", notes: "n" };
  doc.isConstructionMode = true;
  doc.toolpathHighlightIds = new Set([rect.id]);
  doc.toolpathHighlightColor = "#f00";

  doc.clear();

  // Geometry: only the origin point survives.
  expect(doc.entities).toHaveLength(1);
  expect(doc.entities[0].id).toBe(ORIGIN_ENTITY_ID);

  expect(doc.constraints).toEqual([]);
  expect(doc.dimensions).toEqual([]);
  expect(doc.variables).toEqual([]);
  expect(doc.bindings).toEqual([]);
  expect(doc.groups).toEqual([]);
  expect(doc.patterns).toEqual([]);
  expect(doc.operations).toEqual([]);
  expect(doc.tools).toEqual([]);
  expect(doc.metadata).toEqual({});
  expect(doc.endPosition).toBeNull();
  expect(doc.isConstructionMode).toBe(false);

  // Layers reset to the single default layer.
  expect(doc.layers).toHaveLength(1);
  expect(doc.layers[0].id).toBe("layer-0");
  expect(doc.activeLayerId).toBe("layer-0");

  // Transient highlight/region state cleared.
  expect(doc.toolpathHighlightIds).toBeNull();
  expect(doc.toolpathHighlightColor).toBeNull();
  expect(doc.regionPickHandler).toBeNull();
});
