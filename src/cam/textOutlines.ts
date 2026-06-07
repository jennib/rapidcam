/**
 * Convert a TextEntity to closed/open glyph contours in world mm coordinates.
 * Used by gcode.ts and stockRasterizer.ts to expand text into cuttable geometry.
 */

import { getFont } from "../core/fontManager";
import type { Vec2 } from "../core/vec2";
import type { TextEntity } from "../model/entities";

export interface TextContour {
  points: Vec2[];
  closed: boolean;
}

export function textToContours(ent: TextEntity, toleranceMM = 0.05): TextContour[] {
  const font = getFont(ent.fontId);
  if (!font || !ent.text) return [];

  const path = font.getPath(ent.text, 0, 0, ent.sizeMM);
  const cos = Math.cos(ent.angle);
  const sin = Math.sin(ent.angle);

  // opentype path is Y-down (ascenders at negative Y).
  // Flip Y to convert to world Y-up, then rotate and translate to ent.position.
  const xfm = (px: number, py: number): Vec2 => {
    const lx = px, ly = -py;
    return {
      x: ent.position.x + lx * cos - ly * sin,
      y: ent.position.y + lx * sin + ly * cos,
    };
  };

  const contours: TextContour[] = [];
  let current: Vec2[] = [];

  for (const cmd of path.commands) {
    switch (cmd.type) {
      case "M":
        if (current.length > 1) contours.push({ points: current, closed: false });
        current = [xfm(cmd.x!, cmd.y!)];
        break;
      case "L":
        current.push(xfm(cmd.x!, cmd.y!));
        break;
      case "C": {
        if (current.length === 0) break;
        const p0 = current[current.length - 1];
        flattenCubic(
          p0,
          xfm(cmd.x1!, cmd.y1!),
          xfm(cmd.x2!, cmd.y2!),
          xfm(cmd.x!,  cmd.y!),
          current,
          toleranceMM,
        );
        break;
      }
      case "Q": {
        if (current.length === 0) break;
        const p0 = current[current.length - 1];
        const pc = xfm(cmd.x1!, cmd.y1!);
        const p2 = xfm(cmd.x!,  cmd.y!);
        // Promote quadratic to cubic
        const cp1: Vec2 = { x: p0.x + (2 / 3) * (pc.x - p0.x), y: p0.y + (2 / 3) * (pc.y - p0.y) };
        const cp2: Vec2 = { x: p2.x + (2 / 3) * (pc.x - p2.x), y: p2.y + (2 / 3) * (pc.y - p2.y) };
        flattenCubic(p0, cp1, cp2, p2, current, toleranceMM);
        break;
      }
      case "Z":
        if (current.length > 1) contours.push({ points: current, closed: true });
        current = [];
        break;
    }
  }
  if (current.length > 1) contours.push({ points: current, closed: false });
  return contours;
}

function flattenCubic(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, out: Vec2[], tol: number): void {
  const sub = (
    ax: number, ay: number, bx: number, by: number,
    cx: number, cy: number, dx: number, dy: number,
    depth: number,
  ): void => {
    if (depth > 12) { out.push({ x: dx, y: dy }); return; }
    // Measure flatness: distance of control polygon midpoint from curve midpoint
    const mx = (ax + 3 * bx + 3 * cx + dx) / 8;
    const my = (ay + 3 * by + 3 * cy + dy) / 8;
    const hx = (ax + dx) / 2;
    const hy = (ay + dy) / 2;
    if ((mx - hx) ** 2 + (my - hy) ** 2 < tol * tol) {
      out.push({ x: dx, y: dy });
      return;
    }
    // De Casteljau split at t=0.5
    const ab_x = (ax + bx) / 2, ab_y = (ay + by) / 2;
    const bc_x = (bx + cx) / 2, bc_y = (by + cy) / 2;
    const cd_x = (cx + dx) / 2, cd_y = (cy + dy) / 2;
    const abc_x = (ab_x + bc_x) / 2, abc_y = (ab_y + bc_y) / 2;
    const bcd_x = (bc_x + cd_x) / 2, bcd_y = (bc_y + cd_y) / 2;
    const m_x = (abc_x + bcd_x) / 2, m_y = (abc_y + bcd_y) / 2;
    sub(ax, ay, ab_x, ab_y, abc_x, abc_y, m_x, m_y, depth + 1);
    sub(m_x, m_y, bcd_x, bcd_y, cd_x, cd_y, dx, dy, depth + 1);
  };
  sub(p0.x, p0.y, p1.x, p1.y, p2.x, p2.y, p3.x, p3.y, 0);
}
