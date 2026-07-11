/**
 * Klein — cylindrical / rotary "unfolding".
 *
 * A part is drawn flat, in the normal top view, then *wrapped* around a cylinder
 * mounted on a rotary (4th) axis. One work axis stays linear (it runs along the
 * length of the cylinder); the perpendicular work axis is rolled around the
 * circumference and emitted as a rotary word (`A`/`B`, in degrees) instead of a
 * linear coordinate. Depth (`Z`) is left as cut depth below the surface — the
 * standard "wrapped rotary" model where the tool cuts at the top-dead-centre of
 * the cylinder and each angular position is rolled up to meet it.
 *
 * Clean-math core:  a point's wrapped coordinate `w` (mm along the surface) maps
 * to an angle  θ = w · 360 / (π · D)  degrees — one full turn per circumference.
 * The mapping is *cumulative* (never taken mod 360), so the axis unwinds
 * continuously and a design taller than one circumference simply spirals.
 *
 * Design note — like {@link ./flip}, we reuse the whole existing generator rather
 * than re-plumbing every op. Flip could transform at the entity level (a mirror
 * is a 2-D transform); a wrap is *not* a 2-D transform (a linear axis becomes an
 * angular one), so the single correct chokepoint is the emitted motion. We take
 * the finished linear program and rewrite it move-by-move: linear moves get their
 * wrapped word swapped for the rotary word; circular moves (`G2`/`G3`) are
 * flattened to short `G1` chords first, because an arc in the flat plane is not a
 * circular arc once one of its axes is angular. Every op type — profile, pocket,
 * engrave, v-carve, drill, relief — wraps for free. Mill-only.
 */

import {
  type CADDocument,
  resolveOrigin,
  stockFootprint,
  type RotarySettings,
} from "../model/document";
import { generateGCode, type GCodeOptions } from "./gcode";
import { n } from "./postprocessors/base";

export type { RotarySettings, RotaryAxisWord } from "../model/document";

/** Default arc-flattening chord tolerance (mm). */
export const ARC_TOL_DEFAULT = 0.1;

/** A sensible default rotary setup (A-axis, Y wraps, diameter from the stock's short side). */
export function defaultRotarySettings(doc: CADDocument): RotarySettings {
  // Guess a diameter that would make the design span exactly one wrap on the
  // circumference — the common intent (a label that goes all the way round).
  const span = stockFootprint(doc).height; // default wrapAxis "y"
  // Round the diameter UP to 0.1mm so the circumference is ≥ the span — a design
  // that fills the stock then wraps just under one turn, not just over it (which
  // would immediately trip validateRotary's overlap warning).
  const diameter = Math.max(1, Math.ceil((span / Math.PI) * 10) / 10);
  return { axisWord: "A", diameter, wrapAxis: "y" };
}

/** Circumference (mm) of the wrap cylinder — the surface travel for one full turn. */
export function circumference(settings: RotarySettings): number {
  return Math.PI * settings.diameter;
}

/**
 * Map a wrapped-axis coordinate (mm along the surface, in work coordinates) to a
 * rotary angle in degrees. Cumulative — never reduced mod 360 — so the axis turns
 * continuously and coordinates past one circumference spiral rather than fold back.
 */
export function wrapAngleDeg(coordMM: number, settings: RotarySettings): number {
  const c = circumference(settings);
  return c > 1e-9 ? (coordMM * 360) / c : 0;
}

// --- G-code motion rewriting -------------------------------------------------

/** Address letters we read from a motion line; everything else passes through. */
interface Move {
  g: number; // 0..3
  x?: number;
  y?: number;
  z?: number;
  i?: number;
  j?: number;
  f?: number;
}

const WORD_RE = /([A-Za-z])(-?\d*\.?\d+)/g;

/**
 * Flatten a circular arc (start→end about a centre) into a list of intermediate
 * points *after* the start, up to and including the exact end. `cw` = G2 (a
 * clockwise sweep in the standard XY plane). Z, when the arc is helical, is
 * lerped along the swept angle. Chord count is set so the mid-chord bulge stays
 * within `tol`.
 */
