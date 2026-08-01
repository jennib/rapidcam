/**
 * The Layers panel row must keep every control inside the panel.
 *
 * This exists because of a real regression: the panel is ~225px and the row
 * already carried six controls at its limit on a mill. Adding the laser beam
 * toggle laid the beam button and **Delete Layer** out past the panel's right
 * edge — Delete by 30px, i.e. permanently unclickable on any laser document.
 *
 * Nothing else in the suite could have caught it. The unit tests assert the
 * model, and the happy-dom component tests assert structure — but happy-dom has
 * no layout engine, so every `querySelector` was green while the UI was broken.
 * It took a screenshot to see it. This spec is the automated version of that
 * look: real Chrome, real layout, measured.
 *
 * Written as "no control lands outside the panel" rather than pinning pixel
 * widths, so it guards whatever gets added to the row next instead of just the
 * one button that broke it.
 */
import { test, expect, waitForApp, APP_URL } from "./appFixture";

/** Controls laid out beyond the panel's edges, or collapsed to nothing. */
async function unreachableControls(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const panel = document.querySelector("#layersbar");
    if (!panel) throw new Error("no #layersbar");
    const pr = panel.getBoundingClientRect();
    const bad: { row: string; control: string; right: number; panelRight: number }[] = [];
    for (const row of document.querySelectorAll("#layersbar .layer-row")) {
      const name =
        row.querySelector<HTMLInputElement>('input[type="text"]')?.value ?? "(unnamed)";
      for (const kid of row.children) {
        const kr = kid.getBoundingClientRect();
        const label =
          (kid as HTMLElement).title || kid.textContent?.trim() || kid.tagName.toLowerCase();
        // Half a pixel of slack for sub-pixel layout rounding.
        if (kr.right > pr.right + 0.5 || kr.left < pr.left - 0.5 || kr.width < 1)
          bad.push({
            row: name,
            control: label.slice(0, 40),
            right: Math.round(kr.right),
            panelRight: Math.round(pr.right),
          });
      }
    }
    return bad;
  });
}

test("every layer control stays inside the panel, on a mill and on a laser", async ({ page }) => {
  await page.goto(APP_URL);
  await waitForApp(page);

  // Worst case for width: several layers, a fixture layer (which adds a clamp
  // height field to its row) and beam recipes (which add the ⚡ toggle).
  await page.evaluate(() => {
    const doc = (window as unknown as { __app: { doc: Record<string, unknown> } }).__app.doc as {
      machineKind: string;
      layers: Record<string, unknown>[];
      emitChange: () => void;
    };
    doc.machineKind = "laser";
    doc.layers[0].name = "Cut";
    doc.layers[0].laser = { feedrate: 300, laserPower: 100, laserPasses: 3 };
    doc.layers.push({
      id: "l-score",
      name: "Score",
      color: "#e05a5a",
      visible: true,
      locked: false,
      laser: { feedrate: 1800, laserPower: 15, laserPasses: 1 },
    });
    doc.layers.push({
      id: "l-clamp",
      name: "Clamps",
      color: "#f5c542",
      visible: true,
      locked: false,
      fixture: true,
      fixtureHeight: 20,
    });
    doc.emitChange();
  });

  await expect(page.locator("#layersbar .layer-row")).toHaveCount(3);
  // Positive control: the beam toggle really is rendered, so a pass below means
  // "the crowded row fits" rather than "the crowded row never happened".
  await expect(page.locator("#layersbar .layer-beam-toggle")).toHaveCount(2);
  expect(await unreachableControls(page)).toEqual([]);

  // Delete is the control that was pushed out, so prove it can be clicked.
  const del = page.locator("#layersbar .layer-row").first().locator("button.icon-btn").last();
  await expect(del).toBeVisible();
  await expect(del).toHaveAttribute("title", "Delete Layer");

  // The same rows on a mill, where the row was already at its limit.
  await page.evaluate(() => {
    const doc = (window as unknown as { __app: { doc: { machineKind: string; emitChange: () => void } } })
      .__app.doc;
    doc.machineKind = "mill";
    doc.emitChange();
  });
  await expect(page.locator("#layersbar .layer-beam-toggle")).toHaveCount(0);
  expect(await unreachableControls(page)).toEqual([]);
});
