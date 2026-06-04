import type { Vec2 } from "../../core/vec2";
import type { CAMOperation } from "../types";
import { PostProcessor, n, X, Y, Z, depthPasses } from "./base";

export class LinuxCNC extends PostProcessor {
  readonly name = "linuxcnc";

  // G5 uses relative offsets from endpoints, not absolute control points:
  //   I/J = vector from current position (p0) to first control handle (p1)
  //   P/Q = vector from end point (p3) to second control handle (p2)
  override engraveBezier(
    p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2,
    op: CAMOperation,
    ox: number, oy: number, zOff: number,
  ): string[] {
    const I = n(p1.x - p0.x), J = n(p1.y - p0.y);
    const P = n(p2.x - p3.x), Q = n(p2.y - p3.y);
    const lines: string[] = [];
    for (const z of depthPasses(op)) {
      lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
      lines.push(`G0 X${X(p0.x, ox)} Y${Y(p0.y, oy)}`);
      lines.push(`G1 Z${Z(z, zOff)} F${n(op.plungeRate)}`);
      lines.push(`G5 I${I} J${J} P${P} Q${Q} X${X(p3.x, ox)} Y${Y(p3.y, oy)} F${n(op.feedrate)}`);
    }
    lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
    return lines;
  }
}
