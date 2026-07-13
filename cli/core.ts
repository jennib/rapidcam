/**
 * Headless core for the RapidCAM CLI and MCP server: validate and post .rcam
 * files in Node, reusing the exact browser pipeline (parse → load → solve →
 * generate → Apollo lint). Nothing here touches the DOM.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020";
import type { GCodeOptions } from "../src/cam/gcode";
import { type PostResult, postPrograms } from "../src/cam/postPrograms";
import { BUNDLED, registerEmbeddedFont } from "../src/core/fontManager";
import {
  type AiCheckResult,
  checkRcamText,
  formatSchemaIssue,
  type SchemaValidator,
} from "../src/io/aiCheck";
import { applyFile, parseRcam } from "../src/io/fileio";
import { CADDocument } from "../src/model/document";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

let validator: SchemaValidator | null = null;
export function makeSchemaValidator(): SchemaValidator {
  if (validator) return validator;
  const schema = JSON.parse(
    readFileSync(join(repoRoot, "public", "schema", "rcam-v2.schema.json"), "utf8"),
  );
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const compiled = ajv.compile(schema);
  validator = (data: unknown) =>
    compiled(data) ? [] : (compiled.errors ?? []).map(formatSchemaIssue);
  return validator;
}

/**
 * In the browser the bundled fonts arrive over fetch; here they are read from
 * public/fonts and pushed through the embedded-font path (idempotent).
 */
export function registerBundledFonts(): void {
  for (const f of BUNDLED) {
    const bytes = readFileSync(join(repoRoot, "public", f.url.replace(/^\//, "")));
    registerEmbeddedFont({
      id: f.id,
      name: f.name,
      format: "woff",
      data: bytes.toString("base64"),
    });
  }
}

/** Full check pipeline (schema + load + refs + solve + bounds) on .rcam text. */
export function validateRcamText(text: string): AiCheckResult {
  registerBundledFonts();
  return checkRcamText(text, makeSchemaValidator());
}

export type { PostedProgram, PostResult } from "../src/cam/postPrograms";

/**
 * Generate the machine program(s) for a .rcam file — parse/load here (the
 * Node-only shell), then the shared browser-safe {@link postPrograms} routine
 * routes by machine kind (rotary wrap / double-sided flip / flat) and runs
 * the Apollo pre-flight lint over every program.
 */
export function postRcamText(text: string, baseName: string, opts: GCodeOptions = {}): PostResult {
  registerBundledFonts();
  const file = parseRcam(text);
  const doc = new CADDocument({ width: 100, height: 100 }); // applyFile overwrites
  applyFile(doc, file);
  return postPrograms(doc, baseName, opts);
}
