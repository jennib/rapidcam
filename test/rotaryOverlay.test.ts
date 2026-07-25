import { expect, test } from "vitest";
import { circumference, defaultRotarySettings, wrapAngleDeg } from "../src/cam/klein";
import { CADDocument, resolveOrigin, type RotarySettings } from "../src/model/document";
import { rotaryWrapHint, tickLabel } from "../src/view/rotaryOverlay";

// A cylinder whose circumference is exactly 360mm, so 1mm of surface = 1° — the
// same trick klein.test.ts uses to keep wrap assertions readable.
const UNIT: RotarySettings = { axisWord: "A", diameter: 360 / Math.PI, wrapAxis: "y" };

/** A rotary doc obeying the diameter↔canvas lock: canvas[wrapped] === π·D. */
function rotaryDoc(settings: RotarySettings = UNIT, length = 150): CADDocument {
  const circ = circumference(settings);
  const doc =
    settings.wrapAxis === "x"
      ? new CADDocument({ width: circ, height: length })
      : new CADDocument({ width: length, height: circ });
  doc.machineKind = "mill-rotary";
  doc.rotary = { ...settings };
  return doc;
}

test("no hint for a document that isn't on the rotary", () => {
  const doc = rotaryDoc();
  doc.machineKind = "mill";
  expect(rotaryWrapHint(doc, 3)).toBeNull();
  doc.machineKind = "laser";
  expect(rotaryWrapHint(doc, 3)).toBeNull();
});

test("wrapped axis, length and seams come off the canvas (wrapAxis y)", () => {
  const hint = rotaryWrapHint(rotaryDoc(), 3)!;
  expect(hint.wrapAxis).toBe("y");
  expect(hint.linearAxis).toBe("x");
  expect(hint.span).toBeCloseTo(360, 6); // one full turn of surface
  expect(hint.length).toBe(150);
  expect(hint.circumference).toBeCloseTo(360, 6);
  expect(hint.warning).toBeNull();
  // Both wrapped extremes are the same line on the rod — each spans the length.
  expect(hint.seams).toEqual([
    { a: { x: 0, y: 0 }, b: { x: 150, y: 0 } },
    { a: { x: 0, y: 360 }, b: { x: 150, y: 360 } },
  ]);
});

test("wrapAxis x swaps which canvas dimension is the wrap and which is the length", () => {
  const hint = rotaryWrapHint(rotaryDoc({ ...UNIT, wrapAxis: "x" }), 3)!;
  expect(hint.wrapAxis).toBe("x");
  expect(hint.linearAxis).toBe("y");
  expect(hint.span).toBeCloseTo(360, 6);
  expect(hint.length).toBe(150);
  expect(hint.seams).toEqual([
    { a: { x: 0, y: 0 }, b: { x: 0, y: 150 } },
    { a: { x: 360, y: 0 }, b: { x: 360, y: 150 } },
  ]);
});

test("graduations run 0…360° from the canvas edge when the origin is at the front", () => {
  const doc = rotaryDoc();
  expect(resolveOrigin(doc).oy).toBe(0);
  const hint = rotaryWrapHint(doc, 3)!;
  expect(hint.zeroCoordMM).toBe(0);
  const majors = hint.ticks.filter((t) => t.major);
  expect(majors.map((t) => t.deg)).toEqual([0, 90, 180, 270, 360]);
  // 1mm of surface = 1° on this cylinder, so the ruler is a straight copy.
  expect(majors.map((t) => t.coordMM)).toEqual([0, 90, 180, 270, 360]);
  expect(tickLabel(majors[1])).toBe("90°");
});

test("A0 follows the WORK ORIGIN, not the canvas edge — a centred origin reads −180…+180°", () => {
  const doc = rotaryDoc();
  doc.origin = { x: "left", y: "center", z: "top" };
  const hint = rotaryWrapHint(doc, 3)!;
  expect(hint.zeroCoordMM).toBeCloseTo(180, 6); // mid-canvas
  const majors = hint.ticks.filter((t) => t.major);
  expect(majors.map((t) => t.deg)).toEqual([-180, -90, 0, 90, 180]);
  expect(tickLabel(majors[0])).toBe("-180°");
  // The 0° graduation sits on the origin, halfway up the canvas.
  expect(majors[2].coordMM).toBeCloseTo(180, 6);
});

test("every graduation matches the angle the post would emit there", () => {
  for (const origin of ["front", "center", "back"] as const) {
    const doc = rotaryDoc();
    doc.origin = { x: "left", y: origin, z: "top" };
    const { oy } = resolveOrigin(doc);
    const hint = rotaryWrapHint(doc, 3)!;
    expect(hint.ticks.length).toBeGreaterThan(0);
    for (const t of hint.ticks) {
      // wrapGCode wraps the finished (origin-shifted) program, so this is the
      // exact same arithmetic the emitted A word goes through.
      expect(wrapAngleDeg(t.coordMM - oy, doc.rotary!)).toBeCloseTo(t.deg, 6);
    }
  }
});

test("graduation density follows the zoom, and gives up rather than smearing", () => {
  const doc = rotaryDoc();
  const degs = (px: number) => rotaryWrapHint(doc, px)!.ticks.map((t) => t.deg);

  // Zoomed in: quarter turns labelled, 5° subdivisions.
  const fine = degs(3);
  expect(fine.filter((d) => d % 90 === 0)).toEqual([0, 90, 180, 270, 360]);
  expect(fine).toContain(5);

  // Zoomed out: quarter turns no longer fit, so halves are labelled and the
  // subdivisions coarsen to 30°.
  const coarse = rotaryWrapHint(doc, 0.3)!.ticks;
  expect(coarse.filter((t) => t.major).map((t) => t.deg)).toEqual([0, 180, 360]);
  expect(coarse.map((t) => t.deg)).toContain(30);
  expect(coarse.map((t) => t.deg)).not.toContain(15);

  // Zoomed far out: nothing readable, so draw no ruler at all.
  expect(degs(0.1)).toEqual([]);
});

test("a canvas that isn't one full turn is called out (the diameter↔canvas lock is broken)", () => {
  const doc = rotaryDoc();
  doc.canvas.height = 540; // 1.5 turns
  const hint = rotaryWrapHint(doc, 3)!;
  expect(hint.span).toBe(540);
  expect(hint.warning).toMatch(/1\.50×/);
  // The ruler keeps telling the truth: it runs past 360° into the second turn.
  expect(hint.ticks.filter((t) => t.major).map((t) => t.deg)).toEqual([
    0, 90, 180, 270, 360, 450, 540,
  ]);
});

test("legend reads out the cylinder in the document's display unit", () => {
  const doc = rotaryDoc({ axisWord: "B", diameter: 50, wrapAxis: "y" }, 100);
  expect(rotaryWrapHint(doc, 3)!.legend).toBe("B ⟳ Ø50.0 mm · 360° = 157.1 mm · length 100.0 mm");
  doc.displayUnit = "in";
  expect(rotaryWrapHint(doc, 3)!.legend).toBe("B ⟳ Ø1.97 in · 360° = 6.18 in · length 3.94 in");
});

test("falls back to the derived settings when the doc carries no rotary block", () => {
  const doc = rotaryDoc();
  doc.rotary = null;
  const hint = rotaryWrapHint(doc, 3)!;
  // Same settings the export would fall back to — the ruler can't promise angles
  // generateRotaryProgram wouldn't emit.
  expect(hint.diameter).toBe(defaultRotarySettings(doc).diameter);
  expect(hint.axisWord).toBe("A");
  expect(hint.ticks.length).toBeGreaterThan(0);
});
