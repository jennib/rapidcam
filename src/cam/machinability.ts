/**
 * Machinability pre-flight: detect geometry a too-large tool cannot reach.
 *
 * The toolpath layer fails SILENTLY here — `profilePolygon` returns [] when the
 * offset vanishes, and features narrower than the tool are simply swallowed by
 * the polygon offset (a 6 mm end mill on a module-2 gear posts clean G-code for
 * a toothless disc). Pockets at least leave a `; NOTE:` comment, but nobody
 * reads comments. This check surfaces both cases in the pre-flight dialog.
 *
 * It exists to guard USER-chosen tools and hand-built ops: generator-suggested
 * ops already clamp their tool to the narrowest feature they must enter, so
 * fresh inserts pass clean — the danger is re-tooling an op afterwards.
 *
 * Method: DUAL-MORPHOLOGY comparison. For an outside profile, the achieved
 * boundary is the CLOSING of the nominal outline by the tool radius (dilate
 * then erode) — concave notches narrower than the tool diameter seal shut and
 * show up as difference pieces. For inside profiles and pockets it is the
 * OPENING (erode then dilate) — too-narrow features vanish; a fully empty
 * erosion means the op cuts nothing at all.
 *
 * The comparison runs with BOTH join types and intersects the two difference
 * sets, because each morphology has a distinct, non-overlapping artifact:
 *
 * | join  | models                | false positive it produces               |
 * |-------|-----------------------|------------------------------------------|
 * | round | the physical disc cut | fillet slivers (0.215·r²) at every concave corner — normal rounding that dog-bone relief recovers |
 * | miter | sharp-corner ideal    | falsely seals corner-open steps a real cutter reaches (box rim-corner notches, measured 320 mm²)  |
 *
 * A piece survives the intersection only when both models agree the tool
 * cannot cut it — real swallowed features (gear tooth spaces, narrow slots)
 * seal under both; each artifact class exists in only one diff and cancels.
 * That eliminates the area-threshold trade-off entirely: the gate is a flat
 * hairline floor, so even small real features (a 0.8 mm slot, ~3 mm²) flag,
 * where the earlier single-morphology r²-scaled threshold missed them.
 *
 * Documented limitation: loops are analyzed independently, so tool fit BETWEEN
 * separate parts (layout gaps) is not modeled; the box generator's inter-part
 * gap of max(4t, 6) keeps generated layouts safe.
 */

import type { Vec2 } from "../core/vec2";
import type { CADDocument } from "../model/document";
import { type CAMOperation, resolveOpTool } from "./types";
import { collectClosedLoops, pointInPolygon } from "./loops";
import { resolveRegion } from "./regions";
import { intersectPolygonSets, offsetPolygons, signedArea, subtractPolygonSets } from "./offset";
import type { LintFinding } from "./lint";

/**
 * 10 µm epsilon on the morph radius, applied ASYMMETRICALLY to match what the
 * toolpath engine does at an exact fit (2r == feature width — which is where
 * every generator-clamped tool sits, e.g. gear ⌀ = root gap):
 * - OUTWARD (profile closing): r − ε. An exact-fit outside cut traces the
 *   feature exactly — the engine happily posts it — so the check must pass it;
 *   backing off 10 µm makes that deterministic instead of clipper-noise-flaky.
 * - INWARD (pocket/inside erosion): r + ε. The engine insets by exactly r and
 *   REFUSES a degenerate result ("pocket too small — skipped"), so an
 *   exact-fit channel must flag; overshooting 10 µm makes the erosion
 *   deterministically empty.
 */
const MORPH_EPS = 0.01;

/**
 * Hairline noise floor (mm²) for intersection pieces. Structural artifacts are
 * already excluded by the DUAL-MORPHOLOGY intersection (see the module doc):
 * round-join fillet slivers exist only in the round diff, miter's falsely
 * sealed corner-open steps only in the miter diff — a piece survives the
 * intersection only when BOTH models agree the tool can't cut it. What remains
 * to filter is clipper hairline noise, orders of magnitude below this.
 * The flat floor (no r² scaling) is what lets sub-threshold real features —
 * e.g. a 0.8 mm-wide slot at ~3 mm² — flag correctly.
 */
const PIECE_FLOOR = 0.25;
const pieceThreshold = (_r: number): number => PIECE_FLOOR;

