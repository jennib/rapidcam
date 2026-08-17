import { test, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CADDocument } from "../src/model/document";
import { CircleEntity, RectEntity, TextEntity } from "../src/model/entities";
import { textToContours } from "../src/cam/textOutlines";
import { loadFromFile } from "../src/core/fontManager";
import { generateGCode } from "../src/cam/gcode";
import {
  partitionOps,
  defaultPins,
  defaultFlipSettings,
  mirrorPoint,
  pinsSymmetric,
  stockBox,
  mirrorDocForFlip,
  validateFlip,
  generateFlipPrograms,
  flipSides,
  opFace,
} from "../src/cam/flip";
import { lintGCode, buildLintContext } from "../src/cam/lint";
import { serializeDoc, applyFile } from "../src/io/fileio";
import type { CAMOperation } from "../src/cam/types";

// A real font, loaded once, so text→contour tests exercise the glyph path.
let fontId: string;
beforeAll(async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const bytes = readFileSync(join(here, "..", "public", "fonts", "roboto-regular.woff"));
  const fakeFile = {
    name: "roboto.woff",
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as File;
  ({ id: fontId } = await loadFromFile(fakeFile));
});

// --- op builders -------------------------------------------------------------

function drillOp(id: string, entityIds: string[], face?: "top" | "bottom"): CAMOperation {
  return {
    id,
    name: `drill ${id}`,
    type: "drill",
    side: "inside",
    entityIds,
    face,
    toolType: "end-mill",
    toolNumber: 1,
    diameter: 6,
    feedrate: 1000,
    plungeRate: 300,
    spindleSpeed: 18000,
    safeZ: 5,
    depth: -12,
    stepdown: 3,
    stepover: 0.4,
  };
}

function profileOp(
  id: string,
  entityIds: string[],
  opts: Partial<CAMOperation> = {},
): CAMOperation {
  return {
    id,
    name: `profile ${id}`,
    type: "profile",
    side: "outside",
    entityIds,
    toolType: "end-mill",
    toolNumber: 1,
    diameter: 6,
    feedrate: 1000,
    plungeRate: 300,
    spindleSpeed: 18000,
    safeZ: 5,
    depth: -2,
    stepdown: 2,
    stepover: 0.4,
    ...opts,
  };
}

/** X/Y coordinates of every cut move (G1/G2/G3 carrying X and Y). */
function cutXY(code: string): { x: number; y: number }[] {
  return code
    .split("\n")
    .filter((l) => /^G[123] /.test(l) && /X/.test(l) && /Y/.test(l))
    .map((l) => ({
      x: parseFloat(l.match(/X(-?[\d.]+)/)![1]),
      y: parseFloat(l.match(/Y(-?[\d.]+)/)![1]),
    }));
}

// --- partition ---------------------------------------------------------------

test("partitionOps splits by face and preserves document order", () => {
  const ops = [
    drillOp("a", ["e1"], "top"),
    drillOp("b", ["e2"], "bottom"),
    drillOp("c", ["e3"]),
    drillOp("d", ["e4"], "bottom"),
  ];
  const { top, bottom } = partitionOps(ops);
  expect(top.map((o) => o.id)).toEqual(["a", "c"]); // undefined face = top
  expect(bottom.map((o) => o.id)).toEqual(["b", "d"]);
  expect(opFace(ops[2])).toBe("top");
});

// --- pin math ----------------------------------------------------------------

test("default pins sit on the flip-axis centreline and are symmetric", () => {
  const stock = { x: 0, y: 0, width: 200, height: 120 };
  const ph = defaultPins(stock, "h");
  expect(ph.every((p) => Math.abs(p.x - 100) < 1e-9)).toBe(true); // on the vertical centreline
  expect(pinsSymmetric(ph, "h", stock)).toBe(true);

  const pv = defaultPins(stock, "v");
  expect(pv.every((p) => Math.abs(p.y - 60) < 1e-9)).toBe(true); // on the horizontal centreline
  expect(pinsSymmetric(pv, "v", stock)).toBe(true);
});

