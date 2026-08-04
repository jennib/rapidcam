/**
 * A line's Angle property, driven by a formula.
 *
 * A literal rotates the line directly; a formula parks in a hidden `angle-x`
 * dimension so the SOLVER holds the direction. What only a browser proves is
 * that the whole chain is connected — field → dimension → evaluate → solve →
 * geometry — and that both paths mean DEGREES, which they briefly did not.
 */
import { expect, openDoc, test } from "./appFixture";
import { CADDocument } from "../src/model/document";
import { LineEntity } from "../src/model/entities";
import { makeVariable } from "../src/model/variables";
import { serializeDoc } from "../src/io/fileio";

function doc(): string {
  const d = new CADDocument({ width: 200, height: 150 }, "mm");
  d.addVariable(makeVariable("tilt", "30", "mm"));
  d.add(new LineEntity({ x: 20, y: 20 }, { x: 100, y: 20 }));
  return JSON.stringify(serializeDoc(d, "angle"));
}

const dirDeg = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const l = (window as any).__app.doc.entities.find((e: any) => e.type === "line");
    return (Math.atan2(l.b.y - l.a.y, l.b.x - l.a.x) * 180) / Math.PI;
  });

test("live: a literal and a formula in the Angle box mean the same thing", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openDoc(page, doc());
  await page.evaluate(() => {
    const d = (window as any).__app.doc;
    d.entities.find((e: any) => e.type === "line").selected = true;
    d.emitChange();
  });

  const angle = page.locator("#propertiesbar .props-row").filter({ hasText: "Angle" }).first().locator("input");
  await expect(angle).toHaveAttribute("list", /.+/); // suggests variable names

  await angle.fill("45");
  await angle.dispatchEvent("change");
  expect(await dirDeg(page)).toBeCloseTo(45, 1);

  // The variable is 30 — so the line must land at 30 DEGREES, not 30 radians.
  await angle.fill("tilt");
  await angle.dispatchEvent("change");
  expect(await dirDeg(page)).toBeCloseTo(30, 1);
});
