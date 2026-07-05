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
  /** Distinct gaps closed (a cluster of coincident endpoints, not per endpoint). */
  gapsWelded: number;
  /** Open polylines whose ends met and were closed. */
  polylinesClosed: number;
}

const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

/** Total number of changes the repair made. */
export function repairChangeCount(r: RepairReport): number {
  return r.degenerateRemoved + r.duplicatesRemoved + r.gapsWelded + r.polylinesClosed;
}

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/** Human-readable lines describing what the repair did (empty if it changed nothing). */
export function summarizeRepairs(r: RepairReport): string[] {
  const out: string[] = [];
  if (r.gapsWelded) out.push(`welded ${plural(r.gapsWelded, "gap", "gaps")}`);
  if (r.polylinesClosed) out.push(`closed ${plural(r.polylinesClosed, "open contour", "open contours")}`);
  if (r.duplicatesRemoved) out.push(`removed ${plural(r.duplicatesRemoved, "duplicate", "duplicates")}`);
  if (r.degenerateRemoved) out.push(`removed ${plural(r.degenerateRemoved, "empty entity", "empty entities")}`);
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

/**
 * Union-find the endpoints into clusters of coincident-within-`tol` points,
 * returning only clusters of ≥2. Two endpoints of the *same* entity are never
 * merged (that would collapse a short segment to nothing).
 */
function clusterEndpoints(nodes: WeldNode[], tol: number): number[][] {
  const n = nodes.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  // O(n²) pairwise — fine for typical DXF sizes (hundreds of endpoints).
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (nodes[i].owner === nodes[j].owner) continue;
      if (dist(nodes[i].pos, nodes[j].pos) < tol) parent[find(i)] = find(j);
    }
  }
  const clusters = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    (clusters.get(r) ?? clusters.set(r, []).get(r)!).push(i);
  }
  return [...clusters.values()].filter((c) => c.length >= 2);
}

/** The shared target a cluster collapses to: an arc anchor if present, else the centroid. */
function clusterTarget(members: number[], nodes: WeldNode[]): Vec2 {
  const anchor = members.find((i) => !nodes[i].set);
  if (anchor !== undefined) return { ...nodes[anchor].pos };
  const cx = members.reduce((s, i) => s + nodes[i].pos.x, 0) / members.length;
  const cy = members.reduce((s, i) => s + nodes[i].pos.y, 0) / members.length;
  return { x: cx, y: cy };
}

/** Snap near-coincident open endpoints together; returns the number of gaps closed. */
function weldEndpoints(entities: Entity[], tol: number): number {
  const nodes = weldNodes(entities);
  let gaps = 0;
  for (const members of clusterEndpoints(nodes, tol)) {
    const target = clusterTarget(members, nodes);
    let moved = false;
    for (const i of members) {
      const node = nodes[i];
      if (node.set && dist(node.pos, target) > 1e-9) { node.set(target); moved = true; }
    }
    if (moved) gaps++;
  }
  return gaps;
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
    gapsWelded: 0,
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
    report.gapsWelded = weldEndpoints(result, weldTolerance);
  }

  return { entities: result, report };
}

// ---------------------------------------------------------------------------
// Diagnosis (non-mutating) — locate issues so they can be highlighted before
// the user commits to a repair.
// ---------------------------------------------------------------------------

/** CAM chains loops at this threshold (mm); gaps at or below it already meet. */
const GAP_CHAIN_EPS = 1e-4;

export type DiagnosticKind = "gap" | "open-contour" | "duplicate" | "degenerate";

export interface DxfDiagnostic {
  kind: DiagnosticKind;
  /** Where to anchor the on-canvas marker (world mm). */
  pos: Vec2;
  /** Magnitude in mm where meaningful (gap / end-separation width); 0 otherwise. */
  sizeMM: number;
}

/** A representative point for marking an entity (its middle / centre). */
function entityAnchor(e: Entity): Vec2 {
  if (e instanceof LineEntity) return { x: (e.a.x + e.b.x) / 2, y: (e.a.y + e.b.y) / 2 };
  if (e instanceof CircleEntity || e instanceof ArcEntity) return { ...e.center };
  if (e instanceof PolylineEntity && e.points.length) return { ...e.points[0] };
  return { x: 0, y: 0 };
}

/** Largest separation between any two endpoints in a cluster. */
function clusterSpan(members: number[], nodes: WeldNode[]): number {
  let max = 0;
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      max = Math.max(max, dist(nodes[members[i]].pos, nodes[members[j]].pos));
    }
  }
  return max;
}

/**
 * Find everything {@link repairImportedEntities} would fix, with a location for
 * each, without changing any geometry. Used to highlight issues on the canvas
 * before the user decides whether to repair.
 */
export function diagnoseImportedEntities(
  entities: Entity[],
  opts: RepairOptions = {},
): DxfDiagnostic[] {
  const tol = opts.weldTolerance ?? DEFAULT_WELD_TOLERANCE;
  const diags: DxfDiagnostic[] = [];

  // Degenerates — reported on their own; excluded from the passes below as noise.
  const live: Entity[] = [];
  for (const e of entities) {
    if (isDegenerate(e)) diags.push({ kind: "degenerate", pos: entityAnchor(e), sizeMM: 0 });
    else live.push(e);
  }

  // Exact duplicates (2nd and later occurrences).
  const seen = new Set<string>();
  for (const e of live) {
    const key = dupeKey(e);
    if (key === null) continue;
    if (seen.has(key)) diags.push({ kind: "duplicate", pos: entityAnchor(e), sizeMM: 0 });
    else seen.add(key);
  }

  // Weldable gaps — clusters wide enough that CAM can't already chain them.
  const nodes = weldNodes(live);
  for (const members of clusterEndpoints(nodes, tol)) {
    const span = clusterSpan(members, nodes);
    if (span <= GAP_CHAIN_EPS) continue;
    diags.push({ kind: "gap", pos: clusterTarget(members, nodes), sizeMM: span });
  }

  // Unclosed contours — polylines whose ends meet but aren't flagged closed.
  for (const e of live) {
    if (e instanceof PolylineEntity && !e.closed && e.points.length >= 3) {
      const a = e.points[0], b = e.points[e.points.length - 1];
      const d = dist(a, b);
      if (d < tol) diags.push({ kind: "open-contour", pos: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, sizeMM: d });
    }
  }

  return diags;
}

/** Human-readable lines describing diagnosed issues (empty if none). */
export function summarizeDiagnostics(diags: DxfDiagnostic[]): string[] {
  const c: Record<DiagnosticKind, number> = { gap: 0, "open-contour": 0, duplicate: 0, degenerate: 0 };
  for (const d of diags) c[d.kind]++;
  const out: string[] = [];
  if (c.gap) out.push(plural(c.gap, "gap", "gaps"));
  if (c["open-contour"]) out.push(plural(c["open-contour"], "unclosed contour", "unclosed contours"));
  if (c.duplicate) out.push(plural(c.duplicate, "duplicate", "duplicates"));
  if (c.degenerate) out.push(plural(c.degenerate, "empty entity", "empty entities"));
  return out;
}
