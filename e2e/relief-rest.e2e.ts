/**
 * Rest machining on a relief-rough toolpath, through the real dialog.
 *
 * `restToolDiameter` was a pocket-only field in three separate places — the row's
 * visibility, the operation the dialog builds, and the emitter — and unit tests
 * can see only the third. happy-dom has no layout, so it cannot tell a hidden row
 * from a shown one; and a G-code test never opens a dialog. Both gates need the
 * app.
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

test("the Rest row shows for relief roughing, and hides for a profile", async ({ page }) => {
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

  await typeSelect.selectOption("relief-rough");
  await expect(row).toBeVisible();
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
test("a rest diameter typed on a relief-rough op survives into the document", async ({ page }) => {
  await openDoc(page, reliefDoc());
  await openToolpathDialog(page);

  await page.locator(".tp-dialog select").first().selectOption("relief-rough");
  const input = restRow(page).locator("input").first();
  await expect(input).toBeVisible();
  await input.fill("8");
  await input.blur();
  await page.locator(".tp-dialog button", { hasText: /^Apply$/ }).first().click();
  await expect(page.locator(".tp-dialog")).toHaveCount(0);

  const saved = await page.evaluate(() => {
    const doc = (
      window as unknown as {
        __app: { doc: { operations: { type: string; restToolDiameter?: number }[] } };
      }
    ).__app.doc;
    const op = doc.operations.find((o) => o.type === "relief-rough");
    return op ? { type: op.type, rest: op.restToolDiameter ?? null } : null;
  });
  expect(saved).toEqual({ type: "relief-rough", rest: 8 });
});
