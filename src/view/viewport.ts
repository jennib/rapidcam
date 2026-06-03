/**
 * Viewport / camera.
 *
 * Maps between WORLD coordinates (millimetres, Y-up — +Y points up like a CAD
 * drawing) and SCREEN coordinates (CSS pixels, Y-down — standard canvas).
 *
 *   screenX =  worldX * scale + tx
 *   screenY = -worldY * scale + ty
 *
 * `scale` is pixels-per-millimetre. Device-pixel-ratio is handled separately by
 * the renderer; everything here is in CSS pixels.
 */

import { Vec2 } from "../core/vec2";
import { Bounds } from "../model/entities";

export class Viewport {
  scale = 3; // px per mm
  tx = 0;
  ty = 0;

  /** Viewport size in CSS pixels. */
  width = 0;
  height = 0;

  worldToScreen(p: Vec2): Vec2 {
    return { x: p.x * this.scale + this.tx, y: -p.y * this.scale + this.ty };
  }
  screenToWorld(s: Vec2): Vec2 {
    return { x: (s.x - this.tx) / this.scale, y: (this.ty - s.y) / this.scale };
  }

  /** Convert a world length (mm) to screen pixels. */
  toScreenLen(mm: number): number {
    return mm * this.scale;
  }
  /** Convert a screen length (px) to world mm. */
  toWorldLen(px: number): number {
    return px / this.scale;
  }

  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  /** Pan by a screen-pixel delta. */
  panBy(dxScreen: number, dyScreen: number): void {
    this.tx += dxScreen;
    this.ty += dyScreen;
  }

  /** Zoom by `factor` while keeping the world point under `screenPivot` fixed. */
  zoomAt(screenPivot: Vec2, factor: number): void {
    const world = this.screenToWorld(screenPivot);
    this.scale = clampScale(this.scale * factor);
    // Re-solve translation so `world` still maps to `screenPivot`.
    this.tx = screenPivot.x - world.x * this.scale;
    this.ty = screenPivot.y + world.y * this.scale;
  }

  /** Fit a world-bounds into the viewport with `marginPx` padding. */
  fit(b: Bounds, marginPx = 40): void {
    const w = Math.max(b.max.x - b.min.x, 1e-6);
    const h = Math.max(b.max.y - b.min.y, 1e-6);
    const availW = Math.max(this.width - marginPx * 2, 10);
    const availH = Math.max(this.height - marginPx * 2, 10);
    this.scale = clampScale(Math.min(availW / w, availH / h));

    const cx = (b.min.x + b.max.x) / 2;
    const cy = (b.min.y + b.max.y) / 2;
    // Centre (cx, cy) in the viewport.
    this.tx = this.width / 2 - cx * this.scale;
    this.ty = this.height / 2 + cy * this.scale;
  }

  /** Visible world rectangle (min has smaller x and y). */
  visibleWorldBounds(): Bounds {
    const a = this.screenToWorld({ x: 0, y: 0 });
    const b = this.screenToWorld({ x: this.width, y: this.height });
    return {
      min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) },
      max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) },
    };
  }
}

const MIN_SCALE = 0.02; // px/mm  (very zoomed out)
const MAX_SCALE = 400; // px/mm   (very zoomed in)
function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}
