// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HELP_TOPICS } from "../src/docs/helpContent";
import { BUNDLED } from "../src/core/fontManager";
import { TOOL_SHORTCUTS } from "../src/tools/shortcuts";
import { COLORS } from "../src/view/colors";
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

  it("names the solver-health colours the renderer actually paints", () => {
    // The canvas has exactly three states: a distinct blue for under-defined, a
    // distinct red for conflict, and — for fully constrained — no colour of its
    // own at all, because the entity simply returns to its LAYER colour. The
    // help claimed green for that third state; green is the Design Tree icon,
    // not the geometry, and a reader waiting for green geometry waits forever.
    const solverTips = HELP_TOPICS.flatMap((t) => t.sections)
      .filter((s) => s.heading.includes("Degrees of Freedom"))
      .flatMap((s) => s.tips ?? []);
    expect(solverTips.length, "the solver-health section must still exist").toBeGreaterThan(0);
    const text = solverTips.join(" ").toLowerCase();

    expect(COLORS.entityUnderDefined).toBeTruthy();
    expect(COLORS.entityConflict).toBeTruthy();
    expect(text).toMatch(/under-constrained \(blue\)/);
    expect(text).toMatch(/conflict \(red\)/);
    // There is no third geometry colour to name...
    expect(COLORS).not.toHaveProperty("entityFullyDefined");
    // ...so the help must not promise one.
    expect(text).not.toMatch(/fully constrained \(green\)/);
    expect(text).toMatch(/layer colour/);
  });

  it("does not offer a click target the app never draws", () => {
    // "Click on the flagged red badge to delete the conflicting constraint"
    // described a badge that does not exist. Deleting a conflicting constraint
    // goes through the Design Tree's Constraints section.
    const all = HELP_TOPICS.flatMap((t) => t.sections)
      .flatMap((s) => [s.body, ...(s.tips ?? [])])
      .join(" ")
      .toLowerCase();
    expect(all).not.toMatch(/red badge/);
  });

  it("does not claim the app talks to a machine over USB", () => {
    // A whole section described a "Direct WebSerial USB Machine Sender" with jog
    // controls, a DRO, probing, feed-rate overrides and an E-Stop warning. None
    // of it existed: `navigator.serial` appeared nowhere but that page. What the
    // app really does is hand the program to gSender/ncSender over HTTP, or open
    // it in GEditor — a shop reading the old text would have gone looking for a
    // Connect button that was never there.
    //
    // Tied to the source of truth rather than to the word: if someone builds a
    // WebSerial sender, `navigator.serial` will appear in src/ and this guard
    // steps aside on its own.
    const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
    const usesWebSerial = readdirSync(srcDir, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".ts") && !f.includes("helpContent"))
      .some((f) => {
        const p = join(srcDir, f);
        return statSync(p).isFile() && readFileSync(p, "utf8").includes("navigator.serial");
      });
    if (usesWebSerial) return;
    expect(allText, "help describes a serial/USB machine connection the app has not got").not.toMatch(
      /WebSerial|navigator\.serial|\bDRO\b|jog controls?/i,
    );
  });

  it("does not promise fonts the app does not ship", () => {
    // The help described "built-in single-stroke Hershey fonts", twice, plus a
    // best-practice tip telling people to use them. The word appeared nowhere
    // else in the repo: BUNDLED is Roboto Regular and Bold, both outline fonts,
    // and no single-stroke engine exists. Someone following that advice went
    // looking for a font list that has never been there.
    //
    // The CLAIM, not the word: text naming Hershey to say it is NOT included
    // would be fine — what must not reappear is the app being said to have one.
    expect(allText).not.toMatch(/(includes?|built[- ]in|ships? with)[^".]{0,40}Hershey/i);
    expect(allText).not.toMatch(/Hershey[^".]{0,40}(included|built[- ]in|bundled)/i);
    // Anything named as a bundled font has to actually be bundled.
    const bundled = BUNDLED.map((b) => b.name.toLowerCase());
    // The whole sentence, not just what follows the phrase — the font is named
    // before it ("Roboto Regular and Bold ship with the app").
    for (const m of allText.matchAll(/[^.!?"]*ships? with the app[^.!?"]*/gi)) {
      const claim = m[0].toLowerCase();
      expect(
        bundled.some((n) => claim.includes(n.split(" ")[0])),
        `help says something ships with the app that isn't in BUNDLED: "${m[0].slice(0, 80)}"`,
      ).toBe(true);
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
