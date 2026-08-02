/**
 * Structured checking for externally-authored (hand- or AI-written) .rcam
 * text, and a paste-back error report for the AI that wrote it.
 *
 * The pipeline runs the same machinery a real open does — parse, (optionally)
 * schema-validate, load into a scratch CADDocument, solve, dry-run the machine
 * program(s) and Apollo pre-flight lint them — plus reference checks the
 * tolerant loader won't complain about, and reports everything as a flat
 * issue list instead of throwing at the first problem. Used by the AI
 * Assistant paste-import dialog and the headless CLI.
 *
 * Schema validation is injected: the browser lazy-loads ajv + fetches the
 * published schema only when the dialog is used, the CLI compiles it from
 * disk, and tests can pass a stub.
 */

import { postPrograms } from "../cam/postPrograms";
import { CADDocument, ORIGIN_ENTITY_ID, STOCK_ENTITY_ID } from "../model/document";
import { RasterImageEntity } from "../model/entities";
import { solve } from "../solver/solver";
import { applyFile, normalizeRcam, type RcamFile } from "./fileio";

export interface AiIssue {
  severity: "error" | "warning";
  /** Which check produced it: "json" | "schema" | "load" | "refs" | "solver" | "bounds" | "toolpath" | "lint". */
  check: string;
  message: string;
}

export interface AiCheckResult {
  /** The parsed file when it got far enough to load, else null. */
  file: RcamFile | null;
  /** The loaded scratch document when the file loaded, else null. */
  doc: CADDocument | null;
  issues: AiIssue[];
  /** True when there are no error-severity issues (warnings allowed). */
  ok: boolean;
}

/** Returns [] when valid, else one entry per violation. */
export type SchemaValidator = (data: unknown) => { path: string; message: string }[];

/**
 * Normalize an ajv error into a path + message, appending the enum options
 * when there are any — "must be equal to one of the allowed values" with the
 * values withheld sent one field-tested AI into a guessing loop.
 */
export function formatSchemaIssue(e: {
  instancePath?: string;
  message?: string;
  params?: Record<string, unknown>;
}): { path: string; message: string } {
  const allowed = e.params?.allowedValues;
  const suffix = Array.isArray(allowed)
    ? ` (allowed: ${allowed.map((v) => JSON.stringify(v)).join(", ")})`
    : "";
  return { path: e.instancePath ?? "", message: `${e.message ?? "invalid"}${suffix}` };
}

/**
 * Chat replies usually wrap the file in a ```json fence with prose around it.
 * Accept raw JSON as-is, otherwise take the outermost { … } span.
 */
export function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) return trimmed.slice(first, last + 1);
  return trimmed;
}

