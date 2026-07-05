/**
 * Babel — DXF repair.
 *
 * A post-import cleanup pass that turns messy CAD exports into geometry the CAM
 * loop detector can actually chain. It runs on the imported `Entity[]` *after*
 * `importDxf` (which is kept byte-exact for round-tripping), so nothing here
 * touches the parser.
 *
 * Three failures break CAM on real-world DXFs, and this fixes all three:
 *
 *   1. Gaps      — endpoints that should meet sit a few microns apart. CAM
 *                  chains loops with a 1e-4 mm threshold (see cam/loops.ts), so
 *                  a 0.01 mm gap silently prevents a pocket/profile from closing.
 *                  We weld open-curve endpoints within `weldTolerance` onto a
 *                  shared point (snapping to an arc endpoint when one is present,
 *                  so arcs keep their exact geometry).
 *   2. Duplicates— exact overlapping lines/circles/arcs, a classic exporter bug
 *                  that doubles cut time and confuses region picking.
 *   3. Degenerates— zero-length lines, zero-radius circles/arcs, empty polylines.
 *
 * Plus a freebie: an open polyline whose first and last vertex meet within the
 * weld tolerance is marked closed.
 *
 * Everything is reported (see `RepairReport` / `summarizeRepairs`) — the import
 * never moves geometry silently.
 */

import type { Vec2 } from "../core/vec2";
import {
  Entity,
  LineEntity,
  CircleEntity,
  ArcEntity,
  PolylineEntity,
} from "../model/entities";

/** Endpoints closer than this (mm) are treated as the same point when welding. */
export const DEFAULT_WELD_TOLERANCE = 0.05;

/** Grid (mm / rad) for hashing entities when detecting exact duplicates. */
const DUPE_GRID = 1e-4;
const DUPE_ANGLE_GRID = 1e-6;

/** Below this (mm / rad) a line/radius/sweep is geometrically nothing. */
const DEGENERATE_EPS = 1e-4;

export interface RepairOptions {
  /** Snap open-curve endpoints within this many mm. Default {@link DEFAULT_WELD_TOLERANCE}. */
  weldTolerance?: number;
  /** Weld near-coincident endpoints (and auto-close polylines). Default true. */
  weld?: boolean;
  /** Drop exact-duplicate lines/circles/arcs. Default true. */
  removeDuplicates?: boolean;
  /** Drop zero-length / zero-radius / empty entities. Default true. */
  removeDegenerate?: boolean;
}

export interface RepairReport {
  degenerateRemoved: number;
  duplicatesRemoved: number;
  /** Individual endpoints snapped onto a neighbour. */
  endpointsWelded: number;
  /** Open polylines whose ends met and were closed. */
  polylinesClosed: number;
}

const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

/** Total number of changes the repair made. */
export function repairChangeCount(r: RepairReport): number {
  return r.degenerateRemoved + r.duplicatesRemoved + r.endpointsWelded + r.polylinesClosed;
}

/** Human-readable lines describing what the repair did (empty if it changed nothing). */
export function summarizeRepairs(r: RepairReport): string[] {
  const out: string[] = [];
  const n = (count: number, one: string, many: string) =>
    `${count} ${count === 1 ? one : many}`;
  if (r.endpointsWelded) out.push(`welded ${n(r.endpointsWelded, "gap", "gaps")}`);
  if (r.polylinesClosed) out.push(`closed ${n(r.polylinesClosed, "open contour", "open contours")}`);
  if (r.duplicatesRemoved) out.push(`removed ${n(r.duplicatesRemoved, "duplicate", "duplicates")}`);
  if (r.degenerateRemoved) out.push(`removed ${n(r.degenerateRemoved, "empty entity", "empty entities")}`);
  return out;
}

// ---------------------------------------------------------------------------
// Degenerate removal
// ---------------------------------------------------------------------------

