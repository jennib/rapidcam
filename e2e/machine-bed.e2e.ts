import { expect, openDoc, test } from "./appFixture";
import { CADDocument } from "../src/model/document";
import { RectEntity } from "../src/model/entities";
import { serializeDoc } from "../src/io/fileio";

/**
 * The bed setting's WIRING, which unit tests structurally cannot reach: that the
 * dialog persists what you type, that camBar hands it to the pre-flight, and that
 * the finding actually reaches the export screen. test/machineBed.test.ts covers
 * the store and the check in isolation; all of that can pass while the three
 * pieces are not connected to each other.
 */

/** A 400x300 part with a real profile op — far bigger than the bed we'll set. */
function bigPart(): string {
  const doc = new CADDocument({ width: 500, height: 400 }, "mm");
  doc.stockThickness = 10;
  const r = doc.add(new RectEntity({ x: 0, y: 0 }, { x: 400, y: 300 }));
  doc.operations.push({
    id: "op1", name: "cut", type: "profile", side: "outside", entityIds: [r.id],
    toolType: "end-mill", toolNumber: 1, diameter: 6, feedrate: 1000, plungeRate: 300,
    spindleSpeed: 18000, safeZ: 5, depth: -2, stepdown: 2, stepover: 0.4,
  } as never);
  return JSON.stringify(serializeDoc(doc, "big-part"));
}

test("live: bed set in the dialog refuses a job that needs more travel", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await openDoc(page, bigPart());

  // Blank by default, then set a deliberately tiny bed through the real dialog.
  await page.locator("#topbar").getByRole("button", { name: "Settings" }).click();
  const dlg = page.locator(".post-settings-dialog");
  await expect(dlg).toBeVisible();
  const bedX = dlg.locator(".post-settings-field", { hasText: "Bed travel X" }).locator("input");
  const bedY = dlg.locator(".post-settings-field", { hasText: "Bed travel Y" }).locator("input");
  // Unset by default — the field must not arrive pre-filled with a guess.
  await expect(bedX).toHaveValue("");
  await bedX.fill("120");
  await bedY.fill("120");
  await dlg.getByRole("button", { name: "Save" }).click();
  await expect(dlg).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("rapidcam:machine:bed"))).toBe("120x120");

  await page.locator(".rtab", { hasText: "CAM" }).click();
  await page.locator(".cam-gen-btn").click();
  const body = await page.locator(".tp-backdrop").first().innerText();
  // Matched on the specific sentence, not the word "travel": the out-of-bounds
  // error on the same screen says "moves travel outside the stock", so a loose
  // pattern here passes without the bed check running at all (it did, first go).
  expect(body).toMatch(/cannot run on this machine/i);
  expect(body).toMatch(/406mm of X travel \(machine has 120mm\)/);
});