/** 20 µm arcs are far under anything a cut resolves, and keep round-join
 *  offsets fast (the library's default tolerance is pathologically fine). */
const ROUND = { join: "round", arcTolerance: 0.02 } as const;
const MITER = { join: "miter" } as const;

/** Ops with more loops than this are skipped (pathological text-as-profile docs). */
const MAX_LOOPS_PER_OP = 200;

const ccw = (p: Vec2[]): Vec2[] => (signedArea(p) < 0 ? [...p].reverse() : p);
const cw = (p: Vec2[]): Vec2[] => (signedArea(p) > 0 ? [...p].reverse() : p);

/** Difference pieces above the noise gate: count + total area. */
function significantPieces(pieces: Vec2[][], r: number): { count: number; area: number } {
  let count = 0;
  let area = 0;
  const t = pieceThreshold(r);
  for (const p of pieces) {
    const a = Math.abs(signedArea(p));
    if (a >= t) {
      count++;
      area += a;
    }
  }
  return { count, area };
}

/** One independent boundary of an op's nominal cut geometry: a NonZero path
 *  set (profile loop, or pocket outer + holes) plus the entity ids that form
 *  it — carried through so findings can highlight the offending geometry. */
interface NominalSet {
  paths: Vec2[][];
  ids: string[];
}

function nominalSets(doc: CADDocument, op: CAMOperation): NominalSet[] {
  const allLoops = collectClosedLoops(doc.entities);

  if (op.type === "pocket" && op.regions?.length) {
    const sets: NominalSet[] = [];
    for (const ref of op.regions) {
      const region = resolveRegion(ref, allLoops);
      // Unresolved refs already emit a NOTE at toolpath time; skip quietly.
      if (region) {
        sets.push({ paths: [ccw(region.outer), ...region.holes.map(cw)], ids: region.loopIds });
      }
    }
    return sets;
  }

  const ids = new Set(op.entityIds);
  const boundaries = allLoops.filter((L) => L.ids.every((id) => ids.has(id)));
  if (op.type === "pocket") {
    const islIds = new Set(op.islandIds ?? []);
    const islands = allLoops.filter((L) => L.ids.every((id) => islIds.has(id)));
    return boundaries.map((b) => {
      const holes = islands.filter((i) => pointInPolygon(i.verts[0], b.verts));
      return {
        paths: [ccw(b.verts), ...holes.map((i) => cw(i.verts))],
        ids: [...b.ids, ...holes.flatMap((i) => i.ids)],
      };
    });
  }
  // Profile: each closed loop is cut independently (matches profilePolygon).
  return boundaries.map((b) => ({ paths: [ccw(b.verts)], ids: [...b.ids] }));
}

/**
 * Findings for every mill profile/pocket op whose tool cannot reach part (or
 * any) of its geometry. Non-blocking warnings; surfaced via Apollo pre-flight.
 */
