/**
 * Kumiko panel — a real cut-out lattice, not an engraved impression of one.
 *
 * CONSTRUCTION. Every pattern here is one *jigumi* (base grid) plus one rule for
 * dividing its cells, which is how kumiko itself is built: a lattice of half-
 * lapped bars, then short infill pieces — *ha*, "leaves" — dropped into each
 * cell. So the generator is a small table of {lattice, division}, not a switch
 * with a hand-written routine per pattern:
 *
 *   - **Asanoha** (麻の葉, "hemp leaf") — triangular jigumi, every triangle split
 *     into three 30-30-120 faces by spokes from its centre to its corners. Those
 *     spokes are the ha, meeting three-at-a-time in a mitsu-kude (three-way)
 *     joint. Six leaves and six jigumi bars converge at every lattice vertex —
 *     twelve faces around one point — and THAT is the hemp-leaf rosette.
 *   - **Mitsu-kude** (三つ組手) — the bare triangular jigumi, undivided. Named for
 *     the three-way joint that forms it, and a finished pattern in its own right
 *     rather than a half-built asanoha.
 *   - **Kaku-asanoha** (角麻の葉, "square hemp leaf") — the same spoke rule on a
 *     SQUARE jigumi, giving 45-45-90 faces and an eight-pointed star at each
 *     vertex. The woodworking sources cut its pieces at 22.5°/67.5°, which are
 *     exactly the mitres a 45° leaf tip needs — an independent check that this
 *     is the right construction rather than a plausible-looking one.
 *
 * A bare triangular grid presented AS asanoha is the jigumi alone — scaffolding,
 * not the pattern — and is the specific way this generator has been got wrong
 * before. test/kumiko.test.ts pins each tiling by its face angles and by how
 * many faces meet at a lattice vertex, which no wrong-but-plausible drawing
 * satisfies.
 *
 * WHAT IS EMITTED. Every face of the tiling, inset by half the bar width, comes
 * out as one closed polyline: the OPENING to cut. The wood left standing between
 * the openings *is* the lattice, so `bar` is load-bearing geometry rather than a
 * decorative hint, and the panel leaves the machine as one piece from one board.
 * Cut the openings as through inside-profiles and the frame as a through
 * outside-profile.
 *
 * Faces are keyed by lattice coordinate, so a cell keeps its document id — and
 * any CAM op, dimension or constraint attached to it — across regeneration, even
 * though changing the pitch changes how many cells exist. Switching PATTERN is
 * a different tiling and deliberately does not preserve ids.
 *
 * Uses cam/offset.ts (Clipper2) for the inset and the border clip. That is pure
 * geometry — no document, no DOM, no fonts — so the Sketch stays Worker-safe.
 */

import { intersectPolygonSets, offsetPolygons, signedArea } from "../cam/offset";
import { DEFAULTS } from "../cam/types";
import type { Vec2 } from "../core/vec2";
import type { Generator } from "./index";
import type { Handle, Pt, Sketch } from "./sketch";

/** Height of an equilateral triangle of side 1 — the lattice row pitch. */
const ROW = Math.sqrt(3) / 2;

/**
 * Fraction of an opening's width the suggested cutter takes up. A tool sized to
 * *just* fit leaves a toolpath barely longer than a plunge, and rounds off the
 * 30° leaf tips badly; well under half leaves room to traverse and keeps the
 * tips crisp, which is the whole point of the pattern.
 */
const TOOL_FIT = 0.6;

/** Smallest cutter worth suggesting (mm) — below this, nothing real exists. */
const MIN_TOOL = 0.8;

/**
 * Ceiling on emitted openings. Each one is a document entity and a target of the
 * inside-profile op, so an absurd pitch/panel combination would otherwise commit
 * tens of thousands of entities and wedge the app. Refusing with a note beats
 * silently truncating the pattern to a "representative sample".
 *
 * This is a DOCUMENT limit and nothing more. It says nothing about whether the
 * result can be cut: 800 openings is comfortably under it and is still several
 * hours of through-profiling on a sub-millimetre bit. The machining side is
 * reported rather than capped — see {@link FRAGILE_TOOL} — because how long a
 * job may run and how brave the operator feels are not this generator's call.
 */
