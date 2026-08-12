/**
 * Kumiko asanoha generator.
 *
 * The load-bearing assertion here is the 30-30-120 face angle: asanoha is the
 * triakis triangular tiling, so every opening must be an obtuse isosceles
 * triangle. A bare jigumi — the triangular grid with the leaves missing, which
 * is the easy thing to draw by accident — yields 60-60-60 faces and fails it.
 */

import { expect, test } from "vitest";
import { PolylineEntity, RectEntity } from "../src/model/entities";
import { kumiko } from "../src/generators/kumiko";
import { Sketch } from "../src/generators/sketch";

function build(params: Record<string, number> = {}) {
  const s = new Sketch({ params });
  return { s, handles: kumiko.build(s) };
}

/** The emitted openings (everything but the keyed frame rectangle). */
function openings(s: Sketch): PolylineEntity[] {
  return s.entities.filter((e): e is PolylineEntity => e instanceof PolylineEntity);
}

/** Interior angles of a closed polygon, in degrees. */
function angles(p: PolylineEntity): number[] {
  const pts = p.points;
  return pts.map((_, i) => {
    const prev = pts[(i - 1 + pts.length) % pts.length];
    const cur = pts[i];
    const next = pts[(i + 1) % pts.length];
    const a = Math.atan2(prev.y - cur.y, prev.x - cur.x);
    const b = Math.atan2(next.y - cur.y, next.x - cur.x);
    let d = Math.abs(a - b) * (180 / Math.PI);
    if (d > 180) d = 360 - d;
    return d;
  });
}

function area(p: PolylineEntity): number {
  const pts = p.points;
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const q = pts[(i + 1) % pts.length];
    a += pts[i].x * q.y - q.x * pts[i].y;
  }
  return Math.abs(a / 2);
}

/**
 * Openings clear of the border, where a face is a whole face. The border clip
 * legitimately truncates faces into quads at the panel edge — cropped leaves
 * are what a real kumiko border looks like — so the shape assertions below hold
 * over the interior only.
 */
function interior(s: Sketch, panel: { w: number; h: number }, margin: number): PolylineEntity[] {
  return openings(s).filter((c) =>
    c.points.every(
      (p) =>
        p.x > margin && p.y > margin && p.x < panel.w - margin && p.y < panel.h - margin,
    ),
  );
}

// --- the pattern itself ----------------------------------------------------

test("every opening is a 30-30-120 triangle — the asanoha face, not a jigumi cell", () => {
  const { s } = build({ width: 200, height: 160 });
  const cells = interior(s, { w: 200, h: 160 }, 20);
  expect(cells.length).toBeGreaterThan(50);

  for (const cell of cells) {
    expect(cell.points).toHaveLength(3);
    const sorted = angles(cell).sort((a, b) => a - b);
    expect(sorted[0]).toBeCloseTo(30, 1);
    expect(sorted[1]).toBeCloseTo(30, 1);
    expect(sorted[2]).toBeCloseTo(120, 1);
  }
});

test("a bare triangular grid would have failed the angle check", () => {
  // Positive control for the test above: an equilateral face sorts to 60-60-60,
  // so the assertion genuinely discriminates and isn't passing vacuously.
  const equilateral = new PolylineEntity(
    [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 5, y: 5 * Math.sqrt(3) },
    ],
    true,
  );
  for (const a of angles(equilateral)) expect(a).toBeCloseTo(60, 1);
});

test("openings are congruent — one face repeated across the panel", () => {
  const { s } = build({ width: 200, height: 160 });
  const areas = interior(s, { w: 200, h: 160 }, 20).map(area);
  const first = areas[0];
  for (const a of areas) expect(a).toBeCloseTo(first, 6);
});

