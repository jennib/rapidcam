/**
 * Drawer-style finger-jointed box — an open-top box (a tray/drawer), laid out
 * FLAT as nine closed polylines: four walls, four bottom grooves, and the bottom
 * panel.
 *
 * Construction (this is the first *coordinated multi-panel* generator — mating
 * features are pre-phased so the parts assemble):
 *  - Outer size length (X) × width (Y) × height (Z); material thickness t.
 *  - The four vertical corners are box (finger) joints running the FULL height.
 *    Front/back and side walls comb their vertical edges with COMPLEMENTARY phase
 *    (where one is solid the other is notched), so tabs meet slots. Because these
 *    joints inherently alternate, some fingers show at the rim on every wall —
 *    that is correct for a box joint, not a defect.
 *  - The bottom is captured in a GROOVE (dado), not finger-jointed into the wall
 *    edges — exactly like a real drawer. Each wall carries a groove rectangle
 *    (inset from the corners so it clears the corner fingers) meant to be milled
 *    as a shallow POCKET (~t/2 deep); the plain bottom panel drops into the four
 *    grooves. Keeping the bottom off the wall edges is what avoids the 3-way
 *    corner conflict that a bottom-edge finger joint creates.
 *
 * The wall outlines and the bottom are profile cuts; the four groove rectangles
 * are pockets. Joints are square (no kerf compensation) — the operator adds fit
 * allowance via tool offset. Drawn around the origin; the runner places the
 * layout in the work area. See generators/index.ts.
 */

import type { Generator } from "./index";
import type { Handle, Pt } from "./sketch";

/** One edge profile of a panel: a square-finger comb, or straight when omitted. */
export interface CombSpec {
  /** Nominal finger pitch (mm); the actual count is chosen to fit the span. */
  fingerW: number;
  /** Finger depth (mm) — the mating material thickness. */
  depth: number;
  /** true = tabs protrude outward; false = notches recede inward. */
  protrude: boolean;
  /** Whether finger 0 (from the canonical start) is the active (tab/notch) one. */
  firstActive: boolean;
  /** Keep-out (mm) at the canonical start / end: the comb runs over [start, len-end].
   *  Ends abutting a perpendicular joint inset by t; a free rim (open top) insets 0. */
  insetStart: number;
  insetEnd: number;
  /** Joint clearance (mm): each active (notch) run widens by clearance/2 per
   *  mating face, at the expense of its inactive neighbours, for a snugger fit
   *  after kerf/tolerance. 0 reproduces the un-relieved comb exactly. */
  clearance: number;
}

/**
 * Canonical comb along +X from (0,0) to (len,0); active fingers step ±depth in Y
 * (+ = protrude, − = recede). Fingers live in [insetStart, len-insetEnd]; the ends
 * stay on the base line so they abut a perpendicular joint cleanly. At least two
 * fingers, so a pair of complementary edges always interlocks (with one finger,
 * one side would carry the notch and the mate nothing).
 *
 * Exported for tests — mating-edge complementarity verification; not part of
 * the generator API.
 */
export function comb(len: number, spec: CombSpec): Pt[] {
  const s = spec.insetStart;
  const e = len - spec.insetEnd;
  const span = e - s;
  const n = Math.max(2, Math.round(span / spec.fingerW));
  const w = span / n;
  const sign = spec.protrude ? 1 : -1;
  const c = spec.clearance;
  const isActive = (i: number) => (spec.firstActive ? i % 2 === 0 : i % 2 === 1);

  // Boundary x-positions between runs (n+1 of them), nominally s + w·k — the
  // same expression the un-relieved code used, so c = 0 reproduces it exactly.
  // The comb-span ends (k = 0, n) stay pinned to s/e. An interior boundary sits
  // between exactly one active run and one inactive run (active alternates
  // every run), and moves clearance/2 into the INACTIVE run's territory —
  // widening the active notch by c/2 per mating face — clamped so it can't
  // cross the comb's own ends. Runs are read off these shared boundaries, so
  // they stay contiguous with no gap or overlap (holds for c < w).
  const boundary = (k: number): number => {
    const x = s + w * k;
    if (k <= 0 || k >= n) return x;
    return isActive(k - 1) ? Math.min(e, x + c / 2) : Math.max(s, x - c / 2);
  };

  const pts: Pt[] = [
    { x: 0, y: 0 },
    { x: s, y: 0 },
  ];
  let curY = 0;
  for (let i = 0; i < n; i++) {
    const active = isActive(i);
    const y = active ? sign * spec.depth : 0;
    const x0 = boundary(i);
    const x1 = boundary(i + 1);
    if (y !== curY) {
      pts.push({ x: x0, y }); // riser from the previous point at x0
      curY = y;
    }
    pts.push({ x: x1, y });
  }
  if (curY !== 0) pts.push({ x: e, y: 0 });
  pts.push({ x: len, y: 0 });
  return pts;
}