const MAX_CELLS = 1200;

/**
 * Cutter diameter (mm) below which a long through-profile in hardwood is a
 * broken-tool risk worth mentioning. A rule of thumb, not physics — which is
 * why it produces a note and not a refusal.
 */
const FRAGILE_TOOL = 2;

type Rect = { x0: number; y0: number; x1: number; y1: number };

/** Lattice vertex (u,v) — the basis is u·(a,0) + v·(a/2, a·√3/2). */
function vertex(u: number, v: number, a: number, o: Pt): Pt {
  return { x: o.x + (u + v / 2) * a, y: o.y + v * a * ROW };
}

/**
 * Inset a CONVEX polygon by `d`, exactly: each corner slides along its bisector
 * by d/sin(θ/2). Returns null if the inset collapses or inverts the shape.
 *
 * This exists because Clipper works on a 0.01 mm coordinate grid, and snapping
 * to it leaves otherwise-congruent faces differing by ~0.02 mm — invisible in
 * wood, but it means the lattice is not quite one shape repeated. Interior faces
 * are convex triangles needing no boolean work, so they are inset analytically
 * and come out exactly congruent; Clipper is left to the border faces, which
 * genuinely need clipping. Fewer calls, too.
 */
function insetConvex(poly: Pt[], d: number): Pt[] | null {
  const n = poly.length;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const cur = poly[i];
    const prev = poly[(i - 1 + n) % n];
    const next = poly[(i + 1) % n];
    const pl = Math.hypot(prev.x - cur.x, prev.y - cur.y);
    const nl = Math.hypot(next.x - cur.x, next.y - cur.y);
    if (pl < 1e-9 || nl < 1e-9) return null;
    const u = { x: (prev.x - cur.x) / pl, y: (prev.y - cur.y) / pl };
    const v = { x: (next.x - cur.x) / nl, y: (next.y - cur.y) / nl };
    // For a convex corner wound CCW, u+v points into the polygon.
    const bx = u.x + v.x;
    const by = u.y + v.y;
    const blen = Math.hypot(bx, by);
    if (blen < 1e-9) return null; // straight corner — no bisector
    const half = Math.acos(Math.max(-1, Math.min(1, u.x * v.x + u.y * v.y))) / 2;
    const back = d / Math.sin(half);
    out.push({ x: cur.x + (bx / blen) * back, y: cur.y + (by / blen) * back });
  }
  // Over-inset turns the polygon inside out, which flips the winding.
  return Math.sign(signedArea(out)) === Math.sign(signedArea(poly)) ? out : null;
}

/** Effective inscribed radius: exact for a triangle, a fair proxy otherwise. */
function inradius(poly: Vec2[]): number {
  let perim = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    perim += Math.hypot(q.x - p.x, q.y - p.y);
  }
  return perim > 0 ? (2 * Math.abs(signedArea(poly))) / perim : 0;
}

/** True when `poly` lies wholly inside `r` — lets the common case skip Clipper. */
function inside(poly: Pt[], r: Rect): boolean {
  return poly.every((p) => p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1);
}

/** True when `poly`'s bounding box misses `r` entirely — a cheap early reject. */
function misses(poly: Pt[], r: Rect): boolean {
  let lo = poly[0];
  let hi = poly[0];
  for (const p of poly) {
    if (p.x < lo.x || p.y < lo.y) lo = { x: Math.min(lo.x, p.x), y: Math.min(lo.y, p.y) };
    if (p.x > hi.x || p.y > hi.y) hi = { x: Math.max(hi.x, p.x), y: Math.max(hi.y, p.y) };
  }
  return hi.x <= r.x0 || lo.x >= r.x1 || hi.y <= r.y0 || lo.y >= r.y1;
}

