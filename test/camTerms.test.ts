/**
 * Drift guard for the in-dialog machining glossary (src/cam/camTerms.ts).
 *
 * CAM_TERMS entries are referenced by dialog fields as `help: CAM_TERMS.<key>`.
 * This test asserts BOTH directions, so the table cannot quietly go stale:
 * a key no field references (the field or its help was removed) and a reference
 * to a key that is not defined (a typo) both fail.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CAM_TERMS } from "../src/cam/camTerms";

const dialogDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "ui",
  "camBar",
  "dialog",
);
const source = readdirSync(dialogDir, { recursive: true, encoding: "utf8" })
  .filter((f) => f.endsWith(".ts"))
  .map((f) => readFileSync(join(dialogDir, f), "utf8"))
  .join("\n");

const referenced = new Set<string>();
for (const m of source.matchAll(/CAM_TERMS\.(\w+)/g)) referenced.add(m[1]);

describe("CAM term glossary drift guard", () => {
  it("every term is referenced by a dialog field", () => {
    const missing = Object.keys(CAM_TERMS)
      .filter((k) => !referenced.has(k))
      .sort();
    expect(missing).toEqual([]);
  });

  it("every reference names a defined term", () => {
    const defined = new Set(Object.keys(CAM_TERMS));
    const unknown = [...referenced].filter((k) => !defined.has(k)).sort();
    expect(unknown).toEqual([]);
  });
});