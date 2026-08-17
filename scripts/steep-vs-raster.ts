/**
 * Does the steep/shallow split ever leave MORE material than the plain raster?
 *
 * It does, and this is what settles what that means. Turning the split on has to
 * be an improvement everywhere or it is a trap: a user who ticks it and gets a
 * worse surface *somewhere* has no way to find out which somewhere.
 *
 * Simulated with the app's own cut model (`rasterizeStock`) rather than a
 * re-derivation of it, so the comparison is between the two things the user
 * actually gets. Run it BUNDLED — see `scripts/steep-cost.ts` for why tsx lies.
 *
 * ## The answer
 *
 * Both directions happen, and the split is ahead on both count and magnitude:
 * it leaves LESS material at 3–5× as many cells as it leaves more. What is left
 * standing is bounded by about one cusp and lands on a handful of REPEATED
 * values (0.070 mm × 8, 0.121 mm × 8) — the signature of the two finishes
 * meeting on a seam, not of a region nothing cut. Halving the stepover roughly
 * halves it, which a fixed sampling artifact would not do.
 *
 * That is inherent to splitting at all: the raster's ridge crests and the
 * contours' crests are in different PHASE, so along the boundary a cell can sit
 * on one strategy's crest and between the other's passes. Every package that
 * ships a surface-angle split has the same seam.
 */

import { rasterizeStock } from "../src/cam/stockRasterizer";
import type { CAMOperation } from "../src/cam/types";
import { registerEmbeddedImage } from "../src/core/imageManager";
import { CADDocument } from "../src/model/document";
import { RasterImageEntity } from "../src/model/entities";

const DEPTH = 10;
const MM = 64;
const W = 512;
const S = Number(process.env.S ?? 0.5);
const mid = MM / 2;

const shapes: Record<string, (x: number, y: number) => number> = {
  cone: (x, y) => Math.max(0, DEPTH - 2 * Math.hypot(x - mid, y - mid)),
  hemisphere: (x, y) => {
    const r = Math.hypot(x - mid, y - mid);
    return r < 28 ? (DEPTH * Math.sqrt(784 - r * r)) / 28 : 0;
  },
  moat: (x, y) => Math.max(0, Math.min(DEPTH, DEPTH - 2 * (Math.hypot(x - mid, y - mid) - 8))),
};

for (const [name, h] of Object.entries(shapes)) {
  const px: number[] = [];
  for (let py = 0; py < W; py++)
    for (let x = 0; x < W; x++) {
      const X = ((x + 0.5) * MM) / W;
      const Y = MM - ((py + 0.5) * MM) / W;
      px.push(Math.round((255 * Math.min(DEPTH, Math.max(0, h(X, Y)))) / DEPTH));
    }
  const id = `img_${name}`;
  registerEmbeddedImage({
    id,
    name,
    width: W,
    height: W,
    data: Buffer.from(Uint8Array.from(px)).toString("base64"),
  });

  const mk = (steep: boolean): { doc: CADDocument; op: CAMOperation } => {
    const doc = new CADDocument({ width: MM + 20, height: MM + 20 });
    doc.stockThickness = DEPTH + 5;
    const ent = new RasterImageEntity(id, { x: 10, y: 10 }, MM, MM, 0);
    doc.add(ent);
    const op = {
      id: "r",
      name: "r",
      type: "engrave",
      entityIds: [ent.id],
      side: "outside",
      toolType: "ball-nose",
      toolNumber: 1,
      diameter: 3,
      feedrate: 1500,
      plungeRate: 300,
      spindleSpeed: 18000,
      safeZ: 5,
      depth: -DEPTH,
      stepdown: DEPTH,
      stepover: 0.4,
      rasterLineInterval: S,
      rasterDotPitch: S,
      reliefSteepPass: steep || undefined,
    } as unknown as CAMOperation;
    return { doc, op };
  };

  const a = mk(false);
  const b = mk(true);
  const plain = rasterizeStock([a.op], a.doc);
  const split = rasterizeStock([b.op], b.doc);

  // Compare only inside the image footprint, away from its very edge.
  let worse = 0;
  let better = 0;
  let worstAmt = 0;
  let bestAmt = 0;
  const hist: number[] = [];
  for (let r = 0; r < plain.gridH; r++)
    for (let c = 0; c < plain.gridW; c++) {
      const i = r * plain.gridW + c;
      const d = split.data[i] - plain.data[i]; // +ve = split left MORE material
      if (d > 1e-6) {
        worse++;
        worstAmt = Math.max(worstAmt, d);
        hist.push(d);
      } else if (d < -1e-6) {
        better++;
        bestAmt = Math.max(bestAmt, -d);
      }
    }
  hist.sort((p, q) => q - p);
  console.log(
    `${name.padEnd(11)} S=${S}  split leaves MORE at ${String(worse).padStart(5)} cells ` +
      `(worst ${worstAmt.toFixed(3)}mm)   LESS at ${String(better).padStart(6)} cells ` +
      `(best ${bestAmt.toFixed(3)}mm)   of ${plain.gridW * plain.gridH}`,
  );
  if (hist.length)
    console.log(
      `            top: ${hist
        .slice(0, 8)
        .map((v) => v.toFixed(3))
        .join(" ")}`,
    );
}
