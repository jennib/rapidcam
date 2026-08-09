/**
 * Drift guard for the published v3 .rcam format.
 *
 * Validates every bundled example project against public/schema/rcam-v3.schema.json.
 * If the format changes, either the schema or the examples must be updated to
 * match — this test forces them to stay in sync. It also doubles as a contract
 * test for external authors (including AIs) generating .rcam files from the
 * published schema.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020";
import { describe, expect, it } from "vitest";
import type { CAMOperation, ToolDef } from "../src/cam/types";
import { registerEmbeddedImage } from "../src/core/imageManager";
import { applyFile, serializeDoc } from "../src/io/fileio";
import { CONSTRAINT_GLYPH } from "../src/model/constraints";
import { makeDimension } from "../src/model/dimensions";
import { CADDocument, isRotary, MACHINE_KINDS } from "../src/model/document";
import {
  ArcEntity,
  BezierEntity,
  CircleEntity,
  LineEntity,
  PolylineEntity,
  RasterImageEntity,
  RectEntity,
  TextEntity,
} from "../src/model/entities";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const schemaPath = join(repoRoot, "public", "schema", "rcam-v3.schema.json");
const examplesDir = join(repoRoot, "examples");

const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

const exampleFiles = readdirSync(examplesDir).filter((f) => f.endsWith(".rcam"));

describe("rcam v3 schema", () => {
  it("finds the bundled examples", () => {
    expect(exampleFiles.length).toBeGreaterThan(0);
  });

  // Parity guard: every ConstraintType the code knows must be in the schema's
  // constraint enum (else a file that uses it fails validation), and the schema
  // must not enumerate a type the code doesn't implement. CONSTRAINT_GLYPH is a
  // Record<ConstraintType, string>, so TypeScript keeps its keys exhaustive —
  // it's the runtime source of truth for the full type list. (A missing `center`
  // enum entry is exactly the drift this catches.)
  it("constraint type enum matches ConstraintType in code (both directions)", () => {
    const schemaTypes = new Set<string>(schema.$defs.constraint.properties.type.enum);
    const codeTypes = new Set(Object.keys(CONSTRAINT_GLYPH));
    expect([...codeTypes].filter((t) => !schemaTypes.has(t))).toEqual([]); // missing in schema
    expect([...schemaTypes].filter((t) => !codeTypes.has(t))).toEqual([]); // stale in schema
  });

  for (const file of exampleFiles) {
    it(`validates ${file} against the v3 schema`, () => {
      const data = JSON.parse(readFileSync(join(examplesDir, file), "utf8"));
      const ok = validate(data);
      if (!ok) {
        const msg = (validate.errors ?? [])
          .map((e) => `  ${e.instancePath || "<root>"} ${e.message}`)
          .join("\n");
        throw new Error(`${file} does not match rcam-v3 schema:\n${msg}`);
      }
      expect(ok).toBe(true);
    });
  }

  it("rejects a file with the wrong version", () => {
    expect(validate({ ...minimalDoc(), version: 1 })).toBe(false);
    expect(validate({ ...minimalDoc(), version: 2 })).toBe(false);
    expect(validate({ ...minimalDoc(), version: 4 })).toBe(false);
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
    doc.patterns = [
      {
        id: "pat1",
        kind: "linear",
        sourceIds: ["l"],
        instanceIds: [["l-c1"], ["l-c2"]],
        params: { countX: 3, countY: 1, spacingX: 20, spacingY: 20, countXExpr: "n" },
      },
    ];
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
    doc.dimensions = [
      // radius dim uses only entities — no `points`
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
    doc.operations = [
      camOp({
        peckDepth: 2,
        coolant: "flood",
        finishPass: true,
        finishAllowance: 0.2,
      }),
    ];
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
    doc.operations = [
      camOp({
        type: "chamfer",
        toolType: "v-bit",
        vAngle: 60,
        chamferWidth: 3,
        chamferSide: "outside",
        sharpenCorners: true,
      }),
    ];
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
describe("rcam v3 schema — serialized real document", () => {
  it("validates a serializeDoc() output covering every op type and optional field", () => {
    const data = serializeDoc(kitchenSinkDoc(), "kitchen-sink");
    const ok = validate(data);
    if (!ok) {
      const msg = (validate.errors ?? [])
        .map((e) => `  ${e.instancePath || "<root>"} ${e.message}`)
        .join("\n");
      throw new Error(`serialized kitchen-sink doc does not match rcam-v3 schema:\n${msg}`);
    }
    expect(ok).toBe(true);
  });

  it("emits the tool referenced by toolId (and only referenced tools)", () => {
    const data = serializeDoc(kitchenSinkDoc(), "kitchen-sink") as { tools?: unknown[] };
    expect((data.tools ?? []).map((t: any) => t.id)).toEqual(["tool1"]);
  });

  // Drift guard for the parametric/metadata/image additions (the kitchen-sink
  // above only covers CAM). Serializes a doc exercising: variable-to-variable
  // formulas, a scalar binding, a hidden driving dimension, an image entity with
  // formula fields + flip + aspectLocked (and an embedded image), and metadata.
  // Coverage the bundled examples lack: bezier, non-empty `groups`, a non-default
  // `layer`, construction geometry, and a polyline carrying `polygon` + `vertexIds`.
  // (`point` is intentionally excluded — it's origin-only, filtered from save, and
  // no longer in the schema.)
  it("validates a serializeDoc() output covering every serializable entity type + optional fields", () => {
    const data = serializeDoc(allEntityTypesDoc(), "all-entities");
    const ok = validate(data);
    if (!ok) {
      const msg = (validate.errors ?? [])
        .map((e) => `  ${e.instancePath || "<root>"} ${e.message}`)
        .join("\n");
      throw new Error(`serialized all-entities doc does not match rcam-v3 schema:\n${msg}`);
    }
    expect(ok).toBe(true);
  });

  it("validates a serializeDoc() output covering the parametric + image + metadata fields", () => {
    const data = serializeDoc(parametricDoc(), "parametric");
    const ok = validate(data);
    if (!ok) {
      const msg = (validate.errors ?? [])
        .map((e) => `  ${e.instancePath || "<root>"} ${e.message}`)
        .join("\n");
      throw new Error(`serialized parametric doc does not match rcam-v3 schema:\n${msg}`);
    }
    expect(ok).toBe(true);
  });

  // Enum/flag tripwires. The sample docs above can only cover the values they
  // happen to use, so a value added in TypeScript but forgotten in the schema
  // slips through — which is exactly what happened once before: the rotary
  // refactor left `machineKind` at ["mill","laser"] and every rotary .rcam
  // failed validation. These enumerate the code's own possibilities, so the
  // schema cannot fall behind no matter what is added next.
  it("every MachineKind in the TS union is accepted by the schema", () => {
    for (const [kind] of MACHINE_KINDS) {
      const doc = new CADDocument({ width: 100, height: 100 });
      doc.machineKind = kind;
      // A rotary kind needs its cylinder block; a beam needs a laser post.
      if (isRotary(kind)) doc.rotary = { axisWord: "A", diameter: 30, wrapAxis: "y" };
      const data = serializeDoc(doc, `kind-${kind}`);
      const ok = validate(data);
      const msg = (validate.errors ?? [])
        .map((e) => `  ${e.instancePath || "<root>"} ${e.message}`)
        .join("\n");
      expect(ok, `machineKind "${kind}" rejected by the schema:\n${msg}`).toBe(true);
    }
  });

  it("every image constraint-permission combination is accepted by the schema", () => {
    for (const resize of [false, true]) {
      for (const rotate of [false, true]) {
        const doc = new CADDocument({ width: 100, height: 100 });
        const img = doc.add(new RasterImageEntity("img-fit", { x: 0, y: 0 }, 20, 10, 0));
        img.constraintResize = resize;
        img.constraintRotate = rotate;
        const label = `resize=${resize} rotate=${rotate}`;
        const data = serializeDoc(doc, "fit") as {
          entities: { type: string; constraintResize?: boolean; constraintRotate?: boolean }[];
        };
        const ok = validate(data);
        const msg = (validate.errors ?? [])
          .map((e) => `  ${e.instancePath || "<root>"} ${e.message}`)
          .join("\n");
        expect(ok, `${label} rejected by the schema:\n${msg}`).toBe(true);
        // False is the rigid default and is deliberately omitted, so an image
        // that nobody has unlocked serializes exactly as it always did.
        const e = data.entities.find((x) => x.type === "image")!;
        expect([e.constraintResize, e.constraintRotate], label).toEqual([
          resize || undefined,
          rotate || undefined,
        ]);
      }
    }
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
    file.dimensions = [
      { id: "d1", type: "radius", entities: ["ent1"], value: 10, driving: true, offset: 5 },
    ];
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
  const outer = doc.add(
    new PolylineEntity(
      [
        { x: 10, y: 10 },
        { x: 90, y: 10 },
        { x: 90, y: 90 },
        { x: 10, y: 90 },
      ],
      true,
    ),
  );
  const island = doc.add(
    new PolylineEntity(
      [
        { x: 40, y: 40 },
        { x: 60, y: 40 },
        { x: 60, y: 60 },
        { x: 40, y: 60 },
      ],
      true,
    ),
  );

  // A library tool referenced by one op's toolId — exercises the tools array
  // (and the used-tools filter) in serializeDoc.
  const tool: ToolDef = {
    id: "tool1",
    name: "6mm flat",
    toolType: "end-mill",
    diameter: 6,
    vAngle: 60,
    tipDiameter: 0.5,
    tipAngle: 118,
    feedrate: 1000,
    plungeRate: 300,
    spindleSpeed: 18000,
    safeZ: 5,
  };
  doc.tools.push(tool);

  const base = {
    toolNumber: 1,
    diameter: 6,
    feedrate: 1000,
    plungeRate: 300,
    spindleSpeed: 18000,
    safeZ: 5,
    depth: -5,
    stepdown: 1.5,
    stepover: 0.4,
  };

  const ops: CAMOperation[] = [
    {
      // profile: side, toolId, coolant, finishPass/allowance, tabs, leads
      id: "op-profile",
      name: "Profile",
      type: "profile",
      entityIds: [outer.id],
      side: "outside",
      toolId: "tool1",
      toolType: "end-mill",
      ...base,
      coolant: "flood",
      finishPass: true,
      finishAllowance: 0.3,
      tabs: { enabled: true, count: 4, width: 5, height: 1 },
      leadIn: { type: "arc", length: 4 },
      leadOut: { type: "linear", length: 4 },
      // Parametric CAM fields: raw expressions driving numeric op params,
      // re-evaluated against variables/stock on every solve.
      paramExprs: { depth: "-stock", feedrate: "1000 * 1.2" },
    },
    {
      // engrave
      id: "op-engrave",
      name: "Engrave",
      type: "engrave",
      entityIds: [outer.id],
      side: "outside",
      toolType: "v-bit",
      vAngle: 30,
      ...base,
    },
    {
      // drill: peckDepth, tipAngle, coolant
      id: "op-drill",
      name: "Drill",
      type: "drill",
      entityIds: [circle.id],
      side: "outside",
      toolType: "drill",
      tipAngle: 118,
      ...base,
      peckDepth: 2,
      coolant: "mist",
    },
    {
      // pocket: pocketStrategy, islandIds, regions
      id: "op-pocket",
      name: "Pocket",
      type: "pocket",
      entityIds: [outer.id],
      side: "inside",
      toolType: "end-mill",
      ...base,
      // Every value of the enum has to appear on a kitchen-sink doc or the
      // drift guard never sees it: the schema is additionalProperties:false, so
      // an enum the app can emit but the schema doesn't list breaks the app's
      // own validators while still loading.
      pocketStrategy: "adaptive",
      restToolDiameter: 8,
      islandIds: [island.id],
      regions: [{ containingLoops: [[outer.id]] }],
      finishPass: true,
      finishAllowance: 0.25,
    },
    {
      // face: faceTarget, faceOverhang, faceDirection. Carries NO entityIds —
      // facing takes its extent from the blank or the bed — which is itself
      // worth round-tripping.
      id: "op-face",
      name: "Face",
      type: "face",
      entityIds: [],
      side: "inside",
      toolType: "end-mill",
      ...base,
      faceTarget: "bed",
      faceOverhang: 2,
      faceDirection: "y",
    },
    {
      // chamfer: vAngle, tipDiameter, chamferWidth/Side, sharpenCorners
      id: "op-chamfer",
      name: "Chamfer",
      type: "chamfer",
      entityIds: [outer.id],
      side: "outside",
      toolType: "v-bit",
      vAngle: 60,
      tipDiameter: 0.5,
      ...base,
      chamferWidth: 3,
      chamferSide: "inside",
      sharpenCorners: true,
    },
  ];
  doc.operations.push(...ops);
  // Cylindrical/rotary wrap setup — exercises the serialized `rotary` block.
  doc.rotary = { axisWord: "A", diameter: 63.5, wrapAxis: "y", arcTolerance: 0.05 };
  return doc;
}

/**
 * One of every entity type, plus optional fields the bundled examples miss:
 * construction geometry, a non-default layer, a group, and a polyline carrying
 * both `polygon` params and `vertexIds`.
 */