test("twelve faces meet at each lattice vertex, three at each triangle centre", () => {
  // The defining incidence of the triakis triangular tiling, and the thing that
  // makes it a hemp leaf: six jigumi bars and six leaves converge on every
  // lattice vertex. Recovering it means undoing the inset — a corner of angle θ
  // moved inward along its bisector by (bar/2)/sin(θ/2) — which checks the
  // inset itself in passing.
  const bar = 5;
  const { s } = build({ width: 240, height: 200, pitch: 40, bar });
  const hits = new Map<string, number>();
  for (const cell of interior(s, { w: 240, h: 200 }, 20)) {
    const pts = cell.points;
    pts.forEach((cur, i) => {
      const prev = pts[(i - 1 + pts.length) % pts.length];
      const next = pts[(i + 1) % pts.length];
      const norm = (a: { x: number; y: number }, b: { x: number; y: number }) => {
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        return { x: (a.x - b.x) / d, y: (a.y - b.y) / d };
      };
      const u = norm(prev, cur);
      const v = norm(next, cur);
      const bis = { x: u.x + v.x, y: u.y + v.y };
      const len = Math.hypot(bis.x, bis.y);
      const theta = Math.acos(Math.max(-1, Math.min(1, u.x * v.x + u.y * v.y)));
      const back = bar / 2 / Math.sin(theta / 2);
      const o = { x: cur.x - (bis.x / len) * back, y: cur.y - (bis.y / len) * back };
      const key = `${o.x.toFixed(1)},${o.y.toFixed(1)}`;
      hits.set(key, (hits.get(key) ?? 0) + 1);
    });
  }
  const counts = [...hits.values()];
  expect(counts.filter((n) => n === 12).length).toBeGreaterThan(3); // lattice vertices
  expect(counts.filter((n) => n === 3).length).toBeGreaterThan(10); // triangle centres
});

// --- every pattern, by its defining tiling ----------------------------------

/**
 * Each pattern is a lattice plus a face rule, and the face angles plus how many
 * faces meet at a lattice vertex pin down which tiling was actually drawn. The
 * failure this guards is the one that shipped from a handoff: geometry that
 * renders plausibly and is the wrong pattern. A bare jigumi passes any
 * count-based check while failing these.
 */
const TILINGS = [
  { value: 0, name: "asanoha", angles: [30, 30, 120], atVertex: 12, atCentre: 3 },
  { value: 1, name: "mitsu-kude", angles: [60, 60, 60], atVertex: 6, atCentre: 0 },
  { value: 2, name: "kaku-asanoha", angles: [45, 45, 90], atVertex: 8, atCentre: 4 },
] as const;

for (const t of TILINGS) {
  test(`${t.name}: every interior opening is a ${t.angles.join("-")} face`, () => {
    const { s } = build({ pattern: t.value, width: 240, height: 200, pitch: 40 });
    const cells = interior(s, { w: 240, h: 200 }, 25);
    expect(cells.length).toBeGreaterThan(20);
    for (const cell of cells) {
      expect(cell.points).toHaveLength(3);
      const got = angles(cell).sort((a, b) => a - b);
      for (const [i, want] of [...t.angles].sort((a, b) => a - b).entries()) {
        expect(got[i]).toBeCloseTo(want, 1);
      }
    }
  });

  test(`${t.name}: ${t.atVertex} faces meet at each lattice vertex`, () => {
    // Undo the inset — a corner of angle θ moved inward along its bisector by
    // (bar/2)/sin(θ/2) — to recover the tiling's own vertices, which also
    // checks the inset itself in passing.
    const bar = 5;
    const { s } = build({ pattern: t.value, width: 240, height: 200, pitch: 40, bar });
    const hits = new Map<string, number>();
    for (const cell of interior(s, { w: 240, h: 200 }, 25)) {
      const pts = cell.points;
      pts.forEach((cur, i) => {
        const prev = pts[(i - 1 + pts.length) % pts.length];
        const next = pts[(i + 1) % pts.length];
        const unit = (a: { x: number; y: number }) => {
          const d = Math.hypot(a.x - cur.x, a.y - cur.y);
          return { x: (a.x - cur.x) / d, y: (a.y - cur.y) / d };
        };
        const u = unit(prev);
        const v = unit(next);
        const bis = { x: u.x + v.x, y: u.y + v.y };
        const len = Math.hypot(bis.x, bis.y);
        const theta = Math.acos(Math.max(-1, Math.min(1, u.x * v.x + u.y * v.y)));
        const back = bar / 2 / Math.sin(theta / 2);
        const o = { x: cur.x - (bis.x / len) * back, y: cur.y - (bis.y / len) * back };
        const key = `${o.x.toFixed(1)},${o.y.toFixed(1)}`;
        hits.set(key, (hits.get(key) ?? 0) + 1);
      });
    }
    const counts = [...hits.values()];
    expect(counts.filter((n) => n === t.atVertex).length).toBeGreaterThan(2);
    if (t.atCentre > 0) {
      expect(counts.filter((n) => n === t.atCentre).length).toBeGreaterThan(5);
    }
  });

  test(`${t.name}: openings are congruent and the cutter fits them`, () => {
    const { s } = build({ pattern: t.value, width: 240, height: 200, pitch: 40 });
    const areas = interior(s, { w: 240, h: 200 }, 25).map(area);
    for (const a of areas) expect(a).toBeCloseTo(areas[0], 6);

    const tool = s.opSuggestions.find((o) => o.kind === "profile-inside")?.toolDiameter ?? 0;
    expect(tool).toBeGreaterThan(0);
    for (const cell of openings(s)) {
      const pts = cell.points;
      let perim = 0;
      for (let i = 0; i < pts.length; i++) {
        const q = pts[(i + 1) % pts.length];
        perim += Math.hypot(q.x - pts[i].x, q.y - pts[i].y);
      }
      expect((2 * area(cell)) / perim).toBeGreaterThanOrEqual(tool / 2 - 1e-9);
    }
  });
}