function refIssues(file: RcamFile): AiIssue[] {
  const issues: AiIssue[] = [];
  const entityIds = new Set(
    (file.entities as { id?: string }[]).map((e) => e.id).filter((id): id is string => !!id),
  );
  const toolIds = new Set(
    ((file.tools ?? []) as { id?: string }[]).map((t) => t.id).filter(Boolean),
  );
  /**
   * Reserved synthetic entities. Neither is ever serialized into `entities`,
   * but both are legitimate, resolvable reference targets at runtime — the
   * origin point, and the stock rectangle's edges/corners (see
   * STOCK_ENTITY_ID in model/document.ts and stockRefDimension.test.ts).
   * Omitting __stock__ here rejected any file containing a dimension
   * anchored to a stock edge — a fully supported thing to draw — so a design
   * that saved cleanly then failed its own import check on reopen.
   */
  const SYNTHETIC_IDS = new Set<string>([ORIGIN_ENTITY_ID, STOCK_ENTITY_ID]);
  const missing = (id: string) => !SYNTHETIC_IDS.has(id) && !entityIds.has(id);

  type PointRef = { entityId?: string };
  const scanPointRefs = (section: string, items: unknown[] | undefined) => {
    for (const item of (items ?? []) as { id?: string; points?: PointRef[] }[]) {
      for (const p of item.points ?? []) {
        if (p.entityId && missing(p.entityId)) {
          issues.push({
            severity: "error",
            check: "refs",
            message: `${section} "${item.id ?? "?"}" references entity "${p.entityId}", which does not exist`,
          });
        }
      }
    }
  };
  scanPointRefs("constraint", file.constraints);
  scanPointRefs("dimension", file.dimensions);

  for (const c of (file.constraints ?? []) as { id?: string; entities?: string[] }[]) {
    for (const ref of c.entities ?? []) {
      // A "<polylineId>#<vertexId>" segment reference resolves by the polyline id.
      const id = ref.split("#")[0];
      if (missing(id)) {
        issues.push({
          severity: "error",
          check: "refs",
          message: `constraint "${c.id ?? "?"}" references entity "${ref}", which does not exist`,
        });
      }
    }
  }

  for (const b of (file.bindings ?? []) as { entityId?: string; scalarKey?: string }[]) {
    if (b.entityId && missing(b.entityId)) {
      issues.push({
        severity: "error",
        check: "refs",
        message: `binding on "${b.entityId}.${b.scalarKey ?? "?"}" references an entity that does not exist`,
      });
    }
  }

  for (const op of (file.operations ?? []) as {
    id?: string;
    name?: string;
    entityIds?: string[];
    toolId?: string;
  }[]) {
    for (const id of op.entityIds ?? []) {
      if (missing(id)) {
        issues.push({
          severity: "error",
          check: "refs",
          message: `operation "${op.name ?? op.id ?? "?"}" targets entity "${id}", which does not exist`,
        });
      }
    }
    if (op.toolId && !toolIds.has(op.toolId)) {
      issues.push({
        severity: "warning",
        check: "refs",
        message: `operation "${op.name ?? op.id ?? "?"}" has toolId "${op.toolId}" that is not in the file's tools array — its inline tool fields will be used instead`,
      });
    }
  }

  // Two driving dimensions measuring the same thing are redundant; three with
  // differing values cannot all hold. The solver reports only that it failed,
  // so the duplicates have to be named here or they are near-impossible to
  // find by eye in a long dimension list.
  const bySubject = new Map<string, string[]>();
  for (const d of (file.dimensions ?? []) as {
    id?: string;
    type?: string;
    driving?: boolean;
    entities?: string[];
    points?: { entityId?: string; key?: string }[];
  }[]) {
    if (d.driving === false) continue;
    const ents = [...(d.entities ?? [])].sort().join(",");
    const pts = (d.points ?? [])
      .map((p) => `${p.entityId}:${p.key}`)
      .sort()
      .join(",");
    const k = `${d.type}|${ents}|${pts}`;
    bySubject.set(k, [...(bySubject.get(k) ?? []), d.id ?? "?"]);
  }
  for (const ids of bySubject.values()) {
    if (ids.length > 1) {
      issues.push({
        severity: "warning",
        check: "refs",
        message: `${ids.length} driving dimensions measure the same thing (${ids.join(", ")}) — only one can drive it, and further dimensions on that measurement will fail to solve`,
      });
    }
  }

  const imageIds = new Set(((file.images ?? []) as { id?: string }[]).map((i) => i.id));
  for (const e of file.entities as { type?: string; id?: string; imageId?: string }[]) {
    if (e.type === "image" && e.imageId && !imageIds.has(e.imageId)) {
      issues.push({
        severity: "warning",
        check: "refs",
        message: `image entity "${e.id ?? "?"}" references imageId "${e.imageId}" with no matching entry in the images array — its pixels only resolve if already loaded in this session`,
      });
    }
  }

  return issues;
}

function boundsIssues(doc: CADDocument): AiIssue[] {
  const eps = 1e-6;
  const outside: string[] = [];
  for (const e of doc.entities) {
    if (e.id === ORIGIN_ENTITY_ID) continue;
    const b = e.bounds();
    if (!Number.isFinite(b.min.x) || !Number.isFinite(b.max.x)) continue;
    if (
      b.min.x < -eps ||
      b.min.y < -eps ||
      b.max.x > doc.canvas.width + eps ||
      b.max.y > doc.canvas.height + eps
    ) {
      outside.push(e.id);
    }
  }
  if (!outside.length) return [];
  return [
    {
      severity: "warning",
      check: "bounds",
      message: `${outside.length} entit${outside.length === 1 ? "y extends" : "ies extend"} outside the ${doc.canvas.width}×${doc.canvas.height} mm sheet: ${outside.slice(0, 8).join(", ")}${outside.length > 8 ? ", …" : ""}`,
    },
  ];
}

/**
 * Dry-run the real machine program(s) — routed by machine kind exactly as the
 * export button routes (mill / laser / rotary wrap / double-sided flip) — and
 * surface two kinds of findings:
 *
 * - every `; NOTE:` skip the generators emit (check "toolpath") — the field
 *   test showed a file can pass every structural check while its main
 *   operation silently produces zero cutting moves (e.g. geometry the profile
 *   chainer couldn't close);
 * - every Apollo pre-flight lint finding over each generated program (check
 *   "lint") — out-of-bounds toolpaths, over-deep cuts, fast plunges, missing
 *   tool-change pauses. These are ALWAYS reported as warnings (prefixed with
 *   the lint's own severity) so a machinability advisory never blocks an
 *   import the app itself would allow to export.
 *
 * Skipped entirely when an op targets a raster image, whose relief/raster
 * generation can emit 100k+ lines.
 */
