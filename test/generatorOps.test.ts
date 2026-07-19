/**
 * Generator-suggested CAM ops: a generator's declared CAM intent (profile /
 * pocket / depths / corner relief) becomes real operations at insert time,
 * machine-kind aware, with pocket regions seeded against the live document.
 */
import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { generateGCode } from "../src/cam/gcode";
import { GENERATORS, regenerateFeature, runGenerator } from "../src/generators/index";
import { sketchPreviews } from "../src/generators/preview";
import { Sketch } from "../src/generators/sketch";
import { gear } from "../src/generators/gear";

test("box insert with createOps produces a through profile op and a groove pocket op", () => {
  const doc = new CADDocument({ width: 500, height: 500 });
  const t = 8;
  const res = runGenerator(doc, GENERATORS["finger-box"], { thickness: t }, { createOps: true });

  expect(res.operations).toHaveLength(2);
  expect(doc.operations).toHaveLength(2);

  const [profile, pocket] = res.operations;
  // Walls + bottom: through cut at exactly -stockThickness (the "⊥ stock"
  // convention), dog-boned so fingers seat.
  expect(profile.type).toBe("profile");
  expect(profile.side).toBe("outside");
  expect(profile.entityIds).toHaveLength(5);
  expect(profile.depth).toBe(-doc.stockThickness);
  expect(profile.cornerStyle).toBe("dogbone");
  expect(profile.diameter).toBe(6); // default slot (40/3 ≈ 13.3mm) fits the 6mm tool

  // Grooves: pocket at half the material thickness (t/2, NOT the DEFAULTS
  // depth), with parametric regions seeded inside each groove rect.
  expect(pocket.type).toBe("pocket");
  expect(pocket.entityIds).toHaveLength(4);
  expect(pocket.depth).toBe(-t / 2);
  expect(pocket.cornerStyle).toBe("dogbone");
  expect(pocket.diameter).toBe(t / 2); // clamped: a 6mm tool can't enter a t-wide groove
  expect(pocket.regions).toHaveLength(4);
  for (const ref of pocket.regions!) {
    expect(ref.containingLoops.length).toBeGreaterThan(0);
  }
});

test("no ops are created when createOps is absent, and never on regenerate", () => {
  const doc = new CADDocument({ width: 500, height: 500 });
  const res = runGenerator(doc, GENERATORS["finger-box"], {});
  expect(res.operations).toHaveLength(0);
  expect(doc.operations).toHaveLength(0);

  const again = regenerateFeature(doc, res.feature.id, { thickness: 5 });
  expect(again!.operations).toHaveLength(0);
  expect(doc.operations).toHaveLength(0);
});

test("laser documents get beam profile ops and skip pocket suggestions", () => {
  const doc = new CADDocument({ width: 500, height: 500 });
  doc.machineKind = "laser";
  const res = runGenerator(doc, GENERATORS["finger-box"], {}, { createOps: true });

  // Pocket suggestion dropped; only the panel profile survives, as a beam cut.
  expect(res.operations).toHaveLength(1);
  const op = res.operations[0];
  expect(op.type).toBe("profile");
  expect(op.diameter).toBe(0);
  expect(op.spindleSpeed).toBe(0);
  expect(op.laserPower).toBeGreaterThan(0);
  expect(op.laserPasses).toBe(1);
});

test("gear suggests body profile (no corner relief) and a clamped-tool bore", () => {
  const doc = new CADDocument({ width: 300, height: 300 });
  const res = runGenerator(
    doc,
    GENERATORS["spur-gear"],
    { teeth: 16, module: 2, bore: 6 },
    { createOps: true },
  );

  expect(res.operations).toHaveLength(2);
  const [body, bore] = res.operations;
  expect(body.side).toBe("outside");
  expect(body.cornerStyle).toBeUndefined(); // dog-boning involute roots would gouge
  expect(bore.side).toBe("inside");
  expect(bore.diameter).toBe(3); // min(6, bore/2): default tool can't fit the bore
  expect(bore.entityIds).toHaveLength(1);

  const noBore = runGenerator(
    new CADDocument({ width: 300, height: 300 }),
    GENERATORS["spur-gear"],
    { teeth: 16, module: 2, bore: 0 },
    { createOps: true },
  );
  expect(noBore.operations).toHaveLength(1);
});

test("suggested box ops post to G-code with real cutting moves", () => {
  const doc = new CADDocument({ width: 500, height: 500 });
  runGenerator(doc, GENERATORS["finger-box"], {}, { createOps: true });
  const gcode = generateGCode(doc.operations, doc);

  // Both ops emit actual feed moves at their target depths: the profile at
  // -stockThickness, the groove pocket at -t/2 (t=6 default → -3) — not just
  // headers or "skipped" notes. (The post trims trailing zeros: "Z-10".)
  expect(gcode).toContain("G1");
  expect(gcode).toMatch(/Z-10\b/);
  expect(gcode).toMatch(/Z-3\b/);
  expect(gcode).not.toMatch(/skipped/i);
});