/** Straight edge, canonical +X. */
function straight(len: number): Pt[] {
  return [
    { x: 0, y: 0 },
    { x: len, y: 0 },
  ];
}

/** Map canonical edge points onto the segment a→b with outward normal `out`. */
function place(pts: Pt[], a: Pt, b: Pt, out: Pt): Pt[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L = Math.hypot(dx, dy) || 1;
  const ux = dx / L;
  const uy = dy / L;
  return pts.map((p) => ({
    x: a.x + ux * p.x + out.x * p.y,
    y: a.y + uy * p.x + out.y * p.y,
  }));
}

const near = (a: Pt, b: Pt) => Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;

interface PanelSpecs {
  bottom?: CombSpec;
  right?: CombSpec;
  top?: CombSpec;
  left?: CombSpec;
}

/**
 * Build a w×h panel outline (CCW) from four edge specs. Edges are generated in a
 * canonical direction (bottom/top left→right, left/right bottom→top) and the top
 * and left edges are reversed so the outline stays CCW.
 */
function panel(w: number, h: number, specs: PanelSpecs): Pt[] {
  const bl = { x: 0, y: 0 };
  const br = { x: w, y: 0 };
  const tr = { x: w, y: h };
  const tl = { x: 0, y: h };
  const edge = (len: number, spec: CombSpec | undefined) => (spec ? comb(len, spec) : straight(len));

  const segs: Pt[][] = [
    place(edge(w, specs.bottom), bl, br, { x: 0, y: -1 }),
    place(edge(h, specs.right), br, tr, { x: 1, y: 0 }),
    place(edge(w, specs.top), tl, tr, { x: 0, y: 1 }).reverse(),
    place(edge(h, specs.left), bl, tl, { x: -1, y: 0 }).reverse(),
  ];

  const out: Pt[] = [];
  for (const seg of segs) {
    for (const p of seg) {
      if (out.length && near(out[out.length - 1], p)) continue;
      out.push(p);
    }
  }
  if (out.length > 1 && near(out[0], out[out.length - 1])) out.pop();
  return removeSpurs(out);
}

/**
 * Remove zero-area backtracking spurs from an assembled outline. When a comb's
 * first/last run is ACTIVE (a notch at the panel corner — the side walls'
 * full-height corner joints), the adjacent straight edge still runs to the
 * nominal corner and the comb immediately doubles back along it: the outline
 * visits a corner point that is notched-away material and retraces a segment.
 * Rendering hides this (the spur overlaps the edge) but boolean/offset
 * geometry sees a self-touching polygon. Snip any vertex whose outgoing
 * segment exactly reverses the incoming one, clipping the overlap; iterate
 * until stable (a corner can need two passes as the closing wraps).
 */
function removeSpurs(pts: Pt[]): Pt[] {
  let cur = pts;
  for (let pass = 0; pass < pts.length; pass++) {
    let changed = false;
    const n = cur.length;
    const next: Pt[] = [];
    for (let i = 0; i < n; i++) {
      const prev = cur[(i - 1 + n) % n];
      const v = cur[i];
      const after = cur[(i + 1) % n];
      const ax = v.x - prev.x;
      const ay = v.y - prev.y;
      const bx = after.x - v.x;
      const by = after.y - v.y;
      // Anti-parallel (cross = 0, dot < 0) means the path doubles back at v —
      // v is a spur tip on a notched-away corner; drop it.
      const cross = ax * by - ay * bx;
      const dot = ax * bx + ay * by;
      if (Math.abs(cross) < 1e-9 && dot < -1e-9) {
        changed = true;
        continue;
      }
      next.push(v);
    }
    cur = next;
    if (!changed) break;
  }
  return cur;
}

/** Plain closed rectangle w×h with its bottom-left corner at the origin. */
function rect(w: number, h: number): Pt[] {
  return [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ];
}