function isDegenerate(e: Entity): boolean {
  if (e instanceof LineEntity) return dist(e.a, e.b) < DEGENERATE_EPS;
  if (e instanceof CircleEntity) return e.radius < DEGENERATE_EPS;
  // A zero-sweep arc is genuinely nothing; a zero-radius one too. Start==end is
  // left alone (some exporters mean "full circle" by it — not our call to make).
  if (e instanceof ArcEntity) return e.radius < DEGENERATE_EPS;
  if (e instanceof PolylineEntity) {
    const need = e.closed ? 3 : 2;
    if (e.points.length < need) return true;
    // All points coincident → no geometry.
    return e.points.every((p) => dist(p, e.points[0]) < DEGENERATE_EPS);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Duplicate removal
// ---------------------------------------------------------------------------

const q = (v: number) => Math.round(v / DUPE_GRID);
const qa = (v: number) => Math.round(v / DUPE_ANGLE_GRID);
const pt = (p: Vec2) => `${q(p.x)},${q(p.y)}`;

/** A canonical key for entities we know how to compare, or null to never dedupe. */
function dupeKey(e: Entity): string | null {
  if (e instanceof LineEntity) {
    // Direction-independent: a→b and b→a are the same segment.
    const [p1, p2] = [pt(e.a), pt(e.b)].sort();
    return `L|${p1}|${p2}`;
  }
  if (e instanceof CircleEntity) return `C|${pt(e.center)}|${q(e.radius)}`;
  if (e instanceof ArcEntity) {
    // A CCW arc start→end differs from end→start (complementary sweep), so the
    // angles are part of the identity and are not reordered.
    return `A|${pt(e.center)}|${q(e.radius)}|${qa(e.startAngle)}|${qa(e.endAngle)}`;
  }
  return null; // polylines/others: too export-specific to canonicalize safely
}

// ---------------------------------------------------------------------------
// Welding (union-find over open-curve endpoints)
// ---------------------------------------------------------------------------

interface WeldNode {
  owner: Entity;
  pos: Vec2;
  /** Undefined = immovable anchor (an arc endpoint keeps arcs exact). */
  set?: (p: Vec2) => void;
}

function arcEndpoints(a: ArcEntity): [Vec2, Vec2] {
  return [
    { x: a.center.x + a.radius * Math.cos(a.startAngle), y: a.center.y + a.radius * Math.sin(a.startAngle) },
    { x: a.center.x + a.radius * Math.cos(a.endAngle), y: a.center.y + a.radius * Math.sin(a.endAngle) },
  ];
}

/** Collect the chainable endpoints of open curves as weld nodes. */
function weldNodes(entities: Entity[]): WeldNode[] {
  const nodes: WeldNode[] = [];
  for (const e of entities) {
    if (e instanceof LineEntity) {
      nodes.push({ owner: e, pos: e.a, set: (p) => { e.a = { ...p }; } });
      nodes.push({ owner: e, pos: e.b, set: (p) => { e.b = { ...p }; } });
    } else if (e instanceof ArcEntity) {
      const [a, b] = arcEndpoints(e);
      nodes.push({ owner: e, pos: a });
      nodes.push({ owner: e, pos: b });
    } else if (e instanceof PolylineEntity && !e.closed && e.points.length >= 2) {
      const last = e.points.length - 1;
      nodes.push({ owner: e, pos: e.points[0], set: (p) => { e.points[0] = { ...p }; } });
      nodes.push({ owner: e, pos: e.points[last], set: (p) => { e.points[last] = { ...p }; } });
    }
  }
  return nodes;
}

/** Snap near-coincident open endpoints together; returns the number of moved endpoints. */
function weldEndpoints(entities: Entity[], tol: number): number {
  const nodes = weldNodes(entities);
  const n = nodes.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const union = (i: number, j: number) => { parent[find(i)] = find(j); };

  // O(n²) pairwise — fine for typical DXF sizes (hundreds of endpoints). Never
  // merge two endpoints of the same entity (that would collapse a short segment).
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (nodes[i].owner === nodes[j].owner) continue;
      if (dist(nodes[i].pos, nodes[j].pos) < tol) union(i, j);
    }
  }

  // Group by cluster root.
  const clusters = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    (clusters.get(r) ?? clusters.set(r, []).get(r)!).push(i);
  }

  let welded = 0;
  for (const members of clusters.values()) {
    if (members.length < 2) continue;
    // Prefer an anchor (arc endpoint) as the shared target so arcs stay exact;
    // otherwise use the centroid of the movable endpoints.
    const anchor = members.find((i) => !nodes[i].set);
    let target: Vec2;
    if (anchor !== undefined) {
      target = { ...nodes[anchor].pos };
    } else {
      const cx = members.reduce((s, i) => s + nodes[i].pos.x, 0) / members.length;
      const cy = members.reduce((s, i) => s + nodes[i].pos.y, 0) / members.length;
      target = { x: cx, y: cy };
    }
    for (const i of members) {
      const node = nodes[i];
      if (node.set && dist(node.pos, target) > 1e-9) {
        node.set(target);
        welded++;
      }
    }
  }
  return welded;
}

/** Mark open polylines whose ends already meet as closed; returns how many. */
function closeOpenPolylines(entities: Entity[], tol: number): number {
  let closed = 0;
  for (const e of entities) {
    if (e instanceof PolylineEntity && !e.closed && e.points.length >= 3) {
      const first = e.points[0], last = e.points[e.points.length - 1];
      if (dist(first, last) < tol) { e.closed = true; closed++; }
    }
  }
  return closed;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Clean up freshly-imported DXF geometry. Mutates entity positions in place and
 * returns the surviving entities (some removed) plus a report of what changed.
 */
export function repairImportedEntities(
  entities: Entity[],
  opts: RepairOptions = {},
): { entities: Entity[]; report: RepairReport } {
  const {
    weldTolerance = DEFAULT_WELD_TOLERANCE,
    weld = true,
    removeDuplicates = true,
    removeDegenerate = true,
  } = opts;

  const report: RepairReport = {
    degenerateRemoved: 0,
    duplicatesRemoved: 0,
    endpointsWelded: 0,
    polylinesClosed: 0,
  };

  let result = entities;

  if (removeDegenerate) {
    result = result.filter((e) => {
      if (isDegenerate(e)) { report.degenerateRemoved++; return false; }
      return true;
    });
  }

  if (removeDuplicates) {
    const seen = new Set<string>();
    result = result.filter((e) => {
      const key = dupeKey(e);
      if (key === null) return true;
      if (seen.has(key)) { report.duplicatesRemoved++; return false; }
      seen.add(key);
      return true;
    });
  }

  if (weld) {
    // Close self-meeting polylines first so their ends drop out of the open-endpoint
    // welding below.
    report.polylinesClosed = closeOpenPolylines(result, weldTolerance);
    report.endpointsWelded = weldEndpoints(result, weldTolerance);
  }

  return { entities: result, report };
}
