/**
 * The "click anywhere on it" pick is the same for EVERY object, not just lines:
 * a polyline segment, a Bézier's curve, and a rectangle's side all take an
 * anchor where the click landed.
 *
 * Only the real app can test this. A unit `ToolContext` uses `toWorldLen: px =>
 * px`, so its hotspot tolerance is 8 MILLIMETRES rather than 8 screen pixels —
 * which on a short segment swallows the vertices and the midpoint and leaves
 * almost no body to click. Whether `doc.pickPoint` steals the click before the
 * body pick sees it is exactly the question here, and at unit scale the answer
 * is always "yes" for reasons that have nothing to do with this code.
 */
import type { Page } from "@playwright/test";
import { expect, openDoc, test } from "./appFixture";

/** A zig-zag polyline, an arch Bézier, a rectangle, and a datum line under them. */
const DOC = JSON.stringify({
  version: 3,
  canvas: { width: 300, height: 200 },
  displayUnit: "mm",
  layers: [{ id: "layer-0", name: "Default", color: "#cdd2da", visible: true, locked: false }],
  activeLayerId: "layer-0",
  entities: [
    // Datum line along y = 20.
    {
      type: "line",
      id: "datum",
      a: { x: 10, y: 20 },
      b: { x: 290, y: 20 },
      isConstruction: false,
      layerId: "layer-0",
    },
    // Open zig-zag: (20,80) → (80,140) → (140,80). Segment 0 rises at 45°.
    {
      type: "polyline",
      id: "zig",
      points: [
        { x: 20, y: 80 },
        { x: 80, y: 140 },
        { x: 140, y: 80 },
      ],
      vertexIds: ["v0", "v1", "v2"],
      closed: false,
      isConstruction: false,
      layerId: "layer-0",
    },
    // Symmetric arch; t=0.5 is (210, 125), well away from every control point.
    {
      type: "bezier",
      id: "arch",
      p0: { x: 170, y: 80 },
      p1: { x: 170, y: 140 },
      p2: { x: 250, y: 140 },
      p3: { x: 250, y: 80 },
      isConstruction: false,
      layerId: "layer-0",
    },
    // Parallel to the zig-zag's first segment (both run at +45°), so the pair
    // is a true gap — the one pairing that keeps WHERE along each edge the
    // click landed, in `anchors`.
    {
      type: "line",
      id: "rail",
      a: { x: 60, y: 60 },
      b: { x: 120, y: 120 },
      isConstruction: false,
      layerId: "layer-0",
    },
    { type: "circle", id: "hole", center: { x: 250, y: 40 }, radius: 12, isConstruction: false, layerId: "layer-0" },
    {
      type: "rectangle",
      id: "box",
      p0: { x: 20, y: 35 },
      p1: { x: 140, y: 65 },
      isConstruction: false,
      layerId: "layer-0",
    },
  ],
  constraints: [],
  dimensions: [],
  variables: [],
  bindings: [],
  patterns: [],
  operations: [],
});

async function toPx(page: Page, mm: [number, number]): Promise<{ x: number; y: number }> {
  return page.evaluate(([x, y]) => {
    const app = (
      window as unknown as {
        __app: {
          view: { worldToScreen(p: { x: number; y: number }): { x: number; y: number } };
          canvas: HTMLElement;
        };
      }
    ).__app;
    const p = app.view.worldToScreen({ x, y });
    const r = app.canvas.getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  }, mm);
}

const dims = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as {
        __app: {
          doc: {
            dimensions: {
              type: string;
              value: number;
              anchors?: number[];
              entities: string[];
              points: { entityId: string; key: string }[];
            }[];
          };
        };
      }
    ).__app.doc.dimensions.map((d) => ({
      type: d.type,
      value: Math.round(d.value * 100) / 100,
      points: d.points.map((p) => `${p.entityId}:${p.key}`),
      entities: d.entities,
      anchors: d.anchors,
    })),
  );

/** Click `first`, then `second`, then place at `place`. */
async function dimension(
  page: Page,
  first: [number, number],
  second: [number, number],
  place: [number, number],
) {
  await page.locator('button.tool-btn[data-tip^="Dimension"]').click();
  for (const mm of [first, second, place]) {
    const p = await toPx(page, mm);
    await page.mouse.move(p.x, p.y);
    await page.mouse.click(p.x, p.y);
  }
  await page.keyboard.press("Escape");
}

test("a polyline segment anchors where it was clicked", async ({ page }) => {
  await openDoc(page, DOC);
  // Segment 0 of the zig-zag against the parallel rail: a gap dimension, the
  // one pairing that records where along the edges it sits. (35,95) is a
  // quarter along that segment, clear of both vertices and of its midpoint.
  await dimension(page, [35, 95], [75, 75], [55, 90]);

  const d = await dims(page);
  expect(d).toHaveLength(1);
  expect(d[0].type).toBe("line-distance");
  // The segment is named by the stable id of its START vertex, so the
  // reference survives a vertex inserted ahead of it — and it has to RESOLVE,
  // or the dimension silently draws nothing.
  expect(d[0].entities).toContain("zig#mid_v0");
  // A quarter along, not the segment's midpoint (0.5) nor a vertex (0 or 1).
  expect(d[0].anchors![0]).toBeCloseTo(0.25, 2);
  // Perpendicular gap between y = x + 60 (the segment) and y = x (the rail).
  expect(d[0].value).toBeCloseTo(60 / Math.SQRT2, 1);
});

