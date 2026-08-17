/**
 * The steep/shallow split: finish the walls with Z-level passes and the floors
 * with the raster, each where it is the better of the two.
 *
 * A parallel raster stepping `s` across a near-vertical wall leaves ridges spaced
 * by however far the wall climbs in that `s` — on a wall at 80° that is 5.7·s,
 * so a stepover chosen for a 15 µm cusp delivers 480 µm and the wall is
 * effectively unfinished. MeshCAM's *Surface Angle Limit* is the standard answer:
 * raster below the angle, waterline above it. This is that, on a heightfield.
 *
 * ## The threshold is derived — there is no angle to tune
 *
 * Both strategies leave a cusp, and a cusp is monotone in the distance between
 * adjacent passes **measured on the surface** ({@link ../cam/scallop}). So the
 * better strategy at a cell is simply the one whose passes land closer together
 * there, and both distances are pure geometry:
 *
 *     raster:   s · hypot(1, g)              rows spaced s, worst orientation
 *     Z-level:  Δz · hypot(1, g) / g         g = |∇z|, climbing Δz up the slope
 *
 * The Z step is not a new number either. Sizing it as `Δz = s` is the statement
 * "leave the same cusp on a vertical wall that the raster leaves on a flat
 * floor" — the two passes are then quoted at one finish, which is the whole
 * point of choosing a stepover by cusp height in the first place. Substituting
 * it, the comparison collapses to
 *
 *     steep  ⟺  |∇z| > 1,  i.e.  slope > 45°
 *
 * — the textbook crossover, arrived at rather than picked. Nothing here is
 * calibrated against a corpus; change the stepover and the split moves with it,
 * correctly.
 *
 * ## The raster's spacing is taken at its WORST orientation, deliberately
 *
 * A raster's cusp depends on which way the slope runs relative to the scan. The
 * exact spacing is `s · hypot(1, ∂z/∂y)` — the slope ACROSS the rows — so a wall
 * running *along* the scan is finished as well as flat ground (the tool climbs
 * it along a row, and the next row sits `s` away horizontally in the plane of
 * the wall). That exact form was implemented first, and rejected after looking
 * at what it draws: on a cone it fires only on the two caps where the flank
 * faces across the rows, leaving the other two to the raster. The two halves
 * meet the same cusp SPEC, so the metric says it is fine — and the part is not,
 * because tool marks from a raster and from a contour run in different
 * directions and the wall of one boss comes out in two visibly different
 * finishes meeting on a diagonal. It also yields almost no closed contours, so
 * every wall is machined as four arcs with four plunges instead of a loop.
 *
 * A finish is a guarantee rather than an average, so the raster is judged on the
 * worst orientation the surface presents — which is also what every CAM package
 * that exposes this exposes (MeshCAM, PowerMill, Fusion all split on the surface
 * ANGLE, isotropically). `scripts/steep-split-probe.ts` draws both.
 *
 * ## The contours are tool-centre paths already
 *
 * No offsetting, and specifically no Clipper2. {@link toolContactField} returns
 * the drop-cutter surface — the Z the tool TIP may ride at, flank included — so
 * an iso-contour of THAT field at constant Z *is* the tool-centre path, by
 * construction. Offsetting contours of the raw field by a tool radius would be a
 * second and worse way to compute what the dilation already computed.
 *
 * ## Why the plunges are safe
 *
 * Each contour is entered with a vertical plunge, and levels are emitted from
 * the top down. At a point on level `k` the pass at level `k−1` came within
 * roughly the contour spacing laterally, and its tool body cleared that column
 * down to nearly `z_{k−1}` — so the plunge takes about one `Δz` of fresh
 * material, the same bite the raster's own stepdown passes take. That argument
 * needs consecutive contours to be CLOSE, which is the mask's own condition:
 * where contours are far apart the surface is shallow, and shallow is exactly
 * what this pass does not touch. The safety follows from the split rather than
 * being an assumption bolted onto it.
 */

import { isHalftone } from "./halftone";
import type { RasterField } from "./rasterEngrave";
import type { CAMOperation } from "./types";

