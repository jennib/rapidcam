import type { Vec2 } from "../../core/vec2";
import { flattenBezier } from "../../core/geom";
import type { CAMOperation } from "../types";

export function n(v: number): string {
  return parseFloat(v.toFixed(3)).toString();
}

export function X(v: number, ox: number): string { return n(v - ox); }
export function Y(v: number, oy: number): string { return n(v - oy); }
export function Z(v: number, zOff: number): string { return n(v + zOff); }

export function depthPasses(op: CAMOperation): number[] {
  const total = Math.abs(op.depth);
  const count = Math.max(1, Math.ceil(total / op.stepdown));
  const passes: number[] = [];
  for (let i = 1; i <= count; i++) {
    passes.push(-Math.min(i * op.stepdown, total));
  }
  return passes;
}

export abstract class PostProcessor {
  abstract readonly name: string;

  /** Emit G-code for engraving a single cubic Bezier segment. Default: flatten to G1 segments. */
  engraveBezier(
    p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2,
    op: CAMOperation,
    ox: number, oy: number, zOff: number,
  ): string[] {
    const pts = flattenBezier(p0, p1, p2, p3, 0.05);
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
    }
    lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
    return lines;
  }
}
