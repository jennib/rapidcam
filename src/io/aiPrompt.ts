/**
 * Builds a self-contained prompt the user can paste into any LLM chat to have
 * it author (or modify) a .rcam file for THIS machine and stock setup.
 *
 * The prompt embeds the full format guide (39 KB — well within any modern
 * model's context) so it works for models without web access, plus the
 * document's machine context so the AI never has to guess units, stock size,
 * or which tools exist. The round trip back into RapidCAM is File ▸ AI
 * Assistant ▸ paste, which validates the result and produces a copyable error
 * report to feed back to the model — the loop matters more than the first
 * attempt.
 */

import formatGuide from "../../docs/rcam-format-v3.md?raw";
import { getPostFor, getHasToolChanger } from "../core/prefs";
import type { CADDocument } from "../model/document";
import { RCAM_VERSION, serializeDoc, stripEmbeddedFonts } from "./fileio";

export type AiPromptMode = "new" | "modify";

const GUIDE_BEGIN = "----- BEGIN RCAM FORMAT GUIDE -----";
const GUIDE_END = "----- END RCAM FORMAT GUIDE -----";

/** One line per tool so the AI references real tools instead of inventing them. */
function describeTools(doc: CADDocument): string {
  if (!doc.tools.length) {
    return "The document has no tool library. If you add CAM operations, give each operation inline tool fields (toolType, diameter, feedrate, plungeRate, spindleSpeed, safeZ) instead of a toolId.";
  }
  const lines = doc.tools.map((t) => {
    const geom =
      t.toolType === "v-bit"
        ? `Ø${t.diameter}mm, ${t.vAngle ?? 60}° included${t.tipDiameter ? `, ${t.tipDiameter}mm flat tip` : ""}`
        : t.toolType === "drill"
          ? `Ø${t.diameter}mm, ${t.tipAngle ?? 118}° tip`
          : `Ø${t.diameter}mm`;
    return `- id "${t.id}": ${t.name} — ${t.toolType}, ${geom}; feed ${t.feedrate} mm/min, plunge ${t.plungeRate} mm/min, ${t.spindleSpeed} rpm, safe Z ${t.safeZ} mm`;
  });
  return `Tool library (reference these by \`toolId\` in operations):\n${lines.join("\n")}`;
}

/** The machine/stock/job facts the AI must respect and never invent. */
function describeMachineContext(doc: CADDocument): string {
  const lines: string[] = [];
  lines.push(`- Machine kind: ${doc.machineKind}`);
  lines.push(`- Post-processor: ${getPostFor(doc.isLaser ? "laser" : "mill")}`);
  lines.push(
    `- Work area (canvas): ${doc.canvas.width} × ${doc.canvas.height} mm — keep all geometry inside it`,
  );
  if (doc.stockRect) {
    const s = doc.stockRect;
    lines.push(
      `- Stock: ${s.width} × ${s.height} mm positioned at (${s.x}, ${s.y}) within the sheet (emit it as top-level \`stockRect\`)`,
    );
  } else {
    lines.push("- Stock: fills the sheet (omit `stockRect`)");
  }
  lines.push(`- Stock thickness: ${doc.stockThickness} mm`);
  lines.push(
    `- Origin: x=${doc.origin.x}, y=${doc.origin.y}, z=${doc.origin.z}` +
      " (informational — coordinates in the file are always canvas-frame mm)",
  );
  lines.push(`- Display unit: ${doc.displayUnit} (values in the file stay mm regardless)`);
  lines.push(`- Tool changer: ${getHasToolChanger() ? "yes" : "no"}`);
  if (doc.rotary) {
    const r = doc.rotary;
    lines.push(
      `- Rotary wrap: ${r.axisWord}-axis, cylinder Ø${r.diameter} mm, wrap axis ${r.wrapAxis}, Z0 at ${r.zero ?? "surface"} — the canvas is the unrolled cylinder surface`,
    );
  }
  if (doc.flip) {
    lines.push(
      `- Double-sided (flip) machining is set up: axis "${doc.flip.axis}", registration ${doc.flip.registration} — operations may carry \`face\` "top" or "bottom"`,
    );
  }
  return lines.join("\n");
}