/** One constant-Z contour, in the image's LOCAL raster frame (x right, y up). */
export interface SteepPath {
  /** Tip Z for the whole path, mm (negative, below the stock top). */
  z: number;
  /** Tool-centre points, mm in local raster coordinates. */
  pts: { x: number; y: number }[];
  /** First point repeated at the end — the contour closed on itself. */
  closed: boolean;
}

export type SteepSplit =
  | { kind: "off" }
  /** Asked for, but no cell in this relief is steep enough to want it. */
  | { kind: "none" }
  | {
      kind: "split";
      /** Is cell (row, col) one the RASTER should skip and the contours cover? */
      steep(row: number, col: number): boolean;
      cells: number;
      total: number;
      /** Z spacing of the contour levels, mm — derived, see the header. */
      zStep: number;
      /** Contours, ordered shallow → deep and travel-ordered within each level. */
      paths: SteepPath[];
    };

/**
 * Work out the split for a relief finish pass.
 *
 * `contact` must be the field the emitter will actually ride — the output of
 * {@link toolContactField}, not the raw image field. Both halves depend on it:
 * the mask, because the cusp is set by where adjacent TOOL POSITIONS land, and
 * the contours, because that is the property that makes them tool-centre paths.
 */
export function steepSplit(
  contact: RasterField,
  op: CAMOperation,
  maxDepth: number,
): SteepSplit {
  if (op.reliefSteepPass !== true) return { kind: "off" };
  // A halftone has no surface to finish — the groove width IS the tone, and the
  // field it screens is not a shape a contour means anything on. The same
  // predicate the dilation screens out (`toolContactField`), for the same
  // reason: the dialog cannot produce this pairing, but a hand-written file can.
  if (isHalftone(op)) return { kind: "off" };
  const { cols, colPitch, rowPitch, rows } = contact;
  const nRows = rows.length;
  if (cols < 2 || nRows < 2 || !(maxDepth > 0) || !(colPitch > 0) || !(rowPitch > 0))
    return { kind: "none" };

  // The Z spacing IS the stepover — one finish quoted for both passes. See the
  // header; this is the line that keeps the threshold derived.
  const zStep = rowPitch;

  // Depth in mm at a node, from the level field (1 = full depth, and the field
  // reads bottom→top so r+1 is +y).
  const zAt = (r: number, c: number): number => -rows[r].levels[c] * maxDepth;

  // --- the mask ------------------------------------------------------------
  // `slope` is kept as well as the flag, because the contours are clipped
  // against the SMOOTH field rather than against the flag's cell staircase —
  // see {@link contourSteep}. One predicate, sampled at nodes for the raster and
  // interpolated for the contours, so the two halves cannot disagree about where
  // the boundary is.
  const slope = new Float32Array(cols * nRows);
  const steepFlag = new Uint8Array(cols * nRows);
  let steepCells = 0;
  for (let r = 0; r < nRows; r++) {
    const rUp = r + 1 < nRows ? r + 1 : r;
    const rDn = r > 0 ? r - 1 : r;
    // Central differences, clamped at the border — the same replicate-the-edge
    // convention the dilation uses, and for the same reason: outside the image
    // there is no model, so the edge sample extends outward rather than
    // inventing a wall.
    const dy = (rUp - rDn) * rowPitch;
    for (let c = 0; c < cols; c++) {
      const cR = c + 1 < cols ? c + 1 : c;
      const cL = c > 0 ? c - 1 : c;
      const dx = (cR - cL) * colPitch;
      const gx = dx > 0 ? (zAt(r, cR) - zAt(r, cL)) / dx : 0;
      const gy = dy > 0 ? (zAt(rUp, c) - zAt(rDn, c)) / dy : 0;
      const g = Math.hypot(gx, gy);
      // Distance between adjacent passes, measured on the surface. Whichever is
      // shorter leaves the finer cusp; that strategy owns the cell. The raster
      // is read at the worst orientation this slope could present (`g`, not
      // `gy`) — a finish is a guarantee, not an average. See the header.
      const rasterSpacing = rowPitch * Math.hypot(1, g);
      const levelSpacing = g > 0 ? (zStep * Math.hypot(1, g)) / g : Infinity;
      // Stored as the RATIO of the two, so "steep" is `> 1` wherever it is read
      // and the comparison exists in exactly one place.
      slope[r * cols + c] = rasterSpacing > 0 ? rasterSpacing / levelSpacing : 0;
      if (levelSpacing < rasterSpacing) {
        steepFlag[r * cols + c] = 1;
        steepCells++;
      }
    }
  }
  if (steepCells === 0) return { kind: "none" };

  // --- contours ------------------------------------------------------------
  const levels: number[] = [];
  for (let k = 1; k * zStep < maxDepth; k++) levels.push(-k * zStep);
  if (levels.length === 0) return { kind: "none" };

  const paths = contourSteep(contact, maxDepth, steepFlag, slope, levels, zStep, op.diameter);
  if (paths.length === 0) return { kind: "none" };

  // The raster gives up a cell only where a contour DEMONSTRABLY runs — not
  // merely where the mask said it should. Anything else is a promise that some
  // path covers this, and an uncut bump is what a broken promise looks like.
  //
  // "Runs" means within a cell horizontally AND **at or below the cell's own
  // floor**. The depth half is not fussiness: a cusp between contours is
  // finished by the tool bodies on BOTH sides of it, so a cell with no contour
  // beneath it is not being cut to depth by anything. It shows up at the foot of
  // every wall, where the deepest level sits one zStep above the floor — the
  // preview left 0.37 mm of stock standing in a ring round the base of a cone
  // before this read the Z as well as the XY.
  //
  // The horizontal half changes nothing in the interior — a steep cell has
  // `zStep / g < zStep = rowPitch` of spacing between consecutive contours, so
  // one always passes within a cell — but it removes the boundary fringe, where
  // the mask is one cell wide and the contour that grazed it was dropped as a
  // stub. Marginal cells go back to the raster, which is free of consequence
  // exactly there: slope ≈ 1 is where the two strategies leave the same cusp by
  // definition.
  const covered = new Uint8Array(cols * nRows);
  const eps = maxDepth * 1e-9;
  for (const p of paths)
    for (const pt of p.pts) {
      const c0 = Math.round(pt.x / colPitch - 0.5);
      const r0 = Math.round((pt.y - rows[0].y) / rowPitch);
      for (let r = Math.max(0, r0 - 1); r <= Math.min(nRows - 1, r0 + 1); r++)
        for (let c = Math.max(0, c0 - 1); c <= Math.min(cols - 1, c0 + 1); c++)
          if (p.z <= zAt(r, c) + eps) covered[r * cols + c] = 1;
    }
  let skipped = 0;
  for (let i = 0; i < steepFlag.length; i++) {
    steepFlag[i] = steepFlag[i] && covered[i] ? 1 : 0;
    skipped += steepFlag[i];
  }
  if (skipped === 0) return { kind: "none" };

  return {
    kind: "split",
    steep: (r, c) => steepFlag[r * cols + c] === 1,
    cells: skipped,
    total: cols * nRows,
    zStep,
    paths,
  };
}

