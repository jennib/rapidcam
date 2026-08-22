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
import { CONSTRAINT_GLYPH, SEGMENT_SEP } from "../src/model/constraints";
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

  it("emits every referenced tool — one per ToolType — and only referenced tools", () => {
    const data = serializeDoc(kitchenSinkDoc(), "kitchen-sink") as { tools?: unknown[] };
    expect((data.tools ?? []).map((t: any) => t.id)).toEqual([
      "tool1",
      "tool-bn",
      "tool-vb",
      "tool-dr",
      "tool-tb",
    ]);
  });

  // Drift guard for the parametric/metadata/image additions (the kitchen-sink
  // above only covers CAM). Serializes a doc exercising: variable-to-variable
  // formulas, a scalar binding, a hidden driving dimension, an image entity with
  // formula fields + flip + aspectLocked (and an embedded image), and metadata.
  // Coverage the bundled examples lack: bezier, non-empty `groups`, a non-default
  // `layer`, construction geometry, and a polyline carrying `polygon`,
  // `vertexIds` and a shaped corner.
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
 * Corner radii are the first field added to an entity since the format was
 * published, so they get their own round trip: old files must still open, new
 * ones must come back identical, and a square rectangle must serialise exactly
 * as it always did (otherwise every existing file gains a diff on next save).
 */
describe("rectangle corner radii round-trip", () => {
  function reopen(doc: CADDocument): CADDocument {
    const file = JSON.parse(JSON.stringify(serializeDoc(doc, "corners")));
    const fresh = new CADDocument({ width: 100, height: 100 });
    applyFile(fresh, file);
    return fresh;
  }

  it("a square rectangle serialises with no corner fields at all", () => {
    const doc = new CADDocument({ width: 100, height: 100 });
    doc.add(new RectEntity({ x: 0, y: 0 }, { x: 50, y: 30 }));
    const data = serializeDoc(doc, "square") as { entities: Record<string, unknown>[] };
    const rect = data.entities.find((e) => e.type === "rectangle")!;
    expect(Object.keys(rect)).not.toContain("cornerRadii");
    expect(Object.keys(rect)).not.toContain("cornerType");
  });

  it("shaped corners survive a save/open cycle", () => {
    const doc = new CADDocument({ width: 100, height: 100 });
    const r = doc.add(new RectEntity({ x: 0, y: 0 }, { x: 50, y: 30 }));
    r.cornerRadii = [5, 0, 2.5, 8];
    r.cornerType = "chamfer";

    const back = reopen(doc).entities.find((e): e is RectEntity => e instanceof RectEntity)!;
    expect(back.cornerRadii).toEqual([5, 0, 2.5, 8]);
    expect(back.cornerType).toBe("chamfer");
    // The boundary is what actually gets cut — compare that, not just the fields.
    expect(back.outlinePoints()).toEqual(r.outlinePoints());
  });

  it("keeps the radius a shrunken rectangle cannot currently draw", () => {
    // effectiveCornerRadii clamps for drawing; the FILE must hold the asked-for
    // value, or saving while temporarily small would destroy the corner.
    const doc = new CADDocument({ width: 100, height: 100 });
    const r = doc.add(new RectEntity({ x: 0, y: 0 }, { x: 6, y: 6 }));
    r.cornerRadii = [8, 8, 8, 8];
    expect(r.effectiveCornerRadii()[0]).toBeCloseTo(3, 9);

    const back = reopen(doc).entities.find((e): e is RectEntity => e instanceof RectEntity)!;
    expect(back.cornerRadii).toEqual([8, 8, 8, 8]);
  });

  it("a file written before corner radii existed loads square", () => {
    const file = minimalDoc();
    file.entities = [{ type: "rectangle", id: "r1", p0: { x: 0, y: 0 }, p1: { x: 10, y: 10 } }];
    expect(validate(file)).toBe(true);
    const doc = new CADDocument({ width: 100, height: 100 });
    applyFile(doc, file);
    const rect = doc.entities.find((e): e is RectEntity => e instanceof RectEntity)!;
    expect(rect.cornerRadii).toEqual([0, 0, 0, 0]);
    expect(rect.cornerType).toBe("round");
    expect(rect.outlinePoints()).toEqual(rect.corners());
  });

  it("survives a hand-authored file with a malformed cornerRadii array", () => {
    // The schema demands four numbers; the LOADER must not produce NaN geometry
    // when it gets something else, because a file that loads wrong is worse
    // than one that is rejected.
    const file = minimalDoc();
    file.entities = [
      {
        type: "rectangle",
        id: "r1",
        p0: { x: 0, y: 0 },
        p1: { x: 10, y: 10 },
        cornerRadii: [2, "x", -3],
        cornerType: "bogus",
      },
    ];
    expect(validate(file), "the schema still rejects it").toBe(false);
    const doc = new CADDocument({ width: 100, height: 100 });
    applyFile(doc, file);
    const rect = doc.entities.find((e): e is RectEntity => e instanceof RectEntity)!;
    expect(rect.cornerRadii).toEqual([2, 0, 0, 0]);
    expect(rect.cornerType).toBe("round");
    for (const p of rect.outlinePoints()) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    }
  });

  it("the schema rejects a negative radius and an unknown corner type", () => {
    const bad = (extra: Record<string, unknown>) => {
      const file = minimalDoc();
      file.entities = [
        { type: "rectangle", id: "r1", p0: { x: 0, y: 0 }, p1: { x: 10, y: 10 }, ...extra },
      ];
      return validate(file);
    };
    expect(bad({ cornerRadii: [1, 2, 3, 4] })).toBe(true); // positive control
    expect(bad({ cornerRadii: [-1, 0, 0, 0] })).toBe(false);
    expect(bad({ cornerRadii: [1, 2, 3] })).toBe(false);
    expect(bad({ cornerType: "rounded" })).toBe(false);
  });
});