test("mirrorPoint reflects about the correct axis", () => {
  const stock = { x: 0, y: 0, width: 200, height: 120 };
  expect(mirrorPoint({ x: 40, y: 30 }, "h", stock)).toEqual({ x: 160, y: 30 });
  expect(mirrorPoint({ x: 40, y: 30 }, "v", stock)).toEqual({ x: 40, y: 90 });
});

test("asymmetric pins are rejected; a mirror-image pair is accepted", () => {
  const stock = { x: 0, y: 0, width: 200, height: 120 };
  expect(pinsSymmetric([{ x: 40, y: 30 }], "h", stock)).toBe(false); // lone off-axis pin
  expect(
    pinsSymmetric(
      [
        { x: 40, y: 30 },
        { x: 160, y: 30 },
      ],
      "h",
      stock,
    ),
  ).toBe(true); // its mirror partner
});

// --- geometry mirroring ------------------------------------------------------

test("mirrorDocForFlip reflects entity geometry about the stock centreline", () => {
  const doc = new CADDocument({ width: 200, height: 120 });
  const c = doc.add(new CircleEntity({ x: 40, y: 60 }, 5)) as CircleEntity;
  const mDoc = mirrorDocForFlip(doc, "h");
  const mc = mDoc.entities.find((e) => e.id === c.id) as CircleEntity;
  expect(mc.center.x).toBeCloseTo(160, 6); // 200 - 40
  expect(mc.center.y).toBeCloseTo(60, 6);
  // The original document is untouched (we mirror a clone).
  expect((doc.entities.find((e) => e.id === c.id) as CircleEntity).center.x).toBe(40);
});

test("a blank OFFSET on its sheet mirrors about the blank, not the sheet", () => {
  // The case the old code got wrong. While New Project centred the blank, the
  // sheet's centreline and the blank's were the same point, so mirroring about
  // the sheet looked right; offset the blank and it is out by twice the offset.
  // A physical flip turns the MATERIAL over about its own centreline.
  const doc = new CADDocument({ width: 300, height: 250 });
  doc.stockRect = { x: 40, y: 30, width: 200, height: 150 };
  // A hole 20mm in from the blank's left edge.
  const c = doc.add(new CircleEntity({ x: 60, y: 105 }, 5)) as CircleEntity;

  const mDoc = mirrorDocForFlip(doc, "h");
  const mc = mDoc.entities.find((e) => e.id === c.id) as CircleEntity;

  // It must come back 20mm in from the blank's RIGHT edge: 40 + 200 - 20 = 220.
  expect(mc.center.x).toBeCloseTo(220, 6);
  expect(mc.center.y).toBeCloseTo(105, 6);
  // Mirroring about the sheet would have put it at 300 - 60 = 240 — 20mm past
  // the blank's right edge, i.e. cutting fresh air.
  expect(mc.center.x).not.toBeCloseTo(240, 6);
});

test("default pins land inside an offset blank, and stay symmetric about it", () => {
  const doc = new CADDocument({ width: 300, height: 250 });
  doc.stockRect = { x: 40, y: 30, width: 200, height: 150 };
  const stock = stockBox(doc);
  const pins = defaultPins(stock, "h");

  // On the BLANK's vertical centreline (40 + 100), not the sheet's (150).
  expect(pins.every((p) => Math.abs(p.x - 140) < 1e-9)).toBe(true);
  // And within the material, which is what validateFlip checks.
  for (const p of pins) {
    expect(p.x).toBeGreaterThanOrEqual(stock.x);
    expect(p.x).toBeLessThanOrEqual(stock.x + stock.width);
    expect(p.y).toBeGreaterThanOrEqual(stock.y);
    expect(p.y).toBeLessThanOrEqual(stock.y + stock.height);
  }
  expect(pinsSymmetric(pins, "h", stock)).toBe(true);
});