export function flattenArc(
  sx: number,
  sy: number,
  ex: number,
  ey: number,
  cx: number,
  cy: number,
  cw: boolean,
  tol: number,
  zStart?: number,
  zEnd?: number,
): { x: number; y: number; z?: number }[] {
  const r = Math.hypot(sx - cx, sy - cy);
  if (r < 1e-9) return [{ x: ex, y: ey, z: zEnd }];

  const a0 = Math.atan2(sy - cy, sx - cx);
  const a1 = Math.atan2(ey - cy, ex - cx);
  let sweep = a1 - a0;
  // Normalise to the correct arc direction. A zero raw difference on a closed
  // path (start == end) is a full turn, not a no-op — the common engraveCircle case.
  if (cw) {
    while (sweep >= 0) sweep -= 2 * Math.PI;
  } else {
    while (sweep <= 0) sweep += 2 * Math.PI;
  }

  // Max angular step that keeps the chord bulge under tol: bulge = r(1-cos(Δ/2)).
  const ratio = Math.max(-1, Math.min(1, 1 - tol / r));
  const maxStep = 2 * Math.acos(ratio);
  const nSeg = Math.max(1, Math.ceil(Math.abs(sweep) / Math.max(1e-6, maxStep)));

  const haveZ = zStart !== undefined && zEnd !== undefined;
  const pts: { x: number; y: number; z?: number }[] = [];
  for (let k = 1; k <= nSeg; k++) {
    const t = k / nSeg;
    if (k === nSeg) {
      // Land exactly on the commanded end point (no radial drift from rounding).
      pts.push({ x: ex, y: ey, z: haveZ ? zEnd : undefined });
    } else {
      const a = a0 + sweep * t;
      pts.push({
        x: cx + r * Math.cos(a),
        y: cy + r * Math.sin(a),
        z: haveZ ? zStart! + (zEnd! - zStart!) * t : undefined,
      });
    }
  }
  return pts;
}

/** Parse a motion line into a {@link Move}, or null if it carries no motion. */
function parseMove(code: string): Move | null {
  WORD_RE.lastIndex = 0;
  const words: Record<string, number> = {};
  let g: number | null = null;
  let m = WORD_RE.exec(code);
  while (m !== null) {
    const letter = m[1].toUpperCase();
    const value = parseFloat(m[2]);
    if (letter === "G") g = value;
    else words[letter] = value;
    m = WORD_RE.exec(code);
  }
  if (g === null || g < 0 || g > 3) return null;
  return { g, x: words.X, y: words.Y, z: words.Z, i: words.I, j: words.J, f: words.F };
}

export interface WrapOptions {
  /**
   * Emit **inverse-time feed** (G93): a feed move's `F` becomes `feed ÷ path-length`
   * (the move then takes `path-length ÷ feed` minutes), which is how a controller
   * reads a combined linear + rotary move at the intended *surface* speed — a plain
   * mm/min `F` is ambiguous once an axis is angular. `G94` (feed-per-minute) is
   * restored before program end. Default false: leave the authored mm/min feeds as
   * they are (a pure geometric wrap). {@link generateRotaryProgram} enables it.
   */
  inverseTimeFeed?: boolean;
}

/**
 * Rewrite one finished linear-mode program (mill work coordinates) so the wrapped
 * axis is emitted as rotary degrees and arcs are linearised. Non-motion lines
 * (comments, spindle, tool changes, plane/units) pass through untouched. With
 * `inverseTimeFeed`, feed moves are re-fed in G93 inverse-time (see {@link WrapOptions}).
 * Pure — no document access; the caller supplies the settings.
 */
