/**
 * Guards audit #5: a bundled example must not ship under-constrained. After the
 * SolidWorks-style colouring (dof commits), loose geometry renders BLUE — an
 * example that opens blue teaches a newcomer that "kind of constrained" is
 * normal. So every example must load with the solver converged and NO entity
 * reported under-defined (feature/pattern-controlled geometry counts as defined;
 * see computeEntityDofStatus).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { CADDocument } from "../src/model/document";
import { applyFile } from "../src/io/fileio";
import { solve, computeEntityDofStatus } from "../src/solver/solver";
import { evaluateAll } from "../src/model/variables";

const files = readdirSync("examples")
  .filter((n) => n.endsWith(".rcam"))
  .sort();

describe("bundled examples are fully defined (no loose/blue geometry)", () => {
  it("has example files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const f of files) {
    it(`${f} loads converged with no under-defined geometry`, () => {
      const file = JSON.parse(readFileSync(`examples/${f}`, "utf8"));
      const doc = new CADDocument({ width: 1, height: 1 }, "mm");
      applyFile(doc, file);
      evaluateAll(doc.variables, doc.dimensions, doc.displayUnit, doc.stockThickness);
      const r = solve(doc);
      const status = computeEntityDofStatus(doc, r);
      const loose = doc.entities
        .filter((e) => status.get(e.id) === "under-defined")
        .map((e) => e.type);
      expect(r.converged).toBe(true);
      expect(loose).toEqual([]);
    });
  }
});
