/**
 * Behavior smoke test for the bundled example projects.
 *
 * rcam-schema.test.ts guards the JSON *shape*; this guards what the examples
 * actually do: every example must load through the real loader, its constraint
 * system must converge, and any CAM operations must post to real G-code, routed
 * per machineKind — mill, laser, or the rotary cylinder wrap.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CADDocument } from "../src/model/document";
import { parseRcam, applyFile } from "../src/io/fileio";
import { registerEmbeddedFont } from "../src/core/fontManager";
import { solve } from "../src/solver/solver";
import { generateGCode } from "../src/cam/gcode";
import { generateRotaryProgram } from "../src/cam/klein";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const examplesDir = join(repoRoot, "examples");

const exampleFiles = readdirSync(examplesDir).filter((f) => f.endsWith(".rcam"));

beforeAll(() => {
  // Bundled fonts normally arrive via fetch("/fonts/*.woff") at app startup;
  // in Node, register the same bytes under their bundled ids so example text
  // expands to real glyph toolpaths instead of posting nothing.
  for (const [id, file] of [
    ["roboto-regular", "roboto-regular.woff"],
    ["roboto-bold", "roboto-bold.woff"],
  ] as const) {
    const bytes = readFileSync(join(repoRoot, "public", "fonts", file));
    registerEmbeddedFont({ id, name: id, format: "woff", data: bytes.toString("base64") });
  }
});

describe("bundled examples load and post", () => {
  for (const file of exampleFiles) {
    it(`${file}: loads, solves, and generates G-code`, () => {
      const parsed = parseRcam(readFileSync(join(examplesDir, file), "utf8"));
      const doc = new CADDocument({ width: 100, height: 100 });
      applyFile(doc, parsed);
      expect(doc.entities.length).toBeGreaterThan(0);

      // The shipped geometry must already satisfy its own constraint system
      // (the authoring guide's "emit geometry in its solved positions").
      const res = solve(doc);
      if (res.hasConstraints) expect(res.converged).toBe(true);

      if (doc.operations.length === 0) return;
      if (doc.machineKind === "mill-rotary") {
        const { program, warnings } = generateRotaryProgram(doc);
        expect(warnings).toEqual([]);
        expect(program).toMatch(/\bA-?\d/); // wrapped axis emitted in degrees
        expect(program).toContain("M30");
      } else {
        const g = generateGCode(doc.operations, doc);
        expect(g).not.toContain("No toolpaths");
        expect(g).toMatch(/G1 /); // real cutting moves, not an empty program
        expect(g).toContain("M30");
      }
    });
  }
});