function rectPoly(r: Rect): Vec2[] {
  return [
    { x: r.x0, y: r.y0 },
    { x: r.x1, y: r.y0 },
    { x: r.x1, y: r.y1 },
    { x: r.x0, y: r.y1 },
  ];
}

/**
 * The *kis* operation: split a cell into one face per edge by running a spoke
 * from its centre to every corner. This is the whole of what makes a hemp-leaf
 * pattern — the spokes ARE the `ha` (leaves), joined three-at-a-time in the
 * middle of each cell by a mitsu-kude in real joinery.
 *
 * Applied to a triangular jigumi it gives asanoha (the triakis triangular
 * tiling, 30-30-120 faces); to a square jigumi it gives kaku-asanoha, "square
 * hemp leaf" (the tetrakis square tiling, 45-45-90 faces). Same rule, different
 * lattice — which is exactly how the woodworking sources describe the pair, and
 * it is why the square variant's pieces are cut at 22.5°/67.5°: those are the
 * mitres a 45° leaf tip needs, where asanoha's 30° tip takes 15°.
 *
 * Corner order is preserved so a face's key is stable across rebuilds.
 */
function kis(cell: Pt[]): Pt[][] {
  const n = cell.length;
  const c = {
    x: cell.reduce((t, p) => t + p.x, 0) / n,
    y: cell.reduce((t, p) => t + p.y, 0) / n,
  };
  return cell.map((p, k) => [c, p, cell[(k + 1) % n]]);
}

/** Receives each jigumi cell with a key unique and stable within the lattice. */
type CellSink = (key: string, cell: Pt[]) => void;

/**
 * Equilateral triangles on the basis u·(a,0) + v·(a/2, a·√3/2). Each (u,v)
 * rhombus splits into an up- and a down-pointing triangle, both wound CCW —
 * which the bisector inset and the NonZero clip both depend on.
 */
function triangularJigumi(rect: Rect, a: number, o: Pt, sink: CellSink): void {
  const v0 = Math.floor((rect.y0 - o.y) / (a * ROW)) - 1;
  const v1 = Math.ceil((rect.y1 - o.y) / (a * ROW)) + 1;
  for (let v = v0; v <= v1; v++) {
    const u0 = Math.floor((rect.x0 - o.x) / a - v / 2) - 1;
    const u1 = Math.ceil((rect.x1 - o.x) / a - v / 2) + 1;
    for (let u = u0; u <= u1; u++) {
      const p00 = vertex(u, v, a, o);
      const p10 = vertex(u + 1, v, a, o);
      const p01 = vertex(u, v + 1, a, o);
      const p11 = vertex(u + 1, v + 1, a, o);
      sink(`${u}-${v}-u`, [p00, p10, p01]);
      sink(`${u}-${v}-d`, [p10, p11, p01]);
    }
  }
}

/** Squares of side `a`, wound CCW, aligned so a lattice vertex sits on `o`. */
function squareJigumi(rect: Rect, a: number, o: Pt, sink: CellSink): void {
  const j0 = Math.floor((rect.y0 - o.y) / a) - 1;
  const j1 = Math.ceil((rect.y1 - o.y) / a) + 1;
  const i0 = Math.floor((rect.x0 - o.x) / a) - 1;
  const i1 = Math.ceil((rect.x1 - o.x) / a) + 1;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const x = o.x + i * a;
      const y = o.y + j * a;
      sink(`${i}-${j}-s`, [
        { x, y },
        { x: x + a, y },
        { x: x + a, y: y + a },
        { x, y: y + a },
      ]);
    }
  }
}

/**
 * One kumiko pattern, as a lattice plus a rule for dividing its cells. Every
 * quantity the rest of the generator needs to reason about tool fit, panel
 * density and hub size is derived from the tiling and stated here, so adding a
 * pattern cannot silently leave those computed for the wrong geometry.
 */
