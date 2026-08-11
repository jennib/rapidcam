/**
 * Guards for the tool reference table (src/tools/shortcuts.ts), which is now
 * the single source for the keyboard handler, the palette, the `?` overlay and
 * the F1 help.
 *
 * The whole point of collapsing four copies into one is that the copy can no
 * longer disagree with the code — so these check the table against the actual
 * Tool classes, and check the help prose against the table in BOTH directions.
 * Both directions matter: the help has claimed typed input for tools that had
 * none (Circle, Rotate) AND stayed silent about three tools that had it. An
 * audit that only hunts for overclaims finds half the bug.
 */

import { describe, it, expect } from "vitest";
import {
  TOOLS,
  TOOL_HINTS,
  TOOL_SHORTCUTS,
  TYPE_TO_DRAW_TOOLS,
  shortcutForTool,
  toolReferenceRows,
} from "../src/tools/shortcuts";
import { HELP_TOPICS } from "../src/docs/helpContent";
import type { Tool } from "../src/tools/tool";

import { SelectTool } from "../src/tools/selectTool";
import { LineTool } from "../src/tools/lineTool";
import { PolylineTool } from "../src/tools/polylineTool";
import { RectTool } from "../src/tools/rectTool";
import { CircleTool } from "../src/tools/circleTool";
import { ArcTool } from "../src/tools/arcTool";
import { BezierTool } from "../src/tools/bezierTool";
import { PolygonTool } from "../src/tools/polygonTool";
import { SlotTool } from "../src/tools/slotTool";
import { TextTool } from "../src/tools/textTool";
import { FilletTool } from "../src/tools/filletTool";
import { ChamferTool } from "../src/tools/chamferTool";
import { TrimTool } from "../src/tools/trimTool";
import { ExtendTool } from "../src/tools/extendTool";
import { OffsetTool } from "../src/tools/offsetTool";
import { MirrorTool } from "../src/tools/mirrorTool";
import { RotateTool } from "../src/tools/rotateTool";
import { ScaleTool } from "../src/tools/scaleTool";
import { DimensionTool } from "../src/tools/dimensionTool";
import { MeasureTool } from "../src/tools/measureTool";

/** Every tool the app registers. */
const ALL_TOOLS: Tool[] = [
  new SelectTool(),
  new LineTool(),
  new PolylineTool(),
  new RectTool(),
  new CircleTool(),
  new ArcTool(),
  new BezierTool(),
  new PolygonTool(),
  new SlotTool(),
  new TextTool(),
  new FilletTool(),
  new ChamferTool(),
  new TrimTool(),
  new ExtendTool(),
  new OffsetTool(),
  new MirrorTool(),
  new RotateTool(),
  new ScaleTool(),
  new DimensionTool(),
  new MeasureTool(),
];

describe("the tool reference table matches the tools themselves", () => {
  it("covers every registered tool, and invents none", () => {
    expect(Object.keys(TOOLS).sort()).toEqual(ALL_TOOLS.map((t) => t.id).sort());
  });

  it("uses each tool's own label", () => {
    for (const tool of ALL_TOOLS) {
      expect(TOOLS[tool.id].label, `label drifted for "${tool.id}"`).toBe(tool.label);
    }
  });

  it("gives every tool a non-empty hint", () => {
    for (const [id, t] of Object.entries(TOOLS)) {
      expect(t.hint.trim(), `"${id}" has no hint`).not.toBe("");
    }
  });

  it("binds each key to exactly one tool", () => {
    const keys = Object.values(TOOLS)
      .map((t) => t.key)
      .filter((k): k is string => Boolean(k));
    expect(new Set(keys).size, "two tools share a key").toBe(keys.length);
    for (const k of keys) expect(k, `"${k}" must be a single lowercase letter`).toMatch(/^[a-z]$/);
  });

  it("derives the legacy views consistently", () => {
    for (const [id, t] of Object.entries(TOOLS)) {
      expect(TOOL_HINTS[id]).toBe(t.hint);
      if (t.key) {
        expect(TOOL_SHORTCUTS[t.key]).toBe(id);
        expect(shortcutForTool(id)).toBe(t.key.toUpperCase());
      } else {
        expect(shortcutForTool(id)).toBeUndefined();
      }
    }
    expect(Object.keys(TOOL_SHORTCUTS)).toHaveLength(
      Object.values(TOOLS).filter((t) => t.key).length,
    );
  });

  it("generates one help row per keyed tool", () => {
    const rows = toolReferenceRows();
    expect(rows).toHaveLength(Object.values(TOOLS).filter((t) => t.key).length);
    for (const [key, name, action] of rows) {
      expect(key).toMatch(/^[A-Z]$/);
      expect(name).toMatch(/ Tool$/);
      expect(action.trim()).not.toBe("");
    }
  });
});

