/**
 * Drift guard for the published v2 .rcam format.
 *
 * Validates every bundled example project against public/schema/rcam-v2.schema.json.
 * If the format changes, either the schema or the examples must be updated to
 * match — this test forces them to stay in sync. It also doubles as a contract
 * test for external authors (including AIs) generating .rcam files from the
 * published schema.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { CADDocument } from "../src/model/document";
import { CircleEntity, PolylineEntity } from "../src/model/entities";
import { serializeDoc, applyFile } from "../src/io/fileio";
import type { CAMOperation, ToolDef } from "../src/cam/types";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const schemaPath = join(repoRoot, "public", "schema", "rcam-v2.schema.json");
const examplesDir = join(repoRoot, "examples");

const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

const exampleFiles = readdirSync(examplesDir).filter((f) => f.endsWith(".rcam"));

describe("rcam v2 schema", () => {
  it("finds the bundled examples", () => {
    expect(exampleFiles.length).toBeGreaterThan(0);
  });

  for (const file of exampleFiles) {
    it(`validates ${file} against the v2 schema`, () => {
      const data = JSON.parse(readFileSync(join(examplesDir, file), "utf8"));
      const ok = validate(data);
      if (!ok) {
        const msg = (validate.errors ?? [])
          .map((e) => `  ${e.instancePath || "<root>"} ${e.message}`)
          .join("\n");
        throw new Error(`${file} does not match rcam-v2 schema:\n${msg}`);
      }
      expect(ok).toBe(true);
    });
  }

  it("rejects a file with the wrong version", () => {
    expect(validate({ ...minimalDoc(), version: 1 })).toBe(false);
    expect(validate({ ...minimalDoc(), version: 3 })).toBe(false);
  });

  it("rejects an entity carrying the dropped UI `selected` field", () => {
    const doc = minimalDoc();
    doc.entities[0].selected = false;
    expect(validate(doc)).toBe(false);
  });

  it("accepts pattern params carrying a count expression", () => {
    const doc = minimalDoc();
    doc.variables = [{ id: "v", name: "n", expr: "3", value: 3 }];
    doc.entities.push({ type: "line", id: "l", a: { x: 0, y: 0 }, b: { x: 10, y: 0 } });
    doc.patterns = [{
      id: "pat1", kind: "linear", sourceIds: ["l"], instanceIds: [["l-c1"], ["l-c2"]],
      params: { countX: 3, countY: 1, spacingX: 20, spacingY: 20, countXExpr: "n" },
    }];
    const ok = validate(doc);
    if (!ok) throw new Error(JSON.stringify(validate.errors, null, 2));
    expect(ok).toBe(true);
  });

  it("rejects an unknown entity type", () => {
    const doc = minimalDoc();
    doc.entities = [{ type: "spline", id: "ent1" }];
    expect(validate(doc)).toBe(false);
  });

  it("accepts a minimal hand-authored document", () => {
    expect(validate(minimalDoc())).toBe(true);
  });

  // points/entities are optional on constraints/dimensions: a type that uses
  // only one operand kind may omit the other array entirely.
  it("accepts a constraint that omits the unused operand array", () => {
    const doc = minimalDoc();
    doc.entities.push({ type: "line", id: "ent2", a: { x: 0, y: 0 }, b: { x: 10, y: 0 } });
    doc.constraints = [{ id: "c1", type: "horizontal", entities: ["ent2"] }]; // no `points`
    const ok = validate(doc);
    if (!ok) throw new Error(JSON.stringify(validate.errors, null, 2));
    expect(ok).toBe(true);
  });

  it("accepts a dimension that omits the unused operand array", () => {
    const doc = minimalDoc();
    doc.dimensions = [ // radius dim uses only entities — no `points`
      { id: "d1", type: "radius", entities: ["ent1"], value: 10, driving: true, offset: 5 },
    ];
    const ok = validate(doc);
    if (!ok) throw new Error(JSON.stringify(validate.errors, null, 2));
    expect(ok).toBe(true);
  });

  // The bundled examples don't exercise the newer per-op CAM fields, so guard
  // them directly: an operation carrying every optional field added recently,
  // plus a top-level endPosition, must validate.
  it("accepts the optional CAM fields (peck, coolant, finishPass/allowance, endPosition)", () => {
    const doc = minimalDoc();
    doc.endPosition = { x: 0, y: 0 };
    doc.operations = [camOp({
      peckDepth: 2, coolant: "flood", finishPass: true, finishAllowance: 0.2,
    })];
    const ok = validate(doc);
    if (!ok) throw new Error(JSON.stringify(validate.errors, null, 2));
    expect(ok).toBe(true);
  });

  it("rejects an operation with an unknown field (schema drift guard)", () => {
    const doc = minimalDoc();
    doc.operations = [camOp({ bogusField: 1 })];
    expect(validate(doc)).toBe(false);
  });

  it("accepts a chamfer operation with its fields", () => {
    const doc = minimalDoc();
    doc.operations = [camOp({ type: "chamfer", toolType: "v-bit", vAngle: 60, chamferWidth: 3, chamferSide: "outside", sharpenCorners: true })];
    const ok = validate(doc);
    if (!ok) throw new Error(JSON.stringify(validate.errors, null, 2));
    expect(ok).toBe(true);
  });
});

/**
 * The above guards hand-authored docs. This block guards the *real save path*:
 * serializeDoc() emits doc.operations and doc.tools verbatim, and the schema is
 * additionalProperties:false. So a document carrying one operation of every type
 * — collectively setting every optional CAM field — serialized through the
 * production path must still validate. If someone adds a field to CAMOperation
 * (and sets it here) without declaring it in the schema, this fails.
 *
 * When you add a new optional field to CAMOperation, set it on the relevant op
 * below so it stays covered.
 */