/**
 * Marching squares over the steep cells, at every level, chained into paths.
 *
 * Crossings are identified by the GRID EDGE they lie on rather than by their
 * coordinates, so linking segments into a chain is an integer key lookup and
 * cannot suffer a floating-point near-miss at a shared cell boundary.
 *
 * ## Clipped against the slope field, not against the cell flags
 *
 * The obvious way to restrict contours to the steep region is to contour only
 * the flagged cells. It produces garbage, and the reason is worth keeping: near
 * the boundary the contour runs almost PARALLEL to it, so a boundary that is a
 * cell staircase cuts the curve at every step. Measured on a hemisphere at a
 * 0.25 mm stepover, that is **628 contours of which 336 are under 1 mm** —
 * hundreds of plunge-and-retract stubs where a dozen clean rings belong. The
 * 8-bit level quantisation was the first suspect and is not the cause: at 1/4096
 * it is 580 and 340, essentially unchanged.
 *
 * Testing the interpolated slope AT the contour point instead cuts each ring
 * once, where the surface really crosses 45°. Same predicate, same field, read
 * as the continuous quantity it is. `scripts/steep-split-probe.ts` prints the
 * before/after distribution.
 */
function contourSteep(
  contact: RasterField,
  maxDepth: number,
  steepFlag: Uint8Array,
  slope: Float32Array,
  levels: number[],
  zStep: number,
  diameter: number,
): SteepPath[] {
  const { cols, colPitch, rows } = contact;
  const nRows = rows.length;
  const zAt = (r: number, c: number): number => -rows[r].levels[c] * maxDepth;
  const xAt = (c: number): number => (c + 0.5) * colPitch;
  const yAt = (r: number): number => rows[r].y;

  // Edge ids: horizontals first, then verticals.
  const hCount = nRows * (cols - 1);
  const hId = (r: number, c: number): number => r * (cols - 1) + c;
  const vId = (r: number, c: number): number => hCount + r * cols + c;

  /** Per level: crossing point by edge id, and the segments joining them. */
  const pos: Map<number, { x: number; y: number }>[] = levels.map(() => new Map());
  const segs: [number, number][][] = levels.map(() => []);

  const put = (
    li: number,
    id: number,
    x: number,
    y: number,
  ): number => {
    const m = pos[li];
    if (!m.has(id)) m.set(id, { x, y });
    return id;
  };

  /** The steepness ratio at an arbitrary point, bilinearly interpolated. */
  const slopeAt = (x: number, y: number): number => {
    const fc = Math.min(cols - 1.0001, Math.max(0, x / colPitch - 0.5));
    const fr = Math.min(nRows - 1.0001, Math.max(0, (y - rows[0].y) / (rows[1].y - rows[0].y)));
    const c0 = Math.floor(fc);
    const r0 = Math.floor(fr);
    const tx = fc - c0;
    const ty = fr - r0;
    return (
      slope[r0 * cols + c0] * (1 - tx) * (1 - ty) +
      slope[r0 * cols + c0 + 1] * tx * (1 - ty) +
      slope[(r0 + 1) * cols + c0] * (1 - tx) * ty +
      slope[(r0 + 1) * cols + c0 + 1] * tx * ty
    );
  };

  /** Keep a segment when the surface is steep at its MIDPOINT. */
  const keep = (a: number, b: number, li: number): void => {
    const pa = pos[li].get(a);
    const pb = pos[li].get(b);
    if (!pa || !pb) return;
    if (slopeAt((pa.x + pb.x) / 2, (pa.y + pb.y) / 2) > 1) segs[li].push([a, b]);
  };

  for (let r = 0; r + 1 < nRows; r++) {
    for (let c = 0; c + 1 < cols; c++) {
      // One steep corner is enough. Over-covering by a cell at the boundary
      // costs a little overlap; under-covering leaves a strip nothing finishes.
      if (
        !steepFlag[r * cols + c] &&
        !steepFlag[r * cols + c + 1] &&
        !steepFlag[(r + 1) * cols + c] &&
        !steepFlag[(r + 1) * cols + c + 1]
      )
        continue;

      const zA = zAt(r, c); // corners CCW from bottom-left
      const zB = zAt(r, c + 1);
      const zC = zAt(r + 1, c + 1);
      const zD = zAt(r + 1, c);
      const lo = Math.min(zA, zB, zC, zD);
      const hi = Math.max(zA, zB, zC, zD);
      const x0 = xAt(c);
      const x1 = xAt(c + 1);
      const y0 = yAt(r);
      const y1 = yAt(r + 1);

      // Only the levels between this cell's own lo and hi can cross it, and the
      // levels are evenly spaced (`levels[k] = −(k+1)·zStep`), so that is an
      // index RANGE rather than a search. Scanning all of them instead is the
      // pass's dominant cost on any deep model — a 200 mm relief 20 mm deep has
      // 133 levels and 1.8 M cells, i.e. 236 M iterations to find the ~2 that
      // cross. The bounds are deliberately loose by one on each side and the
      // exact test below still runs, so this narrows the loop without owning
      // the decision.
      const kLo = Math.max(0, Math.floor(-hi / zStep) - 1);
      const kHi = Math.min(levels.length - 1, Math.ceil(-lo / zStep));
      for (let li = kLo; li <= kHi; li++) {
        const z = levels[li];
        if (z <= lo || z >= hi) continue; // no crossing in this cell

        const aA = zA > z;
        const aB = zB > z;
        const aC = zC > z;
        const aD = zD > z;
        const idx = (aA ? 1 : 0) | (aB ? 2 : 0) | (aC ? 4 : 0) | (aD ? 8 : 0);
        if (idx === 0 || idx === 15) continue;

        // Crossing on each edge, linearly interpolated between its two corners.
        const eBottom = (): number =>
          put(li, hId(r, c), x0 + ((z - zA) / (zB - zA)) * (x1 - x0), y0);
        const eRight = (): number =>
          put(li, vId(r, c + 1), x1, y0 + ((z - zB) / (zC - zB)) * (y1 - y0));
        const eTop = (): number =>
          put(li, hId(r + 1, c), x0 + ((z - zD) / (zC - zD)) * (x1 - x0), y1);
        const eLeft = (): number =>
          put(li, vId(r, c), x0, y0 + ((z - zA) / (zD - zA)) * (y1 - y0));

        switch (idx) {
          case 1:
          case 14:
            keep(eLeft(), eBottom(), li);
            break;
          case 2:
          case 13:
            keep(eBottom(), eRight(), li);
            break;
          case 3:
          case 12:
            keep(eLeft(), eRight(), li);
            break;
          case 4:
          case 11:
            keep(eRight(), eTop(), li);
            break;
          case 6:
          case 9:
            keep(eBottom(), eTop(), li);
            break;
          case 7:
          case 8:
            keep(eLeft(), eTop(), li);
            break;
          // Saddles: one diagonal pair joins through the middle, and the other
          // two corners are then islands with an arc apiece. The cell's own
          // average decides which — the asymptotic decider's answer for a
          // bilinear patch.
          case 5:
          case 10: {
            const centreAbove = (zA + zB + zC + zD) / 4 > z;
            // 5 = A,C above: a high centre joins them and isolates B and D.
            // 10 = B,D above: a high centre joins THOSE, isolating A and C.
            const isolateBD = idx === 5 ? centreAbove : !centreAbove;
            if (isolateBD) {
              keep(eBottom(), eRight(), li); // around B
              keep(eTop(), eLeft(), li); // around D
            } else {
              keep(eLeft(), eBottom(), li); // around A
              keep(eRight(), eTop(), li); // around C
            }
            break;
          }
        }
      }
    }
  }

  const paths: SteepPath[] = [];
  let at = { x: 0, y: 0 };
  for (let li = 0; li < levels.length; li++) {
    const chains = chainSegments(segs[li], pos[li]).filter(longEnough(diameter));
    // Travel-order within the level, and only within it: levels must stay in
    // order top→down or the plunge argument in the header stops holding.
    orderPaths(chains, at, levels[li]).forEach((p) => {
      paths.push(p);
      at = p.pts[p.pts.length - 1];
    });
  }
  return paths;
}