test("a bottom-face op is generated mirrored about the flip axis", () => {
  const doc = new CADDocument({ width: 200, height: 120 });
  const hole = doc.add(new CircleEntity({ x: 40, y: 60 }, 3));
  doc.operations = [drillOp("b", [hole.id], "bottom")];
  doc.flip = { axis: "h", registration: "none", pinDiameter: 6, pinDepth: 4, pins: [] };

  const { sideB } = generateFlipPrograms(doc);
  // The drilled point moves through rapid, but the plunge Z-feed is at the hole
  // centre; check the rapid position instead: the mirror puts X at 200-40 = 160.
  expect(sideB).toMatch(/X160\b/);
  expect(sideB).toMatch(/Y60\b/);
  expect(sideB).not.toMatch(/X40\b/);
});

test("mirroring preserves cut-move count for a profile (leads/tabs survive)", () => {
  const doc = new CADDocument({ width: 200, height: 120 });
  const r = doc.add(new RectEntity({ x: 20, y: 20 }, { x: 80, y: 100 }));
  const top = new CADDocument({ width: 200, height: 120 });
  const rt = top.add(new RectEntity({ x: 20, y: 20 }, { x: 80, y: 100 }));

  doc.operations = [profileOp("b", [r.id], { face: "bottom", cutDirection: "climb" })];
  doc.flip = { axis: "h", registration: "none", pinDiameter: 6, pinDepth: 4, pins: [] };
  const { sideB } = generateFlipPrograms(doc);

  top.operations = [profileOp("t", [rt.id], { cutDirection: "climb" })];
  const normal = generateGCode(top.operations, top);

  expect(cutXY(sideB).length).toBe(cutXY(normal).length);
});

// --- text mirroring ----------------------------------------------------------

test("textToContours reflects the finished contours when mirror is set (angle-correct)", () => {
  const t = new TextEntity("Rb", fontId, 12, { x: 40, y: 60 }, Math.PI / 6); // rotated 30°
  const plain = textToContours(t);
  expect(plain.length).toBeGreaterThan(0);
  const xs = plain.flatMap((c) => c.points.map((p) => p.x));

  t.mirror = { axis: "h", c: 100 };
  const mirrored = textToContours(t);
  const mxs = mirrored.flatMap((c) => c.points.map((p) => p.x));
  // Every point reflected about x=100 → the block's X range maps [a,b] → [200-b, 200-a].
  expect(mirrored.length).toBe(plain.length);
  expect(Math.min(...mxs)).toBeCloseTo(200 - Math.max(...xs), 4);
  expect(Math.max(...mxs)).toBeCloseTo(200 - Math.min(...xs), 4);
  // Y is untouched by a horizontal flip (proves it's a true world reflection, not a local one).
  const ys = plain.flatMap((c) => c.points.map((p) => p.y)).sort((a, b) => a - b);
  const mys = mirrored.flatMap((c) => c.points.map((p) => p.y)).sort((a, b) => a - b);
  expect(mys[0]).toBeCloseTo(ys[0], 4);
});

test("a bottom-face text engrave is mirrored into side B", () => {
  const doc = new CADDocument({ width: 200, height: 120 });
  const txt = doc.add(new TextEntity("Fb", fontId, 12, { x: 30, y: 55 }, 0));
  doc.operations = [
    {
      id: "e",
      name: "engrave",
      type: "engrave",
      side: "outside",
      entityIds: [txt.id],
      face: "bottom",
      toolType: "v-bit",
      toolNumber: 1,
      diameter: 6,
      vAngle: 60,
      feedrate: 1000,
      plungeRate: 300,
      spindleSpeed: 18000,
      safeZ: 5,
      depth: -1,
      stepdown: 1,
      stepover: 0.4,
    },
  ];
  doc.flip = { axis: "h", registration: "none", pinDiameter: 6, pinDepth: 4, pins: [] };

  const { sideB } = generateFlipPrograms(doc);
  const xs = cutXY(sideB).map((p) => p.x);
  expect(xs.length).toBeGreaterThan(0);
  // Text drawn near x=30 (left of centre) engraves near x=170 on side B (right of centre).
  expect(Math.min(...xs)).toBeGreaterThan(100);
  // validateFlip no longer warns about bottom-face text.
  expect(generateFlipPrograms(doc).warnings.some((w) => /text/i.test(w))).toBe(false);
});

// --- flipSides (shared by export + 3D preview) -------------------------------