test("the three tilings are genuinely different patterns", () => {
  // Positive control on the table above: if two entries were wired to the same
  // geometry, their per-pattern tests would both pass and mean nothing.
  const counts = TILINGS.map((t) => openings(build({ pattern: t.value }).s).length);
  expect(new Set(counts).size).toBe(TILINGS.length);
});

test("an unknown pattern value falls back to asanoha rather than drawing nothing", () => {
  const { s } = build({ pattern: 99 });
  expect(openings(s).length).toBeGreaterThan(20);
  const sorted = angles(interior(s, { w: 200, h: 160 }, 20)[0]).sort((a, b) => a - b);
  expect(sorted[2]).toBeCloseTo(120, 1);
});

test("a panel saved before the pattern param existed still builds as asanoha", () => {
  // Old features carry no `pattern` override at all; the choice must default to
  // the geometry they were drawn with, not to whatever is first in the table.
  const withoutParam = build({ width: 200, height: 160 });
  const explicitAsanoha = build({ pattern: 0, width: 200, height: 160 });
  expect(openings(withoutParam.s).length).toBe(openings(explicitAsanoha.s).length);
  expect(withoutParam.s.entityKeys).toEqual(explicitAsanoha.s.entityKeys);
});

// --- bar width is real geometry --------------------------------------------

test("bar width is honoured: openings shrink as the bars widen", () => {
  const thin = openings(build({ bar: 2 }).s).map(area)[0];
  const thick = openings(build({ bar: 8 }).s).map(area)[0];
  expect(thick).toBeLessThan(thin);
});

test("openings stay inside the frame by the full frame width", () => {
  const width = 200;
  const height = 160;
  const frame = 12;
  const { s } = build({ width, height, frame, bar: 5 });
  for (const cell of openings(s)) {
    for (const p of cell.points) {
      expect(p.x).toBeGreaterThanOrEqual(frame - 1e-6);
      expect(p.y).toBeGreaterThanOrEqual(frame - 1e-6);
      expect(p.x).toBeLessThanOrEqual(width - frame + 1e-6);
      expect(p.y).toBeLessThanOrEqual(height - frame + 1e-6);
    }
  }
});

test("the frame rectangle is emitted at the requested panel size", () => {
  const { handles } = build({ width: 250, height: 180 });
  const frame = handles[0].entity;
  expect(frame).toBeInstanceOf(RectEntity);
  const b = frame.bounds();
  expect(b.max.x - b.min.x).toBeCloseTo(250, 6);
  expect(b.max.y - b.min.y).toBeCloseTo(180, 6);
});

// --- CAM intent -------------------------------------------------------------

test("every opening is a target of the inside-profile op — no sampling", () => {
  const { s } = build();
  const inside = s.opSuggestions.find((o) => o.kind === "profile-inside");
  expect(inside).toBeDefined();
  expect(inside?.targets).toHaveLength(openings(s).length);
  expect(inside?.depth).toBe("through");
});

test("the suggested cutter fits the openings it is asked to cut", () => {
  for (const pitch of [25, 40, 60]) {
    const { s } = build({ pitch, bar: 4 });
    const inside = s.opSuggestions.find((o) => o.kind === "profile-inside");
    const tool = inside?.toolDiameter ?? Number.POSITIVE_INFINITY;
    for (const cell of openings(s)) {
      // Inradius of a triangle = 2A/P; the cutter must clear it.
      const pts = cell.points;
      let perim = 0;
      for (let i = 0; i < pts.length; i++) {
        const q = pts[(i + 1) % pts.length];
        perim += Math.hypot(q.x - pts[i].x, q.y - pts[i].y);
      }
      expect(tool / 2).toBeLessThanOrEqual((2 * area(cell)) / perim + 1e-9);
    }
  }
});

test("the frame is cut as a through outside profile", () => {
  const { s, handles } = build();
  const outside = s.opSuggestions.find((o) => o.kind === "profile-outside");
  expect(outside?.targets.map((t) => t.entity)).toEqual([handles[0].entity]);
  expect(outside?.depth).toBe("through");
});

