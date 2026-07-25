/**
 * Programmatic builder for the tumbler-wrap example (laser on a rotary).
 *
 * Built rather than hand-authored for two reasons: the canvas height must be
 * exactly π·diameter (the diameter↔canvas lock), and the lettering is centred
 * against the REAL font metrics rather than a guess — so the shipped file is
 * correct by construction instead of by eyeballing.
 *
 * Run:  npx tsx scripts/build-tumbler-wrap.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CAMOperation } from "../src/cam/types";
import { initBundledFonts } from "../src/core/fontManager";
import { serializeDoc } from "../src/io/fileio";
import { makeConstraint } from "../src/model/constraints";
import { CADDocument } from "../src/model/document";
import { LineEntity, TextEntity } from "../src/model/entities";

// The bundled fonts load over fetch() in the browser; serve them off disk here
// so the text measures with the same glyphs the app uses. They keep their
// bundled ids, so the example references the font rather than embedding it.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith("/fonts/")) {
    const buf = readFileSync(join(process.cwd(), "public", url));
    return new Response(new Uint8Array(buf));
  }
  return realFetch(input, init);
}) as typeof fetch;
await initBundledFonts();

// --- the cylinder -----------------------------------------------------------
const DIAMETER = 80; // mm — a 20oz-ish tumbler
const CIRC = Math.PI * DIAMETER; // 251.327mm of surface = one full revolution
const LENGTH = 120; // mm of engravable height, along the rotary axis

// The canvas IS the unrolled surface: X runs along the tumbler's axis, Y wraps
// around it, and the wrapped span must equal the circumference exactly.
const doc = new CADDocument({ width: LENGTH, height: CIRC }, "mm");
doc.machineKind = "laser-rotary";
doc.rotary = { axisWord: "A", diameter: DIAMETER, wrapAxis: "y" };
doc.postProcessor = "grbl-dynamic";
doc.stockThickness = 1.2; // the tumbler wall; a beam emits no Z, so it's informational

// --- geometry ---------------------------------------------------------------
// A line spanning the FULL wrapped extent closes on itself once the sheet is
// rolled up: these two are rings around the tumbler, bounding the engrave band.
const RING_A = 25;
const RING_B = 95;
const rings = [RING_A, RING_B].map((x) =>
  doc.add(new LineEntity({ x, y: 0 }, { x, y: CIRC })),
);

// Twelve ticks every 30° of rotation, hanging off the lower ring. Spacing is
// circumference ÷ 12, which is what "every 30°" means on the unrolled surface.
// There is no tick at y = CIRC: that is the same line on the rod as y = 0.
const TICKS = 12;
const ticks = Array.from({ length: TICKS }, (_, k) => {
  const y = (k * CIRC) / TICKS;
  return doc.add(new LineEntity({ x: RING_A, y }, { x: RING_A + 6, y }));
});

// The name reads AROUND the tumbler, so its baseline runs along the wrapped
// axis — a quarter turn CCW from the usual left-to-right. (Artwork for a rotary
// job is rotated like this whenever you want it to read around the part.)
const name = doc.add(
  new TextEntity("RAPIDCAM", "roboto-bold", 18, { x: 0, y: 0 }, Math.PI / 2),
);
// Centre it in the band using the real ink box, both along the axis and around
// the circumference.
const b = name.bounds();
name.translate({
  x: (RING_A + RING_B) / 2 - (b.min.x + b.max.x) / 2,
  y: CIRC / 2 - (b.min.y + b.max.y) / 2,
});

// Everything sits at a deliberate axial/angular position, so the layout is
// fixed rather than under-defined. One `fixed` constraint can hold them all.
doc.addConstraint(
  makeConstraint("fixed", { entities: [...rings, ...ticks, name].map((e) => e.id) }),
);

// --- toolpaths --------------------------------------------------------------
const beam = {
  side: "outside" as const,
  toolType: "end-mill" as const,
  toolNumber: 1,
  diameter: 0.2, // beam kerf
  plungeRate: 300,
  spindleSpeed: 0,
  safeZ: 5,
  depth: -1,
  stepdown: 1,
  stepover: 0.4,
  laserPasses: 1,
};
const ops: CAMOperation[] = [
  {
    id: "op1",
    name: "Engrave rings",
    type: "engrave",
    entityIds: rings.map((e) => e.id),
    feedrate: 1500,
    laserPower: 40,
    ...beam,
  },
  {
    id: "op2",
    name: "Engrave 30° ticks",
    type: "engrave",
    entityIds: ticks.map((e) => e.id),
    feedrate: 1500,
    laserPower: 40,
    ...beam,
  },
  {
    id: "op3",
    name: "Fill-engrave name",
    type: "engrave",
    entityIds: [name.id],
    feedrate: 2000,
    laserPower: 65,
    laserFill: true,
    laserFillSpacing: 0.2,
    laserOverscan: 2,
    ...beam,
  },
];
doc.operations.push(...ops);

const out = join("examples", "tumbler-wrap.rcam");
writeFileSync(out, `${JSON.stringify(serializeDoc(doc, "Tumbler Wrap"), null, 2)}\n`);
console.log(
  `wrote ${out}: ⌀${DIAMETER} × ${LENGTH}mm, canvas ${LENGTH} × ${CIRC.toFixed(3)}mm, ` +
    `${doc.entities.length - 1} entities, ${ops.length} ops`,
);