function allEntityTypesDoc(): CADDocument {
  const doc = new CADDocument({ width: 300, height: 300 });
  doc.layers.push({ id: "layer-1", name: "Cuts", color: "#ff3333", visible: true, locked: false });
  // A layer beam recipe, every field populated. The layer object is
  // additionalProperties:false, so a wrong key here would reject files the app
  // itself writes — and the schema is the contract external authors (and AIs)
  // generate .rcam from.
  doc.layers.push({
    id: "layer-beam",
    name: "Score",
    color: "#e05a5a",
    visible: true,
    locked: false,
    laser: {
      kind: "cut",
      side: "inside",
      feedrate: 300,
      laserPower: 100,
      laserPasses: 3,
      kerfWidth: 0.2,
      airAssist: true,
    },
  });
  // A workholding layer carrying its own default height, plus a clamp that
  // OVERRIDES it — the per-entity `fixtureHeight` only appears in the serialized
  // output when something sets it, so the schema guard is blind to it otherwise.
  doc.layers.push({
    id: "layer-clamps",
    name: "Workholding",
    color: "#e0a555",
    visible: true,
    locked: false,
    fixture: true,
    fixtureHeight: 20,
  });
  const line = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 20, y: 0 }));
  line.isConstruction = true;
  line.layerId = "layer-1";
  doc.add(new CircleEntity({ x: 40, y: 40 }, 6));
  doc.add(new RectEntity({ x: 60, y: 60 }, { x: 90, y: 85 }));
  const clamp = doc.add(new RectEntity({ x: 0, y: 200 }, { x: 60, y: 240 }));
  clamp.layerId = "layer-clamps";
  clamp.fixtureHeight = 12;
  doc.add(new ArcEntity({ x: 120, y: 120 }, 10, 0, Math.PI / 2));
  doc.add(
    new BezierEntity({ x: 0, y: 100 }, { x: 10, y: 130 }, { x: 30, y: 130 }, { x: 40, y: 100 }),
  );
  const poly = new PolylineEntity(
    [
      { x: 150, y: 150 },
      { x: 174, y: 150 },
      { x: 162, y: 171 },
    ],
    true,
    undefined,
    ["va", "vb", "vc"],
  );
  poly.polygon = { sides: 3, center: { x: 162, y: 157 }, radius: 12, rotation: 0 };
  doc.add(poly);
  doc.add(new TextEntity("Hi", "roboto-regular", 10, { x: 200, y: 200 }, 0.2));
  doc.groups.push({ id: "grp1", name: "Group A", entityIds: [line.id] });
  return doc;
}

