/**
 * Flip — double-sided machining with registration.
 *
 * A two-sided part is drawn once, in the top view ("X-ray" model). Each op is
 * tagged with a `face` ("top" | "bottom"); the top ops are cut as drawn, then
 * the operator flips the stock and cuts the bottom ops from a program whose
 * geometry is mirrored about the flip axis — so a feature drawn at (x, y) lands
 * at the same physical spot on the reverse of the part.
 *
 * Registration: at the END of the top-side program (stock still clamped exactly
 * as it was machined) we bore dowel-pin holes through the stock into the
 * spoilboard. The flipped stock drops back onto those dowels, re-registered. For
 * the flip to align, the pin *set* must be invariant under the mirror — each pin
 * has a mirror-image partner, or sits on the flip-axis centreline (the default).
 *
 * Design note — we mirror at the ENTITY level (a cloned document run through the
 * normal generator), NOT at the coordinate formatter. The entity flip
 * ({@link ../core/transform.applyFlipH}/`applyFlipV`) already reverses arc sweeps
 * and polyline winding, so leads, tabs, dogbones, offsets and climb/conventional
 * all come out correct for the reverse side for free. A mirror injected at the
 * X()/Y() emitters would flip the coordinates but leave G2/G3 arc handedness
 * wrong. Mill-only.
 */

import { CADDocument, type FlipSettings } from "../model/document";
import { CircleEntity, TextEntity } from "../model/entities";
import { applyFlipH, applyFlipV } from "../core/transform";
import { generateGCode, type GCodeOptions } from "./gcode";
import { toAsciiGcode } from "./postprocessors/base";
import { DEFAULTS, resolveOpTool, type CAMOperation } from "./types";
import { nextId } from "../model/ids";

/** Positions on/near the flip axis are matched within this tolerance (mm). */
const SYM_TOL = 0.05;

/** The face an op cuts, defaulting undefined → "top". */
export function opFace(op: CAMOperation): "top" | "bottom" {
  return op.face === "bottom" ? "bottom" : "top";
}

/** Split ops into top/bottom sets, preserving document order within each. */
export function partitionOps(ops: CAMOperation[]): { top: CAMOperation[]; bottom: CAMOperation[] } {
  const top: CAMOperation[] = [];
  const bottom: CAMOperation[] = [];
  for (const op of ops) (opFace(op) === "bottom" ? bottom : top).push(op);
  return { top, bottom };
}

/**
 * Two registration pins on the flip-axis centreline, inset from the ends — the
 * simplest correct default (centreline points map to themselves under the
 * mirror). For "h" (mirror X) the centreline is vertical at x = W/2; for "v" it
 * is horizontal at y = H/2.
 */
export function defaultPins(
  canvas: { width: number; height: number },
  axis: "h" | "v",
  inset?: number,
): { x: number; y: number }[] {
  if (axis === "h") {
    const cx = canvas.width / 2;
    const d = inset ?? Math.min(15, canvas.height * 0.2);
    return [
      { x: cx, y: d },
      { x: cx, y: canvas.height - d },
    ];
  }
  const cy = canvas.height / 2;
  const d = inset ?? Math.min(15, canvas.width * 0.2);
  return [
    { x: d, y: cy },
    { x: canvas.width - d, y: cy },
  ];
}

/** A sensible default flip setup for a document (pins on the centreline). */
export function defaultFlipSettings(doc: CADDocument): FlipSettings {
  const axis: "h" | "v" = "h";
  return {
    axis,
    registration: "pins",
    pinDiameter: 6,
    pinDepth: 4,
    pins: defaultPins(doc.canvas, axis),
  };
}

/** Mirror a point about the flip axis of a stock of the given size. */
export function mirrorPoint(
  p: { x: number; y: number },
  axis: "h" | "v",
  canvas: { width: number; height: number },
): { x: number; y: number } {
  return axis === "h" ? { x: canvas.width - p.x, y: p.y } : { x: p.x, y: canvas.height - p.y };
}

