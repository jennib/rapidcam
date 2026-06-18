import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import {
  LineEntity, CircleEntity, RectEntity, PolylineEntity, ArcEntity, BezierEntity, TextEntity, type Entity,
} from "../src/model/entities";
import { makeConstraint } from "../src/model/constraints";
import { makeDimension } from "../src/model/dimensions";
import { makeVariable } from "../src/model/variables";
import { makeCircularPattern, computeSourceSnapshot, type CircularPatternParams } from "../src/model/patterns";
import { applyRotate } from "../src/core/transform";
import { serializeDoc, applyFile } from "../src/io/fileio";
import type { CAMOperation } from "../src/cam/types";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getFont, loadFromFile, registerEmbeddedFont, isFontResolvable } from "../src/core/fontManager";

/**
 * Round-trip fidelity: a document exercising every persisted feature must
 * survive serialize -> deserialize unchanged. We compare doc.snapshot() before
 * and after (NOT serialize->serialize, which would mask a field that's dropped
 * uniformly at save time).
 */
function buildKitchenSink(): CADDocument {
  const doc = new CADDocument({ width: 200, height: 150 }, "in");
  doc.stockThickness = 12;
  doc.hasToolChanger = true;
  doc.origin = { x: "center", y: "center", z: "bed" };
  doc.postProcessor = "grbl";

  // Custom layer + make it active.
  doc.layers.push({ id: "layer-1", name: "Cuts", color: "#ff3344", visible: false, locked: true });
  doc.activeLayerId = "layer-1";

  // One of every entity type.
  const line = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 40, y: 0 }));
  const circle = doc.add(new CircleEntity({ x: 60, y: 30 }, 8));
  const rect = doc.add(new RectEntity({ x: 80, y: 20 }, { x: 120, y: 50 }));
  const poly = doc.add(new PolylineEntity([{ x: 0, y: 60 }, { x: 20, y: 60 }, { x: 20, y: 80 }], true));
  const arc = doc.add(new ArcEntity({ x: 120, y: 100 }, 10, 0, Math.PI / 2));
  doc.add(new BezierEntity({ x: 0, y: 100 }, { x: 10, y: 110 }, { x: 20, y: 110 }, { x: 30, y: 100 }));
  const text = doc.add(new TextEntity("Hi", "roboto-regular", 10, { x: 140, y: 10 }, 0.25));

  // Entity flags that must persist.
  (line as LineEntity).isConstruction = true;
  text.layerId = "layer-1";

  // Constraints covering points / entities / params.
  doc.addConstraint(makeConstraint("horizontal", { entities: [line.id] }));
  doc.addConstraint(makeConstraint("fixedPoint", { points: [{ entityId: circle.id, key: "c" }], params: [60, 30] }));
  doc.addConstraint(makeConstraint("equal", { entities: [circle.id, arc.id] }));

  // Dimensions: a plain one, a diameter, and a variable-driven (expr) reference dim.
  doc.addDimension(makeDimension("distance", {
    points: [{ entityId: line.id, key: "a" }, { entityId: line.id, key: "b" }],
    value: 40, offset: 10,
  }));
  doc.addDimension(makeDimension("diameter", { entities: [circle.id], value: 16, offset: 1, expr: "dia" }));
  doc.addDimension(makeDimension("radius", { entities: [arc.id], value: 10, offset: 0.5, driving: false }));

  // Variables.
  doc.variables.push(makeVariable("dia", "16", "mm"));
  doc.variables.push(makeVariable("w", "100mm", "mm"));

  // Group.
  doc.groups.push({ id: "grp1", name: "frame", entityIds: [line.id, rect.id] });

  // Circular pattern of the circle.
  const params: CircularPatternParams = { count: 4, cx: 60, cy: 30, totalAngle: Math.PI * 2 };
  const step = params.totalAngle / params.count;
  const instanceIds: string[][] = [];
  for (let k = 1; k < params.count; k++) {
    const copies: Entity[] = [circle.duplicate()];
    applyRotate(copies, params.cx, params.cy, k * step);
    const ids: string[] = [];
    for (const c of copies) { doc.add(c); ids.push(c.id); }
    instanceIds.push(ids);
  }
  doc.addPattern(makeCircularPattern([circle.id], instanceIds, params, computeSourceSnapshot(doc.entities, [circle.id])));

  // Embedded tool library + an operation that references it by toolId.
  doc.tools.push({
    id: "tool-em-6", name: "6mm End Mill", toolType: "end-mill", diameter: 6,
    feedrate: 900, plungeRate: 250, spindleSpeed: 18000, safeZ: 5,
  });

  // CAM operation with the nested optional shapes.
  const op: CAMOperation = {
    id: "op1", name: "Profile", type: "profile", entityIds: [rect.id], side: "outside",
    toolId: "tool-em-6",
    toolType: "end-mill", toolNumber: 2, diameter: 6, feedrate: 900, plungeRate: 250,
    spindleSpeed: 18000, safeZ: 5, depth: -12, stepdown: 2.5, stepover: 0.4,
    tabs: { enabled: true, count: 4, width: 6, height: 2 },
    leadIn: { type: "arc", length: 3 }, leadOut: { type: "arc", length: 3 },
  };
  doc.operations.push(op);

  return doc;
}