// --- identity ---------------------------------------------------------------

test("openings are keyed by lattice coordinate, so ids survive a pitch change", () => {
  const a = build({ pitch: 40 }).s.entityKeys.filter((k): k is string => !!k);
  const b = build({ pitch: 50 }).s.entityKeys.filter((k): k is string => !!k);
  expect(new Set(a).size).toBe(a.length); // unique — s.key() would throw otherwise
  const shared = a.filter((k) => b.includes(k));
  expect(shared.length).toBeGreaterThan(10);
  expect(shared).toContain("frame");
});

// --- guard rails ------------------------------------------------------------

test("a pitch that would flood the document is refused, not truncated", () => {
  const { s, handles } = build({ pitch: 8, bar: 0.5, width: 400, height: 300 });
  expect(handles).toHaveLength(1); // the frame alone
  expect(s.notes.some((n) => n.includes("this document can hold"))).toBe(true);
  expect(s.opSuggestions.some((o) => o.kind === "profile-inside")).toBe(false);
});

// --- machining cost ---------------------------------------------------------

test("the summary reports the profile length the machine actually has to run", () => {
  const { s } = build();
  const cells = openings(s);
  let expected = 0;
  for (const c of cells) {
    const pts = c.points;
    for (let i = 0; i < pts.length; i++) {
      const q = pts[(i + 1) % pts.length];
      expected += Math.hypot(q.x - pts[i].x, q.y - pts[i].y);
    }
  }
  const summary = s.notes.find((n) => n.includes("profile at full depth"));
  expect(summary).toBeDefined();
  // Reported to the nearest mm, so match the rounded figure.
  expect(summary).toContain(`${expected.toFixed(0)} mm of profile`);
});

test("a fine lattice warns about the cutter even though it clears the cell cap", () => {
  // The case the entity cap misses by construction: comfortably under 1200
  // openings, and still metres of through-cut on a sub-millimetre bit.
  const { s, handles } = build({ pitch: 15, bar: 2 });
  expect(handles.length).toBeLessThan(1200);
  expect(handles.length).toBeGreaterThan(500);
  const tool = s.opSuggestions.find((o) => o.kind === "profile-inside")?.toolDiameter ?? 0;
  expect(tool).toBeLessThan(2);
  expect(s.notes.some((n) => n.includes("breaks easily"))).toBe(true);
});

test("...and a normal panel does not", () => {
  // Positive control: the warning must be about THIS pattern being fine, not
  // fire on everything and train the user to ignore it.
  const { s } = build();
  const tool = s.opSuggestions.find((o) => o.kind === "profile-inside")?.toolDiameter ?? 0;
  expect(tool).toBeGreaterThan(2);
  expect(s.notes.some((n) => n.includes("breaks easily"))).toBe(false);
});

test("bars too wide for the pitch close the lattice solid, with a way out", () => {
  const { s, handles } = build({ pitch: 12, bar: 6 });
  expect(handles).toHaveLength(1);
  expect(s.notes.some((n) => n.includes("widen the pitch past"))).toBe(true);
});

test("a frame wider than the panel is refused", () => {
  const { s, handles } = build({ frame: 90, width: 200, height: 160 });
  expect(handles).toHaveLength(1);
  expect(s.notes.some((n) => n.includes("no room"))).toBe(true);
});

test("a pitch coarser than the panel says so", () => {
  const { s } = build({ width: 30, height: 25, pitch: 40 });
  expect(s.notes.some((n) => n.includes("too coarse"))).toBe(true);
});

test("border scraps are reported rather than emitted as uncuttable slivers", () => {
  const { s } = build({ width: 200, height: 160, bar: 5 });
  expect(s.notes.some((n) => n.includes("left solid"))).toBe(true);
  // Positive control: everything that DID survive can take the suggested tool,
  // so the drop rule removed only what it claimed to.
  const tool = s.opSuggestions.find((o) => o.kind === "profile-inside")?.toolDiameter ?? 0;
  expect(tool).toBeGreaterThan(0);
  for (const cell of openings(s)) {
    const pts = cell.points;
    let perim = 0;
    for (let i = 0; i < pts.length; i++) {
      const q = pts[(i + 1) % pts.length];
      perim += Math.hypot(q.x - pts[i].x, q.y - pts[i].y);
    }
    expect((2 * area(cell)) / perim).toBeGreaterThanOrEqual(tool / 2 - 1e-9);
  }
});