/**
 * Drop arcs shorter than the cutter is wide.
 *
 * Such an arc lies inside a single tool footprint, so the pass on the
 * neighbouring contour — which on a steep wall is under one cell away — has
 * already swept it; posting it separately spends a plunge and a retract to
 * remove a sliver that is gone. They arrive in bulk from ONE place: the contour
 * whose level happens to run along the 45° boundary, which the grid cuts into
 * dozens of pieces. Measured on a hemisphere at a 0.5 mm stepover, five of the
 * six levels are single closed rings of ~180 mm and the sixth is **48 arcs
 * averaging 2.3 mm**. The threshold is the tool, not a tuned number, and the
 * cells those arcs would have covered go back to the raster (see the caller).
 */
function longEnough(diameter: number): (c: Chain) => boolean {
  return (chain) => {
    let len = 0;
    for (let i = 1; i < chain.pts.length; i++) {
      len += Math.hypot(
        chain.pts[i].x - chain.pts[i - 1].x,
        chain.pts[i].y - chain.pts[i - 1].y,
      );
      if (len >= diameter) return true;
    }
    return false;
  };
}

interface Chain {
  pts: { x: number; y: number }[];
  closed: boolean;
}

/** Link segments end-to-end into open chains first, then closed loops. */
function chainSegments(
  segs: [number, number][],
  pos: Map<number, { x: number; y: number }>,
): Chain[] {
  const adj = new Map<number, { to: number; seg: number }[]>();
  const link = (a: number, b: number, seg: number): void => {
    const list = adj.get(a);
    if (list) list.push({ to: b, seg });
    else adj.set(a, [{ to: b, seg }]);
  };
  segs.forEach(([a, b], i) => {
    link(a, b, i);
    link(b, a, i);
  });

  const used = new Uint8Array(segs.length);
  const out: Chain[] = [];
  const walk = (start: number): void => {
    const ids = [start];
    let cur = start;
    let closed = false;
    for (;;) {
      const next = adj.get(cur)?.find((l) => !used[l.seg]);
      if (!next) break;
      used[next.seg] = 1;
      ids.push(next.to);
      cur = next.to;
      if (cur === start) {
        closed = true;
        break;
      }
    }
    if (ids.length < 2) return;
    const pts = ids.map((id) => pos.get(id)).filter((p): p is { x: number; y: number } => !!p);
    if (pts.length >= 2) out.push({ pts, closed });
  };

  // Open ends first: starting a walk mid-chain would split one path in two.
  for (const [id, links] of adj) if (links.length === 1) walk(id);
  for (const [id] of adj) walk(id);
  return out;
}