/**
 * A document exercising every parametric / metadata / image format addition,
 * built and serialized through the production path.
 */
function parametricDoc(): CADDocument {
  const doc = new CADDocument({ width: 200, height: 200 });
  doc.metadata = { job: "J-100", revision: "A", notes: "anodize after cut" };
  doc.variables.push({ id: "v1", name: "plateW", expr: "120", value: 120 });
  doc.variables.push({ id: "v2", name: "margin", expr: "plateW * 0.1", value: 12 }); // var-to-var

  const c = doc.add(new CircleEntity({ x: 50, y: 50 }, 10));
  doc.bindings.push({ id: "b1", entityId: c.id, scalarKey: "r", expr: "plateW/2", scale: 1 });

  const l = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 50, y: 0 }));
  doc.dimensions.push(
    makeDimension("distance", {
      points: [
        { entityId: l.id, key: "a" },
        { entityId: l.id, key: "b" },
      ],
      value: 50,
      offset: 0,
      driving: true,
      expr: "margin",
      hidden: true, // hidden driving dim
    }),
  );

  registerEmbeddedImage({
    id: "img-p",
    name: "p",
    width: 2,
    height: 2,
    data: btoa(String.fromCharCode(0, 255, 255, 0)),
  });
  const img = new RasterImageEntity("img-p", { x: 10, y: 10 }, 40, 20, 0.3, true, false);
  img.aspectLocked = true;
  doc.add(img);
  // Image size/rotation formulas are ordinary scalar bindings (like circle radius).
  doc.bindings.push(
    { id: "b2", entityId: img.id, scalarKey: "w", expr: "plateW" },
    { id: "b3", entityId: img.id, scalarKey: "h", expr: "plateW/2" },
    { id: "b4", entityId: img.id, scalarKey: "angle", expr: "margin", scale: Math.PI / 180 },
  );

  // A re-editable generator feature carrying BOTH optional maps: `paramExprs`
  // (expression per param) and `keyIds` (stable key → entity id). No bundled
  // example has a `features` array, so this is the only schema coverage the
  // feature object gets — the fields llms.txt tells external authors to emit.
  const featLine = doc.add(new LineEntity({ x: 0, y: 80 }, { x: 60, y: 80 }));
  doc.groups.push({ id: "grp-feat", name: "Box joint", entityIds: [featLine.id] });
  doc.features.push({
    id: "feat1",
    generatorId: "box-joint",
    params: { width: 120, fingers: 5 },
    paramExprs: { width: "plateW" },
    keyIds: { "front-wall": featLine.id },
    groupId: "grp-feat",
    offset: { x: 5, y: 5 },
  });
  return doc;
}

/** A schema-complete CAM operation with all required fields, plus `extra`. */
function camOp(extra: Record<string, unknown>): any {
  return {
    id: "op1",
    name: "Op",
    type: "profile",
    entityIds: ["ent1"],
    side: "outside",
    toolType: "end-mill",
    toolNumber: 1,
    diameter: 6,
    feedrate: 900,
    plungeRate: 250,
    spindleSpeed: 18000,
    safeZ: 5,
    depth: -3,
    stepdown: 1.5,
    stepover: 0.4,
    ...extra,
  };
}

/** Smallest document an external author must emit for a valid v3 file. */
function minimalDoc(): any {
  return {
    version: 3,
    name: "Minimal",
    canvas: { width: 100, height: 100 },
    displayUnit: "mm",
    entities: [{ type: "circle", id: "ent1", center: { x: 50, y: 50 }, radius: 10 }],
    constraints: [],
    dimensions: [],
  };
}