const OUTPUT_RULES = `## Output rules

1. Reply with exactly ONE fenced JSON code block containing the COMPLETE .rcam file, and nothing else inside the block. A short explanation outside the block is fine.
2. \`"version": ${RCAM_VERSION}\`. All lengths in mm, all angles in radians (CCW), world frame Y-up. Every \`id\` a unique non-empty string.
3. Keep the machine context above (canvas, stock, machineKind, postProcessor, rotary/flip) exactly as given unless the task explicitly changes it.
4. You do NOT need perfect coordinates. Emit rough positions plus constraints and driving dimensions; RapidCAM's parametric solver snaps the geometry exact. For simple parts, plain coordinates with no constraints are also perfectly valid.
5. Never author the reserved \`"__origin__"\` entity, and never include \`fonts\` or \`images\` arrays — RapidCAM re-attaches those. When modifying a design, keep every existing \`fontId\` / \`imageId\` reference intact.
6. If the task calls for CAM, reference library tools by \`toolId\` where possible, and keep cut depths within the stock thickness.
7. Keep all geometry inside the work area, away from any \`fixture\` layer geometry.`;

const FEEDBACK_NOTE = `If the user comes back with a "RapidCAM import report" listing errors, fix every listed issue and reply with the complete corrected file — again as a single JSON code block.`;

/**
 * Build the paste-into-a-chatbot prompt.
 *
 * `request` is the user's own description of what they want; when blank a
 * visible placeholder is emitted so they can fill it in inside the chat.
 */
export function buildAiPrompt(
  doc: CADDocument,
  name: string,
  mode: AiPromptMode,
  request?: string,
): string {
  const parts: string[] = [];

  parts.push(
    mode === "new"
      ? `You are authoring a project file for RapidCAM (https://rapidcam.app), a parametric 2D CAD/CAM app for CNC machines. Produce a complete \`.rcam\` file (plain JSON, format version ${RCAM_VERSION}) for the machine and stock described below.`
      : `You are modifying an existing project file for RapidCAM (https://rapidcam.app), a parametric 2D CAD/CAM app for CNC machines. The current design is included below as \`.rcam\` JSON (format version ${RCAM_VERSION}). Apply the requested change and return the COMPLETE updated file — not a diff.`,
  );

  parts.push(`## Machine & job context\n\n${describeMachineContext(doc)}\n\n${describeTools(doc)}`);

  parts.push(OUTPUT_RULES);

  if (mode === "modify") {
    const file = stripEmbeddedFonts(serializeDoc(doc, name));
    parts.push(
      "## Current design\n\n(Embedded font/image payloads are omitted here; keep their id references.)\n\n```json\n" +
        JSON.stringify(file, null, 1) +
        "\n```",
    );
    parts.push(
      "When modifying: preserve the ids of everything you don't change — constraints, dimensions, and operations reference entities by id, and patterns reference their instances.",
    );
  }

  parts.push(
    `## Reference\n\nThe complete .rcam format guide is embedded between the markers below. The machine-readable JSON Schema is at https://rapidcam.app/schema/rcam-v3.schema.json and golden examples at https://rapidcam.app/examples/index.json (fetch them only if you need more detail than the guide).\n\n${GUIDE_BEGIN}\n${formatGuide}\n${GUIDE_END}`,
  );

  const task = request?.trim()
    ? request.trim()
    : mode === "new"
      ? "[Describe the part you want here — shape, key dimensions, hole positions, and whether you want CAM operations.]"
      : "[Describe the change you want here.]";
  parts.push(`## Your task\n\n${task}\n\n${FEEDBACK_NOTE}`);

  return parts.join("\n\n");
}
