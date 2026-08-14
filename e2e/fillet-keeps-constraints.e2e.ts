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
  // Pin the TOP-RIGHT corner — not the one we will round away.
  doc.addConstraint(
    makeConstraint("pointOnLine", {
      points: [{ entityId: r.id, key: "tr" }],
      entities: [`${STOCK_ENTITY_ID}#mid_t`],
    }),
  );
  return JSON.stringify(serializeDoc(doc, "pinned"));
}

/**
 * A constraint on an untouched corner survives a fillet, through the REAL tool.
 *
 * test/filletStockEdge.test.ts proves the remap by calling spliceCornerVertices
 * directly. This proves the fillet TOOL reaches that code — the gap that let a
 * point-drag ship without ever emitting a change event earlier in this project.
 *
 * The assertion on POSITION is the strong one: the pinned corner ends up on the
 * stock top edge (y=120), not where the rectangle was drawn (y=100). A merely
 * surviving record would leave it at 100. Being moved proves the solver is
 * enforcing it.
 */
test("filleting via the real tool keeps a constraint on an untouched corner", async ({ page }) => {
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

  const from = await toPx({ x: 40, y: 30 }); // bottom-left — NOT the pinned corner
  const to = await toPx({ x: 48, y: 38 });
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / 6, from.y + ((to.y - from.y) * i) / 6);
    await page.waitForTimeout(12);
  }
  await page.mouse.up();

  const after = await page.evaluate(() => {
    const doc = (window as any).__app.doc;
    const ent = doc.entities.find((e: any) => e.type === "polyline");
    const c = doc.constraints[0];
    const key = c?.points?.[0]?.key;
    return {
      n: doc.constraints.length,
      key,
      resolves: ent ? ent.dofPoints().some((p: any) => p.key === key) : false,
      pos: ent && key ? ent.getPoint(key) : null,
    };
  });
  console.log("constraints before:", before, "after:", after.n);
  console.log("remapped key:", after.key, "resolves:", after.resolves, "at", JSON.stringify(after.pos));
  expect(after.n).toBe(before);
  expect(after.key).not.toBe("tr"); // "tr" is meaningless on a polyline
  expect(after.resolves, "the remapped key must resolve on the new polyline").toBe(true);
  // Live, not merely recorded: the solver has pulled it onto the stock top edge.
  expect(after.pos.y).toBeCloseTo(120, 1);
});