export const box: Generator = {
  id: "finger-box",
  name: "Finger-Joint Box",
  build(s) {
    const length = s.param("length", 100, { min: 10, label: "Length (X)" });
    const width = s.param("width", 60, { min: 10, label: "Width (Y)" });
    const height = s.param("height", 40, { min: 10, label: "Height (Z)" });
    const t = s.param("thickness", 6, { min: 0.5, label: "Material thickness" });
    const f = s.param("fingerWidth", 12, { min: 2, label: "Finger width" });
    const clearance = s.param("clearance", 0, { min: 0, label: "Joint clearance" });
    s.note("Grooves are pockets ≈ thickness/2 deep; the bottom panel drops into them.");
    if (clearance > 0) s.note(`Clearance adds ~${clearance} mm of gap per mating face.`);

    // Vertical corner joints run the FULL height (no inset — the bottom is held
    // by a groove, not a bottom-edge joint, so nothing conflicts at the corners).
    // Front/back and side walls take complementary phase so tabs meet slots; the
    // fingers alternate, so some show at the rim on every wall — that's inherent
    // to a box joint. Straight top/bottom edges (the groove captures the bottom).
    const cornerFB: CombSpec = {
      fingerW: f,
      depth: t,
      protrude: false,
      firstActive: false,
      insetStart: 0,
      insetEnd: 0,
      clearance,
    };
    const cornerSide: CombSpec = {
      fingerW: f,
      depth: t,
      protrude: false,
      firstActive: true,
      insetStart: 0,
      insetEnd: 0,
      clearance,
    };

    const frontBack: PanelSpecs = { left: cornerFB, right: cornerFB };
    const side: PanelSpecs = { left: cornerSide, right: cornerSide };
    const front = panel(length, height, frontBack);
    const back = panel(length, height, frontBack);
    const left = panel(width, height, side);
    const right = panel(width, height, side);
    // Bottom drops into the grooves: cavity (outer − 2t) plus the groove depth
    // (t/2) it enters on each side → (length − t) × (width − t), less the
    // clearance so it seats snugly in the widened channel below.
    const bottom = rect(length - t - clearance, width - t - clearance);

    // A groove (dado) on each wall, inset t from the corners so it clears the
    // corner fingers, a channel t wide (t + clearance, widened to match clearance)
    // sitting `t` above the wall's bottom edge. Milled as a
    // shallow pocket (~t/2 deep); the bottom edge slides into it.
    const grooveOffset = t;
    const grooveOf = (faceW: number): Pt[] => rect(faceW - 2 * t, t + clearance);

    const g = Math.max(4 * t, 6);
    const shift = (pts: Pt[], ox: number, oy: number): Pt[] =>
      pts.map((p) => ({ x: p.x + ox, y: p.y + oy }));
    // Each wall's y offset in the flat layout column.
    const yFront = 0,
      yBack = height + g,
      yLeft = 2 * (height + g),
      yRight = 3 * (height + g);
    const groove = (faceW: number, oy: number) =>
      shift(grooveOf(faceW), t, oy + grooveOffset);

    // Walls + bottom are profile cuts on the default layer. Every entity is
    // KEYED so toolpaths/constraints follow the logical part across regens
    // even after a partial delete (see Sketch.key).
    const keyed = (k: string, pts: Pt[]): Handle => {
      s.key(k);
      return s.polyline(pts, { closed: true });
    };
    const profiles = [
      keyed("front-wall", shift(front, 0, yFront)),
      keyed("back-wall", shift(back, 0, yBack)),
      keyed("left-wall", shift(left, 0, yLeft)),
      keyed("right-wall", shift(right, 0, yRight)),
      keyed("bottom", shift(bottom, length + g, 0)),
    ];
    // Grooves are POCKETS, not profile cuts — put them on their own layer so the
    // distinction is obvious when assigning toolpaths.
    s.layer("Groove pockets", "#f59e0b");
    const grooves = [
      keyed("groove-front", groove(length, yFront)),
      keyed("groove-back", groove(length, yBack)),
      keyed("groove-left", groove(width, yLeft)),
      keyed("groove-right", groove(width, yRight)),
    ];
    s.layer(); // back to the default layer

    // Suggest operations pre-configured for the box. Profile cuts use dog-bone
    // relief so square fingers/panel edges seat against a round
    // cutter's corners.
    // The tool must enter each corner-comb slot on the wall outlines. Slot
    // width = height / n with comb()'s own finger count (span = height, no
    // insets on the corner joints) — clamp the suggested tool to fit.
    const slotW = height / Math.max(2, Math.round(height / f));
    s.suggestOp({
      name: "Box panels — Profile (outside)",
      kind: "profile-outside",
      targets: profiles,
      depth: "through",
      cornerStyle: "dogbone",
      toolDiameter: Math.max(1, Math.min(6, slotW)),
    });
    s.suggestOp({
      name: "Bottom grooves — Pocket",
      kind: "pocket",
      targets: grooves,
      depth: -t / 2,
      cornerStyle: "dogbone",
      // The groove channel is only t wide — the default 6 mm end mill leaves
      // zero pocket area after tool-radius insetting and the op would post as
      // "pocket too small — skipped". Half the channel width always fits.
      toolDiameter: Math.min(6, t / 2),
    });

    return [...profiles, ...grooves];
  },
};
