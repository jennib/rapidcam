/**
 * Pure helpers for the CAM toolpaths bar (no DOM, no class state).
 * Extracted from camBar.ts so the operation-matching / region-seeding logic can
 * be unit-tested and reasoned about independently of the dialog UI.
 */
import type { CADDocument } from "../model/document";
import {
  type Entity,
  CircleEntity,
  LineEntity,
  PolylineEntity,
  RectEntity,
  ArcEntity,
  BezierEntity,
  TextEntity,
  RasterImageEntity,
} from "../model/entities";
import type { Vec2 } from "../core/vec2";
import { dist } from "../core/vec2";
import { formatLength } from "../core/units";
import type { CAMOperation, RegionRef } from "../cam/types";
import { collectClosedLoops, pointInPolygon } from "../cam/loops";
import { interiorPoint, refAtPoint, resolveRegion } from "../cam/regions";

export type OpCombo = "profile-outside" | "profile-inside" | "pocket" | "engrave" | "drill" | "chamfer" | "vcarve" | "relief-rough" | "score";

/** Matches names produced by autoName(), e.g. "Pocket 2", "Profile (outside) 1". */
export const AUTO_NAME_RE = /^(Profile \(outside\)|Profile \(inside\)|Pocket|Engrave|Drill|Chamfer|V-Carve|Relief Roughing|Score \/ Fold) \d+$/;

export function comboOf(op: CAMOperation): OpCombo {
  if (op.type === "profile") return op.side === "outside" ? "profile-outside" : "profile-inside";
  return op.type as OpCombo;
}

/**
 * The op-type a freshly opened toolpath dialog should start on:
 * - editing an existing op → its own type;
 * - a new op in a laser doc → a beam-capable type (profile/engrave);
 * - a new op whose selection includes a raster image → **Engrave**, because an
 *   image can only be engraved. Any other default would let the geometry list
 *   strip the image as "invalid for profile", leaving the op with no geometry
 *   (and Apply then rejecting it as an empty selection).
 */
export function defaultCombo(existing: CAMOperation | null, preSelected: Entity[], isLaser: boolean): OpCombo {
  let combo: OpCombo = existing ? comboOf(existing) : "profile-outside";
  // Laser has no spindle/Z ops; keep only beam-capable types.
  if (isLaser && combo !== "profile-outside" && combo !== "profile-inside" && combo !== "engrave" && combo !== "score")
    combo = "profile-outside";
  if (!existing && preSelected.some((e) => e instanceof RasterImageEntity)) combo = "engrave";
  return combo;
}

export function describeEntity(e: Entity, doc: CADDocument): string {
  const u = doc.displayUnit;
  if (e instanceof LineEntity) return `Line — ${formatLength(dist(e.a, e.b), u)}`;
  if (e instanceof CircleEntity) return `Circle — r=${formatLength(e.radius, u)}`;
  if (e instanceof RectEntity)
    return `Rectangle — ${formatLength(e.width, u)} × ${formatLength(e.height, u)}`;
  if (e instanceof PolylineEntity)
    return `Polyline — ${e.points.length} pts${e.closed ? " (closed)" : " (open)"}`;
  if (e instanceof TextEntity)
    return `Text — "${e.text.length > 20 ? `${e.text.slice(0, 20)}…` : e.text}"`;
  return "Entity";
}

export interface OpSelectionCheck {
  /** Selected entity ids that are valid for this op type (the op's actual targets). */
  validIds: string[];
  /** A user-facing reason when nothing valid is selected, else null. */
  error: string | null;
}

/**
 * Validate a toolpath's target selection for its op type. Returns the subset of
 * the selection valid for `combo`; when none are valid it returns a *specific*
 * reason — e.g. an image can only be engraved — so the dialog can guide the user
 * rather than just saying "select geometry". Invalid entities are filtered, not
 * required to be absent, so a selection can carry geometry that only some op
 * types accept (an image stays selected when you flip the op to Cut and back).
 */
export function checkOpSelection(entities: Entity[], selectedIds: Iterable<string>, combo: OpCombo): OpSelectionCheck {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const sel: Entity[] = [];
  for (const id of selectedIds) { const e = byId.get(id); if (e) sel.push(e); }
  const valid = sel.filter((e) => isValidFor(e, combo));
  if (valid.length > 0) return { validIds: valid.map((e) => e.id), error: null };
  if (sel.some((e) => e instanceof RasterImageEntity))
    return { validIds: [], error: "An image can only be engraved — set this toolpath's type to Engrave." };
  if (sel.length > 0)
    return { validIds: [], error: "None of the selected geometry can be used by this operation type." };
  return { validIds: [], error: "Select at least one geometry item." };
}