test("a polyline segment crossing another edge gives the angle between them", async ({ page }) => {
  await openDoc(page, DOC);
  // Segment 0 rises at 45°; the datum is horizontal.
  await dimension(page, [35, 95], [35, 20], [55, 55]);

  const d = await dims(page);
  expect(d).toHaveLength(1);
  expect(d[0].type).toBe("angle");
  expect(d[0].value).toBeCloseTo(Math.PI / 4, 2); // radians (dims() rounds to 2dp)
  expect(d[0].entities.sort()).toEqual(["datum", "zig#mid_v0"]);
});

test("a Bézier anchors on the curve itself", async ({ page }) => {
  await openDoc(page, DOC);
  // (182.5, 113.75) is t = 0.25 on the arch — deliberately NOT its apex, which
  // is t = 0.5 and would be indistinguishable from a picker that ignored the
  // click. Every other candidate answer is far away: the apex reads 105, a
  // middle control point 120, an endpoint 60.
  await dimension(page, [182.5, 113.75], [182.5, 20], [240, 70]);

  const d = await dims(page);
  expect(d).toHaveLength(1);
  expect(d[0].value).toBeCloseTo(93.75, 0); // 113.75 − 20
  const key = d[0].points.find((p) => p.startsWith("arch:curve@"));
  expect(key, `expected a curve@ anchor, got ${d[0].points.join(", ")}`).toBeTruthy();
  expect(Number(key!.split("@")[1])).toBeCloseTo(0.25, 2);
});

test("a rectangle side clicked twice is that side's length", async ({ page }) => {
  await openDoc(page, DOC);
  // Twice on the bottom edge (y=35), both clear of the corners and its midpoint.
  await dimension(page, [45, 35], [115, 35], [80, 12]);

  const d = await dims(page);
  expect(d).toHaveLength(1);
  expect(d[0].value).toBeCloseTo(120, 1); // the full width, not the 70 clicked
  // Witnessed at the side's real CORNERS, so the dimension can drive them.
  expect(d[0].points.sort()).toEqual(["box:bl", "box:br"]);
});

test("a rectangle side clicked once is a point on it", async ({ page }) => {
  await openDoc(page, DOC);
  // The bottom edge, then the datum line under it. Both are horizontal, so this
  // resolves to a true edge-to-edge gap dimension rather than a point pair —
  // and the gap sits where the edge was clicked.
  await dimension(page, [45, 35], [45, 20], [75, 28]);

  const d = await dims(page);
  expect(d).toHaveLength(1);
  expect(d[0].type).toBe("line-distance");
  expect(d[0].value).toBeCloseTo(15, 1); // 35 − 20
  // A gap dim names two whole EDGES; where it sits along them is `anchors`.
  expect(d[0].entities).toContain("box#mid_b");
  // (45 − 20) / 120 along the bottom edge — the click, not the midpoint (0.5).
  expect(d[0].anchors![0]).toBeCloseTo(25 / 120, 2);
});

test("a circle's centre to a line is the perpendicular drop, not a sideways gap", async ({
  page,
}) => {
  await openDoc(page, DOC);
  // The datum line runs y=20 and the arch's left foot is at (170,80); use the
  // zig-zag's apex vertex instead — a real point — and measure it to the line.
  // Click the line well off its own midpoint (x=150) so the anchor is a genuine
  // point on it, then place ABOVE, which the cursor rule reads as "measure Δx".
  await dimension(page, [80, 140], [60, 20], [70, 175]);

  const d = await dims(page);
  expect(d).toHaveLength(1);
  // The perpendicular drop from the vertex to the line. Δx would be 20 — the
  // horizontal gap to WHEREVER on the line was clicked, which changes if you
  // click 10mm further along even though nothing moved.
  expect(d[0].type).toBe("point-line-distance");
  expect(d[0].value).toBeCloseTo(120, 1);
  expect(d[0].entities).toEqual(["datum"]);
});

test("a circle defaults to its DIAMETER, and Tab gives the radius", async ({ page }) => {
  await openDoc(page, DOC);
  await page.locator('button.tool-btn[data-tip^="Dimension"]').click();
  // Click the rim, then open space to place it.
  for (const mm of [[262, 40], [285, 75]] as [number, number][]) {
    const p = await toPx(page, mm);
    await page.mouse.move(p.x, p.y);
    await page.mouse.click(p.x, p.y);
  }
  await page.keyboard.press("Escape");

  const d = await dims(page);
  expect(d).toHaveLength(1);
  // Both Fusion and SolidWorks dimension a full circle by its diameter, and
  // it is the number a machinist wants for a hole.
  expect(d[0].type).toBe("diameter");
  expect(d[0].value).toBeCloseTo(24, 1);
});

test("a selected circle is not a dead end — a second pick measures from its centre", async ({
  page,
}) => {
  await openDoc(page, DOC);
  await page.locator('button.tool-btn[data-tip^="Dimension"]').click();

  // Click the circle's RIM — which used to commit the tool to a radius, with
  // Escape the only way out — then the datum line, then place.
  for (const mm of [[262, 40], [200, 20], [230, 30]] as [number, number][]) {
    const p = await toPx(page, mm);
    await page.mouse.move(p.x, p.y);
    await page.mouse.click(p.x, p.y);
  }
  await page.keyboard.press("Escape");

  const d = await dims(page);
  expect(d).toHaveLength(1);
  // From the circle's CENTRE (250,40) down to the datum at y=20 — not its rim,
  // and not the radius the first click used to lock in.
  expect(d[0].type).toBe("point-line-distance");
  expect(d[0].value).toBeCloseTo(20, 1);
  expect(d[0].points).toEqual(["hole:c"]);
  expect(d[0].entities).toEqual(["datum"]);
});
