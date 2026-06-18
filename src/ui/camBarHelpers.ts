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
} from "../model/entities";
import type { Vec2 } from "../core/vec2";
import { dist } from "../core/vec2";
import { formatLength } from "../core/units";
import type { CAMOperation, RegionRef } from "../cam/types";
import { collectClosedLoops, pointInPolygon } from "../cam/loops";
import { interiorPoint, refAtPoint, resolveRegion } from "../cam/regions";

export type OpCombo = "profile-outside" | "profile-inside" | "pocket" | "engrave" | "drill";

/** Matches names produced by autoName(), e.g. "Pocket 2", "Profile (outside) 1". */
export const AUTO_NAME_RE = /^(Profile \(outside\)|Profile \(inside\)|Pocket|Engrave|Drill) \d+$/;

export function comboOf(op: CAMOperation): OpCombo {
  if (op.type === "profile") return op.side === "outside" ? "profile-outside" : "profile-inside";
  return op.type as OpCombo;
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
    return `Text — "${e.text.length > 20 ? e.text.slice(0, 20) + "…" : e.text}"`;
  return "Entity";
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
      return true;
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