/**
 * Whether the pin set is invariant under the flip mirror — every pin has a
 * partner at its mirror image (a centreline pin is its own partner). Required
 * for the flipped stock's holes to land back on the same physical dowels.
 */
export function pinsSymmetric(
  pins: { x: number; y: number }[],
  axis: "h" | "v",
  canvas: { width: number; height: number },
): boolean {
  for (const p of pins) {
    const m = mirrorPoint(p, axis, canvas);
    if (!pins.some((q) => Math.hypot(q.x - m.x, q.y - m.y) <= SYM_TOL)) return false;
  }
  return true;
}

/** Deep-clone a document via its own snapshot/restore path. */
export function cloneDoc(doc: CADDocument): CADDocument {
  const c = new CADDocument({ ...doc.canvas }, doc.displayUnit);
  c.restore(doc.snapshot());
  return c;
}

/**
 * A clone of the document with all geometry mirrored about the flip axis — the
 * frame the bottom-side program is generated in. The WCS origin point stays
 * put; see {@link validateFlip}.
 */
export function mirrorDocForFlip(doc: CADDocument, axis: "h" | "v"): CADDocument {
  const c = cloneDoc(doc);
  const center = axis === "h" ? c.canvas.width / 2 : c.canvas.height / 2;
  // Text is excluded from the editor-level flip: applyFlipH/V keep text
  // readable and only relocate its footprint (MIRRTEXT=0 convention), but the
  // reverse side needs a TRUE mirror image. The `mirror` flag makes
  // textToContours reflect the glyph outlines — position included — about the
  // axis, so the engrave reads correctly from the flipped face.
  const nonText = c.entities.filter((e) => !(e instanceof TextEntity));
  if (axis === "h") applyFlipH(nonText, center);
  else applyFlipV(nonText, center);
  for (const e of c.entities) {
    if (e instanceof TextEntity) e.mirror = { axis, c: center };
  }
  return c;
}

/**
 * Build the registration pin geometry + a synthetic op that bores it, sized from
 * a prototype op (the last top-side op = the tool already in the spindle). Bores
 * to `pinDiameter` when it exceeds the tool (helical pocket), else drills a
 * tool-diameter hole. Depth reaches `pinDepth` into the spoilboard past the
 * stock bottom.
 */
function pinBore(
  doc: CADDocument,
  flip: FlipSettings,
  protoRaw: CAMOperation | undefined,
): { circles: CircleEntity[]; op: CAMOperation } {
  // Resolve any library-tool reference so the bore's geometry/feeds match the
  // physical tool (and agree with validateFlip's guards).
  const proto = protoRaw ? resolveOpTool(protoRaw, doc.tools) : undefined;
  const diameter = proto?.diameter ?? DEFAULTS.diameter;
  const toolNumber = proto?.toolNumber ?? DEFAULTS.toolNumber;
  const feedrate = proto?.feedrate ?? DEFAULTS.feedrate;
  const plungeRate = proto?.plungeRate ?? DEFAULTS.plungeRate;
  const spindleSpeed = proto?.spindleSpeed ?? DEFAULTS.spindleSpeed;
  const safeZ = proto?.safeZ ?? DEFAULTS.safeZ;
  const stepdown = proto?.stepdown ?? DEFAULTS.stepdown;

  const r = flip.pinDiameter / 2;
  const circles = flip.pins.map((p) => new CircleEntity({ x: p.x, y: p.y }, r, nextId("flippin")));
  // A pin wider than the tool is bored out (helical pocket-on-circle); a pin at
  // ~tool diameter is a straight drilled hole.
  const helical = flip.pinDiameter > diameter + 0.2;
  const depth = -(doc.stockThickness + flip.pinDepth);

  const op: CAMOperation = {
    id: nextId("cam"),
    name: `Registration pin holes ⌀${flip.pinDiameter}mm`,
    type: helical ? "pocket" : "drill",
    entityIds: circles.map((c) => c.id),
    side: "inside",
    // A flat end mill bores a clean round hole regardless of the prototype's
    // geometry; keep its diameter/feeds and T-number so no tool change is forced.
    toolType: "end-mill",
    toolNumber,
    diameter,
    feedrate,
    plungeRate,
    spindleSpeed,
    safeZ,
    depth,
    stepdown,
    stepover: proto?.stepover ?? DEFAULTS.stepover,
    // Peck a straight-drilled hole so chips clear on the way through the stock.
    ...(helical ? {} : { peckDepth: Math.max(0.5, stepdown) }),
  };
  return { circles, op };
}