function toolpathIssues(doc: CADDocument): AiIssue[] {
  if (doc.operations.length === 0) return [];
  const imageIds = new Set(
    doc.entities.filter((e) => e instanceof RasterImageEntity).map((e) => e.id),
  );
  if (doc.operations.some((op) => op.entityIds.some((id) => imageIds.has(id)))) return [];
  try {
    const { programs } = postPrograms(doc, "check");
    const notes = new Set<string>();
    const lintKeys = new Set<string>();
    const lintIssues: AiIssue[] = [];
    for (const p of programs) {
      for (const line of p.gcode.split("\n")) {
        if (line.startsWith("; NOTE:")) notes.add(line.slice("; NOTE:".length).trim());
      }
      for (const f of p.lint) {
        const key = `${f.code}|${f.message}`;
        if (lintKeys.has(key)) continue;
        lintKeys.add(key);
        lintIssues.push({
          severity: "warning",
          check: "lint",
          message: `${f.severity}: ${f.message}`,
        });
      }
    }
    return [
      ...[...notes].map((n) => ({
        severity: "warning" as const,
        check: "toolpath",
        message: `the G-code generator skipped work: ${n}`,
      })),
      ...lintIssues,
    ];
  } catch (e) {
    return [
      {
        severity: "error",
        check: "toolpath",
        message: `G-code generation failed: ${(e as Error).message}`,
      },
    ];
  }
}

/**
 * Run the full checking pipeline on raw .rcam text. Never throws; every
 * failure becomes an issue. Schema errors stop the pipeline (a file that
 * violates the schema isn't worth solver diagnostics), load errors likewise.
 */
export function checkRcamText(text: string, validateSchema?: SchemaValidator): AiCheckResult {
  const issues: AiIssue[] = [];
  const fail = (): AiCheckResult => ({ file: null, doc: null, issues, ok: false });

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    issues.push({
      severity: "error",
      check: "json",
      message: `not valid JSON: ${(e as Error).message}`,
    });
    return fail();
  }

  let file: RcamFile;
  try {
    file = normalizeRcam(raw);
  } catch (e) {
    issues.push({ severity: "error", check: "load", message: (e as Error).message });
    return fail();
  }

  if (validateSchema) {
    for (const err of validateSchema(file)) {
      issues.push({
        severity: "error",
        check: "schema",
        message: `${err.path || "<root>"}: ${err.message}`,
      });
    }
    if (issues.length) return fail();
  }

  const doc = new CADDocument({ width: 100, height: 100 }); // applyFile overwrites the canvas
  try {
    applyFile(doc, file);
  } catch (e) {
    issues.push({
      severity: "error",
      check: "load",
      message: `RapidCAM could not load the file: ${(e as Error).message}`,
    });
    return { file, doc: null, issues, ok: false };
  }

  issues.push(...refIssues(file));

  try {
    const res = solve(doc);
    if (res.hasConstraints && !res.converged) {
      issues.push({
        severity: "error",
        check: "solver",
        message: `the constraint system did not converge (residual ${res.residualNorm.toExponential(2)} mm over ${res.equations} equations) — the constraints are contradictory or the starting geometry is too far from a solution`,
      });
    }
  } catch (e) {
    issues.push({
      severity: "error",
      check: "solver",
      message: `the constraint solver failed: ${(e as Error).message}`,
    });
  }

  issues.push(...boundsIssues(doc));
  issues.push(...toolpathIssues(doc));

  return { file, doc, issues, ok: !issues.some((i) => i.severity === "error") };
}

/**
 * Format a check result as a markdown report the user pastes back to the AI
 * that authored the file. Written to the AI, not the user — it restates the
 * output contract so the fix comes back in one importable piece.
 */
export function buildErrorReport(result: AiCheckResult, name = "pasted file"): string {
  // ajv with allErrors reports every failed branch of a oneOf, so one bad
  // entity can produce dozens of near-duplicate lines. Dedupe and cap; an AI
  // fixes files better from a short precise list than an avalanche.
  const MAX_ERRORS = 25;
  const dedup = [...new Map(result.issues.map((i) => [`${i.check}|${i.message}`, i])).values()];
  const allErrors = dedup.filter((i) => i.severity === "error");
  const errors = allErrors.slice(0, MAX_ERRORS);
  const warnings = dedup.filter((i) => i.severity === "warning");
  const lines: string[] = [];
  lines.push(`# RapidCAM import report — ${name}`);
  lines.push("");
  lines.push(
    allErrors.length
      ? `The .rcam file failed ${allErrors.length} check${allErrors.length === 1 ? "" : "s"} in RapidCAM. Fix every issue below and reply with the complete corrected file as a single JSON code block.`
      : "The .rcam file imported, with warnings worth reviewing.",
  );
  if (errors.length) {
    lines.push("", "## Errors");
    for (const i of errors) lines.push(`- [${i.check}] ${i.message}`);
    if (allErrors.length > errors.length) {
      lines.push(`- …and ${allErrors.length - errors.length} more`);
    }
  }
  if (warnings.length) {
    lines.push("", "## Warnings");
    for (const i of warnings) lines.push(`- [${i.check}] ${i.message}`);
  }
  lines.push(
    "",
    "Reference: format guide https://rapidcam.app/docs/rcam-format-v3.md — schema https://rapidcam.app/schema/rcam-v3.schema.json",
  );
  return lines.join("\n");
}
