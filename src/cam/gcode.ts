import type { Vec2 } from "../core/vec2";
import { type CADDocument, resolveOrigin } from "../model/document";
import { LineEntity, CircleEntity, RectEntity, PolylineEntity, BezierEntity } from "../model/entities";
import type { CAMOperation } from "./types";
import { offsetPolygon } from "./offset";
import { n, X, Y, Z, depthPasses, PostProcessor } from "./postprocessors/base";
import { pathLengths, computeTabRegions, splitPathForTabs } from "./tabs";
import { rasterRows } from "./pocket";
import { LinuxCNC } from "./postprocessors/linuxcnc";
import { Grbl } from "./postprocessors/grbl";

export function getPostProcessor(name: string): PostProcessor {
  switch (name) {
    case "grbl":     return new Grbl();
    default:         return new LinuxCNC();
  }
}

// --- profile -----------------------------------------------------------------

/** Compute normalised entry/exit tangent and optional lead geometry for a closed path. */
function leadInGeo(path: Vec2[], leadR: number, side: "outside" | "inside") {
  const t1 = path[1], t0 = path[0], tn = path[path.length - 1];
  const dx  = t1.x - t0.x, dy  = t1.y - t0.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-9) return null;
  const tx = dx / len, ty = dy / len;
  // Left normal for outside (CW), right normal for inside (CCW).
  const sg  = side === "outside" ? 1 : -1;
  const nx  = -ty * sg, ny = tx * sg;
  // Entry arc start point
  const arcStart: Vec2 = { x: t0.x + nx * leadR - tx * leadR, y: t0.y + ny * leadR - ty * leadR };
  // Exit tangent (direction arriving at path[0] from the last move)
  const ex = t0.x - tn.x, ey = t0.y - tn.y;
  const el = Math.sqrt(ex * ex + ey * ey);
  const etx = el > 1e-9 ? ex / el : tx, ety = el > 1e-9 ? ey / el : ty;
  const enx = -ety * sg, eny = etx * sg;
  const arcOut: Vec2 = { x: t0.x + enx * leadR + etx * leadR, y: t0.y + eny * leadR + ety * leadR };
  const arcCmd = side === "outside" ? "G3" : "G2";
  return { tx, ty, nx, ny, arcStart, arcCmd, etx, ety, enx, eny, arcOut };
}

function profilePolygon(
  verts: Vec2[], op: CAMOperation,
  ox: number, oy: number, zOff: number,
): string[] {
  const toolR = op.diameter / 2;
  const paths = offsetPolygon(verts, op.side === "outside" ? toolR : -toolR);
  if (paths.length === 0) return [];

  const tabs      = op.tabs;
  const hasTabs   = !!(tabs?.enabled && tabs.count > 0 && tabs.width > 0 && tabs.height > 0);
  const tabZOff   = hasTabs ? op.depth + tabs!.height : 0;

  const liType = op.leadIn?.type  ?? "none";
  const loType = op.leadOut?.type ?? "none";
  const liLen  = op.leadIn?.length  ?? 2;
  const loLen  = op.leadOut?.length ?? 2;

  const lines: string[] = [];
  for (const path of paths) {
    if (path.length < 2) continue;
    const s = path[0];
    const geo = (liType !== "none" || loType !== "none") ? leadInGeo(path, Math.max(liLen, loLen), op.side) : null;

    for (const z of depthPasses(op)) {
      const useTabsThisPass = hasTabs && z < tabZOff;

      // ---- approach / plunge ----
      if (liType === "none" || !geo) {
        lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
        lines.push(`G0 X${X(s.x, ox)} Y${Y(s.y, oy)}`);
        lines.push(`G1 Z${Z(z, zOff)} F${n(op.plungeRate)}`);
      } else if (liType === "linear") {
        const { tx, ty } = geo;
        const lx = s.x - tx * liLen, ly = s.y - ty * liLen;
        lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
        lines.push(`G0 X${X(lx, ox)} Y${Y(ly, oy)}`);
        lines.push(`G1 Z${Z(z, zOff)} F${n(op.plungeRate)}`);
        lines.push(`G1 X${X(s.x, ox)} Y${Y(s.y, oy)} F${n(op.feedrate)}`);
      } else { // arc
        const { arcStart, arcCmd, tx, ty } = leadInGeo(path, liLen, op.side)!;
        lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
        lines.push(`G0 X${X(arcStart.x, ox)} Y${Y(arcStart.y, oy)}`);
        lines.push(`G1 Z${Z(z, zOff)} F${n(op.plungeRate)}`);
        lines.push(`${arcCmd} X${X(s.x, ox)} Y${Y(s.y, oy)} I${n(tx * liLen)} J${n(ty * liLen)} F${n(op.feedrate)}`);
      }

      // ---- main loop ----
      if (!useTabsThisPass) {
        for (let i = 1; i < path.length; i++) {
          const f = (i === 1 && liType === "none") ? ` F${n(op.feedrate)}` : "";
          lines.push(`G1 X${X(path[i].x, ox)} Y${Y(path[i].y, oy)}${f}`);
        }
        lines.push(`G1 X${X(s.x, ox)} Y${Y(s.y, oy)}`);
      } else {
        const cumLens  = pathLengths(path);
        const totalLen = cumLens[path.length];
        const regions  = computeTabRegions(totalLen, tabs!.count, tabs!.width);
        const segs     = splitPathForTabs(path, cumLens, regions);

        let currentZ = z;
        let first    = liType === "none";
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
        if (currentZ !== z) lines.push(`G1 Z${Z(z, zOff)} F${n(op.plungeRate)}`);
      }

      // ---- lead-out ----
      if (loType === "linear" && geo) {
        const { etx, ety } = geo;
        lines.push(`G1 X${X(s.x + etx * loLen, ox)} Y${Y(s.y + ety * loLen, oy)}`);
      } else if (loType === "arc" && geo) {
        const loGeo = leadInGeo(path, loLen, op.side)!;
        lines.push(`${loGeo.arcCmd} X${X(loGeo.arcOut.x, ox)} Y${Y(loGeo.arcOut.y, oy)} I${n(loGeo.enx * loLen)} J${n(loGeo.eny * loLen)}`);
      }
    }
  }
  lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
  return lines;
}

