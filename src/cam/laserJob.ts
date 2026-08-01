/**
 * Build a laser job from the document's layers — the colour-driven workflow
 * taken to its conclusion: say what each layer is FOR, then turn the whole
 * drawing into toolpaths in one action.
 *
 * A layer's beam recipe already carries power, speed and passes (see
 * cam/types.ts {@link LaserRecipe}), and those are LIVE: `resolveOpLaser`
 * applies them at toolpath time, so re-tuning a layer re-tunes every operation
 * cutting it. The job **kind** deliberately is not live, and the distinction
 * matters:
 *
 * - Power, speed and passes are **parameters**. Changing one changes how hard
 *   the same move is cut. Applying that live is safe and is the whole point.
 * - The kind is **structure**. A cut is a kerf-compensated closed contour; an
 *   engrave is a centreline; a fill floods the interior with scan rows. They
 *   emit fundamentally different geometry. Silently retyping somebody's
 *   operation at export time — after they had previewed it — would be a nasty
 *   surprise on a machine that burns things.
 *
 * So the kind is read HERE, when operations are built, and thereafter the
 * operation owns its type. Change a layer's kind and rebuild to apply it.
 */

import type { CADDocument, LayerDef } from "../model/document";
import {
  ArcEntity,
  BezierEntity,
  CircleEntity,
  LineEntity,
  PolylineEntity,
  RasterImageEntity,
  RectEntity,
  TextEntity,
  type Entity,
} from "../model/entities";
import { type CAMOperation, DEFAULTS, type LaserJobKind } from "./types";
import { nextId } from "../model/ids";

/** Human label for a job kind, shared by the layers panel and this builder. */
export const JOB_KIND_LABELS: Record<LaserJobKind, string> = {
  cut: "Cut",
  score: "Score",
  engrave: "Engrave",
  fill: "Engrave (filled)",
};

export interface LayerJob {
  /** One operation per layer that had a kind and usable geometry, in layer order. */
  operations: CAMOperation[];
  /** Layers deliberately passed over, with the reason — surfaced to the user. */
  skipped: { layer: string; why: string }[];
}

/**
 * Anything with a path a beam can follow. An ALLOW-list, deliberately, and it
 * mirrors the cam bar's `isContourTarget`: a deny-list silently swept up the
 * document's implicit WCS origin — a `PointEntity` on layer 0 that every
 * drawing has — into the first cut. Whatever entity type gets added next is
 * excluded until someone decides it is cuttable.
 *
 * Kept local rather than importing the cam bar's version, which lives in ui/;
 * this module is called from tests and headless callers, and cam/ must not
 * depend on ui/.
 */
function hasCuttablePath(e: Entity): boolean {
  return (
    e instanceof LineEntity ||
    e instanceof CircleEntity ||
    e instanceof RectEntity ||
    e instanceof PolylineEntity ||
    e instanceof ArcEntity ||
    e instanceof BezierEntity ||
    e instanceof TextEntity
  );
}

/**
 * Can this entity be cut by this kind of job? An open polyline IS a contour
 * target for a beam (see 4ae234b), so the kind only narrows things for a raster
 * image, which can never be anything but engraved.
 */
function usableFor(kind: LaserJobKind, e: Entity): boolean {
  if (e.isConstruction) return false;
  if (e instanceof RasterImageEntity) return kind === "engrave" || kind === "fill";
  return hasCuttablePath(e);
}

/**
 * One operation per layer carrying a job kind, in layer order — so the program
 * runs down the layer list, which is the order the user arranged them in.
 *
 * Fixture layers are skipped: workholding is not cut. Layers with a beam recipe
 * but no kind are skipped too — a recipe alone says how hard to cut, not what
 * the geometry is for.
 */
export function buildJobFromLayers(doc: CADDocument): LayerJob {
  const operations: CAMOperation[] = [];
  const skipped: { layer: string; why: string }[] = [];

  for (const layer of doc.layers) {
    const recipe = layer.laser;
    if (!recipe?.kind) continue; // not part of the job; nothing to report
    if (layer.fixture) {
      skipped.push({ layer: layer.name, why: "workholding layers are not cut" });
      continue;
    }
    const targets = doc.entities.filter(
      (e) => e.layerId === layer.id && usableFor(recipe.kind as LaserJobKind, e),
    );
    if (targets.length === 0) {
      skipped.push({ layer: layer.name, why: "no geometry on it" });
      continue;
    }
    operations.push(opForLayer(layer, recipe.kind, targets));
  }

  return { operations, skipped };
}

function opForLayer(layer: LayerDef, kind: LaserJobKind, targets: Entity[]): CAMOperation {
  const r = layer.laser!;
  const isCut = kind === "cut";
  const isFill = kind === "fill";
  return {
    id: nextId("cam"),
    // Named for the layer, because that is how the user will look for it — in
    // the CAM list, in the G-code comments and in the pre-flight report.
    name: layer.name,
    type: kind === "score" ? "score" : isCut ? "profile" : "engrave",
    entityIds: targets.map((e) => e.id),
    side: r.side ?? "outside",
    // A laser has no tool, but the fields are required. Same convention as
    // cam/materialTest.ts.
    toolType: "end-mill",
    toolNumber: 1,
    diameter: 0,
    plungeRate: DEFAULTS.plungeRate,
    spindleSpeed: 0,
    safeZ: DEFAULTS.safeZ,
    depth: DEFAULTS.depth,
    stepdown: DEFAULTS.stepdown,
    stepover: DEFAULTS.stepover,
    // Copied from the recipe rather than left to resolution alone, so the
    // operation still holds sane numbers if the layer's recipe is later removed
    // — the same by-value contract applying a material preset uses.
    feedrate: r.feedrate,
    laserPower: r.laserPower,
    laserPasses: r.laserPasses,
    // Kerf compensation only means something on a closed cut.
    kerfWidth: isCut ? (r.kerfWidth ?? DEFAULTS.kerfWidth) : undefined,
    airAssist: r.airAssist,
    laserFill: isFill ? true : undefined,
    laserFillSpacing: isFill ? DEFAULTS.laserFillSpacing : undefined,
  };
}