export function wrapGCode(
  program: string,
  settings: RotarySettings,
  opts: WrapOptions = {},
): string {
  const inverseTime = opts.inverseTimeFeed === true;
  const tol =
    settings.arcTolerance && settings.arcTolerance > 0 ? settings.arcTolerance : ARC_TOL_DEFAULT;
  const wrapX = settings.wrapAxis === "x";
  const keep = wrapX ? "Y" : "X"; // the linear axis we leave alone
  const A = settings.axisWord;
  // Centre-zeroing: the flat program is authored with Z0 on the stock top (cuts
  // negative). To re-reference Z to the rotary axis we lift every emitted Z by the
  // radius, so the surface lands at Z = radius and a cut to depth d lands at
  // Z = radius − d. A constant shift leaves every Z *difference* — and therefore
  // the inverse-time path lengths — untouched, so only the emitted words change.
  const zOffset = settings.zero === "center" ? settings.diameter / 2 : 0;

  // Current tool position in work coords (needed to reconstruct arcs); modal feed
  // carried across moves so a G1 that omits F still knows its surface feed.
  let cx = 0,
    cy = 0,
    cz = 0;
  let curFeed = 0;
  let g93 = false;
  const out: string[] = [];

  const ang = (coord: number) => wrapAngleDeg(coord, settings);
  const emitG93 = (): void => {
    if (inverseTime && !g93) {
      out.push("G93 ; inverse-time feed (rotary combined moves)");
      g93 = true;
    }
  };
  // Inverse-time F for a segment of flat length L (mm) at surface feed f (mm/min):
  // the move takes L/f minutes, so F = 1/time = f/L. Unrolling is an isometry —
  // flat length equals the true surface distance — so L is just the flat move
  // length (Z included). Null for a zero-length move (no F word needed).
  const invF = (L: number, f: number): number | null => (L < 1e-9 || f <= 0 ? null : f / L);

  // Format a flattened arc point as a wrapped linear move.
  const wrappedPoint = (
    x: number,
    y: number,
    z: number | undefined,
    f: number | undefined,
  ): string => {
    const linCoord = wrapX ? y : x; // the axis kept linear
    const rotCoord = wrapX ? x : y; // the axis rolled to rotation
    let s = `G1 ${keep}${n(linCoord)} ${A}${n(ang(rotCoord))}`;
    if (z !== undefined) s += ` Z${n(z + zOffset)}`;
    if (f !== undefined) s += ` F${n(f)}`;
    return s;
  };

  for (const rawLine of program.split("\n")) {
    const semi = rawLine.indexOf(";");
    const codePart = semi >= 0 ? rawLine.slice(0, semi) : rawLine;
    // Carry a single separating space so the re-joined move + comment reads
    // "... F1000 ; cut" (the original space lived in the trimmed code part).
    const comment = semi >= 0 ? ` ${rawLine.slice(semi)}` : "";

    const mv = codePart.trim() ? parseMove(codePart) : null;
    if (!mv) {
      // Restore feed-per-minute just before the program ends, so the machine isn't
      // left in inverse-time mode after the job.
      if (inverseTime && g93 && /^\s*M30\b/.test(codePart)) {
        out.push("G94 ; feed per minute");
        g93 = false;
      }
      out.push(rawLine);
      continue;
    }
    if (mv.f !== undefined) curFeed = mv.f;

    // Resolve the move's endpoint against modal state (omitted words hold).
    const nx = mv.x ?? cx,
      ny = mv.y ?? cy,
      nz = mv.z ?? cz;

    if (mv.g === 2 || mv.g === 3) {
      // Arc: reconstruct centre from I/J (offsets from the start point), flatten
      // to chords, and emit each as a wrapped linear move. Under inverse time each
      // chord carries its own F (a per-move quantity), else only the first does.
      const ci = cx + (mv.i ?? 0),
        cj = cy + (mv.j ?? 0);
      const helical = mv.z !== undefined && Math.abs(nz - cz) > 1e-9;
      const pts = flattenArc(
        cx,
        cy,
        nx,
        ny,
        ci,
        cj,
        mv.g === 2,
        tol,
        helical ? cz : undefined,
        helical ? nz : undefined,
      );
      emitG93();
      let px = cx,
        py = cy,
        pz = cz,
        first = true;
      for (const p of pts) {
        const pz2 = p.z !== undefined ? p.z : cz;
        const f = inverseTime
          ? (invF(Math.hypot(p.x - px, p.y - py, pz2 - pz), curFeed) ?? undefined)
          : first
            ? mv.f
            : undefined;
        out.push(wrappedPoint(p.x, p.y, p.z, f) + (first ? comment : ""));
        px = p.x;
        py = p.y;
        pz = pz2;
        first = false;
      }
    } else {
      // Linear move (G0/G1): swap only the wrapped word, preserving which words
      // were present (so rapids like `G0 Z5` stay minimal and modal).
      const cmd = `G${mv.g}`;
      const parts: string[] = [];
      if (mv.x !== undefined) parts.push(wrapX ? `${A}${n(ang(mv.x))}` : `X${n(mv.x)}`);
      if (mv.y !== undefined) parts.push(wrapX ? `Y${n(mv.y)}` : `${A}${n(ang(mv.y))}`);
      if (mv.z !== undefined) parts.push(`Z${n(mv.z + zOffset)}`);
      if (inverseTime && mv.g === 1) {
        emitG93();
        const f = invF(Math.hypot(nx - cx, ny - cy, nz - cz), curFeed);
        if (f !== null) parts.push(`F${n(f)}`);
      } else if (mv.f !== undefined) {
        parts.push(`F${n(mv.f)}`);
      }
      out.push(`${cmd} ${parts.join(" ")}${comment}`.trimEnd());
    }

    cx = nx;
    cy = ny;
    cz = nz;
  }
  // Fallback: restore G94 if the program had no M30 to anchor it.
  if (inverseTime && g93) out.push("G94 ; feed per minute");
  return out.join("\n");
}

// --- program + validation ----------------------------------------------------

/** The wrapped rotary program plus any pre-flight advisories. */
export interface RotaryProgram {
  program: string;
  warnings: string[];
}

