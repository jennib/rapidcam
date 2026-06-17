/**
 * Drift guard for the frozen v1 .rcam format.
 *
 * Validates every bundled example project against schema/rcam-v1.schema.json.
 * If the format changes, either the schema or the examples must be updated to
 * match — this test forces them to stay in sync, which is what "frozen v1"
 * actually buys us. It also doubles as a contract test for external authors
 * (including AIs) generating .rcam files from the published schema.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Ajv2020 from "ajv/dist/2020";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const schemaPath = join(repoRoot, "schema", "rcam-v1.schema.json");
const examplesDir = join(repoRoot, "examples");

const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

const exampleFiles = readdirSync(examplesDir).filter((f) => f.endsWith(".rcam"));

describe("rcam v1 schema", () => {
  it("finds the bundled examples", () => {
    expect(exampleFiles.length).toBeGreaterThan(0);
  });

  for (const file of exampleFiles) {
    it(`validates ${file} against the v1 schema`, () => {
      const data = JSON.parse(readFileSync(join(examplesDir, file), "utf8"));
      const ok = validate(data);
      if (!ok) {
        const msg = (validate.errors ?? [])
          .map((e) => `  ${e.instancePath || "<root>"} ${e.message}`)
          .join("\n");
        throw new Error(`${file} does not match rcam-v1 schema:\n${msg}`);
      }
      expect(ok).toBe(true);
    });
  }

  it("rejects a file with the wrong version", () => {
    expect(validate({ ...minimalDoc(), version: 2 })).toBe(false);
  });

  it("rejects an unknown entity type", () => {
    const doc = minimalDoc();
    doc.entities = [{ type: "spline", id: "ent1" }];
    expect(validate(doc)).toBe(false);
  });

  it("accepts a minimal hand-authored document", () => {
    expect(validate(minimalDoc())).toBe(true);
  });
});

/** Smallest document an external author must emit for a valid v1 file. */
function minimalDoc(): any {
  return {
    version: 1,
    name: "Minimal",
    canvas: { width: 100, height: 100 },
    displayUnit: "mm",
    entities: [
      { type: "circle", id: "ent1", center: { x: 50, y: 50 }, radius: 10 },
    ],
    constraints: [],
    dimensions: [],
    isConstructionMode: false,
    selectedPoints: [],
  };
}
