import type { Vec2 } from "../core/vec2";
import { type CADDocument, resolveOrigin } from "../model/document";
import { LineEntity, CircleEntity, RectEntity, PolylineEntity, BezierEntity } from "../model/entities";
import type { CAMOperation } from "./types";
import { offsetPolygon } from "./offset";
import { n, X, Y, Z, depthPasses, PostProcessor } from "./postprocessors/base";
import { pathLengths, computeTabRegions, splitPathForTabs } from "./tabs";
import { LinuxCNC } from "./postprocessors/linuxcnc";
import { Grbl } from "./postprocessors/grbl";

export function getPostProcessor(name: string): PostProcessor {
  switch (name) {
    case "grbl":     return new Grbl();
    default:         return new LinuxCNC();
  }
}

// --- profile -----------------------------------------------------------------

function profilePolygon(
  verts: Vec2[], op: CAMOperation,
  ox: number, oy: number, zOff: number,
): string[] {
  const toolR = op.diameter / 2;
  const paths = offsetPolygon(verts, op.side === "outside" ? toolR : -toolR);
  if (paths.length === 0) return [];

  const tabs      = op.tabs;
  const hasTabs   = !!(tabs?.enabled && tabs.count > 0 && tabs.width > 0 && tabs.height > 0);
  const tabZOff   = hasTabs ? op.depth + tabs!.height : 0; // Z offset of tab surface (e.g. -10+3 = -7)

  const lines: string[] = [];
  for (const path of paths) {
    if (path.length < 2) continue;
    const s = path[0];

    for (const z of depthPasses(op)) {
      // Tabs only apply to passes that cut below the tab floor.
      const useTabsThisPass = hasTabs && z < tabZOff;

      lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
      lines.push(`G0 X${X(s.x, ox)} Y${Y(s.y, oy)}`);
      lines.push(`G1 Z${Z(z, zOff)} F${n(op.plungeRate)}`);

      if (!useTabsThisPass) {
        for (let i = 1; i < path.length; i++) {
          const f = i === 1 ? ` F${n(op.feedrate)}` : "";
          lines.push(`G1 X${X(path[i].x, ox)} Y${Y(path[i].y, oy)}${f}`);
        }
        lines.push(`G1 X${X(s.x, ox)} Y${Y(s.y, oy)}`);
      } else {
        const cumLens  = pathLengths(path);
        const totalLen = cumLens[path.length];
        const regions  = computeTabRegions(totalLen, tabs!.count, tabs!.width);
        const segs     = splitPathForTabs(path, cumLens, regions);

        let currentZ = z;
        let first    = true;
        for (const seg of segs) {
          const targetZ = seg.isTab ? tabZOff : z;
          if (targetZ !== currentZ) {
            lines.push(`G1 Z${Z(targetZ, zOff)} F${n(op.plungeRate)}`);
            currentZ = targetZ;
          }
          const feedStr = first ? ` F${n(op.feedrate)}` : "";
          lines.push(`G1 X${X(seg.p1.x, ox)} Y${Y(seg.p1.y, oy)}${feedStr}`);
          first = false;
        }
        // Ensure we return to full cut depth (if last segment was a tab).
        if (currentZ !== z) lines.push(`G1 Z${Z(z, zOff)} F${n(op.plungeRate)}`);
      }
    }
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

// --- chain lines into a closed polygon ---------------------------------------

function chainLines(segs: LineEntity[]): Vec2[] | null {
  if (segs.length < 3) return null;
  const EPS = 1e-4;
  const used = new Set<string>();
  const chain: Vec2[] = [{ ...segs[0].a }, { ...segs[0].b }];
  used.add(segs[0].id);

  while (used.size < segs.length) {
    const tail = chain[chain.length - 1];
    let found = false;
    for (const seg of segs) {
      if (used.has(seg.id)) continue;
      const da = Math.hypot(seg.a.x - tail.x, seg.a.y - tail.y);
      const db = Math.hypot(seg.b.x - tail.x, seg.b.y - tail.y);
      if (da < EPS) { chain.push({ ...seg.b }); used.add(seg.id); found = true; break; }
      if (db < EPS) { chain.push({ ...seg.a }); used.add(seg.id); found = true; break; }
    }
    if (!found) return null;
  }

  const head = chain[0], tail = chain[chain.length - 1];
  if (Math.hypot(tail.x - head.x, tail.y - head.y) > EPS) return null;
  chain.pop(); // remove duplicate closing vertex
  return chain;
}

// --- toolpath body (no spindle/tool-change preamble) -------------------------

function toolpathBody(
  op: CAMOperation, doc: CADDocument,
  ox: number, oy: number, zOff: number,
  pp: PostProcessor,
): string[] {
  const lines: string[] = [];
  const entityMap = new Map(doc.entities.map((e) => [e.id, e]));

  // For profile ops, chain any selected LineEntity instances into a closed polygon.
  const lineSegIds = new Set<string>();
  if (op.type === "profile") {
    const lineEnts = op.entityIds
      .map(id => entityMap.get(id))
      .filter((e): e is LineEntity => e instanceof LineEntity && !e.isConstruction);
    if (lineEnts.length >= 3) {
      const polygon = chainLines(lineEnts);
      if (polygon) {
        lines.push(...profilePolygon(polygon, op, ox, oy, zOff));
        for (const e of lineEnts) lineSegIds.add(e.id);
      } else {
        lines.push("; NOTE: selected lines do not form a closed polygon — skipped");
        for (const e of lineEnts) lineSegIds.add(e.id);
      }
    }
  }

  for (const id of op.entityIds) {
    if (lineSegIds.has(id)) continue;
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
      else if (ent instanceof BezierEntity)
        lines.push(...pp.engraveBezier(ent.p0, ent.p1, ent.p2, ent.p3, op, ox, oy, zOff));
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
    else if (ent instanceof BezierEntity)
      lines.push(`; NOTE: bezier (${ent.id}) skipped in profile — beziers are open paths`);
  }
  return lines;
}

// --- main entry --------------------------------------------------------------

export function generateGCode(ops: CAMOperation[], doc: CADDocument): string {
  if (ops.length === 0) return "; No toolpaths\nM30\n";

  const { ox, oy, zOffset } = resolveOrigin(doc);
  const pp = getPostProcessor(doc.postProcessor ?? "linuxcnc");

  const xLabel = { left: "Left", center: "Center", right: "Right" }[doc.origin.x];
  const yLabel = { front: "Front", center: "Center", back: "Back" }[doc.origin.y];
  const zLabel = doc.origin.z === "top"
    ? "Top of stock"
    : `Bed (top at Z=${n(doc.stockThickness)}mm)`;

  const toolsSeen = new Map<number, CAMOperation>();
  for (const op of ops) {
    if (!toolsSeen.has(op.toolNumber)) toolsSeen.set(op.toolNumber, op);
  }
  const toolSummary = [...toolsSeen.entries()]
    .sort(([a], [b]) => a - b)
    .map(([t, op]) => {
      const tl = op.toolType === "v-bit"    ? `V-Bit(${op.vAngle ?? 60}°)`
               : op.toolType === "ball-nose" ? "BallNose"
               : op.toolType === "drill"     ? "Drill"
               : "EndMill";
      return `T${t} ⌀${op.diameter}mm ${tl} ${op.spindleSpeed}rpm`;
    })
    .join(", ");

  const lines: string[] = [
    "; RapidCAM generated G-code",
    `; Post-processor: ${pp.name}`,
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
    const toolLabel = op.toolType === "v-bit"     ? `V-Bit(${op.vAngle ?? 60}°)`
                    : op.toolType === "ball-nose"  ? "Ball Nose"
                    : op.toolType === "drill"      ? `Drill(tip ${op.tipAngle ?? 118}°)`
                    : "End Mill";
    lines.push(`; --- ${typeLabel} "${op.name}"  T${op.toolNumber} ⌀${op.diameter}mm ${toolLabel}  depth:${op.depth}mm ---`);
    if (op.toolType === "v-bit" && op.type === "engrave") {
      const halfAngle = ((op.vAngle ?? 60) / 2) * (Math.PI / 180);
      const width = (2 * Math.abs(op.depth) * Math.tan(halfAngle)).toFixed(3);
      lines.push(`; V-Bit effective cut width at ${op.depth}mm: ${width}mm`);
    }
    lines.push(...toolpathBody(op, doc, ox, oy, zOffset, pp));
    lines.push("");
  }

  lines.push("M5 ; spindle stop");
  lines.push("M30 ; end program");
  return lines.join("\n");
}