describe("the help prose agrees with the table", () => {
  /**
   * The per-tool help bullet, keyed by tool id. They are spread over more than
   * one section — the drawing primitives in one, the modify tools in another —
   * so this scans every tip in the file rather than a single heading.
   */
  function rosterLines(): Map<string, string> {
    const tips = HELP_TOPICS.flatMap((t) => t.sections).flatMap((s) => s.tips ?? []);
    expect(tips.length, "the help has no tips at all — did the shape change?").toBeGreaterThan(0);

    const byId = new Map<string, string>();
    for (const [id, t] of Object.entries(TOOLS)) {
      // A bullet opens with the tool's label, says "Tool", and runs to the first
      // colon: "Line Tool (L):", "Bezier Curve Tool (B):", "Text Tool:".
      // Requiring "Tool" keeps prose like "Select Objects: …" in Getting
      // Started from being mistaken for the Select tool's own bullet.
      const head = new RegExp(`^${t.label}\\b[^:]*\\bTool\\b[^:]*:`);
      const line = tips.find((tip) => head.test(tip));
      if (line) byId.set(id, line);
    }
    return byId;
  }

  /** The bullet's opening, before the colon — where the key is quoted. */
  const headOf = (line: string) => line.slice(0, line.indexOf(":"));

  it("describes every tool exactly once", () => {
    const byId = rosterLines();
    const missing = Object.keys(TOOLS).filter((id) => !byId.has(id));
    expect(missing, "tools with no roster bullet").toEqual([]);
  });

  it("quotes the right shortcut key for each tool", () => {
    for (const [id, line] of rosterLines()) {
      const key = shortcutForTool(id);
      // Only the opening, so a later "(Shift)" in the prose is not read as a key.
      const quoted = /\(([A-Z])[^)]*\)/.exec(headOf(line))?.[1];
      if (quoted) {
        expect(quoted, `help says (${quoted}) for "${id}" but the key is ${key}`).toBe(key);
      } else {
        expect(key, `"${id}" has key ${key} but its help never quotes it`).toBeUndefined();
      }
    }
  });

  it("mentions typing for exactly the tools that support it", () => {
    // Targets the CLAIM, not a word: "type"/"typed"/"Type to Draw" in a tool's
    // own bullet is a promise that its field exists, and test/typeToDraw.test.ts
    // separately proves the field really opens for everything flagged here.
    const claimsTyping = /\btype\b|\btyping\b|\btyped\b|Type to Draw/i;
    for (const [id, line] of rosterLines()) {
      const supported = TYPE_TO_DRAW_TOOLS.includes(id);
      expect(
        claimsTyping.test(line),
        supported
          ? `"${id}" supports Type to Draw but its help never says so`
          : `"${id}" does NOT support Type to Draw but its help says it does`,
      ).toBe(supported);
    }
  });

  it("the shortcut table is generated, not re-typed", () => {
    const table = HELP_TOPICS.flatMap((t) => t.sections).find(
      (s) => s.heading === "Single-Key CAD Drawing Tools",
    )?.table;
    if (!table) throw new Error("the single-key table moved or was renamed");

    // Every generated row is present verbatim; extras (the X toggle) are fine.
    for (const row of toolReferenceRows()) {
      expect(table.rows, `"${row[1]}" is not the generated row`).toContainEqual(row);
    }
  });
});
