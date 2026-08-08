/**
 * The arc properties panel reads its angles in degrees.
 *
 * Reported from the running app: an arc sitting at 26.6°–104.0° displayed
 * "Start 1522.1, End 5960.8" — the rad→deg conversion applied twice, 57.3× too
 * large. The unit test in test/propertiesAngleUnits.test.ts drives the same
 * PropertiesBar class, but the bug was only ever seen in the real app, so the
 * loop gets closed where it was opened.
 */
import { expect, openDoc, test } from "./appFixture";
import { CADDocument } from "../src/model/document";
import { ArcEntity } from "../src/model/entities";
import { serializeDoc } from "../src/io/fileio";

const DEG = Math.PI / 180;

function arcDoc(): string {
  const doc = new CADDocument({ width: 300, height: 300 }, "mm");
  doc.add(new ArcEntity({ x: 144.743, y: 119.89 }, 28.238, 30 * DEG, 105 * DEG));
  return JSON.stringify(serializeDoc(doc, "arc-angle-units"));
}

test("an arc's Start/End/Sweep read in degrees and agree", async ({ page }) => {
  await openDoc(page, arcDoc());

  // Select the arc through the app's own model, then let the panel rebuild.
  await page.evaluate(() => {
    const app = (window as unknown as { __app: { project: { doc: any } } }).__app;
    const doc = app.project.doc;
    const arc = doc.entities.find((e: { type: string }) => e.type === "arc");
    for (const e of doc.entities) e.selected = false;
    arc.selected = true;
    doc.emitChange();
  });

  const field = (label: string) =>
    page
      .locator(".props-row", { has: page.locator(`span:text-is("${label}")`) })
      .locator("input")
      .first();

  await expect(field("Start")).toHaveValue("30.0");
  await expect(field("End")).toHaveValue("105.0");
  await expect(field("Sweep")).toHaveValue("75.0");
});
