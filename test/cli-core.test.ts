/**
 * Drift guard for the headless CLI/MCP core: every bundled example must
 * validate clean, and every example with CAM operations must post to
 * non-trivial G-code in Node — the same pipeline the browser export uses.
 * If a generator grows a DOM dependency, this is what catches it.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { postRcamText, validateRcamText } from "../cli/core";

const here = dirname(fileURLToPath(import.meta.url));
const examplesDir = join(here, "..", "examples");
const examples = readdirSync(examplesDir).filter((f) => f.endsWith(".rcam"));

describe("headless core over the bundled examples", () => {
  for (const f of examples) {
    const text = readFileSync(join(examplesDir, f), "utf8");

    it(`validate ${f} — clean`, () => {
      const r = validateRcamText(text);
      expect(r.issues, JSON.stringify(r.issues)).toEqual([]);
    });

    const hasOps = ((JSON.parse(text).operations as unknown[]) ?? []).length > 0;
    if (hasOps) {
      it(`post ${f} — produces a program with only known lint errors`, () => {
        const post = postRcamText(text, "t");
        expect(post.programs.length).toBeGreaterThan(0);
        for (const p of post.programs) {
          expect(p.gcode.split("\n").length).toBeGreaterThan(10);
          const errorCodes = p.lint.filter((l) => l.severity === "error").map((l) => l.code);
          // box-joint cuts a profile on the stock edge, so the tool centre
          // legitimately swings a radius outside the stock — the app surfaces
          // the same advisory and lets the user export anyway.
          const known = f === "box-joint-tab-slot.rcam" ? ["out-of-bounds"] : [];
          expect(errorCodes, `${p.name}: ${JSON.stringify(p.lint)}`).toEqual(known);
        }
      });
    }
  }

  it("post refuses a file with no operations", () => {
    const noOps = readFileSync(join(examplesDir, "keychain-tag.rcam"), "utf8");
    const stripped = JSON.stringify({ ...JSON.parse(noOps), operations: [] });
    expect(() => postRcamText(stripped, "t")).toThrow(/no CAM operations/);
  });
});