test("flipSides splits ops by face for per-side preview (bottom ops off side A)", () => {
  const doc = new CADDocument({ width: 200, height: 120 });
  const r = doc.add(new RectEntity({ x: 20, y: 20 }, { x: 180, y: 100 }));
  const hole = doc.add(new CircleEntity({ x: 40, y: 60 }, 3));
  doc.operations = [profileOp("t", [r.id]), drillOp("b", [hole.id], "bottom")];
  doc.flip = {
    axis: "h",
    registration: "pins",
    pinDiameter: 8,
    pinDepth: 4,
    pins: defaultPins(stockBox(doc), "h"),
  };

  const { sideA, sideB, hasPins } = flipSides(doc);
  expect(hasPins).toBe(true);
  // Side A carries the top op + the pin-bore op — NOT the bottom op (which would
  // otherwise carve onto the top face in the 3D preview).
  expect(sideA.ops.some((o) => o.id === "b")).toBe(false);
  expect(sideA.ops.some((o) => o.name.includes("Registration pin holes"))).toBe(true);
  // Side B carries only the bottom op, in a mirrored document (hole at 200-40=160).
  expect(sideB).not.toBeNull();
  expect(sideB!.ops.map((o) => o.id)).toEqual(["b"]);
  const mHole = sideB!.doc.entities.find((e) => e.id === hole.id) as CircleEntity;
  expect(mHole.center.x).toBeCloseTo(160, 6);

  // No bottom ops → no side B.
  const single = new CADDocument({ width: 200, height: 120 });
  const rs = single.add(new RectEntity({ x: 20, y: 20 }, { x: 80, y: 100 }));
  single.operations = [profileOp("t", [rs.id])];
  single.flip = defaultFlipSettings(single);
  expect(flipSides(single).sideB).toBeNull();
});

// --- registration bore -------------------------------------------------------

test("side A ends with pin bores reaching stockThickness + pinDepth below the top", () => {
  const doc = new CADDocument({ width: 200, height: 120 });
  doc.stockThickness = 10;
  const r = doc.add(new RectEntity({ x: 20, y: 20 }, { x: 180, y: 100 }));
  doc.operations = [profileOp("t", [r.id])];
  doc.flip = {
    axis: "h",
    registration: "pins",
    pinDiameter: 8,
    pinDepth: 4,
    pins: defaultPins(stockBox(doc), "h"),
  };

  const { sideA, hasPins } = generateFlipPrograms(doc);
  expect(hasPins).toBe(true);
  // pinDiameter 8 > tool 6 → helically bored; depth = -(10 + 4) = -14.
  expect(sideA).toMatch(/Registration pin holes/);
  expect(sideA).toMatch(/Z-14\b/);
  // Bores at both centreline pins: their exact Y values (15 and height-15=105)
  // appear on the entry rapids (the tool circles the centre in X).
  expect(sideA).toMatch(/Y15\b/);
  expect(sideA).toMatch(/Y105\b/);
});

test("side A with registration=none is just the top program (plus banner)", () => {
  const doc = new CADDocument({ width: 200, height: 120 });
  const r = doc.add(new RectEntity({ x: 20, y: 20 }, { x: 80, y: 100 }));
  doc.operations = [profileOp("t", [r.id])];
  const plain = new CADDocument({ width: 200, height: 120 });
  const rp = plain.add(new RectEntity({ x: 20, y: 20 }, { x: 80, y: 100 }));
  plain.operations = [profileOp("t", [rp.id])];

  doc.flip = { axis: "h", registration: "none", pinDiameter: 6, pinDepth: 4, pins: [] };
  const { sideA } = generateFlipPrograms(doc);
  const withoutBanner = sideA
    .split("\n")
    .filter(
      (l) =>
        !l.startsWith("; ===") &&
        !l.startsWith("; Cut this") &&
        !l.startsWith("; Stock thickness") &&
        !l.startsWith("; This program"),
    )
    .join("\n")
    .trimStart();
  expect(withoutBanner).toBe(generateGCode(plain.operations, plain));
});

// --- lint --------------------------------------------------------------------

