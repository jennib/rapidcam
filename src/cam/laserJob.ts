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
import { collectClosedLoops, pointInPolygon } from "./loops";

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
 * Something the user drew, as opposed to construction geometry or the
 * document's own bookkeeping (the WCS origin point). Used to tell "this layer
 * is empty" from "this layer holds things this job can't do to them".
 */
function isUserGeometry(e: Entity): boolean {
  return !e.isConstruction && (hasCuttablePath(e) || e instanceof RasterImageEntity);
}

/**
 * Can this entity be cut by this kind of job? An open polyline IS a contour
 * target for a beam (see 4ae234b), so the kind only narrows things for a raster
 * image, which can never be anything but engraved.
 */
function usableFor(kind: LaserJobKind, e: Entity): boolean {
  // Hidden means not cut, the same rule the layer check above applies — see
  // cam/machinable.ts. An individually hidden object is no more burnable than
  // one on a hidden layer.
  if (e.isConstruction || !e.visible) return false;
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
    // Hidden means not cut. A user who hides a layer to get it out of the way
    // and then builds the job does not expect the machine to burn it anyway,
    // and finding out costs a piece of material. Unhide it to include it.
    if (layer.visible === false) {
      skipped.push({ layer: layer.name, why: "the layer is hidden" });
      continue;
    }
    const targets = doc.entities.filter(
      (e) => e.layerId === layer.id && usableFor(recipe.kind as LaserJobKind, e),
    );
    if (targets.length === 0) {
      // Distinguish "empty" from "holds things a beam can't do to it" — an
      // image on a cut layer reported as "no geometry" sends the user hunting
      // for shapes that are sitting right there.
      //
      // "Anything" means anything the USER drew. Counting every entity would
      // count the document's implicit WCS origin point, which sits on layer 0
      // of every drawing and would make a genuinely empty first layer report
      // the wrong reason. That point has now caused three separate bugs here.
      const onLayer = doc.entities.filter((e) => e.layerId === layer.id && isUserGeometry(e));
      // All of it hidden is its own answer. Reporting "nothing on it can be
      // cut" would send the user looking for the wrong problem when the fix is
      // one click in the design tree.
      const allHidden = onLayer.length > 0 && onLayer.every((e) => !e.visible);
      skipped.push({
        layer: layer.name,
        why: allHidden
          ? "everything on it is hidden"
          : onLayer.length > 0
            ? `nothing on it can be ${JOB_KIND_LABELS[recipe.kind].toLowerCase()} (an image can only be engraved)`
            : "no geometry on it",
      });
      continue;
    }
    operations.push(...opsForLayer(layer, recipe.kind, targets));
  }

  return { operations, skipped };
}

/**
 * Which of a cut layer's shapes are HOLES — contours enclosed by another
 * contour on the same layer, by the even–odd rule.
 *
 * This matters because kerf compensation has a direction. To finish at the
 * drawn size the beam centreline runs OUTSIDE an outline and INSIDE a hole; use
 * one side for both and every hole comes out a full kerf oversize. A layer has
 * one recipe, so the split has to be derived from the geometry.
 *
 * Same containment test `machinability.ts` already uses for pocket islands.
 */
function splitByContainment(targets: Entity[]): { outer: Entity[]; holes: Entity[] } {
  const loops = collectClosedLoops(targets);
  const holeIds = new Set<string>();
  for (const loop of loops) {
    const depth = loops.filter(
      (other) => other !== loop && pointInPolygon(loop.verts[0], other.verts),
    ).length;
    if (depth % 2 === 1) for (const id of loop.ids) holeIds.add(id);
  }
  return {
    // Open curves belong to no loop and so are never holes.
    outer: targets.filter((e) => !holeIds.has(e.id)),
    holes: targets.filter((e) => holeIds.has(e.id)),
  };
}

/**
 * The operation(s) one layer contributes. Usually one — but a kerf-compensated
 * cut containing holes becomes two, because the compensation runs the opposite
 * way on a hole (see {@link splitByContainment}).
 *
 * Holes are emitted FIRST, which is also how you would run the job by hand:
 * cut the interior features while the part is still held by the sheet, then
 * free it with the outline.
 */
function opsForLayer(layer: LayerDef, kind: LaserJobKind, targets: Entity[]): CAMOperation[] {
  const r = layer.laser!;
  const kerf = r.kerfWidth ?? 0;
  // An explicit side is the user overriding the automatic call — honour it.
  if (kind !== "cut" || kerf <= 0 || r.side) return [opForLayer(layer, kind, targets)];

  const { outer, holes } = splitByContainment(targets);
  if (holes.length === 0) return [opForLayer(layer, kind, targets, "outside")];
  if (outer.length === 0) return [opForLayer(layer, kind, targets, "inside")];
  return [
    opForLayer(layer, kind, holes, "inside", `${layer.name} (holes)`),
    opForLayer(layer, kind, outer, "outside", layer.name),
  ];
}

function opForLayer(
  layer: LayerDef,
  kind: LaserJobKind,
  targets: Entity[],
  side?: "outside" | "inside",
  name?: string,
): CAMOperation {
  const r = layer.laser!;
  const isCut = kind === "cut";
  const isFill = kind === "fill";
  return {
    id: nextId("cam"),
    // Named for the layer, because that is how the user will look for it — in
    // the CAM list, in the G-code comments and in the pre-flight report.
    name: name ?? layer.name,
    type: kind === "score" ? "score" : isCut ? "profile" : "engrave",
    entityIds: targets.map((e) => e.id),
    side: side ?? r.side ?? "outside",
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
