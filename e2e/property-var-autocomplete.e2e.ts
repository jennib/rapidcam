/**
 * A property field that accepts a formula must also SUGGEST the names it
 * accepts. The ƒx badge beside these fields opens a click-to-pick popup, which
 * helps nobody who has already started typing — `wid` suggested nothing here
 * while the identical field in the on-canvas dimension editor suggested
 * `width`. Reported as "Rectangle H and W in properties does not have auto
 * complete for variable".
 *
 * test/propertiesBarVarAutocomplete.test.ts covers the wiring under happy-dom.
 * What only a browser proves is that the `list` attribute reaches a real
 * datalist the browser will actually offer, and that a formula typed against
 * one of those names still drives the geometry.
 */
import { expect, openDoc, test } from "./appFixture";
import { CADDocument } from "../src/model/document";
import { RectEntity } from "../src/model/entities";
import { makeVariable } from "../src/model/variables";
import { serializeDoc } from "../src/io/fileio";

function doc(): string {
  const d = new CADDocument({ width: 200, height: 150 }, "mm");
  d.addVariable(makeVariable("plateWidth", "80", "mm"));
  d.add(new RectEntity({ x: 20, y: 20 }, { x: 100, y: 70 }));
  return JSON.stringify(serializeDoc(d, "vars"));
}

test("live: rectangle W offers variable names while typing", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openDoc(page, doc());
  await page.evaluate(() => {
    const d = (window as any).__app.doc;
    d.entities.find((e: any) => e.type === "rectangle").selected = true;
    d.emitChange();
  });

  const wRow = page.locator("#propertiesbar .props-row").filter({ hasText: "W" }).first();
  const inp = wRow.locator("input").first();
  const listId = await inp.getAttribute("list");
  expect(listId, "the W field must be wired to a datalist").toBeTruthy();

  const opts = await page.evaluate((id) => {
    const dl = document.getElementById(id!) as HTMLDataListElement | null;
    return dl ? [...dl.querySelectorAll("option")].map((o) => (o as HTMLOptionElement).value) : [];
  }, listId);
  expect(opts).toContain("plateWidth");

  // And the field still commits a formula typed against that name.
  await inp.fill("plateWidth/2");
  await inp.dispatchEvent("change");
  const w = await page.evaluate(() => {
    const r = (window as any).__app.doc.entities.find((e: any) => e.type === "rectangle");
    return Math.abs(r.p1.x - r.p0.x);
  });
  expect(w).toBeCloseTo(40, 1);
});