test("a fully-featured document survives a save/load round-trip", () => {
  const doc = buildKitchenSink();
  const before = doc.snapshot();

  const file = serializeDoc(doc, "Kitchen Sink");
  const doc2 = new CADDocument({ width: 1, height: 1 }, "mm");
  applyFile(doc2, file);
  const after = doc2.snapshot();

  expect(after).toEqual(before);
  // displayUnit is persisted as a direct RcamFile field (not part of snapshot()).
  expect(doc2.displayUnit).toBe("in");
});

test("text in a non-bundled font embeds the font and reproduces it on load", async () => {
  // Load a real font as if the user picked it from disk (so it's non-bundled).
  const here = dirname(fileURLToPath(import.meta.url));
  const bytes = readFileSync(join(here, "..", "public", "fonts", "roboto-regular.woff"));
  const fakeFile = {
    name: "user-font.woff",
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as File;
  const { id: fontId } = await loadFromFile(fakeFile);
  expect(fontId.startsWith("font-")).toBe(true);

  const doc = new CADDocument({ width: 100, height: 60 }, "mm");
  doc.add(new TextEntity("Hi", fontId, 10, { x: 10, y: 10 }, 0));

  const file = serializeDoc(doc, "Fonted");
  // The non-bundled font is embedded with its bytes.
  expect(file.fonts).toHaveLength(1);
  expect(file.fonts![0].id).toBe(fontId);
  expect(file.fonts![0].format).toBe("woff");
  const decoded = Buffer.from(file.fonts![0].data, "base64");
  expect(decoded.byteLength).toBe(bytes.byteLength);

  // Re-registering under a fresh id (simulating a load on a clean machine)
  // parses the embedded bytes back into a usable font.
  const freshId = `font-clean-${Date.now()}`;
  expect(getFont(freshId)).toBeNull();
  registerEmbeddedFont({ ...file.fonts![0], id: freshId });
  expect(getFont(freshId)).not.toBeNull();
});

test("bundled fonts are referenced by id, never embedded", () => {
  const doc = new CADDocument({ width: 100, height: 60 }, "mm");
  doc.add(new TextEntity("Hi", "roboto-regular", 10, { x: 10, y: 10 }, 0));
  const file = serializeDoc(doc, "Bundled");
  expect(file.fonts).toBeUndefined();
});

test("isFontResolvable: bundled always, registered yes, unknown no", async () => {
  // Bundled ids resolve even when their async load hasn't run (node test env).
  expect(isFontResolvable("roboto-regular")).toBe(true);
  // An unknown id (e.g. a hand-authored file naming a font it never embedded).
  expect(isFontResolvable("font-deadbeef")).toBe(false);
  // A registered user font resolves.
  const here = dirname(fileURLToPath(import.meta.url));
  const bytes = readFileSync(join(here, "..", "public", "fonts", "roboto-regular.woff"));
  const { id } = await loadFromFile({
    name: "u.woff",
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as File);
  expect(isFontResolvable(id)).toBe(true);
});