test("side B is in bounds; registration bores don't trip over-deep with the pin allowance", () => {
  const doc = new CADDocument({ width: 200, height: 120 });
  doc.stockThickness = 10;
  const hole = doc.add(new CircleEntity({ x: 40, y: 60 }, 3));
  const r = doc.add(new RectEntity({ x: 20, y: 20 }, { x: 180, y: 100 }));
  doc.operations = [profileOp("t", [r.id]), drillOp("b", [hole.id], "bottom")];
  doc.flip = {
    axis: "h",
    registration: "pins",
    pinDiameter: 6,
    pinDepth: 4,
    pins: defaultPins(stockBox(doc), "h"),
  };

  const { sideA, sideB } = generateFlipPrograms(doc);
  // Side B fits the (symmetric) stock envelope.
  expect(lintGCode(sideB, buildLintContext(doc)).some((f) => f.code === "out-of-bounds")).toBe(
    false,
  );
  // Side A bores 4mm into the spoilboard: over-deep without the allowance, clean with it.
  expect(lintGCode(sideA, buildLintContext(doc)).some((f) => f.code === "over-deep")).toBe(true);
  expect(
    lintGCode(sideA, buildLintContext(doc, { extraDepthBelowBottom: 4 })).some(
      (f) => f.code === "over-deep",
    ),
  ).toBe(false);
});

// --- validation --------------------------------------------------------------

test("validateFlip flags asymmetric pins, bottom text-free through-cuts, and empty bottom", () => {
  // Asymmetric pins.
  const d1 = new CADDocument({ width: 200, height: 120 });
  const h1 = d1.add(new CircleEntity({ x: 40, y: 60 }, 3));
  d1.operations = [drillOp("b", [h1.id], "bottom")];
  d1.flip = {
    axis: "h",
    registration: "pins",
    pinDiameter: 6,
    pinDepth: 4,
    pins: [{ x: 40, y: 30 }],
  };
  expect(validateFlip(d1).some((w) => /not symmetric/.test(w))).toBe(true);

  // No bottom ops at all.
  const d2 = new CADDocument({ width: 200, height: 120 });
  const r2 = d2.add(new RectEntity({ x: 20, y: 20 }, { x: 80, y: 100 }));
  d2.operations = [profileOp("t", [r2.id])];
  d2.flip = defaultFlipSettings(d2);
  expect(validateFlip(d2).some((w) => /bottom face/.test(w))).toBe(true);

  // Top-side through-cut with no tabs, plus a bottom op → part frees before flip.
  const d3 = new CADDocument({ width: 200, height: 120 });
  d3.stockThickness = 5;
  const rt = d3.add(new RectEntity({ x: 20, y: 20 }, { x: 80, y: 100 }));
  const hb = d3.add(new CircleEntity({ x: 100, y: 60 }, 3));
  d3.operations = [profileOp("t", [rt.id], { depth: -6 }), drillOp("b", [hb.id], "bottom")];
  d3.flip = defaultFlipSettings(d3);
  expect(validateFlip(d3).some((w) => /comes loose|holding tabs/.test(w))).toBe(true);
});

