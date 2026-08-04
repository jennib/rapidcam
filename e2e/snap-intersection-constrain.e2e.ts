/**
 * Drawing a circle centred on the crossing of two lines must CONSTRAIN it there.
 *
 * Reported from a real file: the centre sat at exactly the intersection and
 * nothing referenced the circle at all, so the first edit to either line left it
 * behind — parametric-looking, not parametric.
 *
 * This has to be an end-to-end test. The unit tests around it drive `autoJoin`
 * and `intersectionsNear` directly, and BOTH still passed when the snap was made
 * to forget what it crossed and when the circle tool went back to discarding
 * keyless snaps. Only the real chain — snap engine → tool → document — catches
 * that, which is the whole bug.
 */
import { expect, openDoc, test } from "./appFixture";
import { CADDocument } from "../src/model/document";
import { LineEntity } from "../src/model/entities";
import { serializeDoc } from "../src/io/fileio";
import { makeConstraint } from "../src/model/constraints";
import type { Page } from "@playwright/test";

function crossedLines(): string {
  const d = new CADDocument({ width: 200, height: 150 }, "mm");
  // Deliberately asymmetric: neither line's MIDPOINT may sit on the crossing.
  // An exact point outranks an intersection snap (correctly — a real vertex
  // should win), so a symmetric fixture snaps to the midpoint and tests the
  // wrong thing. The first version of this test did exactly that and got a
  // `coincident` constraint instead of the two `pointOnLine`s.
  const vert = d.add(new LineEntity({ x: 60, y: 30 }, { x: 60, y: 140 })); // mid y=85
  const horiz = d.add(new LineEntity({ x: 20, y: 75 }, { x: 180, y: 75 })); // mid x=100
  // Constrain their ORIENTATION, as a real drawing does (the reported file has
  // exactly these). Without them the lines are free to rotate, and the solver
  // satisfies the circle's constraint by TILTING the line through the centre
  // instead of carrying the centre with it — true, but not what is being tested.
  d.addConstraint(makeConstraint("vertical", { entities: [vert.id] }));
  d.addConstraint(makeConstraint("horizontal", { entities: [horiz.id] }));
  return JSON.stringify(serializeDoc(d, "crossing"));
}

async function toPx(page: Page, mm: [number, number]) {
  return page.evaluate(([x, y]) => {
    const app = (window as any).__app;
    const p = app.view.worldToScreen({ x, y });
    const r = app.canvas.getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  }, mm);
}
const click = async (page: Page, mm: [number, number]) => {
  const p = await toPx(page, mm);
  await page.mouse.click(p.x, p.y);
};

test("live: a circle centred on a crossing is constrained to it", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openDoc(page, crossedLines());
  await page.locator('button.tool-btn[data-tip^="Circle"]').click();

  // Centre ON the crossing (60, 75), then a radius click well clear of it.
  await click(page, [60, 75]);
  await click(page, [100, 75]);

  const state = await page.evaluate(() => {
    const doc = (window as any).__app.doc;
    const circle = doc.entities.find((e: any) => e.type === "circle");
    return {
      centre: circle.center,
      holding: doc.constraints
        .filter((c: any) => c.points.some((p: any) => p.entityId === circle.id))
        .map((c: any) => c.type),
    };
  });

  expect(state.centre.x).toBeCloseTo(60, 1);
  expect(state.centre.y).toBeCloseTo(75, 1);
  // TWO constraints — one per crossed line. With only one the centre would
  // slide along the other line the moment anything moved.
  expect(state.holding).toEqual(["pointOnLine", "pointOnLine"]);

  // Deliberately NOT asserted here: that dragging a line carries the circle
  // with it. It does not — the solver moves the LINE back instead, because the
  // circle is anchored and the dragged line is released from anchoring. The
  // constraint is honoured either way (they stay coincident), so that is a
  // question about anchor weighting, not about the snap wiring this test
  // exists for. test/snapAutoConstrain.test.ts proves the solver holds the
  // point by fixing the line outright, which is unambiguous.
});
