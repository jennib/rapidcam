/**
 * Kumiko asanoha (麻の葉, "hemp leaf") panel — a real cut-out lattice, not an
 * engraved impression of one.
 *
 * CONSTRUCTION. Asanoha is the *triakis triangular tiling*: an equilateral
 * triangular lattice — the kumiko *jigumi*, or base grid — with every triangle
 * split into three 30-30-120 obtuse triangles by spokes running from its centre
 * to its corners. Those spokes are the *ha* ("leaves"); in real joinery three of
 * them meet in the middle of each triangle in a mitsu-kude (three-way) joint.
 * Six leaves and six jigumi bars converge at every lattice vertex — twelve faces
 * around one point — and THAT is the hemp-leaf rosette. A bare triangular grid
 * with no leaves is the jigumi alone, i.e. the scaffolding, not the pattern.
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
 * though changing the pitch changes how many cells exist.
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
 * Inradius of one asanoha face as a fraction of the lattice pitch. The face is a
 * 30-30-120 triangle with sides (a, a/√3, a/√3), so r = area/s = a²/(4√3) ÷
 * a(1+2/√3)/2, i.e. a/(4+2√3). Half the bar width comes off that, and what
 * remains is the narrowest point of the opening — which is what decides whether
 * a cutter fits.
 */
const FACE_INRADIUS = 1 / (4 + 2 * Math.sqrt(3));

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
 */
const MAX_CELLS = 1200;

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

/** True when `tri` lies wholly inside `r` — lets the common case skip Clipper. */
function inside(tri: Pt[], r: Rect): boolean {
  return tri.every((p) => p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1);
}

/** True when `tri`'s bounding box misses `r` entirely — a cheap early reject. */
function misses(tri: Pt[], r: Rect): boolean {
  return (
    Math.max(tri[0].x, tri[1].x, tri[2].x) <= r.x0 ||
    Math.min(tri[0].x, tri[1].x, tri[2].x) >= r.x1 ||
    Math.max(tri[0].y, tri[1].y, tri[2].y) <= r.y0 ||
    Math.min(tri[0].y, tri[1].y, tri[2].y) >= r.y1
  );
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
 * The three faces of one jigumi triangle: centre to each pair of adjacent
 * corners. Returned in corner order so a face's key is stable across rebuilds.
 */
function faces(tri: Pt[]): Pt[][] {
  const g = {
    x: (tri[0].x + tri[1].x + tri[2].x) / 3,
    y: (tri[0].y + tri[1].y + tri[2].y) / 3,
  };
  return [0, 1, 2].map((k) => [g, tri[k], tri[(k + 1) % 3]]);
}

export const kumiko: Generator = {
  id: "kumiko-asanoha",
  name: "Kumiko Panel (Asanoha)",

  build(s: Sketch): Handle[] {
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
    const cellR = FACE_INRADIUS * pitch - bar / 2;
    const tool = Math.min(DEFAULTS.diameter, 2 * cellR * TOOL_FIT);
    if (tool < MIN_TOOL) {
      s.note(
        `Bar width ${s.len(bar)} closes the lattice solid at a ${s.len(pitch)} pitch — ` +
          `widen the pitch past ${s.len(Math.ceil((bar / 2 + MIN_TOOL / (2 * TOOL_FIT)) / FACE_INRADIUS))} ` +
          "or thin the bars.",
      );
      return out;
    }

    const area = (rect.x1 - rect.x0) * (rect.y1 - rect.y0);
    const projected = Math.ceil((6 * area) / (ROW * pitch * pitch));
    if (projected > MAX_CELLS) {
      s.note(
        `A ${s.len(pitch)} pitch needs about ${projected} openings here (limit ${MAX_CELLS}) — ` +
          "widen the pitch or shrink the panel.",
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

    const v0 = Math.floor((rect.y0 - origin.y) / (pitch * ROW)) - 1;
    const v1 = Math.ceil((rect.y1 - origin.y) / (pitch * ROW)) + 1;
    for (let v = v0; v <= v1; v++) {
      const u0 = Math.floor((rect.x0 - origin.x) / pitch - v / 2) - 1;
      const u1 = Math.ceil((rect.x1 - origin.x) / pitch - v / 2) + 1;
      for (let u = u0; u <= u1; u++) {
        const p00 = vertex(u, v, pitch, origin);
        const p10 = vertex(u + 1, v, pitch, origin);
        const p01 = vertex(u, v + 1, pitch, origin);
        const p11 = vertex(u + 1, v + 1, pitch, origin);
        // The rhombus splits into an up- and a down-pointing jigumi triangle,
        // both wound CCW — which the bisector inset and the NonZero clip below
        // each depend on.
        const tris: [string, Pt[]][] = [
          ["u", [p00, p10, p01]],
          ["d", [p10, p11, p01]],
        ];

        for (const [tag, tri] of tris) {
          if (misses(tri, rect)) continue;
          for (const [k, face] of faces(tri).entries()) {
            if (misses(face, rect)) continue;
            let pieces: Vec2[][];
            if (inside(face, rect)) {
              const exact = insetConvex(face, bar / 2);
              pieces = exact ? [exact] : [];
            } else {
              const bounded = intersectPolygonSets([face], clip);
              if (bounded.length === 0) continue;
              // Miter limit is generous so the 30° leaf tips stay sharp instead
              // of being truncated into facets at the default limit of 4.
              pieces = offsetPolygons(bounded, -bar / 2, { miterLimit: 12 });
            }
            let cut = false;
            for (const [i, cell] of pieces.entries()) {
              if (cell.length < 3) continue;
              const r = inradius(cell);
              if (r < tool / 2) continue;
              minR = Math.min(minR, r);
              cut = true;
              s.key(`cell-${u}-${v}-${tag}-${k}-${i}`);
              cells.push(s.polyline(cell, { closed: true }));
            }
            // A face that reaches the lattice but yields nothing cuttable — the
            // border clipped it to a sliver, or the inset swallowed it whole.
            // Counted so the panel can say why its edge is bare.
            if (!cut) scraps++;
          }
        }
      }
    }
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
        `Cut them with a ⌀${s.len(tool)} bit or smaller.`,
    );
    // Twelve bars converge at 30° on each lattice vertex and overlap for
    // (bar/2)/sin 15°, so the solid hub there is 3.86x the bar width whatever
    // the pitch. Once those hubs approach a third of the pitch they dominate
    // the panel and the lattice stops reading as one — worth saying, because
    // thinning the bars is the only lever on it.
    const hub = bar / Math.sin(Math.PI / 12);
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