describe("rcam v2 schema — serialized real document", () => {
  it("validates a serializeDoc() output covering every op type and optional field", () => {
    const data = serializeDoc(kitchenSinkDoc(), "kitchen-sink");
    const ok = validate(data);
    if (!ok) {
      const msg = (validate.errors ?? [])
        .map((e) => `  ${e.instancePath || "<root>"} ${e.message}`)
        .join("\n");
      throw new Error(`serialized kitchen-sink doc does not match rcam-v2 schema:\n${msg}`);
    }
    expect(ok).toBe(true);
  });

  it("emits the tool referenced by toolId (and only referenced tools)", () => {
    const data = serializeDoc(kitchenSinkDoc(), "kitchen-sink") as { tools?: unknown[] };
    expect((data.tools ?? []).map((t: any) => t.id)).toEqual(["tool1"]);
  });
});

/**
 * The schema relaxation is only safe if the real loader matches it: a file whose
 * constraints/dimensions omit the unused operand array must load without throwing
 * (restore() reads points/entities directly).
 */
describe("rcam v2 loader tolerance", () => {
  it("loads constraints/dimensions that omit the unused operand array", () => {
    const file = minimalDoc();
    file.entities.push({ type: "line", id: "ent2", a: { x: 0, y: 0 }, b: { x: 10, y: 0 } });
    file.constraints = [{ id: "c1", type: "horizontal", entities: ["ent2"] }];
    file.dimensions = [{ id: "d1", type: "radius", entities: ["ent1"], value: 10, driving: true, offset: 5 }];
    const doc = new CADDocument({ width: 100, height: 100 });
    expect(() => applyFile(doc, file)).not.toThrow();
    expect(doc.constraints[0].points).toEqual([]);
    expect(doc.dimensions[0].points).toEqual([]);
  });
});

/**
 * A document with one operation of every CAMOpType, between them setting every
 * optional field in the format, built and serialized through the production path.
 */