interface KumikoPattern {
  /** Persisted `pattern` param value. NEVER renumber — saved files store it. */
  value: number;
  label: string;
  /**
   * Inradius of one whole face, as a fraction of the pitch. Half the bar width
   * comes off it, and what remains is the narrowest point of the opening —
   * which is what decides whether a cutter fits.
   */
  faceInradius: number;
  /** Faces per pitch² of panel — projects the opening count before building. */
  density: number;
  /**
   * Interior angle where faces converge on a lattice vertex. Uniform-width bars
   * meeting at this angle overlap for (bar/2)/sin(θ/2), which is the solid hub
   * at each rosette — 3.86x the bar width at asanoha's 30°, but only 2.0x at
   * mitsu-kude's 60°, so the same bar reads very differently between patterns.
   */
  tipAngleDeg: number;
  jigumi(rect: Rect, a: number, o: Pt, sink: CellSink): void;
  /** Divide one jigumi cell into the faces to cut. */
  divide(cell: Pt[]): Pt[][];
}

/**
 * Ordered as the dropdown reads. Asanoha is value 0 because it shipped first
 * and saved features carry no `pattern` at all — they must keep resolving to
 * the pattern they were drawn with.
 */
const PATTERNS: KumikoPattern[] = [
  {
    value: 0,
    label: "Asanoha",
    // 30-30-120 face: sides (a, a/√3, a/√3), so r = a/(4+2√3).
    faceInradius: 1 / (4 + 2 * Math.sqrt(3)),
    density: 6 / ROW, // 6 faces per rhombus of area ROW·a²
    tipAngleDeg: 30,
    jigumi: triangularJigumi,
    divide: kis,
  },
  {
    value: 1,
    label: "Mitsu-kude",
    // The jigumi itself, undivided: an equilateral triangle, r = a/(2√3).
    faceInradius: 1 / (2 * Math.sqrt(3)),
    density: 2 / ROW,
    tipAngleDeg: 60,
    jigumi: triangularJigumi,
    divide: (cell) => [cell],
  },
  {
    value: 2,
    label: "Kaku-asanoha",
    // 45-45-90 face with hypotenuse a: r = a(√2-1)/2.
    faceInradius: (Math.SQRT2 - 1) / 2,
    density: 4,
    tipAngleDeg: 45,
    jigumi: squareJigumi,
    divide: kis,
  },
];

