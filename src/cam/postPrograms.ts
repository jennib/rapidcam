/**
 * Shared "generate the machine program(s) and pre-flight them" routine —
 * routed exactly as the app export button routes: rotary wrap → one wrapped
 * program; double-sided flip → side A (+ registration pins) and side B;
 * otherwise one flat program (which generateGCode itself dispatches to the
 * laser generator for laser machines). Every program is run through the
 * Apollo pre-flight lint with its matching context.
 *
 * Browser-safe on purpose: the paste-import checker (src/io/aiCheck.ts) uses
 * it so the import check says exactly what the export lint would say, and the
 * headless CLI/MCP core (cli/core.ts) wraps it with its Node-only concerns
 * (fs, font registration, schema compilation).
 */

import { isFontResolvable } from "../core/fontManager";
import type { CADDocument } from "../model/document";
import { TextEntity } from "../model/entities";
import { generateFlipPrograms } from "./flip";
import { type GCodeOptions, generateGCode } from "./gcode";
import { generateRotaryProgram } from "./klein";
import { buildLintContext, type LintFinding, lintGCode } from "./lint";

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
 * Generate the machine program(s) for an already-loaded document. Throws when
 * the document has no CAM operations.
 */
export function postPrograms(
  doc: CADDocument,
  baseName: string,
  opts: GCodeOptions = {},
): PostResult {
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
