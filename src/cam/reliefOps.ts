/**
 * Which image a relief operation carves, and the rough/finish pairing that
 * follows from it.
 *
 * A relief is two operations on the SAME image — a `relief-rough` that clears the
 * bulk and an `engrave` that cuts the surface — but the document stores them as
 * unrelated ops with nothing linking them. The pairing therefore has to be
 * DERIVED from what each op targets, or it would be one fact stored in two places
 * (this project's standing defect class). This is that derivation, shared by the
 * pass-mismatch lint, the per-op gouge warning, and the merged dialog + grouped op
 * list that present the two passes as one job.
 */
import type { CADDocument } from "../model/document";
import { RasterImageEntity } from "../model/entities";
import type { CAMOperation } from "./types";

/** The image entity ids an operation targets (empty for a non-relief op). */
export function reliefImageIds(op: CAMOperation, doc: CADDocument): string[] {
  const images = new Set(doc.entities.filter((e) => e instanceof RasterImageEntity).map((e) => e.id));
  return op.entityIds.filter((id) => images.has(id));
}

/** The image entity ids two operations target in common. */
export function sharedReliefImageIds(a: CAMOperation, b: CAMOperation, doc: CADDocument): string[] {
  const bIds = new Set(reliefImageIds(b, doc));
  return reliefImageIds(a, doc).filter((id) => bIds.has(id));
}

/** Whether two operations carve the same image. */
export function shareReliefImage(a: CAMOperation, b: CAMOperation, doc: CADDocument): boolean {
  return sharedReliefImageIds(a, b, doc).length > 0;
}

/**
 * The roughing/finishing operation paired with `op` on the same image, nearest in
 * job order — or null. A `relief-rough` pairs with the image `engrave` finish and
 * vice versa; a line engrave (no image) has no pair. This is the derived link the
 * merged dialog loads and the grouped op list renders from, so no persisted field
 * has to name it.
 */
export function findReliefPair(op: CAMOperation, doc: CADDocument): CAMOperation | null {
  if (op.type !== "relief-rough" && op.type !== "engrave") return null;
  const myImages = new Set(reliefImageIds(op, doc));
  if (myImages.size === 0) return null;
  const otherType = op.type === "relief-rough" ? "engrave" : "relief-rough";
  const idx = doc.operations.indexOf(op);
  let best: CAMOperation | null = null;
  let bestDist = Infinity;
  for (let i = 0; i < doc.operations.length; i++) {
    const o = doc.operations[i];
    if (o === op || o.type !== otherType) continue;
    if (!reliefImageIds(o, doc).some((id) => myImages.has(id))) continue;
    const dist = Math.abs(i - idx);
    if (dist < bestDist) {
      bestDist = dist;
      best = o;
    }
  }
  return best;
}