export const kumiko: Generator = {
  // The id says "asanoha" because that is the only pattern it built when it
  // shipped, and .rcam files store `generatorId` verbatim — renaming it would
  // orphan every saved panel with no error, only a feature that quietly stops
  // regenerating. A stale-but-stable id is the cheaper half of that trade.
  id: "kumiko-asanoha",
  name: "Kumiko Panel",

  build(s: Sketch): Handle[] {
    // Declared first so it heads the dialog. Features saved before this param
    // existed carry no override and fall to 0 = asanoha, which is what they
    // were drawn as.
    const patternValue = s.param("pattern", 0, {
      label: "Pattern",
      choices: PATTERNS.map((p) => ({ value: p.value, label: p.label })),
    });
    const pattern = PATTERNS.find((p) => p.value === patternValue) ?? PATTERNS[0];

    const width = s.param("width", 200, { unit: "len", min: 20, label: "Width", step: 10 });
    const height = s.param("height", 160, { unit: "len", min: 20, label: "Height", step: 10 });
    const pitch = s.param("pitch", 40, {
      unit: "len",
      min: 8,
      label: "Cell pitch (jigumi)",
      step: 5,
    });
    // 3 mm, not the 6 mm a "sturdy bar" instinct suggests. Twelve bars converge
    // at 30° on every lattice vertex, and uniform-width bars crossing at 30°
    // overlap for (bar/2)/sin 15° — so the SOLID hub is 3.86x the bar width,
    // and the panel's open area collapses with it: 5 mm bars leave it 28% open
    // and visibly chunky, 3 mm leaves 51%, which is the delicate screen asanoha
    // is supposed to be. Real kumiko ha are thinner still, ~1.5-3 mm.
    const bar = s.param("bar", 3, { unit: "len", min: 0.5, label: "Bar width", step: 0.5 });
    const frame = s.param("frame", 10, { unit: "len", min: 0, label: "Frame width", step: 1 });

    s.key("frame");
    const panel = s.rect({ x: 0, y: 0 }, { w: width, h: height });
    const out: Handle[] = [panel];

    // The lattice region is inset by frame - bar/2, because the openings are
    // then inset a further bar/2 all round (the frame's inner edge behaves as
    // one more bar). That makes the LEFT and RIGHT borders exactly `frame`,
    // since bars reach those edges at every row. Top and bottom are a lower
    // bound only: rows land on multiples of pitch·√3/2, so the last one falls
    // where it falls and the border there is `frame` plus the remainder —
    // measured at 13.2 mm for a nominal 10 on a 200x160 panel at 40 mm pitch.
    const inset = frame - bar / 2;
    if (inset < 0) {
      s.note(`Frame width should be at least half the bar width (${s.len(bar / 2)}).`);
    }
    const pad = Math.max(0, inset);
    const rect: Rect = { x0: pad, y0: pad, x1: width - pad, y1: height - pad };
    if (rect.x1 - rect.x0 <= bar || rect.y1 - rect.y0 <= bar) {
      s.note("Frame leaves no room for the lattice — reduce the frame width.");
      return out;
    }

    // Size the cutter from a WHOLE interior opening, not from the tightest cell
    // on the panel: the border clip always leaves a few scraps, and letting one
    // of those pick the tool drags every opening down to whatever fits the worst
    // sliver. Scraps that can't accept this tool are dropped below and stay
    // solid wood — which is what a real kumiko border looks like anyway.
    const cellR = pattern.faceInradius * pitch - bar / 2;
    const tool = Math.min(DEFAULTS.diameter, 2 * cellR * TOOL_FIT);
    if (tool < MIN_TOOL) {
      s.note(
        `Bar width ${s.len(bar)} closes the lattice solid at a ${s.len(pitch)} pitch — ` +
          `widen the pitch past ` +
          `${s.len(Math.ceil((bar / 2 + MIN_TOOL / (2 * TOOL_FIT)) / pattern.faceInradius))} ` +
          "or thin the bars.",
      );
      return out;
    }

    const area = (rect.x1 - rect.x0) * (rect.y1 - rect.y0);
    const projected = Math.ceil((pattern.density * area) / (pitch * pitch));
    if (projected > MAX_CELLS) {
      s.note(
        `A ${s.len(pitch)} pitch needs about ${projected} openings here, past the ` +
          `${MAX_CELLS} this document can hold — widen the pitch or shrink the panel.`,
      );
      return out;
    }

    // A lattice vertex sits at the panel centre, so the rosette is centred and
    // the border crops symmetrically.
    const origin = { x: width / 2, y: height / 2 };
    const clip = [rectPoly(rect)];

    s.layer("Kumiko lattice", "#f59e0b");
    const cells: Handle[] = [];
    let minR = Number.POSITIVE_INFINITY;
    let scraps = 0;
    let cutLength = 0;

    pattern.jigumi(rect, pitch, origin, (cellKey, jigumiCell) => {
      if (misses(jigumiCell, rect)) return;
      for (const [k, face] of pattern.divide(jigumiCell).entries()) {
        if (misses(face, rect)) continue;
        let pieces: Vec2[][];
        if (inside(face, rect)) {
          const exact = insetConvex(face, bar / 2);
          pieces = exact ? [exact] : [];
        } else {
          const bounded = intersectPolygonSets([face], clip);
          if (bounded.length === 0) continue;
          // Miter limit is generous so the sharp leaf tips (30° on asanoha,
          // 45° on the square variant) stay crisp instead of being truncated
          // into facets at the default limit of 4.
          pieces = offsetPolygons(bounded, -bar / 2, { miterLimit: 12 });
        }
        let cut = false;
        for (const [i, cell] of pieces.entries()) {
          if (cell.length < 3) continue;
          const r = inradius(cell);
          if (r < tool / 2) continue;
          minR = Math.min(minR, r);
          cut = true;
          // Perimeter now, while the ring is to hand: summed, it is the
          // length of profile the machine has to run at full depth, which
          // is the honest measure of what this pattern costs to cut.
          for (let n = 0; n < cell.length; n++) {
            const q = cell[(n + 1) % cell.length];
            cutLength += Math.hypot(q.x - cell[n].x, q.y - cell[n].y);
          }
          // Same shape of key the asanoha-only version emitted, so a panel
          // saved before this refactor keeps every entity id it had.
          s.key(`cell-${cellKey}-${k}-${i}`);
          cells.push(s.polyline(cell, { closed: true }));
        }
        // A face that reaches the lattice but yields nothing cuttable — the
        // border clipped it to a sliver, or the inset swallowed it whole.
        // Counted so the panel can say why its edge is bare.
        if (!cut) scraps++;
      }
    });
    s.layer();

    if (cells.length === 0) {
      s.note(
        scraps > 0
          ? `A ${s.len(pitch)} pitch is too coarse for this panel — every opening fell on the border. ` +
              "Reduce the pitch."
          : "No openings survived — check the pitch, bar width and frame width.",
      );
      return out;
    }
    if (scraps > 0) {
      s.note(
        `${scraps} part-opening${scraps === 1 ? "" : "s"} at the border ${scraps === 1 ? "was" : "were"} ` +
          `too narrow for a ⌀${s.len(tool)} cutter and ${scraps === 1 ? "is" : "are"} left solid.`,
      );
    }
    s.note(
      `${cells.length} openings; the tightest is ${s.len(2 * minR)} across. ` +
        `Cut them with a ⌀${s.len(tool)} bit or smaller — ${s.len(cutLength, 0)} of ` +
        "profile at full depth.",
    );
    // The cell cap is a document limit and says nothing about machinability, so
    // the case it misses gets its own note: a fine lattice stays well under
    // 1200 openings while asking a sub-2 mm bit to run metres of through-cut.
    // Thinning the bars widens the openings, which is what lets a bigger cutter
    // in — the opposite of the instinct to "go finer to make it delicate".
    if (tool < FRAGILE_TOOL) {
      s.note(
        `A ⌀${s.len(tool)} bit over ${s.len(cutLength, 0)} of hardwood breaks easily. ` +
          "Widen the pitch or thin the bars to open the cells up for a bigger cutter.",
      );
    }
    // Bars converging on a lattice vertex overlap for (bar/2)/sin(θ/2), so the
    // solid hub there is a fixed multiple of the bar width whatever the pitch —
    // 3.86x at asanoha's 30° tip, 2.0x at mitsu-kude's 60°. Once those hubs
    // approach a third of the pitch they dominate the panel and the lattice
    // stops reading as one; thinning the bars is the only lever on it.
    const hub = bar / Math.sin((pattern.tipAngleDeg * Math.PI) / 360);
    if (hub > pitch / 3) {
      s.note(
        `Bars meet in ${s.len(hub, 0)} solid hubs at this bar width — ` +
          "thin the bars to open the pattern up.",
      );
    }

    s.suggestOp({
      name: "Kumiko lattice — Profile (inside)",
      kind: "profile-inside",
      targets: cells,
      depth: "through",
      toolDiameter: tool,
    });
    s.suggestOp({
      name: "Kumiko frame — Profile (outside)",
      kind: "profile-outside",
      targets: [panel],
      depth: "through",
    });

    return out.concat(cells);
  },
};
