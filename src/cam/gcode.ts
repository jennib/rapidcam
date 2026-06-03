import type { Vec2 } from "../core/vec2";
import type { CADDocument } from "../model/document";
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

// --- profile -----------------------------------------------------------------

function profilePolygon(verts: Vec2[], op: CAMOperation): string[] {
  const toolR = op.diameter / 2;
  const offset = op.side === "outside" ? toolR : -toolR;
  const path = offsetPolygon(verts, offset);
  if (path.length < 2) return [];

  const lines: string[] = [];
  const s = path[0];
  for (const z of depthPasses(op)) {
    lines.push(`G0 Z${n(op.safeZ)}`);
    lines.push(`G0 X${n(s.x)} Y${n(s.y)}`);
    lines.push(`G1 Z${n(z)} F${n(op.plungeRate)}`);
    for (let i = 1; i < path.length; i++) {
      const f = i === 1 ? ` F${n(op.feedrate)}` : "";
      lines.push(`G1 X${n(path[i].x)} Y${n(path[i].y)}${f}`);
    }
    lines.push(`G1 X${n(s.x)} Y${n(s.y)}`);
  }
  lines.push(`G0 Z${n(op.safeZ)}`);
  return lines;
}

function profileCircle(cx: number, cy: number, r: number, op: CAMOperation): string[] {
  const toolR = op.diameter / 2;
  const cutR = op.side === "outside" ? r + toolR : r - toolR;
  if (cutR <= 0) {
    return [`; WARNING: tool diameter (${op.diameter}mm) exceeds inside circle radius (${r}mm) — skipped`];
  }
  const lines: string[] = [];
  const sx = cx + cutR;
  for (const z of depthPasses(op)) {
    lines.push(`G0 Z${n(op.safeZ)}`);
    lines.push(`G0 X${n(sx)} Y${n(cy)}`);
    lines.push(`G1 Z${n(z)} F${n(op.plungeRate)}`);
    lines.push(`G2 X${n(sx)} Y${n(cy)} I${n(-cutR)} J0 F${n(op.feedrate)}`);
  }
  lines.push(`G0 Z${n(op.safeZ)}`);
  return lines;
}

// --- engrave -----------------------------------------------------------------

function engravePoints(pts: Vec2[], closed: boolean, op: CAMOperation): string[] {
  if (pts.length === 0) return [];
  const lines: string[] = [];
  const s = pts[0];
  for (const z of depthPasses(op)) {
    lines.push(`G0 Z${n(op.safeZ)}`);
    lines.push(`G0 X${n(s.x)} Y${n(s.y)}`);
    lines.push(`G1 Z${n(z)} F${n(op.plungeRate)}`);
    for (let i = 1; i < pts.length; i++) {
      const f = i === 1 ? ` F${n(op.feedrate)}` : "";
      lines.push(`G1 X${n(pts[i].x)} Y${n(pts[i].y)}${f}`);
    }
    if (closed && pts.length > 2) lines.push(`G1 X${n(s.x)} Y${n(s.y)}`);
  }
  lines.push(`G0 Z${n(op.safeZ)}`);
  return lines;
}

function engraveCircle(cx: number, cy: number, r: number, op: CAMOperation): string[] {
  const lines: string[] = [];
  const sx = cx + r;
  for (const z of depthPasses(op)) {
    lines.push(`G0 Z${n(op.safeZ)}`);
    lines.push(`G0 X${n(sx)} Y${n(cy)}`);
    lines.push(`G1 Z${n(z)} F${n(op.plungeRate)}`);
    lines.push(`G2 X${n(sx)} Y${n(cy)} I${n(-r)} J0 F${n(op.feedrate)}`);
  }
  lines.push(`G0 Z${n(op.safeZ)}`);
  return lines;
}

// --- drill -------------------------------------------------------------------

function drillPoint(cx: number, cy: number, op: CAMOperation): string[] {
  return [
    `G0 Z${n(op.safeZ)}`,
    `G0 X${n(cx)} Y${n(cy)}`,
    `G1 Z${n(op.depth)} F${n(op.plungeRate)}`,
    `G0 Z${n(op.safeZ)}`,
  ];
}

// --- main entry --------------------------------------------------------------

export function generateGCode(ops: CAMOperation[], doc: CADDocument): string {
  const lines: string[] = [
    "; RapidCAM generated G-code",
    `; ${ops.length} toolpath${ops.length !== 1 ? "s" : ""}`,
    "G21 ; metric",
    "G90 ; absolute",
    "G17 ; XY plane",
    "",
  ];

  const entityMap = new Map(doc.entities.map((e) => [e.id, e]));

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const typeLabel =
      op.type === "profile" ? `Profile (${op.side})`
      : op.type === "engrave" ? "Engrave"
      : "Drill";
    lines.push(
      `; --- ${typeLabel} "${op.name}"  ` +
      `⌀${op.diameter}mm  feed:${op.feedrate}  depth:${op.depth}mm ---`,
    );

    for (const id of op.entityIds) {
      const ent = entityMap.get(id);
      if (!ent || ent.isConstruction) continue;

      if (op.type === "drill") {
        if (ent instanceof CircleEntity) lines.push(...drillPoint(ent.center.x, ent.center.y, op));
        continue;
      }

      if (op.type === "engrave") {
        if (ent instanceof LineEntity)
          lines.push(...engravePoints([ent.a, ent.b], false, op));
        else if (ent instanceof CircleEntity)
          lines.push(...engraveCircle(ent.center.x, ent.center.y, ent.radius, op));
        else if (ent instanceof RectEntity)
          lines.push(...engravePoints([...ent.corners()], true, op));
        else if (ent instanceof PolylineEntity)
          lines.push(...engravePoints(ent.points, ent.closed, op));
        continue;
      }

      // profile
      if (ent instanceof CircleEntity)
        lines.push(...profileCircle(ent.center.x, ent.center.y, ent.radius, op));
      else if (ent instanceof RectEntity)
        lines.push(...profilePolygon([...ent.corners()], op));
      else if (ent instanceof PolylineEntity && ent.closed)
        lines.push(...profilePolygon(ent.points, op));
      else if (ent instanceof LineEntity)
        lines.push("; NOTE: open line skipped — profile requires closed geometry");
    }
    lines.push("");
  }

  lines.push("M30 ; end program");
  return lines.join("\n");
}