export function isValidFor(e: Entity, combo: OpCombo): boolean {
  if (e.isConstruction) return false;
  switch (combo) {
    case "profile-outside":
    case "profile-inside":
    case "pocket":
      return (
        e instanceof TextEntity ||
        e instanceof CircleEntity ||
        e instanceof RectEntity ||
        e instanceof LineEntity ||
        (e instanceof PolylineEntity && e.closed)
      );
    case "engrave":
    case "chamfer":
      return true;
    case "score":
      // A score/fold follows any vector centreline; a raster image can't be scored.
      return !(e instanceof RasterImageEntity);
    case "vcarve":
      // V-carve fills closed regions; text is the main use case.
      return (
        e instanceof TextEntity ||
        e instanceof CircleEntity ||
        e instanceof RectEntity ||
        (e instanceof PolylineEntity && e.closed)
      );
    case "relief-rough":
      // Roughing (like the relief finish) only targets a greyscale image.
      return e instanceof RasterImageEntity;
    case "drill":
      return e instanceof CircleEntity;
  }
}

/**
 * Synthesize region seeds from entity-id sets: one seed inside each boundary
 * loop, clear of its islands. Used to migrate legacy pocket ops and to seed
 * regions from the canvas selection.
 */
export function seedsFromEntityIds(doc: CADDocument, entIds: Set<string>, islIds: Set<string>): Vec2[] {
  const loops = collectClosedLoops(doc.entities);
  const boundaries = loops.filter((L) => L.ids.every((id) => entIds.has(id)));
  const islands = loops.filter((L) => L.ids.every((id) => islIds.has(id)));
  const seeds: Vec2[] = [];
  for (const b of boundaries) {
    const holes = islands
      .filter((i) => pointInPolygon(i.verts[0], b.verts))
      .map((i) => i.verts);
    const p = interiorPoint(b.verts, holes);
    if (p) seeds.push(p);
  }
  return seeds;
}

export function legacyPocketSeeds(op: CAMOperation, doc: CADDocument): Vec2[] {
  return seedsFromEntityIds(doc, new Set(op.entityIds), new Set(op.islandIds ?? []));
}

/**
 * Convert transient edit-time seed points (valid against the current, static
 * geometry while the dialog is open) into parametric region refs for storage.
 */
export function refsFromSeeds(doc: CADDocument, seeds: Vec2[]): RegionRef[] {
  const loops = collectClosedLoops(doc.entities);
  const refs: RegionRef[] = [];
  for (const p of seeds) {
    const ref = refAtPoint(p, loops);
    if (ref) refs.push(ref);
  }
  return refs;
}

/** Resolve stored region refs back to interior seed points for live editing. */
export function seedsFromRegions(doc: CADDocument, regions: RegionRef[]): Vec2[] {
  const loops = collectClosedLoops(doc.entities);
  const seeds: Vec2[] = [];
  for (const ref of regions) {
    const region = resolveRegion(ref, loops);
    if (!region) continue;
    const p = interiorPoint(region.outer, region.holes);
    if (p) seeds.push(p);
  }
  return seeds;
}

export function findContiguousChain(startId: string, doc: CADDocument, validCombo: OpCombo): string[] {
  const chain = new Set<string>();
  const front: Vec2[] = [];

  const startEnt = doc.entities.find(e => e.id === startId);
  if (!startEnt || startEnt.isConstruction) return [];

  const getEnds = (e: Entity): Vec2[] => {
    // The two free endpoints of an open path. (Must be the actual ends — e.g.
    // LineEntity.pickablePoints() is [a, b, mid], so indexing first/last there
    // would wrongly return the midpoint and break chain-walking.)
    if (e instanceof LineEntity) return [e.a, e.b];
    if (e instanceof ArcEntity) return [e.startPoint, e.endPoint];
    if (e instanceof BezierEntity) return [e.p0, e.p3];
    if (e instanceof PolylineEntity && e.points.length > 0)
      return [e.points[0], e.points[e.points.length - 1]];
    return [];
  };

  front.push(...getEnds(startEnt));
  chain.add(startId);

  let added = true;
  while (added) {
    added = false;
    for (const e of doc.entities) {
      if (chain.has(e.id) || e.isConstruction || !isValidFor(e, validCombo)) continue;

      const ePts = getEnds(e);
      if (ePts.length === 2) {
        for (let i = 0; i < front.length; i++) {
          const f = front[i];
          if (dist(f, ePts[0]) < 1e-5) {
            chain.add(e.id);
            front[i] = ePts[1];
            added = true;
            break;
          } else if (dist(f, ePts[1]) < 1e-5) {
            chain.add(e.id);
            front[i] = ePts[0];
            added = true;
            break;
          }
        }
      }
    }
  }
  return [...chain];
}
