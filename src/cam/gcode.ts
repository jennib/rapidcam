import type { Vec2 } from "../core/vec2";
import { type CADDocument, resolveOrigin } from "../model/document";
import { LineEntity, CircleEntity, RectEntity, PolylineEntity } from "../model/entities";
import type { CAMOperation } from "./types";
import { offsetPolygon } from "./offset";

/** Format a number to ≤3 decimal places, stripping trailing zeros. */
function n(v: number): string {
  return parseFloat(v.toFixed(3)).toString();
}

function depthPasses(op: CAMOperation): number[] {
  const total = Math.abs(op.depth);
  const count = Math.max(1, Math.ceil(total / op.stepdown));
  const passes: number[] = [];
  for (let i = 1; i <= count; i++) {
    passes.push(-Math.min(i * op.stepdown, total));
  }
  return passes;
}

// Coordinate helpers — apply WCS offsets
function X(v: number, ox: number): string { return n(v - ox); }
function Y(v: number, oy: number): string { return n(v - oy); }
function Z(v: number, zOff: number): string { return n(v + zOff); }

// --- profile -----------------------------------------------------------------

function profilePolygon(
  verts: Vec2[], op: CAMOperation,
  ox: number, oy: number, zOff: number,
): string[] {
  const toolR = op.diameter / 2;
  const path = offsetPolygon(verts, op.side === "outside" ? toolR : -toolR);
  if (path.length < 2) return [];

  const lines: string[] = [];
  const s = path[0];
  for (const z of depthPasses(op)) {
    lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
    lines.push(`G0 X${X(s.x, ox)} Y${Y(s.y, oy)}`);
    lines.push(`G1 Z${Z(z, zOff)} F${n(op.plungeRate)}`);
    for (let i = 1; i < path.length; i++) {
      const f = i === 1 ? ` F${n(op.feedrate)}` : "";
      lines.push(`G1 X${X(path[i].x, ox)} Y${Y(path[i].y, oy)}${f}`);
    }
    lines.push(`G1 X${X(s.x, ox)} Y${Y(s.y, oy)}`);
  }
  lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
  return lines;
}

function profileCircle(
  cx: number, cy: number, r: number, op: CAMOperation,
  ox: number, oy: number, zOff: number,
): string[] {
  const toolR = op.diameter / 2;
  const cutR = op.side === "outside" ? r + toolR : r - toolR;
  if (cutR <= 0)
    return [`; WARNING: tool ⌀${op.diameter}mm too large for inside circle r=${r}mm — skipped`];

  const lines: string[] = [];
  const sx = cx + cutR;
  for (const z of depthPasses(op)) {
    lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
    lines.push(`G0 X${X(sx, ox)} Y${Y(cy, oy)}`);
    lines.push(`G1 Z${Z(z, zOff)} F${n(op.plungeRate)}`);
    lines.push(`G2 X${X(sx, ox)} Y${Y(cy, oy)} I${n(-cutR)} J0 F${n(op.feedrate)}`);
  }
  lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
  return lines;
}

// --- engrave -----------------------------------------------------------------

function engravePoints(
  pts: Vec2[], closed: boolean, op: CAMOperation,
  ox: number, oy: number, zOff: number,
): string[] {
  if (pts.length === 0) return [];
  const lines: string[] = [];
  const s = pts[0];
  for (const z of depthPasses(op)) {
    lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
    lines.push(`G0 X${X(s.x, ox)} Y${Y(s.y, oy)}`);
    lines.push(`G1 Z${Z(z, zOff)} F${n(op.plungeRate)}`);
    for (let i = 1; i < pts.length; i++) {
      const f = i === 1 ? ` F${n(op.feedrate)}` : "";
      lines.push(`G1 X${X(pts[i].x, ox)} Y${Y(pts[i].y, oy)}${f}`);
    }
    if (closed && pts.length > 2) lines.push(`G1 X${X(s.x, ox)} Y${Y(s.y, oy)}`);
  }
  lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
  return lines;
}

function engraveCircle(
  cx: number, cy: number, r: number, op: CAMOperation,
  ox: number, oy: number, zOff: number,
): string[] {
  const lines: string[] = [];
  const sx = cx + r;
  for (const z of depthPasses(op)) {
    lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
    lines.push(`G0 X${X(sx, ox)} Y${Y(cy, oy)}`);
    lines.push(`G1 Z${Z(z, zOff)} F${n(op.plungeRate)}`);
    lines.push(`G2 X${X(sx, ox)} Y${Y(cy, oy)} I${n(-r)} J0 F${n(op.feedrate)}`);
  }
  lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
  return lines;
}

// --- drill -------------------------------------------------------------------

function drillPoint(
  cx: number, cy: number, op: CAMOperation,
  ox: number, oy: number, zOff: number,
): string[] {
  return [
    `G0 Z${Z(op.safeZ, zOff)}`,
    `G0 X${X(cx, ox)} Y${Y(cy, oy)}`,
    `G1 Z${Z(op.depth, zOff)} F${n(op.plungeRate)}`,
    `G0 Z${Z(op.safeZ, zOff)}`,
  ];
}

// --- toolpath body (no spindle/tool-change preamble) -------------------------