/**
 * The polyline half of the same story. Keyed by vertex id rather than by
 * position, which is the part a round trip has to prove: the corner has to come
 * back on the same physical vertex, including after an edit renumbers the array.
 */
describe("polyline corner radii round-trip", () => {
  function reopen(doc: CADDocument): CADDocument {
    const file = JSON.parse(JSON.stringify(serializeDoc(doc, "polycorners")));
    const fresh = new CADDocument({ width: 100, height: 100 });
    applyFile(fresh, file);
    return fresh;
  }
  const square = () =>
    new PolylineEntity(
      [
        { x: 0, y: 0 },
        { x: 40, y: 0 },
        { x: 40, y: 30 },
        { x: 0, y: 30 },
      ],
      true,
    );

  it("a sharp polyline serialises with no corner fields at all", () => {
    const doc = new CADDocument({ width: 100, height: 100 });
    doc.add(square());
    const data = serializeDoc(doc, "sharp") as { entities: Record<string, unknown>[] };
    const pl = data.entities.find((e) => e.type === "polyline")!;
    expect(Object.keys(pl)).not.toContain("cornerRadii");
    expect(Object.keys(pl)).not.toContain("cornerType");
  });

  it("shaped corners survive a save/open cycle", () => {
    const doc = new CADDocument({ width: 100, height: 100 });
    const p = doc.add(square());
    p.cornerRadii.set("1", 5);
    p.cornerRadii.set("3", 2.5);
    p.cornerType = "chamfer";

    const back = reopen(doc).entities.find(
      (e): e is PolylineEntity => e instanceof PolylineEntity,
    )!;
    expect(Object.fromEntries(back.cornerRadii)).toEqual({ "1": 5, "3": 2.5 });
    expect(back.cornerType).toBe("chamfer");
    // The boundary is what actually gets cut — compare that, not just the fields.
    expect(back.outlinePoints()).toEqual(p.outlinePoints());
  });

  it("the corner comes back on the same VERTEX, not the same index", () => {
    // The whole reason for keying by id. Insert a vertex ahead of the shaped
    // one so its array position moves, then reopen: a positional format would
    // put the corner back on whatever now sits at index 2.
    const doc = new CADDocument({ width: 100, height: 100 });
    const p = doc.add(square());
    p.cornerRadii.set("2", 5);
    const shapedAt = { ...p.points[2] };
    p.spliceVertices(0, 0, { x: -10, y: -10 });
    expect(p.points[3]).toEqual(shapedAt); // it really did move along

    const back = reopen(doc).entities.find(
      (e): e is PolylineEntity => e instanceof PolylineEntity,
    )!;
    const i = back.points.findIndex((q) => q.x === shapedAt.x && q.y === shapedAt.y);
    expect(back.cornerValueAt(i)).toBe(5);
  });

  it("keeps a value the current legs cannot draw", () => {
    // Clamping is for drawing; the FILE must hold what was asked for, or saving
    // while a vertex is temporarily pulled in would destroy the corner.
    const doc = new CADDocument({ width: 100, height: 100 });
    const p = doc.add(square());
    p.setAllCornerValues(40);
    expect(p.effectiveCornerValues()[0]).toBeLessThan(40);

    const back = reopen(doc).entities.find(
      (e): e is PolylineEntity => e instanceof PolylineEntity,
    )!;
    expect(back.cornerRadii.get("0")).toBe(40);
  });

  it("a file written before polyline corners existed loads sharp", () => {
    const file = minimalDoc();
    file.entities = [
      {
        type: "polyline",
        id: "p1",
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
        ],
        closed: true,
      },
    ];
    expect(validate(file)).toBe(true);
    const doc = new CADDocument({ width: 100, height: 100 });
    applyFile(doc, file);
    const pl = doc.entities.find((e): e is PolylineEntity => e instanceof PolylineEntity)!;
    expect(pl.cornerRadii.size).toBe(0);
    expect(pl.cornerType).toBe("round");
    expect(pl.outlinePoints()).toEqual(pl.points);
  });

  it("survives a hand-authored file with junk corner data", () => {
    // A file that loads WRONG is worse than one that is rejected, so the loader
    // drops what it cannot use — including a key naming no vertex at all.
    const file = minimalDoc();
    file.entities = [
      {
        type: "polyline",
        id: "p1",
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
        ],
        closed: true,
        cornerRadii: { "1": 2, "2": "x", "9": 4, "0": -3 },
        cornerType: "bogus",
      },
    ];
    expect(validate(file), "the schema still rejects it").toBe(false);
    const doc = new CADDocument({ width: 100, height: 100 });
    applyFile(doc, file);
    const pl = doc.entities.find((e): e is PolylineEntity => e instanceof PolylineEntity)!;
    expect(Object.fromEntries(pl.cornerRadii)).toEqual({ "1": 2 }); // "9" names no vertex
    expect(pl.cornerType).toBe("round");
    for (const p of pl.outlinePoints()) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    }
  });

  it("the schema rejects a non-positive corner and an unknown corner type", () => {
    const bad = (extra: Record<string, unknown>) => {
      const file = minimalDoc();
      file.entities = [
        {
          type: "polyline",
          id: "p1",
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
          ],
          closed: true,
          ...extra,
        },
      ];
      return validate(file);
    };
    expect(bad({ cornerRadii: { "1": 3 } })).toBe(true); // positive control
    expect(bad({ cornerRadii: { "1": 0 } })).toBe(false);
    expect(bad({ cornerRadii: { "1": -3 } })).toBe(false);
    expect(bad({ cornerRadii: { "1": "3" } })).toBe(false);
    expect(bad({ cornerType: "rounded" })).toBe(false);
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

  // One library tool per ToolType, each referenced by an op's toolId, so the
  // serialized tools array (and the schema TOOL enum) meets every type — not just
  // end-mill. A type missing here is the drift the used-tools filter + schema
  // tool enum guard against, and it stays invisible until a tool of that type is
  // actually referenced and serialized.
  const toolFeeds = { feedrate: 1000, plungeRate: 300, spindleSpeed: 18000, safeZ: 5 };
  const tools: ToolDef[] = [
    { id: "tool1", name: "6mm flat", toolType: "end-mill", diameter: 6, ...toolFeeds },
    { id: "tool-bn", name: "6mm ball nose", toolType: "ball-nose", diameter: 6, ...toolFeeds },
    {
      id: "tool-vb",
      name: "60° V-bit",
      toolType: "v-bit",
      diameter: 6,
      vAngle: 60,
      tipDiameter: 0.5,
      ...toolFeeds,
    },
    {
      id: "tool-dr",
      name: "6mm drill",
      toolType: "drill",
      diameter: 6,
      tipAngle: 118,
      ...toolFeeds,
    },
    {
      id: "tool-tb",
      name: "1mm tapered ball nose",
      toolType: "tapered-ball-nose",
      diameter: 6,
      vAngle: 6,
      tipDiameter: 1,
      ...toolFeeds,
    },
  ];
  doc.tools.push(...tools);

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
      // engrave, incl. the image-relief resolution fields and the V-carve
      // halftone screen. These only reach the guard if something SETS them —
      // an unset field is invisible to an additionalProperties:false schema.
      id: "op-engrave",
      name: "Engrave",
      type: "engrave",
      entityIds: [outer.id],
      side: "outside",
      toolId: "tool-vb",
      toolType: "v-bit",
      vAngle: 30,
      ...base,
      rasterLineInterval: 0.3,
      rasterDotPitch: 0.1,
      rasterInvert: true,
      reliefGamma: 1.8,
      halftone: true,
      halftoneLand: 0.15,
      // Present for schema coverage; the emitter screens the pairing (a
      // halftone has no surface for a contour to mean anything on), which
      // `test/steepSplit.test.ts` asserts.
      reliefSteepPass: true,
    },
    {
      // drill: peckDepth, tipAngle, coolant
      id: "op-drill",
      name: "Drill",
      type: "drill",
      entityIds: [circle.id],
      side: "outside",
      toolId: "tool-dr",
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
      // relief-rough as a REST pass: `restToolDiameter` is honoured on two op
      // types, and a field that only ever round-trips on one of them is exactly
      // how the pair drifts apart.
      id: "op-relief-rough",
      name: "Relief rough",
      type: "relief-rough",
      entityIds: [outer.id],
      side: "inside",
      toolType: "end-mill",
      ...base,
      restToolDiameter: 8,
      finishAllowance: 0.3,
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
    {
      // inlay: pocketDepth, glueGap, sawAllowance, inlayMargin — the four
      // numbers that make a plug seat, plus the shared V-bit fields.
      id: "op-inlay",
      name: "Inlay",
      type: "inlay",
      entityIds: [outer.id],
      side: "outside",
      toolType: "v-bit",
      vAngle: 60,
      ...base,
      vStep: 0.4,
      pocketDepth: 3,
      glueGap: 0.25,
      sawAllowance: 1.5,
      inlayMargin: 10,
    },
    {
      // ball-nose: the smooth-relief tool, and the one ToolType with no op of its
      // own in this fixture — without this the TOOL enum never meets it.
      id: "op-relief-bn",
      name: "Relief ball-nose",
      type: "engrave",
      entityIds: [outer.id],
      side: "outside",
      toolId: "tool-bn",
      toolType: "ball-nose",
      ...base,
    },
    {
      // tapered-ball-nose: the CompositeCutter ToolType — its tip geometry
      // (vAngle + tipDiameter) must round-trip through the schema enum, which is
      // exactly the drift this fixture exists to catch.
      id: "op-tapered",
      name: "Tapered finish",
      type: "engrave",
      entityIds: [outer.id],
      side: "outside",
      toolId: "tool-tb",
      toolType: "tapered-ball-nose",
      vAngle: 6,
      tipDiameter: 1,
      ...base,
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
  // Shaped corners: per-corner radii AND a non-default corner type. Both are
  // omitted from a square rectangle's output, so they only reach the
  // additionalProperties:false guard if something here sets them.
  const rounded = doc.add(new RectEntity({ x: 60, y: 60 }, { x: 90, y: 85 }));
  rounded.cornerRadii = [4, 0, 2.5, 4];
  rounded.cornerType = "inverted";
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
  // A shaped vertex, keyed by id — so the kitchen-sink covers the polyline
  // corner fields the same way it covers `polygon` and `vertexIds`.
  poly.cornerRadii.set("vb", 3);
  poly.cornerType = "inverted";
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

  // A corner radius driven by a formula — the rectangle's `cr` scalar DOF, the
  // same binding channel as a circle's radius.
  const plate = doc.add(new RectEntity({ x: 100, y: 100 }, { x: 180, y: 150 }));
  plate.cornerRadii = [6, 6, 6, 6];
  doc.bindings.push({ id: "b-cr", entityId: plate.id, scalarKey: "cr", expr: "margin / 2" });

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
  // A point-to-line dimension: the only dim type that fills BOTH `points` and
  // `entities`, so it is the only kitchen-sink coverage that pairing gets.
  doc.dimensions.push(
    makeDimension("point-line-distance", {
      points: [{ entityId: l.id, key: "a" }],
      entities: [`${plate.id}${SEGMENT_SEP}mid_b`],
      value: 12,
      offset: 0,
      driving: false,
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

  // An STL-backed HEIGHT MAP alongside the picture above: the only schema
  // coverage `zRangeMM` gets, and the field whose absence would silently re-read
  // an imported model as a photograph.
  registerEmbeddedImage({
    id: "img-hf",
    name: "dome",
    width: 2,
    height: 2,
    data: btoa(String.fromCharCode(0, 128, 255, 64)),
    zRangeMM: 12.5,
  });
  doc.add(new RasterImageEntity("img-hf", { x: 60, y: 10 }, 30, 30, 0));
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
