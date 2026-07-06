/**
 * Stitch phase 3 — registration features.
 *
 * Turns the planner's shared seam points into G-code the operator can use to
 * realign the stock between tiles: drilled dowel holes, scored crosshairs, or
 * neither (align by other means). The features are emitted in the program's
 * coordinate space; Stitch translates them per tile like everything else, so a
 * shared seam hole lands at the right machine-local spot in each tile's file.
 */

import type { Vec2 } from "../core/vec2";
import type { GMoveEvent, GEvent } from "./gcodeMotion";

export type RegistrationMode = "none" | "holes" | "crosshairs" | "both";

export interface RegistrationOptions {
  mode: RegistrationMode;
  /** Safe retract height (program coords). */
  safeZ: number;
  /** Drilled dowel-hole depth (mm, positive). Default 3. */
  holeDepth?: number;
  /** Scored-crosshair depth (mm, positive). Default 0.5. */
  crosshairDepth?: number;
  /** Half-length (mm) of each crosshair scribe line. Default 5. */
  crosshairSize?: number;
  /** Plunge rate (mm/min) for registration moves. Default 150. */
  plungeRate?: number;
  /** Feed rate (mm/min) for scribing crosshairs. Default 400. */
  feedRate?: number;
}

const mv = (motion: 0 | 1, over: Partial<GMoveEvent>): GMoveEvent =>
  ({ kind: "move", motion, x: 0, y: 0, z: 0, hasX: false, hasY: false, hasZ: false, ...over });

/** Retract, rapid over the point, plunge a hole, retract. */
function holeEvents(p: Vec2, safeZ: number, depth: number, plunge: number): GMoveEvent[] {
  return [
    mv(0, { z: safeZ, hasZ: true }),
    mv(0, { x: p.x, y: p.y, hasX: true, hasY: true }),
    mv(1, { z: -depth, hasZ: true, f: plunge }),
    mv(0, { z: safeZ, hasZ: true }),
  ];
}

/** Score a shallow "+" centred on the point. */
function crosshairEvents(p: Vec2, safeZ: number, depth: number, size: number, feed: number, plunge: number): GMoveEvent[] {
  return [
    mv(0, { z: safeZ, hasZ: true }),
    mv(0, { x: p.x - size, y: p.y, hasX: true, hasY: true }),
    mv(1, { z: -depth, hasZ: true, f: plunge }),
    mv(1, { x: p.x + size, y: p.y, hasX: true, hasY: true, f: feed }),
    mv(0, { z: safeZ, hasZ: true }),
    mv(0, { x: p.x, y: p.y - size, hasX: true, hasY: true }),
    mv(1, { z: -depth, hasZ: true, f: plunge }),
    mv(1, { x: p.x, y: p.y + size, hasX: true, hasY: true, f: feed }),
    mv(0, { z: safeZ, hasZ: true }),
  ];
}

/** Build the registration G-code section for one tile's features (empty if mode="none"). */
export function registrationEvents(features: Vec2[], opts: RegistrationOptions): GEvent[] {
  if (opts.mode === "none" || features.length === 0) return [];

  const holeDepth = opts.holeDepth ?? 3;
  const crossDepth = opts.crosshairDepth ?? 0.5;
  const size = opts.crosshairSize ?? 5;
  const plunge = opts.plungeRate ?? 150;
  const feed = opts.feedRate ?? 400;

  const out: GEvent[] = [{ kind: "raw", text: `; --- Stitch registration (${opts.mode}) ---` }];
  for (const f of features) {
    if (opts.mode === "holes" || opts.mode === "both") out.push(...holeEvents(f, opts.safeZ, holeDepth, plunge));
    if (opts.mode === "crosshairs" || opts.mode === "both") {
      out.push(...crosshairEvents(f, opts.safeZ, crossDepth, size, feed, plunge));
    }
  }
  return out;
}