function toolpathBody(op: CAMOperation, doc: CADDocument, ox: number, oy: number, zOff: number): string[] {
  const lines: string[] = [];
  const entityMap = new Map(doc.entities.map((e) => [e.id, e]));

  for (const id of op.entityIds) {
    const ent = entityMap.get(id);
    if (!ent || ent.isConstruction) continue;

    if (op.type === "drill") {
      if (ent instanceof CircleEntity)
        lines.push(...drillPoint(ent.center.x, ent.center.y, op, ox, oy, zOff));
      continue;
    }

    if (op.type === "engrave") {
      if (ent instanceof LineEntity)
        lines.push(...engravePoints([ent.a, ent.b], false, op, ox, oy, zOff));
      else if (ent instanceof CircleEntity)
        lines.push(...engraveCircle(ent.center.x, ent.center.y, ent.radius, op, ox, oy, zOff));
      else if (ent instanceof RectEntity)
        lines.push(...engravePoints([...ent.corners()], true, op, ox, oy, zOff));
      else if (ent instanceof PolylineEntity)
        lines.push(...engravePoints(ent.points, ent.closed, op, ox, oy, zOff));
      continue;
    }

    // profile
    if (ent instanceof CircleEntity)
      lines.push(...profileCircle(ent.center.x, ent.center.y, ent.radius, op, ox, oy, zOff));
    else if (ent instanceof RectEntity)
      lines.push(...profilePolygon([...ent.corners()], op, ox, oy, zOff));
    else if (ent instanceof PolylineEntity && ent.closed)
      lines.push(...profilePolygon(ent.points, op, ox, oy, zOff));
    else if (ent instanceof PolylineEntity)
      lines.push(`; NOTE: open polyline (${ent.id}) skipped — profile requires closed geometry`);
    else if (ent instanceof LineEntity)
      lines.push("; NOTE: open line skipped — profile requires closed geometry");
  }
  return lines;
}

// --- main entry --------------------------------------------------------------

export function generateGCode(ops: CAMOperation[], doc: CADDocument): string {
  if (ops.length === 0) return "; No toolpaths\nM30\n";

  const { ox, oy, zOffset } = resolveOrigin(doc);

  const xLabel = { left: "Left", center: "Center", right: "Right" }[doc.origin.x];
  const yLabel = { front: "Front", center: "Center", back: "Back" }[doc.origin.y];
  const zLabel = doc.origin.z === "top"
    ? "Top of stock"
    : `Bed (top at Z=${n(doc.stockThickness)}mm)`;

  // Unique tools summary
  const toolsSeen = new Map<number, CAMOperation>();
  for (const op of ops) {
    if (!toolsSeen.has(op.toolNumber)) toolsSeen.set(op.toolNumber, op);
  }
  const toolSummary = [...toolsSeen.entries()]
    .sort(([a], [b]) => a - b)
    .map(([t, op]) => `T${t} ⌀${op.diameter}mm ${op.spindleSpeed}rpm`)
    .join(", ");

  const lines: string[] = [
    "; RapidCAM generated G-code",
    `; ${ops.length} toolpath${ops.length !== 1 ? "s" : ""}`,
    `; WCS origin X: ${xLabel}  Y: ${yLabel}  Z: ${zLabel}`,
    `; Stock: ${doc.canvas.width} × ${doc.canvas.height} × ${doc.stockThickness}mm`,
    `; Tools: ${toolSummary}`,
    "G21 ; metric",
    "G90 ; absolute",
    "G17 ; XY plane",
    "",
  ];

  let currentTool: number | null = null;
  let currentSpeed: number | null = null;

  for (const op of ops) {
    const toolChanged = op.toolNumber !== currentTool;
    const speedChanged = op.spindleSpeed !== currentSpeed;
    const isFirst = currentTool === null;

    if (toolChanged || isFirst) {
      if (!isFirst) {
        // Retract and stop spindle before tool change
        lines.push(`G0 Z${n(op.safeZ + (doc.origin.z === "bed" ? doc.stockThickness : 0))}`);
        lines.push("M5 ; spindle stop");
      }

      if (doc.hasToolChanger) {
        lines.push(`T${op.toolNumber} M6 ; tool change`);
      } else if (!isFirst && toolChanged) {
        lines.push(`; *** Manual tool change to T${op.toolNumber} (⌀${op.diameter}mm) ***`);
        lines.push("; M0 ; uncomment to pause for manual tool change");
      }

      lines.push(`M3 S${op.spindleSpeed} ; spindle on`);
      lines.push("");
    } else if (speedChanged) {
      lines.push(`S${op.spindleSpeed} ; spindle speed change`);
    }

    currentTool = op.toolNumber;
    currentSpeed = op.spindleSpeed;

    const typeLabel =
      op.type === "profile" ? `Profile (${op.side})`
      : op.type === "engrave" ? "Engrave"
      : "Drill";
    lines.push(`; --- ${typeLabel} "${op.name}"  T${op.toolNumber} ⌀${op.diameter}mm  depth:${op.depth}mm ---`);
    lines.push(...toolpathBody(op, doc, ox, oy, zOffset));
    lines.push("");
  }

  lines.push("M5 ; spindle stop");
  lines.push("M30 ; end program");
  return lines.join("\n");
}