// --- pocket ------------------------------------------------------------------

function pocketPolygon(
  verts: Vec2[], op: CAMOperation,
  ox: number, oy: number, zOff: number,
): string[] {
  const toolR    = op.diameter / 2;
  const stepover = Math.max(0.01, (op.stepover ?? 0.4) * op.diameter);
  const insets   = offsetPolygon(verts, -toolR);
  if (insets.length === 0)
    return [`; NOTE: pocket too small for ⌀${op.diameter}mm tool — skipped`];

  const lines: string[] = [];

  for (const inset of insets) {
    const rows = rasterRows(inset, stepover);
    if (rows.length === 0) continue;

    for (const z of depthPasses(op)) {
      const entry = rows[0][0];
      lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
      lines.push(`G0 X${X(entry.x, ox)} Y${Y(entry.y, oy)}`);
      lines.push(`G1 Z${Z(z, zOff)} F${n(op.plungeRate)}`);
      let first = true;
      for (const row of rows) {
        for (const pt of row) {
          const f = first ? ` F${n(op.feedrate)}` : "";
          lines.push(`G1 X${X(pt.x, ox)} Y${Y(pt.y, oy)}${f}`);
          first = false;
        }
      }
    }

    // Finish pass: profile the inset boundary at each depth.
    const s = inset[0];
    for (const z of depthPasses(op)) {
      lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
      lines.push(`G0 X${X(s.x, ox)} Y${Y(s.y, oy)}`);
      lines.push(`G1 Z${Z(z, zOff)} F${n(op.plungeRate)}`);
      for (let i = 1; i < inset.length; i++) {
        const f = i === 1 ? ` F${n(op.feedrate)}` : "";
        lines.push(`G1 X${X(inset[i].x, ox)} Y${Y(inset[i].y, oy)}${f}`);
      }
      lines.push(`G1 X${X(s.x, ox)} Y${Y(s.y, oy)}`);
    }
    lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
  }

  return lines;
}

function pocketCircle(
  cx: number, cy: number, r: number, op: CAMOperation,
  ox: number, oy: number, zOff: number,
): string[] {
  const toolR = op.diameter / 2;
  const cutR  = r - toolR;
  if (cutR <= 0)
    return [`; NOTE: pocket circle too small for ⌀${op.diameter}mm tool — skipped`];

  const stepover = Math.max(0.01, (op.stepover ?? 0.4) * op.diameter);
  const nSegs    = Math.max(64, Math.ceil(2 * Math.PI * cutR / 0.5));
  const verts: Vec2[] = Array.from({ length: nSegs }, (_, i) => {
    const a = (i / nSegs) * 2 * Math.PI;
    return { x: cx + cutR * Math.cos(a), y: cy + cutR * Math.sin(a) };
  });

  const rows  = rasterRows(verts, stepover);
  const lines: string[] = [];

  for (const z of depthPasses(op)) {
    if (rows.length > 0) {
      const entry = rows[0][0];
      lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
      lines.push(`G0 X${X(entry.x, ox)} Y${Y(entry.y, oy)}`);
      lines.push(`G1 Z${Z(z, zOff)} F${n(op.plungeRate)}`);
      let first = true;
      for (const row of rows) {
        for (const pt of row) {
          const f = first ? ` F${n(op.feedrate)}` : "";
          lines.push(`G1 X${X(pt.x, ox)} Y${Y(pt.y, oy)}${f}`);
          first = false;
        }
      }
    }
  }

  // Finish pass: smooth G2 arc around boundary.
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

  // For profile/pocket ops, chain any selected LineEntity instances into a closed polygon.
  const lineSegIds = new Set<string>();
  if (op.type === "profile" || op.type === "pocket") {
    const lineEnts = op.entityIds
      .map(id => entityMap.get(id))
      .filter((e): e is LineEntity => e instanceof LineEntity && !e.isConstruction);
    if (lineEnts.length >= 3) {
      const polygon = chainLines(lineEnts);
      if (polygon) {
        if (op.type === "pocket") lines.push(...pocketPolygon(polygon, op, ox, oy, zOff));
        else lines.push(...profilePolygon(polygon, op, ox, oy, zOff));
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

    // profile / pocket
    if (op.type === "pocket") {
      if (ent instanceof CircleEntity)
        lines.push(...pocketCircle(ent.center.x, ent.center.y, ent.radius, op, ox, oy, zOff));
      else if (ent instanceof RectEntity)
        lines.push(...pocketPolygon([...ent.corners()], op, ox, oy, zOff));
      else if (ent instanceof PolylineEntity && ent.closed)
        lines.push(...pocketPolygon(ent.points, op, ox, oy, zOff));
    } else {
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
      : op.type === "pocket"  ? "Pocket"
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