/** Operator banner explaining the wrap setup, prepended to the program. */
function rotaryBanner(doc: CADDocument, s: RotarySettings): string {
  const c = circumference(s);
  const lengthAxis = s.wrapAxis === "y" ? "X" : "Y";
  const foot = stockFootprint(doc);
  const span = s.wrapAxis === "y" ? foot.height : foot.width;
  const wrapU = s.wrapAxis.toUpperCase();
  const center = s.zero === "center";
  const zLine = center
    ? // Centre-zeroed: Z0 is the rotary axis, so the surface sits at Z = radius and
      // cuts land at Z = radius − depth. This is the native rotary convention, which
      // gSender and most controllers visualize on the cylinder with no extra toggle.
      `; Z0 is the ROTARY CENTRE (the axis of rotation): the cylinder surface is at Z${n(s.diameter / 2)} (radius), cuts go below that. Touch the tool off on the stock top and set Z to the radius ${n(s.diameter / 2)}mm.`
    : `; Z0 is the TOP of the cylinder surface (surface-zeroed, not centre-zeroed): touch the tool off on the stock top; cuts go negative from there, at top-dead-centre.`;
  const lines = [
    `; === Rotary / cylindrical wrap ===`,
    `; Stock: cylinder ⌀${n(s.diameter)}mm  (circumference ${n(c)}mm = 360° on ${s.axisWord})`,
  ];
  // Surface-zeroed programs need a hint for rotary visualizers: gSender parses this
  // "Cylinder Dia:" token (Visualize.worker.ts) and adds the radius to lift the
  // surface-zeroed path onto the cylinder — but only with its Config ▸ Rotary ▸
  // "Visualize non-center zeros" toggle on. A centre-zeroed program is already in
  // the axis frame the visualizer expects, so the token/toggle are unnecessary.
  if (!center)
    lines.push(
      `; Cylinder Dia: ${n(s.diameter)}  (mm — for rotary visualizers; in gSender enable Config > Rotary > "Visualize non-center zeros")`,
    );
  lines.push(
    `; The design's ${wrapU} is wrapped around the cylinder; ${lengthAxis} runs along its length.`,
    zLine,
    `; ${s.axisWord}0 is at the ${wrapU} work origin.`,
    `; Design ${wrapU} span ${n(span)}mm → ${n(wrapAngleDeg(span, s))}° of rotation.`,
    `; Feeds use inverse-time mode (G93): each move's F = surface-feed ÷ path-length; G94 (feed/min) is restored at the end.`,
  );
  return lines.join("\n");
}

/**
 * Non-fatal advisories for a rotary setup — a bad diameter, a design that wraps
 * past one full turn (self-overlap), or an incompatible document mode. Empty = clear.
 */
export function validateRotary(doc: CADDocument): string[] {
  const s = doc.rotary;
  if (!s) return [];
  const out: string[] = [];

  if (doc.machineKind === "laser")
    out.push(
      "Rotary wrap is mill-only, but this document is set to a laser machine — switch to mill, or the wrap is ignored.",
    );
  if (doc.flip)
    out.push(
      "Rotary wrap and double-sided (flip) machining can't be combined — turn one of them off.",
    );
  if (!(s.diameter > 0))
    out.push("Cylinder diameter must be greater than 0 — set the rotary stock diameter.");

  if (s.diameter > 0) {
    const foot = stockFootprint(doc);
    const span = s.wrapAxis === "y" ? foot.height : foot.width;
    const turns = span / circumference(s);
    if (turns > 1.0001)
      out.push(
        `The design spans ${n(wrapAngleDeg(span, s))}° (${n(turns)} turns) around the cylinder — past one full wrap, so the ends overlap. Increase the diameter, or shrink the design along ${s.wrapAxis.toUpperCase()}.`,
      );
  }
  return out;
}

/**
 * Generate the wrapped rotary program for a document: build the normal flat
 * program through the shared generator, then roll it around the cylinder. The
 * WCS origin is resolved exactly as for a flat job, so `A0` lands on the wrapped
 * axis's work origin. Requires `doc.rotary`.
 */
export function generateRotaryProgram(doc: CADDocument, opts: GCodeOptions = {}): RotaryProgram {
  const s = doc.rotary ?? defaultRotarySettings(doc);
  const warnings = validateRotary(doc);
  // Origin resolution is shared with flat export (X()/Y() already subtract it),
  // so the wrap sees work coordinates — A0 at the wrapped-axis origin.
  void resolveOrigin(doc);
  const flat = generateGCode(doc.operations, doc, opts);
  const program = `${rotaryBanner(doc, s)}\n\n${wrapGCode(flat, s, { inverseTimeFeed: true })}`;
  return { program, warnings };
}