export function checkMachinability(doc: CADDocument): LintFinding[] {
  if (doc.isLaser) return [];
  const findings: LintFinding[] = [];

  for (const op of doc.operations) {
    if (op.type !== "profile" && op.type !== "pocket") continue;
    // A library tool overrides the inline diameter — lint the tool that cuts.
    const eff = resolveOpTool(op, doc.tools);
    const r = eff.diameter / 2;
    if (!(r > MORPH_EPS)) continue;
    const inward = op.type === "pocket" || op.side === "inside";
    const rm = inward ? r + MORPH_EPS : r - MORPH_EPS;

    const sets = nominalSets(doc, op);
    if (sets.length === 0 || sets.reduce((n, s) => n + s.paths.length, 0) > MAX_LOOPS_PER_OP)
      continue;

    let pieceCount = 0;
    let pieceArea = 0;
    let deadBoundaries = 0;
    let hairlineBoundaries = 0;
    const flagged = new Set<string>();

    for (const { paths: nominal, ids } of sets) {
      let pieces: Vec2[][];
      if (inward) {
        // Opening: erode by the tool radius, dilate back. An empty erosion
        // means the tool cannot enter this boundary at all — the silent
        // `profilePolygon → []` / "pocket too small" case.
        const eroded = offsetPolygons(nominal, -rm, ROUND);
        if (eroded.length === 0) {
          deadBoundaries++;
          for (const id of ids) flagged.add(id);
          continue;
        }

        // Check if the entire eroded region is confined to a tiny space.
        // If the clearing path is narrower than 10% of the tool diameter,
        // it's a "hairline pocket" (e.g. 6.35mm hole with 6mm tool) that technically
        // fits but has no room for proper clearing motion. Long slots survive this.
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const poly of eroded) {
          for (const p of poly) {
            if (p.x < minX) minX = p.x;
            if (p.x > maxX) maxX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.y > maxY) maxY = p.y;
          }
        }
        const maxDim = Math.max(maxX - minX, maxY - minY);
        if (maxDim < eff.diameter * 0.1) {
          hairlineBoundaries++;
          for (const id of ids) flagged.add(id);
          continue;
        }

        const openedRound = offsetPolygons(eroded, rm, ROUND);
        const openedMiter = offsetPolygons(offsetPolygons(nominal, -rm, MITER), rm, MITER);
        pieces = intersectPolygonSets(
          subtractPolygonSets(nominal, openedRound),
          subtractPolygonSets(nominal, openedMiter),
        );
      } else {
        // Closing: dilate outward, erode back — notches narrower than the
        // tool seal shut under both join models and survive the intersection.
        const closedRound = offsetPolygons(offsetPolygons(nominal, rm, ROUND), -rm, ROUND);
        const closedMiter = offsetPolygons(offsetPolygons(nominal, rm, MITER), -rm, MITER);
        pieces = intersectPolygonSets(
          subtractPolygonSets(closedRound, nominal),
          subtractPolygonSets(closedMiter, nominal),
        );
      }
      const { count, area } = significantPieces(pieces, r);
      if (count > 0) for (const id of ids) flagged.add(id);
      pieceCount += count;
      pieceArea += area;
    }

    const dia = eff.diameter;
    const entityIds = flagged.size ? [...flagged] : undefined;
    if (deadBoundaries > 0 && pieceCount === 0 && hairlineBoundaries === 0) {
      findings.push({
        code: "unreachable-features",
        severity: "warning",
        message:
          `"${op.name}": no part of its geometry is reachable by the ` +
          `⌀${dia} mm tool — the toolpath will be empty.`,
        ...(entityIds ? { entityIds } : {}),
      });
    } else if (hairlineBoundaries > 0 && deadBoundaries === 0 && pieceCount === 0) {
      findings.push({
        code: "unreachable-features",
        severity: "warning",
        message:
          `"${op.name}": ${hairlineBoundaries} feature region${hairlineBoundaries === 1 ? " is a" : "s are"} ` +
          `'hairline' fit${hairlineBoundaries === 1 ? "" : "s"} — the tool technically fits, but the clearance ` +
          `is too tight for clearing motion. Use a drill, a smaller tool, or enlarge the feature.`,
        ...(entityIds ? { entityIds } : {}),
      });
    } else if (pieceCount > 0 || deadBoundaries > 0 || hairlineBoundaries > 0) {
      const extra = [];
      if (deadBoundaries > 0) extra.push(`${deadBoundaries} boundar${deadBoundaries === 1 ? "y" : "ies"} entirely unreachable`);
      if (hairlineBoundaries > 0) extra.push(`${hairlineBoundaries} hairline fit${hairlineBoundaries === 1 ? "" : "s"}`);
      const extraStr = extra.length > 0 ? ` (${extra.join(", ")})` : "";
      
      if (pieceCount > 0) {
        findings.push({
          code: "unreachable-features",
          severity: "warning",
          message:
            `"${op.name}": ${pieceCount} feature region${pieceCount === 1 ? "" : "s"} ` +
            `(≈${pieceArea.toFixed(1)} mm² total) are narrower than the ⌀${dia} mm tool ` +
            `can reach and will be left uncut${extraStr} — use a smaller tool or widen the features.`,
          ...(entityIds ? { entityIds } : {}),
        });
      } else {
         // Fallback if only dead and hairline boundaries exist
         findings.push({
           code: "unreachable-features",
           severity: "warning",
           message: `"${op.name}": toolpath has reachability issues${extraStr} — use a smaller tool or widen the features.`,
           ...(entityIds ? { entityIds } : {}),
         });
      }
    }
  }

  return findings;
}
