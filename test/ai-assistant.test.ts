/**
 * The AI Assistant round trip: the prompt pack carries everything the model
 * needs (machine context, tools, the full format guide), and the paste-back
 * checker turns bad files into precise, fixable issues instead of throwing.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { CADDocument, STOCK_ENTITY_ID } from "../src/model/document";
import { CircleEntity, LineEntity } from "../src/model/entities";
import { makeDimension } from "../src/model/dimensions";
import { buildAiPrompt } from "../src/io/aiPrompt";
import {
  buildErrorReport,
  checkRcamText,
  extractJson,
  formatSchemaIssue,
  type SchemaValidator,
} from "../src/io/aiCheck";
import { serializeDoc } from "../src/io/fileio";
import type { ToolDef } from "../src/cam/types";
import { registerBundledFonts } from "../cli/core";

// The checker dry-runs the G-code generators, and text ops need real glyphs.
registerBundledFonts();

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

const schema = JSON.parse(
  readFileSync(join(repoRoot, "public", "schema", "rcam-v3.schema.json"), "utf8"),
);
const ajv = new Ajv2020({ allErrors: true, strict: false });
const compiled = ajv.compile(schema);
const validator: SchemaValidator = (data) =>
  compiled(data) ? [] : (compiled.errors ?? []).map(formatSchemaIssue);

function docWithTool(): CADDocument {
  const doc = new CADDocument({ width: 200, height: 150 });
  doc.stockThickness = 12;
  doc.machineKind = "mill";
  const tool: ToolDef = {
    id: "tool-1",
    name: "1/4 in end mill",
    toolType: "end-mill",
    diameter: 6.35,
    feedrate: 900,
    plungeRate: 300,
    spindleSpeed: 18000,
    safeZ: 5,
  };
  doc.tools.push(tool);
  return doc;
}

describe("buildAiPrompt", () => {
  it("embeds machine context, tools, and the full format guide", () => {
    const doc = docWithTool();
    const p = buildAiPrompt(doc, "Test", "new");
    expect(p).toContain("200 × 150 mm");
    expect(p).toContain("Stock thickness: 12 mm");
    expect(p).toContain("grbl");
    expect(p).toContain('id "tool-1"');
    expect(p).toContain("BEGIN RCAM FORMAT GUIDE");
    // The guide really is the whole document, not a stub.
    expect(p).toContain("## Constraints");
    expect(p).toContain("rcam-v3.schema.json");
  });

  it("modify mode embeds the current design JSON and the user request", () => {
    const doc = docWithTool();
    doc.entities.push(new CircleEntity({ x: 50, y: 50 }, 10, "ent-c1"));
    const p = buildAiPrompt(doc, "Plate", "modify", "add a second circle");
    expect(p).toContain('"ent-c1"');
    expect(p).toContain("add a second circle");
    expect(p).toContain("COMPLETE updated file");
  });

  it("never embeds font/image payload arrays in modify mode", () => {
    const doc = docWithTool();
    const p = buildAiPrompt(doc, "Plate", "modify");
    expect(p).not.toContain('"fonts": [{');
    expect(p).not.toContain('"images": [{');
  });
});

describe("extractJson", () => {
  it("passes raw JSON through and unwraps fenced chat replies", () => {
    expect(extractJson('{"version":2}')).toBe('{"version":2}');
    const fenced = 'Here you go!\n```json\n{"version": 2, "name": "x"}\n```\nEnjoy.';
    expect(JSON.parse(extractJson(fenced))).toEqual({ version: 2, name: "x" });
  });
});

describe("checkRcamText", () => {
  const minimal = JSON.stringify({
    version: 2,
    name: "Minimal",
    canvas: { width: 100, height: 100 },
    displayUnit: "mm",
    entities: [{ type: "circle", id: "ent1", center: { x: 50, y: 50 }, radius: 10 }],
    constraints: [],
    dimensions: [],
  });

  it("accepts a minimal valid file", () => {
    const r = checkRcamText(minimal, validator);
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
    expect(r.doc?.entities.some((e) => e.id === "ent1")).toBe(true);
  });

  it("reports invalid JSON without throwing", () => {
    const r = checkRcamText("{not json", validator);
    expect(r.ok).toBe(false);
    expect(r.issues[0].check).toBe("json");
  });

  it("reports schema violations with their path", () => {
    const bad = JSON.parse(minimal);
    bad.entities[0].radius = "ten"; // wrong type
    const r = checkRcamText(JSON.stringify(bad), validator);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.check === "schema" && i.message.includes("/entities/0"))).toBe(
      true,
    );
  });

  it("flags dangling entity references in operations and constraints", () => {
    const bad = JSON.parse(minimal);
    bad.operations = [
      {
        id: "op1",
        name: "Cut",
        type: "profile",
        entityIds: ["ghost"],
        side: "outside",
        toolId: "no-such-tool",
      },
    ];
    bad.constraints = [
      {
        id: "con1",
        type: "coincident",
        points: [
          { entityId: "ent1", key: "c" },
          { entityId: "phantom", key: "a" },
        ],
      },
    ];
    const r = checkRcamText(JSON.stringify(bad));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.check === "refs" && i.message.includes('"ghost"'))).toBe(true);
    expect(r.issues.some((i) => i.check === "refs" && i.message.includes('"phantom"'))).toBe(true);
    expect(
      r.issues.some((i) => i.severity === "warning" && i.message.includes("no-such-tool")),
    ).toBe(true);
  });

  it("accepts the reserved synthetic entities (__origin__, __stock__) as reference targets", () => {
    // Round-trip of the exact reported failure: a design dimensioned from a
    // stock edge saved fine, then failed its OWN import check on reopen with
    // 'references entity "__stock__", which does not exist'. Neither reserved
    // id is ever serialized into `entities` — both resolve at runtime — so
    // the refs check must allow them rather than treat them as dangling.
    const doc = new CADDocument({ width: 200, height: 150 });
    doc.stockRect = { x: 0, y: 0, width: 200, height: 150 };
    const c = doc.add(new CircleEntity({ x: 60, y: 40 }, 5));
    doc.addDimension(
      makeDimension("horizontal", {
        points: [
          { entityId: STOCK_ENTITY_ID, key: "bl" },
          { entityId: c.id, key: "c" },
        ],
        value: 60,
        offset: 20,
      }),
    );
    const file = serializeDoc(doc, "Stock dim");
    // The stock is NOT an entity in the saved file — that's the whole point.
    expect((file.entities as { id?: string }[]).some((e) => e.id === STOCK_ENTITY_ID)).toBe(false);
    expect(JSON.stringify(file)).toContain(STOCK_ENTITY_ID);

    const r = checkRcamText(JSON.stringify(file), validator);
    expect(r.issues.filter((i) => i.check === "refs")).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("flags a contradictory constraint system as a solver error", () => {
    const doc = new CADDocument({ width: 100, height: 100 });
    doc.entities.push(new LineEntity({ x: 0, y: 0 }, { x: 10, y: 10 }, "ln1"));
    const file = serializeDoc(doc, "Contradiction");
    // Pin both endpoints to places a horizontal line can't satisfy.
    file.constraints = [
      { id: "c1", type: "fixedPoint", points: [{ entityId: "ln1", key: "a" }], params: [0, 0] },
      { id: "c2", type: "fixedPoint", points: [{ entityId: "ln1", key: "b" }], params: [10, 10] },
      { id: "c3", type: "horizontal", entities: ["ln1"] },
    ] as typeof file.constraints;
    const r = checkRcamText(JSON.stringify(file), validator);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.check === "solver")).toBe(true);
  });

  it("warns about geometry outside the work area", () => {
    const bad = JSON.parse(minimal);
    bad.entities.push({ type: "circle", id: "ent2", center: { x: 500, y: 50 }, radius: 10 });
    const r = checkRcamText(JSON.stringify(bad), validator);
    expect(r.ok).toBe(true); // warning, not error
    expect(r.issues.some((i) => i.check === "bounds" && i.message.includes("ent2"))).toBe(true);
  });

  it("validates every bundled example clean (pre-flight lint advisories allowed)", () => {
    const dir = join(repoRoot, "examples");
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".rcam"))) {
      const r = checkRcamText(readFileSync(join(dir, f), "utf8"), validator);
      // Some examples legitimately trip Apollo advisories (edge profile,
      // spoilboard overshoot, sender-paused tool changes) — those surface as
      // "lint" warnings now and are pinned message-by-message in
      // cli-core.test.ts. Everything else must be spotless, and ok stays true.
      const unexpected = r.issues.filter((i) => i.check !== "lint");
      expect(unexpected, `${f}: ${JSON.stringify(r.issues)}`).toEqual([]);
      expect(r.ok, f).toBe(true);
    }
  });
});

describe("field-test regressions (Gemini, 2026-07-12)", () => {
  // Gemini's file, trimmed: a rounded-rectangle plate outline authored as
  // 4 lines + 4 corner fillet arcs, a drill op with no side/stepover (the
  // schema used to require both on every op type, trapping the AI in a guess
  // loop over `side` on a drill), and a profile over the mixed line+arc loop
  // (which the generator used to skip silently as "not a closed polygon").
  const q = Math.PI / 2;
  const geminiShaped = JSON.stringify({
    version: 2,
    name: "Mounting Plate",
    canvas: { width: 863.6, height: 478.79 },
    displayUnit: "in",
    stockThickness: 19.05,
    entities: [
      { id: "line_b", type: "line", a: { x: 105, y: 120 }, b: { x: 195, y: 120 } },
      {
        id: "arc_br",
        type: "arc",
        center: { x: 195, y: 125 },
        radius: 5,
        startAngle: 3 * q,
        endAngle: 4 * q,
      },
      { id: "line_r", type: "line", a: { x: 200, y: 125 }, b: { x: 200, y: 175 } },
      {
        id: "arc_tr",
        type: "arc",
        center: { x: 195, y: 175 },
        radius: 5,
        startAngle: 0,
        endAngle: q,
      },
      { id: "line_t", type: "line", a: { x: 195, y: 180 }, b: { x: 105, y: 180 } },
      {
        id: "arc_tl",
        type: "arc",
        center: { x: 105, y: 175 },
        radius: 5,
        startAngle: q,
        endAngle: 2 * q,
      },
      { id: "line_l", type: "line", a: { x: 100, y: 175 }, b: { x: 100, y: 125 } },
      {
        id: "arc_bl",
        type: "arc",
        center: { x: 105, y: 125 },
        radius: 5,
        startAngle: 2 * q,
        endAngle: 3 * q,
      },
      { id: "hole_bl", type: "circle", center: { x: 108, y: 128 }, radius: 2.75 },
    ],
    constraints: [],
    dimensions: [],
    operations: [
      {
        id: "op_drill_holes",
        name: "Drill",
        type: "drill",
        entityIds: ["hole_bl"],
        toolType: "drill",
        toolNumber: 1,
        diameter: 5.5,
        feedrate: 400,
        plungeRate: 150,
        spindleSpeed: 6000,
        safeZ: 5,
        depth: -19.1,
      },
      {
        id: "op_profile",
        name: "Profile",
        type: "profile",
        entityIds: ["line_b", "arc_br", "line_r", "arc_tr", "line_t", "arc_tl", "line_l", "arc_bl"],
        side: "outside",
        toolType: "end-mill",
        toolNumber: 2,
        diameter: 6,
        feedrate: 900,
        plungeRate: 250,
        spindleSpeed: 18000,
        safeZ: 5,
        depth: -19.1,
        stepdown: 2,
      },
    ],
  });

  it("accepts a drill op without side/stepdown/stepover and cuts the line+arc outline", () => {
    const r = checkRcamText(geminiShaped, validator);
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
    // The line+arc loop must actually produce a toolpath — no generator skips.
    expect(r.issues.filter((i) => i.check === "toolpath")).toEqual([]);
    // The loader backfilled the UI defaults so generators never see undefined.
    const drill = r.doc?.operations.find((o) => o.id === "op_drill_holes");
    expect(drill?.side).toBe("outside");
    expect(drill?.stepover).toBe(0.4);
    expect(drill?.stepdown).toBe(1.5);
  });

  it("flags an operation whose geometry produces no toolpath", () => {
    const bad = JSON.parse(geminiShaped);
    bad.operations[1].entityIds = ["line_b"]; // one loose line can't close
    const r = checkRcamText(JSON.stringify(bad), validator);
    expect(
      r.issues.some((i) => i.check === "toolpath" && i.message.includes("closed polygon")),
    ).toBe(true);
  });

  it("still requires side on a profile op", () => {
    const bad = JSON.parse(geminiShaped);
    delete bad.operations[1].side;
    const r = checkRcamText(JSON.stringify(bad), validator);
    expect(r.issues.some((i) => i.check === "schema" && i.message.includes("side"))).toBe(true);
  });

  it("enum violations name the allowed values in the report", () => {
    const bad = JSON.parse(geminiShaped);
    bad.operations[1].side = "on"; // Gemini's actual guess
    const r = checkRcamText(JSON.stringify(bad), validator);
    const schemaErr = r.issues.find((i) => i.check === "schema");
    expect(schemaErr?.message).toContain('"outside"');
    expect(schemaErr?.message).toContain('"inside"');
  });
});

describe("pre-flight lint in the import check", () => {
  /** A mill file whose only geometry is a 4-line rectangle spanning (x0,y0)–(x1,y1),
   *  cut as an outside profile — at the stock corner the tool centre must swing
   *  a radius off the stock; comfortably inside it must lint clean. */
  const millFile = (x0: number, y0: number, x1: number, y1: number) =>
    JSON.stringify({
      version: 2,
      name: "Lint check",
      canvas: { width: 100, height: 100 },
      displayUnit: "mm",
      stockThickness: 10,
      machineKind: "mill",
      entities: [
        { id: "e_b", type: "line", a: { x: x0, y: y0 }, b: { x: x1, y: y0 } },
        { id: "e_r", type: "line", a: { x: x1, y: y0 }, b: { x: x1, y: y1 } },
        { id: "e_t", type: "line", a: { x: x1, y: y1 }, b: { x: x0, y: y1 } },
        { id: "e_l", type: "line", a: { x: x0, y: y1 }, b: { x: x0, y: y0 } },
      ],
      constraints: [],
      dimensions: [],
      operations: [
        {
          id: "op_profile",
          name: "Profile",
          type: "profile",
          entityIds: ["e_b", "e_r", "e_t", "e_l"],
          side: "outside",
          toolType: "end-mill",
          toolNumber: 1,
          diameter: 6,
          feedrate: 900,
          plungeRate: 300,
          spindleSpeed: 18000,
          safeZ: 5,
          depth: -5,
          stepdown: 3,
        },
      ],
    });

  it("an outside profile on the stock corner surfaces the export lint as a warning", () => {
    const r = checkRcamText(millFile(0, 0, 30, 30), validator);
    expect(r.ok).toBe(true); // machinability findings must never block import
    const lint = r.issues.filter((i) => i.check === "lint");
    expect(lint.length).toBeGreaterThan(0);
    expect(lint.every((i) => i.severity === "warning")).toBe(true);
    // The lint's own severity stays visible in the message prefix.
    expect(lint.some((i) => /^error: .*outside the stock/.test(i.message))).toBe(true);
  });

  it("a comfortably-inside design yields no lint issues", () => {
    const r = checkRcamText(millFile(30, 30, 70, 70), validator);
    expect(r.ok).toBe(true);
    expect(r.issues.filter((i) => i.check === "lint")).toEqual([]);
  });
});

describe("buildErrorReport", () => {
  it("restates the output contract and lists errors before warnings", () => {
    const r = checkRcamText("{not json");
    const report = buildErrorReport(r, "test file");
    expect(report).toContain("RapidCAM import report — test file");
    expect(report).toContain("## Errors");
    expect(report).toContain("single JSON code block");
    expect(report).toContain("rcam-format-v3.md");
  });
});
