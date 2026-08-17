/**
 * Rest machining's Rest row, and the relief pair, through the real dialog.
 *
 * `restToolDiameter` was a pocket-only field in three separate places — the row's
 * visibility, the operation the dialog builds, and the emitter — and unit tests
 * can see only the third. happy-dom has no layout, so it cannot tell a hidden row
 * from a shown one; and a G-code test never opens a dialog. Both gates need the
 * app.
 *
 * Phase 2 removed rest machining from the relief: the merged "3-D Relief" type
 * writes its own roughing + finishing passes and carries no rest field, so this
 * spec now guards that the Rest row is pocket-only and that a relief applies as
 * two ops with no rest diameter.
 */
import { test, expect, waitForApp, openDoc, APP_URL } from "./appFixture";

/**
 * A document carrying a HEIGHT MAP (`zRangeMM` present) and nothing else, because
 * `checkOpSelection` refuses relief roughing on anything but an image — a
 * rectangle silently toasts and applies no operation at all, which is how the
 * first draft of this spec asserted against an empty operations list.
 *
 * The pixels are a 5mm-wide full-depth slot down the middle of a 32mm square: a
 * ⌀3 cutter enters it and a ⌀8 does not, so this is a document where the rest
 * mask is genuinely non-empty.
 */
function reliefDoc(): string {
  const W = 32;
  const px: number[] = [];
  for (let y = 0; y < W; y++)
    for (let x = 0; x < W; x++) {
      const mm = x; // 1 px per mm
      px.push(mm >= 13 && mm < 18 ? 0 : 255);
    }
  const data = Buffer.from(Uint8Array.from(px)).toString("base64");
  return JSON.stringify({
    version: 3,
    name: "Relief rest",
    canvas: { width: 100, height: 100 },
    displayUnit: "mm",
    stockThickness: 12,
    origin: { x: "left", y: "front", z: "top" },
    groups: [],
    layers: [{ id: "layer-0", name: "Layer 0", visible: true, locked: false }],
    activeLayerId: "layer-0",
    entities: [
      {
        type: "image",
        id: "img-ent-1",
        imageId: "img-relief1",
        position: { x: 10, y: 10 },
        widthMM: 32,
        heightMM: 32,
        angle: 0,
      },
    ],
    constraints: [],
    dimensions: [],
    variables: [],
    bindings: [],
    patterns: [],
    operations: [],
    tools: [],
    images: [
      { id: "img-relief1", name: "relief", width: W, height: W, data, zRangeMM: 10 },
    ],
  });
}

/** Select the image and open Add Toolpath. */
async function openToolpathDialog(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => {
    const doc = (
      window as unknown as {
        __app: { doc: { entities: { selected: boolean; type: string }[]; emitChange: () => void } };
      }
    ).__app.doc;
    for (const e of doc.entities) e.selected = e.type === "image";
    doc.emitChange();
    (document.querySelector(".cam-add-btn") as HTMLElement | null)?.click();
  });
  await expect(page.locator(".tp-dialog")).toBeVisible();
}

/** The "Rest: prev tool ⌀" row. */
const restRow = (page: import("@playwright/test").Page) =>
  page.locator(".tp-dialog .tp-field").filter({ hasText: "Rest: prev tool" });

test("the Rest row shows for a pocket only — hidden for a relief and a profile", async ({ page }) => {
  await page.goto(APP_URL);
  await waitForApp(page);
  // Nothing needs to be in the document for a visibility check, but the welcome
  // screen is a modal <dialog> that swallows every click until it is dealt with.
  await page.locator(".welcome-backdrop .welcome-card", { hasText: "New Project" }).click();
  const npd = page.locator("#npd-backdrop");
  await npd.getByRole("button", { name: "Create Project" }).click();
  await expect(npd).toHaveCount(0);
  await page.evaluate(() =>
    (document.querySelector(".cam-add-btn") as HTMLElement | null)?.click(),
  );
  await expect(page.locator(".tp-dialog")).toBeVisible();

  const typeSelect = page.locator(".tp-dialog select").first();
  const row = restRow(page);

  await typeSelect.selectOption("relief");
  await expect(row).toBeHidden();
  // Its mirror. Without a type that must NOT show the row, the assertion above
  // passes just as well for a row that is never hidden.
  await typeSelect.selectOption("profile-outside");
  await expect(row).toBeHidden();
  await typeSelect.selectOption("pocket");
  await expect(row).toBeVisible();
});

// What the posted program then DOES with the field is `test/reliefRest.test.ts`'s
// job. Re-importing gcode.ts inside the page to assert it here would run a second
// copy of the module against the app's entities, which is the identity trap that
// makes `instanceof` fail on geometry that is perfectly valid.
test("applying a 3-D Relief writes a roughing + finishing pair, neither with a rest field", async ({
  page,
}) => {
  await openDoc(page, reliefDoc());
  await openToolpathDialog(page);

  await page.locator(".tp-dialog select").first().selectOption("relief");
  await page.locator(".tp-dialog button", { hasText: /^Apply$/ }).first().click();
  await expect(page.locator(".tp-dialog")).toHaveCount(0);

  const saved = await page.evaluate(() => {
    const doc = (
      window as unknown as {
        __app: { doc: { operations: { type: string; restToolDiameter?: number }[] } };
      }
    ).__app.doc;
    return doc.operations.map((o) => ({ type: o.type, rest: o.restToolDiameter ?? null }));
  });
  expect(saved).toEqual([
    { type: "relief-rough", rest: null },
    { type: "engrave", rest: null },
  ]);

  // The list collapses the two passes into ONE grouped "3-D Relief" card with
  // Roughing/Finishing child rows. `test/reliefGroupList.test.ts` pins the
  // structure in happy-dom; this pins the real-browser rendering too.
  const group = page.locator(".tp-op-item.tp-op-group");
  await expect(group).toHaveCount(1);
  await expect(page.locator(".tp-op-item")).toHaveCount(1); // one card, not two
  await expect(group.locator(".tp-op-group-child")).toHaveCount(2);
  await expect(group.locator(".tp-op-group-stage").first()).toHaveText("Roughing");
  await expect(group.locator(".tp-op-group-stage").last()).toHaveText("Finishing");
});
