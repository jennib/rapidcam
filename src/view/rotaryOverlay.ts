/**
 * Rotary (4th-axis) wrap hint — the on-canvas explanation of what a flat drawing
 * becomes once it is rolled onto the cylinder.
 *
 * For a rotary document the canvas IS the unrolled cylinder surface: one
 * axis runs along the rod's length, the perpendicular one is the circumference
 * (the diameter↔canvas lock keeps `canvas[wrapped] === π·D`, so the drawing
 * covers exactly one turn). None of that is visible in a plain top view, which is
 * what makes a rotary job easy to lay out wrongly.
 *
 * This module computes the hint as pure data — a degree ruler along the wrapped
 * axis, the quarter-turn guides, and the seam edges — so it can be unit-tested
 * without a canvas; {@link ../view/renderer.Renderer.drawRotaryWrap} just paints it.
 *
 * The angles shown are the ones the post actually emits. `wrapGCode` wraps the
 * *finished* program, whose coordinates are already origin-shifted, so **0° sits
 * at the work origin, not at the canvas edge** — a centred origin means the
 * design runs −180°…+180°. Angles are cumulative (never reduced mod 360), so the
 * labels are signed, matching the G-code word for word.
 *
 * The ruler is in degrees for BOTH rotary outputs (see cam/klein `rotaryOutput`).
 * A milled rotary posts those degrees literally as an A/B word; a beam rotary
 * substitutes the axis and posts surface millimetres — but the design still runs
 * one full turn around the rod, so where 90° falls is exactly as meaningful. Only
 * the legend changes, so it never names a word the post doesn't emit.
 */

import { circumference, defaultRotarySettings, rotaryOutput } from "../cam/klein";
import type { Vec2 } from "../core/vec2";
import { formatLengthWithUnit } from "../core/units";
import { type CADDocument, resolveOrigin, type RotaryAxisWord } from "../model/document";

/** One graduation on the wrap ruler. */
export interface RotaryTick {
  /** Position along the wrapped axis, in canvas mm. */
  coordMM: number;
  /** Rotary angle emitted there, in degrees (signed + cumulative, like the G-code). */
  deg: number;
  /** Labelled quarter-turn graduation (vs. a short unlabelled subdivision). */
  major: boolean;
}

export interface RotaryWrapHint {
  /** Work axis rolled around the cylinder; the other one runs along its length. */
  wrapAxis: "x" | "y";
  /** The axis that stays linear — the rod's length. */
  linearAxis: "x" | "y";
  /** Rotary word the wrapped axis is emitted as. */
  axisWord: RotaryAxisWord;
  diameter: number;
  /** Surface travel for one full turn (π·D), mm. */
  circumference: number;
  /** Canvas extent along the wrapped axis, mm — equals the circumference when the lock holds. */
  span: number;
  /** Canvas extent along the linear axis, mm — the cylinder length. */
  length: number;
  /** Where the wrapped axis reads 0° (canvas mm) — the work origin, not the canvas edge. */
  zeroCoordMM: number;
  /** Both wrapped-axis extremes: the same line on the rod once it is rolled up. */
  seams: { a: Vec2; b: Vec2 }[];
  ticks: RotaryTick[];
  /** Compact readout for the ruler head. */
  legend: string;
  /** Set when the canvas span isn't one full turn (the diameter↔canvas lock is broken). */
  warning: string | null;
}

/** Candidate graduations, finest first — the first one that isn't cramped wins. */
const MINOR_STEPS_DEG = [5, 10, 15, 30, 45];
const MAJOR_STEPS_DEG = [90, 180];
/** Minimum on-screen spacing (px) for a subdivision / a labelled graduation. */
const MIN_MINOR_PX = 9;
const MIN_MAJOR_PX = 44;
/** Never emit more graduations than this (guards a broken lock spanning many turns). */
const MAX_TICKS = 240;

/**
 * Build the wrap hint for `doc`, or null when it isn't a rotary job. `pxPerMM` is
 * the current zoom, used only to choose graduation density.
 */