export interface FlipPrograms {
  /** Top-side program (cut as drawn), plus registration bores when enabled. */
  sideA: string;
  /** Bottom-side program (geometry mirrored about the flip axis), or "" if no bottom ops. */
  sideB: string;
  hasBottom: boolean;
  hasPins: boolean;
  /** Non-fatal advisories to surface before export (see {@link validateFlip}). */
  warnings: string[];
}

/** Comment banner prepended to a side's program with operator instructions. */
function sideBanner(side: "A" | "B", doc: CADDocument, flip: FlipSettings): string {
  const t = doc.stockThickness;
  const dir =
    flip.axis === "h"
      ? "left ↔ right (about the vertical centreline)"
      : "near ↔ far (about the horizontal centreline)";
  if (side === "A") {
    const pins =
      flip.registration === "pins" && flip.pins.length
        ? `; This program ends by boring ${flip.pins.length} registration pin hole${flip.pins.length > 1 ? "s" : ""} ` +
          `(⌀${flip.pinDiameter}mm, ${flip.pinDepth}mm into the spoilboard) — keep the stock clamped.\n`
        : "";
    return (
      `; === Double-sided job — SIDE A (top) ===\n` +
      `; Cut this side first with the stock as drawn.\n` +
      pins +
      `; Stock thickness ${t}mm must be accurate — the reverse side references it.\n`
    );
  }
  return (
    `; === Double-sided job — SIDE B (bottom) ===\n` +
    `; Flip the stock ${dir}` +
    (flip.registration === "pins" ? ` onto the registration pins` : ``) +
    `.\n` +
    `; Re-zero Z on the NEW top face; keep X/Y zero at the same machine position.\n` +
    `; Geometry is already mirrored to match the flipped stock.\n`
  );
}

/**
 * Non-fatal advisories for a flip setup — asymmetric pins, pins off the stock,
 * un-mirrorable text on the bottom, and a top-side through-cut that could free
 * the part before the flip. Returns human sentences; an empty array = all clear.
 */
export function validateFlip(doc: CADDocument): string[] {
  const flip = doc.flip;
  if (!flip) return [];
  const out: string[] = [];
  const { top, bottom } = partitionOps(doc.operations);

  if (bottom.length === 0) {
    out.push(
      'No operations are assigned to the bottom face — nothing will be cut on side B. Set an op\'s face to "Bottom".',
    );
  }

  if (flip.registration === "pins") {
    if (flip.pins.length === 0) {
      out.push(
        "Registration is set to pins but none are placed — the flipped stock has nothing to align to.",
      );
    } else {
      if (!pinsSymmetric(flip.pins, flip.axis, doc.canvas)) {
        out.push(
          "Registration pins are not symmetric about the flip axis — after flipping, the holes won't line up on the dowels. Place pins on the centreline or in mirror-image pairs.",
        );
      }
      for (const p of flip.pins) {
        if (p.x < 0 || p.x > doc.canvas.width || p.y < 0 || p.y > doc.canvas.height) {
          out.push("A registration pin lies outside the stock — move it within the material.");
          break;
        }
      }

      // The pins are bored with the last top-side tool (whatever is in the
      // spindle). Guard the two ways that goes wrong.
      const protoRaw = top[top.length - 1];
      const proto = protoRaw ? resolveOpTool(protoRaw, doc.tools) : undefined;
      if (proto) {
        if (proto.toolType === "v-bit" || proto.toolType === "ball-nose") {
          out.push(
            `The registration pins would be bored with the last top-side tool — a ${proto.toolType}, which can't cut a clean straight hole. Make the last top op use a flat end mill, or bore the pins in a separate setup.`,
          );
        }
        if (flip.pinDiameter < proto.diameter - 0.05) {
          out.push(
            `Pin diameter (${flip.pinDiameter}mm) is smaller than the boring tool (${proto.diameter}mm), so the hole comes out tool-sized — too loose for the dowel. Use a pin at least the tool diameter, or a smaller boring tool.`,
          );
        }
      }
    }
  }

  // A top-side outside profile that cuts fully through frees the part before the
  // flip (and before the pins are bored).
  const frees = top.some(
    (op) =>
      op.type === "profile" &&
      op.side === "outside" &&
      op.depth <= -doc.stockThickness + 1e-6 &&
      !op.tabs?.enabled,
  );
  if (frees && bottom.length > 0) {
    out.push(
      "A top-side outside profile cuts through the full stock thickness with no tabs — the part comes loose before the flip. Add holding tabs, or move the cut-out to the bottom side.",
    );
  }

  return out;
}