test("validateFlip guards the pin-bore tool: non-flat bit and too-small pin", () => {
  // Last top op uses a V-bit → pins can't be bored cleanly.
  const d1 = new CADDocument({ width: 200, height: 120 });
  const r1 = d1.add(new RectEntity({ x: 20, y: 20 }, { x: 80, y: 100 }));
  const hb1 = d1.add(new CircleEntity({ x: 100, y: 60 }, 3));
  d1.operations = [
    profileOp("t", [r1.id], { toolType: "v-bit", vAngle: 60 }),
    drillOp("b", [hb1.id], "bottom"),
  ];
  d1.flip = {
    axis: "h",
    registration: "pins",
    pinDiameter: 6,
    pinDepth: 4,
    pins: defaultPins(stockBox(d1), "h"),
  };
  expect(validateFlip(d1).some((w) => /can't cut a clean straight hole|v-bit/.test(w))).toBe(true);

  // Same guard for a tapered ball-nose: its tip is a ball, so pins come out ragged.
  // Drop "tapered-ball-nose" from flip.ts and this branch stops firing.
  const dT = new CADDocument({ width: 200, height: 120 });
  const rT = dT.add(new RectEntity({ x: 20, y: 20 }, { x: 80, y: 100 }));
  const hbT = dT.add(new CircleEntity({ x: 100, y: 60 }, 3));
  dT.operations = [
    profileOp("t", [rT.id], { toolType: "tapered-ball-nose", vAngle: 6, tipDiameter: 1 }),
    drillOp("b", [hbT.id], "bottom"),
  ];
  dT.flip = {
    axis: "h",
    registration: "pins",
    pinDiameter: 6,
    pinDepth: 4,
    pins: defaultPins(stockBox(dT), "h"),
  };
  expect(validateFlip(dT).some((w) => /tapered-ball-nose/.test(w))).toBe(true);

  // Pin narrower than the boring tool → hole comes out tool-sized (loose).
  const d2 = new CADDocument({ width: 200, height: 120 });
  const r2 = d2.add(new RectEntity({ x: 20, y: 20 }, { x: 80, y: 100 }));
  const hb2 = d2.add(new CircleEntity({ x: 100, y: 60 }, 3));
  d2.operations = [profileOp("t", [r2.id]), drillOp("b", [hb2.id], "bottom")]; // tool ⌀6
  d2.flip = {
    axis: "h",
    registration: "pins",
    pinDiameter: 4,
    pinDepth: 4,
    pins: defaultPins(stockBox(d2), "h"),
  };
  expect(validateFlip(d2).some((w) => /smaller than the boring tool|too loose/.test(w))).toBe(true);

  // A flat end mill with a pin at least the tool diameter → neither guard fires.
  const d3 = new CADDocument({ width: 200, height: 120 });
  const r3 = d3.add(new RectEntity({ x: 20, y: 20 }, { x: 180, y: 100 }));
  const hb3 = d3.add(new CircleEntity({ x: 100, y: 60 }, 3));
  d3.operations = [profileOp("t", [r3.id]), drillOp("b", [hb3.id], "bottom")];
  d3.flip = {
    axis: "h",
    registration: "pins",
    pinDiameter: 8,
    pinDepth: 4,
    pins: defaultPins(stockBox(d3), "h"),
  };
  const w3 = validateFlip(d3);
  expect(w3.some((w) => /boring tool|straight hole/.test(w))).toBe(false);
});

// --- persistence -------------------------------------------------------------

test("flip settings + op face round-trip through serialize/apply and omit when null", () => {
  const doc = new CADDocument({ width: 200, height: 120 });
  const r = doc.add(new RectEntity({ x: 20, y: 20 }, { x: 80, y: 100 }));
  doc.operations = [profileOp("t", [r.id], { face: "bottom" })];
  doc.flip = {
    axis: "v",
    registration: "pins",
    pinDiameter: 6,
    pinDepth: 3,
    pins: [
      { x: 30, y: 60 },
      { x: 170, y: 60 },
    ],
  };

  const file = serializeDoc(doc, "flip-doc");
  expect(file.flip).toEqual(doc.flip);

  const loaded = new CADDocument({ width: 10, height: 10 });
  applyFile(loaded, file);
  expect(loaded.flip).toEqual(doc.flip);
  expect(loaded.operations[0].face).toBe("bottom");

  // A single-sided doc omits `flip` entirely.
  const plain = new CADDocument({ width: 100, height: 100 });
  expect(serializeDoc(plain, "plain").flip).toBeUndefined();
});

test("a document without flip generates identical G-code (no regression)", () => {
  const a = new CADDocument({ width: 200, height: 120 });
  const ra = a.add(new RectEntity({ x: 20, y: 20 }, { x: 80, y: 100 }));
  a.operations = [profileOp("t", [ra.id], { face: "bottom" })]; // face present but flip null → ignored

  const b = new CADDocument({ width: 200, height: 120 });
  const rb = b.add(new RectEntity({ x: 20, y: 20 }, { x: 80, y: 100 }));
  b.operations = [profileOp("t", [rb.id])];

  expect(generateGCode(a.operations, a)).toBe(generateGCode(b.operations, b));
});