test("sketchPreviews maps probe entities to offset overlay shapes", () => {
  const s = new Sketch({ params: { teeth: 12, module: 2, bore: 6 } });
  gear.build(s);
  const shapes = sketchPreviews(s, { x: 100, y: 50 });

  expect(shapes).toHaveLength(2); // body polyline + bore circle
  const [body, bore] = shapes;
  expect(body.kind).toBe("polyline");
  if (body.kind === "polyline") {
    expect(body.closed).toBe(true);
    // Offset applied arithmetically; the probe's own entities stay untranslated.
    const first = (s.entities[0] as import("../src/model/entities").PolylineEntity).points[0];
    expect(body.points[0]).toEqual({ x: first.x + 100, y: first.y + 50 });
  }
  expect(bore.kind).toBe("circle");
  if (bore.kind === "circle") {
    expect(bore.center).toEqual({ x: 100, y: 50 });
    expect(bore.radius).toBeCloseTo(3);
  }
});

test("suggested tools are clamped to enter slots and tooth spaces, and still post", () => {
  // boxJoint at 25 fingers: slot = 120/25 = 4.8mm < the default 6mm tool.
  const doc = new CADDocument({ width: 400, height: 400 });
  const bj = runGenerator(doc, GENERATORS["box-joint"], { fingers: 25 }, { createOps: true });
  expect(bj.operations[0].diameter).toBeCloseTo(4.8, 6);
  const bjCode = generateGCode(doc.operations, doc);
  expect(bjCode).toContain("G1");
  expect(bjCode).not.toMatch(/skipped/i);

  // Default 20T/m2 gear: root gap ≈ 2.23mm — the 6mm default could never cut
  // between the teeth (the bug class the groove pocket already exposed).
  const gdoc = new CADDocument({ width: 300, height: 300 });
  const g = runGenerator(gdoc, GENERATORS["spur-gear"], {}, { createOps: true });
  expect(g.operations[0].diameter).toBeGreaterThan(2);
  expect(g.operations[0].diameter).toBeLessThan(2.5);
  const gCode = generateGCode(gdoc.operations, gdoc);
  expect(gCode).toContain("G1");
  expect(gCode).not.toMatch(/skipped/i);
});

test("suggested ops keep cutting the right geometry across a param regen", () => {
  const doc = new CADDocument({ width: 500, height: 500 });
  const res = runGenerator(doc, GENERATORS["finger-box"], {}, { createOps: true });
  const profileIds = [...doc.operations[0].entityIds];
  const pocketIds = [...doc.operations[1].entityIds];

  regenerateFeature(doc, res.feature.id, { thickness: 5, height: 50 });

  // Id-stable regen: the ops still reference live entities, unchanged.
  expect(doc.operations[0].entityIds).toEqual(profileIds);
  expect(doc.operations[1].entityIds).toEqual(pocketIds);
  const live = new Set(doc.entities.map((e) => e.id));
  for (const id of [...profileIds, ...pocketIds]) expect(live.has(id)).toBe(true);
});

test("box insert: the through outside profile gets auto hold-down tabs, the groove pocket does not", () => {
  const doc = new CADDocument({ width: 500, height: 500 });
  const res = runGenerator(doc, GENERATORS["finger-box"], { thickness: 8 }, { createOps: true });

  const [profile, pocket] = res.operations;
  expect(profile.tabs?.enabled).toBe(true);
  expect(profile.tabs?.strategy).toBe("spacing");
  expect(profile.tabs?.height).toBe(Math.min(2, doc.stockThickness / 2));
  expect(pocket.tabs).toBeUndefined();
});

test("gear insert: body profile gets tabs, the inside bore does not; small tool derates feed/stepdown", () => {
  const doc = new CADDocument({ width: 300, height: 300 });
  const res = runGenerator(doc, GENERATORS["spur-gear"], {}, { createOps: true });

  const [body, bore] = res.operations;
  expect(body.side).toBe("outside");
  expect(body.tabs?.enabled).toBe(true);
  expect(body.tabs?.strategy).toBe("spacing");
  expect(bore.side).toBe("inside");
  expect(bore.tabs).toBeUndefined();

  // Default 20T/m2 gear clamps the body tool to the root gap, ~2.227mm — well
  // under DEFAULTS.diameter (6), so small-tool derating kicks in.
  expect(body.diameter).toBeGreaterThan(2);
  expect(body.diameter).toBeLessThan(2.5);
  expect(body.stepdown).toBeCloseTo(0.5 * body.diameter, 2);
  expect(body.feedrate).toBe(400); // max(0.4, 2.227/6) === 0.4 floor
  expect(body.plungeRate).toBe(120);
});

test("boxJoint insert with default fingers keeps the default tool size, so no small-tool derating applies", () => {
  const doc = new CADDocument({ width: 400, height: 400 });
  const res = runGenerator(doc, GENERATORS["box-joint"], {}, { createOps: true });

  const op = res.operations[0];
  expect(op.diameter).toBe(6); // default tool fits the default finger slot
  expect(op.feedrate).toBe(1000);
  expect(op.stepdown).toBe(1.5);
});

test("laser box insert: the beam profile op has no tabs and an untouched feedrate", () => {
  const doc = new CADDocument({ width: 500, height: 500 });
  doc.machineKind = "laser";
  const res = runGenerator(doc, GENERATORS["finger-box"], {}, { createOps: true });

  const op = res.operations[0];
  expect(op.tabs).toBeUndefined();
  expect(op.feedrate).toBe(1000);
});