/** The ops + (cloned/mirrored) document that define one machining side. */
export interface FlipSide {
  ops: CAMOperation[];
  doc: CADDocument;
}

/** Whether the flip setup bores registration pins (pins mode + at least one pin). */
export function flipUsesPins(doc: CADDocument): boolean {
  const flip = doc.flip ?? defaultFlipSettings(doc);
  return flip.registration === "pins" && flip.pins.length > 0;
}

/**
 * Build side A — a clone carrying the top ops (cut as drawn) plus the
 * registration pin bores appended at the end. Each build is a fresh document
 * clone, so callers that only need one side don't pay to build the other.
 */
export function buildSideA(doc: CADDocument): FlipSide {
  const flip = doc.flip ?? defaultFlipSettings(doc);
  const docA = cloneDoc(doc);
  const topA = docA.operations.filter((op) => opFace(op) !== "bottom");
  if (flipUsesPins(doc)) {
    const { circles, op } = pinBore(docA, flip, topA[topA.length - 1]);
    for (const c of circles) docA.entities.push(c);
    return { ops: [...topA, op], doc: docA };
  }
  return { ops: topA, doc: docA };
}

/**
 * Build side B — a mirrored clone carrying the bottom ops, or `null` when there
 * are none. Only clones/mirrors when actually needed.
 */
export function buildSideB(doc: CADDocument): FlipSide | null {
  const flip = doc.flip ?? defaultFlipSettings(doc);
  if (partitionOps(doc.operations).bottom.length === 0) return null;
  const docB = mirrorDocForFlip(doc, flip.axis);
  return { ops: docB.operations.filter((op) => opFace(op) === "bottom"), doc: docB };
}

/**
 * Resolve a flip setup into both machining sides, as (ops, document) pairs — the
 * single source of truth shared by G-code export ({@link generateFlipPrograms})
 * and the 3D preview. Callers that need only one side should use
 * {@link buildSideA} / {@link buildSideB} directly to avoid cloning the other.
 */
export function flipSides(doc: CADDocument): {
  sideA: FlipSide;
  sideB: FlipSide | null;
  hasPins: boolean;
} {
  return { sideA: buildSideA(doc), sideB: buildSideB(doc), hasPins: flipUsesPins(doc) };
}

/**
 * Generate the top-side and (mirrored) bottom-side G-code programs for a
 * double-sided job. Requires `doc.flip` to be set; partitions ops by face,
 * appends registration bores to side A, and mirrors the document for side B.
 */
export function generateFlipPrograms(doc: CADDocument, opts: GCodeOptions = {}): FlipPrograms {
  const flip = doc.flip ?? defaultFlipSettings(doc);
  const warnings = validateFlip(doc);
  const { sideA, sideB, hasPins } = flipSides(doc);

  const a = toAsciiGcode(`${sideBanner("A", doc, flip)}\n${generateGCode(sideA.ops, sideA.doc, opts)}`);
  const b = sideB
    ? toAsciiGcode(`${sideBanner("B", doc, flip)}\n${generateGCode(sideB.ops, sideB.doc, opts)}`)
    : "";

  return { sideA: a, sideB: b, hasBottom: sideB !== null, hasPins, warnings };
}
