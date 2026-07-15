/**
 * Finger-jointed box generator — an open-top box (a tray/drawer): a bottom and
 * four walls, laid out FLAT as five closed polylines ready to cut. The four
 * vertical corners are box (finger) joints, and the bottom is captured by finger
 * joints along the lower edge of every wall.
 *
 * This is the first *coordinated multi-panel* generator: the whole point is that
 * mating edges are pre-phased so the parts actually assemble. The rules that make
 * that work:
 *  - Outer size is length (X) × width (Y) × height (Z); material thickness t.
 *  - Every joint edge is a square-finger comb of pitch ≈ fingerWidth, with the
 *    finger count forced ODD so the pattern is symmetric end-to-end.
 *  - Corner joints: front/back walls and side walls comb their vertical edges
 *    over the same height span with COMPLEMENTARY phase (where one is solid the
 *    other is notched), so tabs meet slots. Fingers are inset by t at top and
 *    bottom so the corner cubes belong cleanly to one panel.
 *  - Base joint: each wall's bottom edge is notched inward; the bottom panel
 *    (inset by t all round so it drops inside the walls) carries matching tabs
 *    over the same span, same phase — tab fills notch.
 *
 * Joints are square (no kerf compensation): the operator adds fit allowance via
 * tool offset. Drawn around the origin; the runner places the layout in the work
 * area. See generators/index.ts.
 */

import type { Generator } from "./index";
import type { Pt } from "./sketch";

/** One edge profile of a panel: a square-finger comb, or straight when omitted. */
interface CombSpec {
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
}

/**
 * Canonical comb along +X from (0,0) to (len,0); active fingers step ±depth in Y
 * (+ = protrude, − = recede). Fingers live in [insetStart, len-insetEnd]; the ends
 * stay on the base line so they abut a perpendicular joint cleanly. At least two
 * fingers, so a pair of complementary edges always interlocks (with one finger,
 * one side would carry the notch and the mate nothing).
 */
function comb(len: number, spec: CombSpec): Pt[] {
  const s = spec.insetStart;
  const e = len - spec.insetEnd;
  const span = e - s;
  const n = Math.max(2, Math.round(span / spec.fingerW));
  const w = span / n;
  const sign = spec.protrude ? 1 : -1;

  const pts: Pt[] = [
    { x: 0, y: 0 },
    { x: s, y: 0 },
  ];
  let curY = 0;
  for (let i = 0; i < n; i++) {
    const active = spec.firstActive ? i % 2 === 0 : i % 2 === 1;
    const y = active ? sign * spec.depth : 0;
    const x0 = s + w * i;
    const x1 = s + w * (i + 1);
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
  return out;
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

    // Edge-role specs. Corner joints use complementary phase between front/back
    // (firstActive true) and side walls (false); base joints share phase, with
    // walls notched and the bottom tabbed.
    // Vertical corner joints run from the base joint (inset t at the bottom) up
    // to the open rim (inset 0 at the top). Front/back and side walls take
    // complementary phase so tabs meet slots.
    const cornerFB: CombSpec = { fingerW: f, depth: t, protrude: false, firstActive: true, insetStart: t, insetEnd: 0 };
    const cornerSide: CombSpec = { fingerW: f, depth: t, protrude: false, firstActive: false, insetStart: t, insetEnd: 0 };
    // Base joints inset t at both ends to clear the two vertical corners.
    const baseWall: CombSpec = { fingerW: f, depth: t, protrude: false, firstActive: true, insetStart: t, insetEnd: t };
    const baseTab: CombSpec = { fingerW: f, depth: t, protrude: true, firstActive: true, insetStart: 0, insetEnd: 0 };

    // Front / back walls (length × height): vertical edges = corner joints,
    // bottom edge = base joint, open top.
    const frontBack: PanelSpecs = { left: cornerFB, right: cornerFB, bottom: baseWall };
    // Side walls (width × height): complementary corner phase.
    const side: PanelSpecs = { left: cornerSide, right: cornerSide, bottom: baseWall };
    // Bottom (inset by t all round): every edge tabs into a wall's base notch.
    const bottomSpecs: PanelSpecs = {
      bottom: baseTab,
      top: baseTab,
      left: baseTab,
      right: baseTab,
    };

    const front = panel(length, height, frontBack);
    const back = panel(length, height, frontBack);
    const left = panel(width, height, side);
    const right = panel(width, height, side);
    const bottom = panel(length - 2 * t, width - 2 * t, bottomSpecs);

    // Lay the five panels out flat with gaps so nothing overlaps.
    const g = Math.max(4 * t, 6);
    const shift = (pts: Pt[], ox: number, oy: number): Pt[] =>
      pts.map((p) => ({ x: p.x + ox, y: p.y + oy }));
    const col = length + g; // bottom sits to the right of the wall column

    return [
      s.polyline(shift(front, 0, 0), { closed: true }),
      s.polyline(shift(back, 0, height + g), { closed: true }),
      s.polyline(shift(left, 0, 2 * (height + g)), { closed: true }),
      s.polyline(shift(right, 0, 3 * (height + g)), { closed: true }),
      s.polyline(shift(bottom, col, 0), { closed: true }),
    ];
  },
};
