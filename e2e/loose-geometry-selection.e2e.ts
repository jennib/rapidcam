/**
 * The solve readout in the status bar is a control, not a caption.
 *
 * The canvas has always drawn loose geometry blue and the bar has always
 * reported how many degrees of freedom are left, but nothing joined the two: a
 * newcomer saw blue geometry and a number with no way to learn they were the
 * same fact, and the number could not be acted on. Clicking it now selects
 * exactly the geometry the canvas is colouring — which is the useful join,
 * because a selection is what the constraint bar acts on.
 *
 * The invariant worth pinning is that agreement. What gets selected has to be
 * the same set the renderer paints under-defined, or the control sends you
 * after the wrong geometry — and a test that only counted selections would pass
 * while doing exactly that.
 */
import type { Page } from "@playwright/test";
import { expect, openDoc, test } from "./appFixture";

const DOC = JSON.stringify({
  version: 3,
  canvas: { width: 200, height: 150 },
  displayUnit: "mm",
  layers: [{ id: "layer-0", name: "Default", color: "#cdd2da", visible: true, locked: false }],
  activeLayerId: "layer-0",
  entities: [
    { type: "line", id: "l1", a: { x: 20, y: 20 }, b: { x: 120, y: 20 }, isConstruction: false, layerId: "layer-0" },
    { type: "circle", id: "c1", center: { x: 60, y: 80 }, radius: 15, isConstruction: false, layerId: "layer-0" },
    { type: "rectangle", id: "r1", p0: { x: 130, y: 60 }, p1: { x: 180, y: 110 }, isConstruction: false, layerId: "layer-0" },
  ],
  constraints: [], dimensions: [], variables: [], bindings: [], patterns: [], operations: [],
});

const solveEl = (page: Page) => page.locator("#statusbar .status-item", { hasText: "constrained" });

/** Selected entity ids, and the ids the renderer is painting under-defined. */
const state = (page: Page) =>
  page.evaluate(() => {
    const app = (
      window as unknown as {
        __app: {
          doc: { entities: { id: string; selected?: boolean }[] };
          renderer: { entityStatus: Map<string, string> };
        };
      }
    ).__app;
    return {
      selected: app.doc.entities.filter((e) => e.selected).map((e) => e.id).sort(),
      loose: [...app.renderer.entityStatus.entries()]
        .filter(([, v]) => v === "under-defined")
        .map(([id]) => id)
        .sort(),
    };
  });

test("clicking the readout selects exactly the geometry drawn as loose", async ({ page }) => {
  await openDoc(page, DOC);

  const readout = solveEl(page);
  await expect(readout).toContainText("Under-constrained");
  // The tooltip is the only place the number and the colour are joined.
  await expect(readout).toHaveAttribute("title", /blue/i);

  const before = await state(page);
  expect(before.selected, "nothing selected to begin with").toHaveLength(0);
  // Positive control: there IS loose geometry, so the assertion below is not
  // comparing two empty lists and calling it agreement.
  expect(before.loose.length).toBeGreaterThan(0);

  await readout.click();

  const after = await state(page);
  expect(after.selected).toEqual(after.loose);
  expect(after.loose).toEqual(["c1", "l1", "r1"]);
  await expect(page.locator("#statusbar")).toContainText("Selected 3 loose entities");
});

test("says so rather than doing nothing when the loose geometry is out of reach", async ({
  page,
}) => {
  await openDoc(page, DOC);
  // Lock the layer everything lives on: still loose, still blue, but nothing
  // there can be selected. A silent no-op reads as a broken control.
  await page.evaluate(() => {
    const doc = (
      window as unknown as {
        __app: { doc: { layers: { locked: boolean }[]; emitChange(): void } };
      }
    ).__app.doc;
    doc.layers[0].locked = true;
    doc.emitChange();
  });

  await solveEl(page).click();

  const after = await state(page);
  expect(after.selected).toHaveLength(0);
  expect(after.loose.length, "still loose — locking does not constrain it").toBeGreaterThan(0);
  await expect(page.locator("#statusbar")).toContainText("No loose geometry you can select");
});