function kitchenSinkDoc(): CADDocument {
  const doc = new CADDocument({ width: 200, height: 200 });
  const circle = doc.add(new CircleEntity({ x: 50, y: 50 }, 10));
  const outer = doc.add(new PolylineEntity(
    [{ x: 10, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 90 }, { x: 10, y: 90 }], true));
  const island = doc.add(new PolylineEntity(
    [{ x: 40, y: 40 }, { x: 60, y: 40 }, { x: 60, y: 60 }, { x: 40, y: 60 }], true));

  // A library tool referenced by one op's toolId — exercises the tools array
  // (and the used-tools filter) in serializeDoc.
  const tool: ToolDef = {
    id: "tool1", name: "6mm flat", toolType: "end-mill", diameter: 6,
    vAngle: 60, tipDiameter: 0.5, tipAngle: 118,
    feedrate: 1000, plungeRate: 300, spindleSpeed: 18000, safeZ: 5,
  };
  doc.tools.push(tool);

  const base = {
    toolNumber: 1, diameter: 6, feedrate: 1000, plungeRate: 300,
    spindleSpeed: 18000, safeZ: 5, depth: -5, stepdown: 1.5, stepover: 0.4,
  };

  const ops: CAMOperation[] = [
    { // profile: side, toolId, coolant, finishPass/allowance, tabs, leads
      id: "op-profile", name: "Profile", type: "profile", entityIds: [outer.id],
      side: "outside", toolId: "tool1", toolType: "end-mill", ...base,
      coolant: "flood", finishPass: true, finishAllowance: 0.3,
      tabs: { enabled: true, count: 4, width: 5, height: 1 },
      leadIn: { type: "arc", length: 4 }, leadOut: { type: "linear", length: 4 },
    },
    { // engrave
      id: "op-engrave", name: "Engrave", type: "engrave", entityIds: [outer.id],
      side: "outside", toolType: "v-bit", vAngle: 30, ...base,
    },
    { // drill: peckDepth, tipAngle, coolant
      id: "op-drill", name: "Drill", type: "drill", entityIds: [circle.id],
      side: "outside", toolType: "drill", tipAngle: 118, ...base,
      peckDepth: 2, coolant: "mist",
    },
    { // pocket: pocketStrategy, islandIds, regions
      id: "op-pocket", name: "Pocket", type: "pocket", entityIds: [outer.id],
      side: "inside", toolType: "end-mill", ...base,
      pocketStrategy: "raster", islandIds: [island.id],
      regions: [{ containingLoops: [[outer.id]] }],
      finishPass: true, finishAllowance: 0.25,
    },
    { // chamfer: vAngle, tipDiameter, chamferWidth/Side, sharpenCorners
      id: "op-chamfer", name: "Chamfer", type: "chamfer", entityIds: [outer.id],
      side: "outside", toolType: "v-bit", vAngle: 60, tipDiameter: 0.5, ...base,
      chamferWidth: 3, chamferSide: "inside", sharpenCorners: true,
    },
  ];
  doc.operations.push(...ops);
  return doc;
}

/** A schema-complete CAM operation with all required fields, plus `extra`. */
function camOp(extra: Record<string, unknown>): any {
  return {
    id: "op1", name: "Op", type: "profile", entityIds: ["ent1"], side: "outside",
    toolType: "end-mill", toolNumber: 1, diameter: 6, feedrate: 900, plungeRate: 250,
    spindleSpeed: 18000, safeZ: 5, depth: -3, stepdown: 1.5, stepover: 0.4,
    ...extra,
  };
}

/** Smallest document an external author must emit for a valid v2 file. */
function minimalDoc(): any {
  return {
    version: 2,
    name: "Minimal",
    canvas: { width: 100, height: 100 },
    displayUnit: "mm",
    entities: [
      { type: "circle", id: "ent1", center: { x: 50, y: 50 }, radius: 10 },
    ],
    constraints: [],
    dimensions: [],
  };
}