export function rotaryWrapHint(doc: CADDocument, pxPerMM: number): RotaryWrapHint | null {
  if (!doc.isRotary) return null;

  // The export reads doc.rotary (falling back to the derived defaults), so read
  // exactly the same settings here — the ruler must not promise angles the post
  // won't emit.
  const settings = doc.rotary ?? defaultRotarySettings(doc);
  const circ = circumference(settings);
  if (!(circ > 1e-6)) return null;

  const wrapAxis = settings.wrapAxis;
  const wrapX = wrapAxis === "x";
  const span = wrapX ? doc.canvas.width : doc.canvas.height;
  const length = wrapX ? doc.canvas.height : doc.canvas.width;
  if (!(span > 0) || !(length > 0)) return null;

  const { ox, oy } = resolveOrigin(doc);
  const zeroCoordMM = wrapX ? ox : oy;

  const unit = doc.displayUnit;
  const len = (mm: number) => formatLengthWithUnit(mm, unit, unit === "in" ? 2 : 1);
  // A substituted axis (the laser case) posts no rotary word at all, so naming
  // one in the legend would be a lie — it says which linear axis carries the
  // surface millimetres instead. The degree ruler stays either way: the design
  // still runs 360° around the rod, which is what the ruler measures.
  const substituted = rotaryOutput(doc) === "linear-substitute";
  const axisLabel = substituted ? `${wrapAxis.toUpperCase()} (surface mm)` : settings.axisWord;
  const legend =
    `${axisLabel} ⟳ Ø${len(settings.diameter)} · ` +
    `360° = ${len(circ)} · length ${len(length)}`;

  const turns = span / circ;
  const warning =
    Math.abs(span - circ) > 0.01
      ? `canvas ${len(span)} ≠ one turn (${len(circ)}) — the design wraps ${turns.toFixed(2)}×`
      : null;

  return {
    wrapAxis,
    linearAxis: wrapX ? "y" : "x",
    axisWord: settings.axisWord,
    diameter: settings.diameter,
    circumference: circ,
    span,
    length,
    zeroCoordMM,
    seams: seamLines(wrapAxis, span, length),
    ticks: wrapTicks(span, circ, zeroCoordMM, pxPerMM),
    legend,
    warning,
  };
}

/** The two wrapped-axis extremes, as world-space segments spanning the length. */
function seamLines(wrapAxis: "x" | "y", span: number, length: number): { a: Vec2; b: Vec2 }[] {
  return [0, span].map((w) =>
    wrapAxis === "x"
      ? { a: { x: w, y: 0 }, b: { x: w, y: length } }
      : { a: { x: 0, y: w }, b: { x: length, y: w } },
  );
}

/**
 * Graduations across `[0, span]` at whole-degree steps measured from `zeroCoordMM`.
 * Density follows the zoom: the finest subdivision that stays ≥ MIN_MINOR_PX apart,
 * and quarter (or half) turns labelled once they are ≥ MIN_MAJOR_PX apart.
 */
export function wrapTicks(
  span: number,
  circ: number,
  zeroCoordMM: number,
  pxPerMM: number,
): RotaryTick[] {
  const pxPerDeg = (circ * Math.max(0, pxPerMM)) / 360;
  const majorDeg = MAJOR_STEPS_DEG.find((d) => d * pxPerDeg >= MIN_MAJOR_PX) ?? null;
  const minorDeg = MINOR_STEPS_DEG.find(
    (d) => d * pxPerDeg >= MIN_MINOR_PX && (majorDeg === null || d < majorDeg),
  );
  const step = minorDeg ?? majorDeg;
  if (step === null || step === undefined) return [];

  const mmPerDeg = circ / 360;
  const degAt = (coord: number) => (coord - zeroCoordMM) / mmPerDeg;
  const kFrom = Math.ceil(degAt(0) / step - 1e-9);
  const kTo = Math.floor(degAt(span) / step + 1e-9);
  if (kTo - kFrom + 1 > MAX_TICKS) return [];

  const ticks: RotaryTick[] = [];
  for (let k = kFrom; k <= kTo; k++) {
    const deg = k * step;
    ticks.push({
      coordMM: zeroCoordMM + deg * mmPerDeg,
      deg: deg === 0 ? 0 : deg, // normalise -0
      major: majorDeg !== null && deg % majorDeg === 0,
    });
  }
  return ticks;
}

/** Label for a graduation — signed degrees, matching the emitted rotary word. */
export function tickLabel(tick: RotaryTick): string {
  return `${tick.deg}°`;
}
