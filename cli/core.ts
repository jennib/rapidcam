/**
 * Headless core for the RapidCAM CLI and MCP server: validate and post .rcam
 * files in Node, reusing the exact browser pipeline (parse → load → solve →
 * generate → Apollo lint). Nothing here touches the DOM.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020";
import { generateFlipPrograms } from "../src/cam/flip";
import { type GCodeOptions, generateGCode } from "../src/cam/gcode";
import { generateRotaryProgram } from "../src/cam/klein";
import { buildLintContext, type LintFinding, lintGCode } from "../src/cam/lint";
import { BUNDLED, isFontResolvable, registerEmbeddedFont } from "../src/core/fontManager";
import {
  type AiCheckResult,
  checkRcamText,
  formatSchemaIssue,
  type SchemaValidator,
} from "../src/io/aiCheck";
import { applyFile, parseRcam } from "../src/io/fileio";
import { CADDocument } from "../src/model/document";
import { TextEntity } from "../src/model/entities";

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

export interface PostedProgram {
  /** Suggested output filename (e.g. "part-sideA.nc"). */
  name: string;
  gcode: string;
  lint: LintFinding[];
}

export interface PostResult {
  programs: PostedProgram[];
  /** Generator advisories (rotary wrap setup, flip setup, missing fonts). */
  warnings: string[];
}

/**
 * Generate the machine program(s) for a .rcam file, routed exactly as the app
 * export button routes: rotary wrap → one wrapped program; double-sided flip →
 * side A (+ registration pins) and side B; otherwise one flat program. Every
 * program is run through the Apollo pre-flight lint.
 */
export function postRcamText(text: string, baseName: string, opts: GCodeOptions = {}): PostResult {
  registerBundledFonts();
  const file = parseRcam(text);
  const doc = new CADDocument({ width: 100, height: 100 }); // applyFile overwrites
  applyFile(doc, file);
  if (doc.operations.length === 0) {
    throw new Error("The file has no CAM operations — nothing to post.");
  }

  const warnings: string[] = [];
  for (const e of doc.entities) {
    if (e instanceof TextEntity && !isFontResolvable(e.fontId)) {
      warnings.push(
        `text "${e.text}" uses unavailable font "${e.fontId}" and is OMITTED from the G-code`,
      );
    }
  }

  const programs: PostedProgram[] = [];
  const isRotary = doc.machineKind === "mill-rotary";
  const hasBottom = !!doc.flip && doc.operations.some((op) => (op.face ?? "top") === "bottom");

  if (isRotary) {
    const { program, warnings: w } = generateRotaryProgram(doc, opts);
    warnings.push(...w);
    programs.push({
      name: `${baseName}-rotary.nc`,
      gcode: program,
      lint: lintGCode(program, buildLintContext(doc)),
    });
  } else if (hasBottom) {
    const flip = doc.flip!;
    const { sideA, sideB, warnings: w, hasPins } = generateFlipPrograms(doc, opts);
    warnings.push(...w);
    programs.push({
      name: `${baseName}-sideA.nc`,
      gcode: sideA,
      lint: lintGCode(
        sideA,
        buildLintContext(doc, hasPins ? { extraDepthBelowBottom: flip.pinDepth } : {}),
      ),
    });
    if (sideB) {
      programs.push({
        name: `${baseName}-sideB.nc`,
        gcode: sideB,
        lint: lintGCode(sideB, buildLintContext(doc)),
      });
    }
  } else {
    const gcode = generateGCode(doc.operations, doc, opts);
    programs.push({
      name: `${baseName}.nc`,
      gcode,
      lint: lintGCode(gcode, buildLintContext(doc)),
    });
  }

  return { programs, warnings };
}
