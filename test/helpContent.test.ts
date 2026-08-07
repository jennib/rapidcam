// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { HELP_TOPICS } from "../src/docs/helpContent";
import { TOOL_SHORTCUTS } from "../src/tools/shortcuts";
import { showHelpDialog } from "../src/ui/helpDialog";
import { isModalOpen, closeAllModals } from "../src/ui/modal";

describe("Help Content & Dialog", () => {
  it("contains all expected help topics", () => {
    expect(HELP_TOPICS.length).toBe(10);
    const ids = HELP_TOPICS.map((t) => t.id);
    expect(ids).toContain("getting-started");
    expect(ids).toContain("2d-drafting");
    expect(ids).toContain("cad-modifications");
    expect(ids).toContain("constraints");
    expect(ids).toContain("cam-toolpaths");
    expect(ids).toContain("laser-machining");
    expect(ids).toContain("tool-library");
    expect(ids).toContain("post-processors-gcode");
    expect(ids).toContain("simulation-cnc");
    expect(ids).toContain("shortcuts-reference");
  });

  it("every topic has valid required fields and non-empty sections", () => {
    for (const topic of HELP_TOPICS) {
      expect(topic.id).toBeTruthy();
      expect(topic.title).toBeTruthy();
      expect(topic.summary).toBeTruthy();
      expect(topic.keywords.length).toBeGreaterThan(0);
      expect(topic.sections.length).toBeGreaterThan(0);
      for (const section of topic.sections) {
        expect(section.heading).toBeTruthy();
        expect(section.body).toBeTruthy();
      }
    }
  });

  it("opens the help dialog and registers modal", () => {
    closeAllModals();
    expect(isModalOpen()).toBe(false);

    showHelpDialog();
    expect(isModalOpen()).toBe(true);

    const dialogHeader = document.querySelector(".tp-dialog-header h3");
    expect(dialogHeader?.textContent).toContain("RapidCAM Documentation");

    closeAllModals();
    expect(isModalOpen()).toBe(false);
  });
});

/**
 * The help text is prose, so nothing type-checks it against the app. It shipped
 * describing a `#var` formula prefix, a "Variables Panel (Ctrl+B)", modulo and
 * a `Math.*` function library — none of which exist — plus a table of six
 * single-key constraint shortcuts that are all drawing-tool keys, and "Fit View:
 * press F" when F is the Fillet tool. A user following any of that gets a broken
 * formula or the wrong tool.
 *
 * These guards pin the claims that CAN be checked mechanically against their
 * source of truth. They target the CLAIM, not the word — the corrected text
 * mentions modulo and constraint shortcuts precisely to say they do not exist.
 */
describe("Help content stays true to the app", () => {
  const allText = JSON.stringify(HELP_TOPICS);
  const tables = HELP_TOPICS.flatMap((t) => t.sections).flatMap((s) => (s.table ? [s.table] : []));

  it("documents every single-key tool shortcut correctly, and invents none", () => {
    const toolTables = tables.filter((t) => t.headers[0] === "Key" && t.headers[1] === "Tool");
    expect(toolTables.length, "the tool-shortcut table must exist to be checked").toBe(1);
    const rows = toolTables[0].rows;
    expect(rows.length).toBeGreaterThan(10);

    for (const [key, tool] of rows) {
      const k = key.toLowerCase();
      // "X" is the construction-geometry toggle in app.ts, not a TOOL_SHORTCUTS entry.
      if (k === "x") continue;
      const actual = TOOL_SHORTCUTS[k];
      expect(actual, `help lists "${key}" as ${tool}, but no tool is bound to it`).toBeTruthy();
      const claimed = tool.toLowerCase();
      expect(
        claimed.includes(actual) || actual.includes(claimed.split(/[ /]/)[0]),
        `help says "${key}" is "${tool}", but it activates "${actual}"`,
      ).toBe(true);
    }
  });

  it("never presents a key as activating a tool it does not activate", () => {
    // Catches prose like "Fit View: Press (F)" when f is the Fillet tool.
    for (const m of allText.matchAll(/Press \(([A-Za-z])\)/g)) {
      const k = m[1].toLowerCase();
      const bound = TOOL_SHORTCUTS[k];
      const ctx = allText.slice(Math.max(0, m.index - 60), m.index);
      if (!bound) continue;
      expect(
        ctx.toLowerCase().includes(bound),
        `"Press (${m[1]})" appears after "...${ctx.slice(-40)}", but ${m[1]} activates "${bound}"`,
      ).toBe(true);
    }
  });

  it("does not document formula syntax the evaluator rejects", () => {
    // The `#` sigil never parsed: expr.ts tokenises identifiers as [a-zA-Z_].
    expect(allText).not.toMatch(/#\w+\s*=/);
    expect(allText).not.toContain("Math.sqrt");
    expect(allText).not.toContain("Math.round");
    // The CLAIM, not the word: "Modulo (%)" listed as a supported operator.
    expect(allText).not.toMatch(/Modulo \(%\)/i);
  });

  it("has no 'Key' column anywhere that names keys the app does not bind", () => {
    // The first guard only looked at headers[0], and MISSED a second fabricated
    // table whose Key column sat third ("Constraint | Glyph | Key | ..."),
    // listing C/H/V/P/K/E for constraints. Found by opening the app and reading
    // the page. Check EVERY column called Key, wherever it sits.
    for (const t of tables) {
      const col = t.headers.findIndex((h) => /^key$/i.test(h));
      if (col < 0) continue;
      for (const row of t.rows) {
        const cell = (row[col] ?? "").trim();
        if (!/^[A-Za-z]$/.test(cell)) continue; // "—", "Ctrl+S" etc. handled elsewhere
        if (cell.toLowerCase() === "x") continue; // construction toggle, not a tool
        const bound = TOOL_SHORTCUTS[cell.toLowerCase()];
        const label = row.filter((_, n) => n !== col).join(" ").toLowerCase();
        expect(bound, `table claims "${cell}" for "${label.slice(0, 40)}", but nothing is bound to it`).toBeTruthy();
        expect(
          label.includes(bound) || bound.includes(label.split(/[ /]/)[0]),
          `table claims "${cell}" for "${label.slice(0, 40)}", but it activates "${bound}"`,
        ).toBe(true);
      }
    }
  });

  it("does not present a table of single-key constraint shortcuts", () => {
    // Every letter is already a drawing tool; app.ts dispatches single keys
    // through TOOL_SHORTCUTS only, so "press P for Parallel" would just switch
    // to the Polyline tool.
    const bad = tables.filter((t) => t.headers[0] === "Key" && t.headers.includes("Constraint"));
    expect(bad).toEqual([]);
  });
});