/**
 * Greedy nearest-first ordering. Open chains may be traversed either way; a
 * closed loop is rotated to begin at its nearest point, which turns a long
 * approach across the model into a step.
 *
 * A closed loop is scanned vertex by vertex to find that rotation, so the search
 * is O(points × loops) per level — 245 M distance evaluations on the 200 mm
 * model above. Each chain's bounding box gives an exact lower bound on how close
 * any of its points can be, which skips the scan for every loop that is already
 * further away than the best one found. The bound can only ever skip candidates
 * that could not have won, so the chosen path and rotation are unchanged.
 */
function orderPaths(
  chains: Chain[],
  from: { x: number; y: number },
  z: number,
): SteepPath[] {
  const out: SteepPath[] = [];
  // The box travels WITH its chain rather than in a second array indexed
  // alongside it: one splice, nothing to keep in step. A parallel array here
  // desyncs on the first removal and the bound then belongs to some other
  // chain — which costs travel and nothing else, so no test would report it.
  const left = chains.map((ch) => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of ch.pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    return { ...ch, minX, minY, maxX, maxY };
  });
  let at = from;
  const d2 = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
    (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

  while (left.length > 0) {
    let best = 0;
    let bestD = Infinity;
    let bestAt = 0;
    let bestRev = false;
    for (let i = 0; i < left.length; i++) {
      const { pts, closed, minX, minY, maxX, maxY } = left[i];
      // Nothing in this chain can beat what we have — skip its points entirely.
      const bx = at.x < minX ? minX - at.x : at.x > maxX ? at.x - maxX : 0;
      const by = at.y < minY ? minY - at.y : at.y > maxY ? at.y - maxY : 0;
      if (bx * bx + by * by >= bestD) continue;
      if (closed) {
        for (let k = 0; k < pts.length - 1; k++) {
          const d = d2(at, pts[k]);
          if (d < bestD) {
            bestD = d;
            best = i;
            bestAt = k;
            bestRev = false;
          }
        }
      } else {
        const dStart = d2(at, pts[0]);
        if (dStart < bestD) {
          bestD = dStart;
          best = i;
          bestAt = 0;
          bestRev = false;
        }
        const dEnd = d2(at, pts[pts.length - 1]);
        if (dEnd < bestD) {
          bestD = dEnd;
          best = i;
          bestAt = 0;
          bestRev = true;
        }
      }
    }
    const { pts, closed } = left.splice(best, 1)[0];
    let ordered: { x: number; y: number }[];
    if (closed) {
      const body = pts.slice(0, -1);
      ordered = [...body.slice(bestAt), ...body.slice(0, bestAt)];
      ordered.push(ordered[0]);
    } else {
      ordered = bestRev ? [...pts].reverse() : pts;
    }
    out.push({ z, pts: ordered, closed });
    at = ordered[ordered.length - 1];
  }
  return out;
}
