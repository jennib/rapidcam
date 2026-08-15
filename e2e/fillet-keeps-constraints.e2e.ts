/* biome-ignore-all lint/suspicious/noExplicitAny: reads untyped app internals */
import { test, expect, openDoc } from "./appFixture";
import { CADDocument, STOCK_ENTITY_ID } from "../src/model/document";
import { RectEntity } from "../src/model/entities";
import { makeConstraint } from "../src/model/constraints";
import { serializeDoc } from "../src/io/fileio";

function rectPinnedToStock(): string {
  const doc = new CADDocument({ width: 200, height: 150 }, "mm");
  doc.stockRect = { x: 0, y: 0, width: 180, height: 120 };
  const r = doc.add(new RectEntity({ x: 40, y: 30 }, { x: 140, y: 100 })) as RectEntity;
  // Pin the corner that will be ROUNDED — the case that used to be unsavable.
  doc.addConstraint(
    makeConstraint("pointOnLine", {
      points: [{ entityId: r.id, key: "tr" }],
      entities: [`${STOCK_ENTITY_ID}#mid_t`],
    }),
  );
  return JSON.stringify(serializeDoc(doc, "pinned"));
}

/**
 * A constraint on a filleted rectangle survives, through the REAL tool.
 *
 * test/filletStockEdge.test.ts proves the model keeps the reference. This
 * proves the fillet TOOL reaches that code and that the SOLVER still enforces
 * the constraint afterwards — the gap that let a point-drag ship without ever
 * emitting a change event earlier in this project.
 *
 * The assertion on POSITION is the strong one: the pinned corner sits on the
 * stock top edge (y=120), not where the rectangle was drawn (y=100). A merely
 * surviving record would leave it at 100. Being held there proves it is live.
 *
 * The pinned corner is the one being ROUNDED, which is the case #53 could only
 * report as a loss: that corner became forty-nine vertices, so there was no
 * single successor for the pin. As a radius it never stops being `tr`.
 */
test("filleting the pinned corner itself keeps the constraint, live", async ({ page }) => {
  await openDoc(page, rectPinnedToStock());
  const toPx = (w: any) =>
    page.evaluate((p) => {
      const app = (window as any).__app;
      const s = app.view.worldToScreen(p);
      const r = document.querySelector("canvas")!.getBoundingClientRect();
      return { x: s.x + r.left, y: s.y + r.top };
    }, w);

  const before = await page.evaluate(() => (window as any).__app.doc.constraints.length);
  await page.evaluate(() => (window as any).__app.tools.activate("fillet"));

  // Read the corner where the SOLVER has put it (pulled up onto the stock top
  // edge), not where the rectangle was authored — aiming at the drawn position
  // would miss the pick band and silently test nothing.
  const tr = await page.evaluate(() => {
    const ent = (window as any).__app.doc.entities.find((e: any) => e.type === "rectangle");
    return ent.getPoint("tr");
  });
  const from = await toPx(tr);
  const to = await toPx({ x: tr.x - 8, y: tr.y - 8 });
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / 6, from.y + ((to.y - from.y) * i) / 6);
    await page.waitForTimeout(12);
  }
  await page.mouse.up();

  const after = await page.evaluate(() => {
    const doc = (window as any).__app.doc;
    const ent = doc.entities.find((e: any) => e.type === "rectangle");
    const c = doc.constraints[0];
    const key = c?.points?.[0]?.key;
    return {
      n: doc.constraints.length,
      type: ent?.type,
      key,
      resolves: ent ? ent.dofPoints().some((p: any) => p.key === key) : false,
      pos: ent && key ? ent.getPoint(key) : null,
      rounded: ent ? ent.outlinePoints().length > 4 : false,
    };
  });
  console.log("constraints before:", before, "after:", after.n);
  console.log("key:", after.key, "resolves:", after.resolves, "at", JSON.stringify(after.pos));
  expect(after.n).toBe(before);
  expect(after.type, "a filleted rectangle stays a rectangle").toBe("rectangle");
  expect(after.key).toBe("tr"); // nothing was replaced, so nothing was remapped
  expect(after.resolves).toBe(true);
  // Live, not merely recorded: the solver holds it on the stock top edge.
  expect(after.pos.y).toBeCloseTo(120, 1);
  // Positive control: the fillet really happened.
  expect(after.rounded).toBe(true);
});
