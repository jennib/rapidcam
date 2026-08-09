/**
 * Does an image survive the recents round trip?
 *
 * `pushRecent` stores `stripEmbeddedFonts(data)`, which drops the `images` array
 * as well as `fonts` (fileio.ts). Fonts that fail to resolve after a load are
 * caught by `warnMissingFonts()`; the image equivalent, `isImageResolvable`, has
 * no production caller. This walks the real user path to find out what actually
 * happens:
 *
 *   session A  open a design with an image -> Save (writes the stripped recent)
 *   reload     module-level IMAGES map starts empty again
 *   session B  open that recent -> is the image still there? -> Save again
 *
 * The two saved files are the evidence: session A's download is the control.
 */
import { readFileSync } from "node:fs";
import { test, expect, waitForApp } from "./appFixture";
import { buildOpenUrl } from "../cli/open";
import { APP_URL } from "./appFixture";
import { StorageKeys } from "../src/core/storageKeys";

/** 4x4 greyscale: top half black (0), bottom half white (255). */
const PIXELS = Buffer.from([
  0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255,
]).toString("base64");

const IMAGE_ID = "img-deadbeef";

/** The same one-entity design, with or without the pixels it references. */
function design(withPixels: boolean): string {
  const file = JSON.parse(DESIGN);
  if (!withPixels) file.images = undefined;
  return JSON.stringify(file);
}

const DESIGN = JSON.stringify({
  version: 3,
  name: "Image Probe",
  canvas: { width: 100, height: 100 },
  displayUnit: "mm",
  stockThickness: 3,
  origin: { x: "left", y: "front", z: "top" },
  groups: [],
  layers: [
    { id: "layer-0", name: "Default", color: "#cdd2da", visible: true, locked: false },
  ],
  activeLayerId: "layer-0",
  entities: [
    {
      type: "image",
      id: "img-ent-1",
      imageId: IMAGE_ID,
      position: { x: 20, y: 20 },
      widthMM: 60,
      heightMM: 60,
      angle: 0,
      layerId: "layer-0",
    },
  ],
  constraints: [],
  dimensions: [],
  variables: [],
  bindings: [],
  patterns: [],
  operations: [],
  tools: [],
  images: [{ id: IMAGE_ID, name: "probe", width: 4, height: 4, data: PIXELS }],
});

/**
 * Count near-WHITE pixels on the drawing canvas.
 *
 * White, not black: the canvas background is dark, so counting dark pixels
 * mostly counts the background and barely moves whether the image draws or not
 * (325765 vs 293239 on the first run — a metric that "passed" for no reason).
 * The probe image's bottom half is pure white, and nothing else in this
 * one-entity design is, so white is the honest discriminator.
 */
async function whitePixelCount(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => {
    const cv = document.querySelector("canvas") as HTMLCanvasElement;
    const ctx = cv.getContext("2d")!;
    const { data } = ctx.getImageData(0, 0, cv.width, cv.height);
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 230 && data[i + 1] > 230 && data[i + 2] > 230 && data[i + 3] > 200) n++;
    }
    return n;
  });
}

/** Drive File ▸ Save and return the .rcam text the app actually wrote. */
async function saveAndRead(page: import("@playwright/test").Page, name: string): Promise<string> {
  page.once("dialog", (d) => d.accept(name)); // the `prompt("Save as:")` fallback
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.evaluate(() => (window as any).__app.project.fileSave()),
  ]);
  return readFileSync(await download.path(), "utf8");
}

test("an image survives a save, a reload, and reopening from Recents", async ({ page }) => {
  // Force the `prompt()` + download branch of fileSave: showSaveFilePicker needs
  // user activation that page.evaluate cannot supply, and its rejection path is
  // browser-version dependent. Removing it takes the same branch a Firefox user
  // takes, deterministically.
  await page.addInitScript(() => {
    delete (window as any).showSaveFilePicker;
  });

  // ---- session A: the design as authored, image embedded --------------------
  await page.goto(await buildOpenUrl(DESIGN, APP_URL));
  await waitForApp(page);

  const whiteBefore = await whitePixelCount(page);
  await page.locator("canvas").first().screenshot({ path: "test-results/A-authored.png" });
  expect(whiteBefore, "positive control: the image should be visible on load").toBeGreaterThan(100);

  const savedA = await saveAndRead(page, "Image Probe");
  const fileA = JSON.parse(savedA);
  expect(fileA.images, "session A's saved file should embed the pixels").toHaveLength(1);
  expect(fileA.entities.filter((e: { type: string }) => e.type === "image")).toHaveLength(1);

  // What actually landed in Recents?
  const recent = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? "[]")[0],
    StorageKeys.recents,
  );
  expect(recent, "the save should have written a recent").toBeTruthy();
  const recentHasImages = Boolean(recent.data.images?.length);

  // ---- reload: the module-level IMAGES registry starts empty -----------------
  await page.reload();
  await waitForApp(page);

  // Watch for any warning during the reopen ONLY — `warnMissingFonts` uses a
  // native alert(), so a missing-image warning would surface the same way. The
  // handler comes off again before the next save, whose prompt() must be
  // answered rather than dismissed.
  const dialogs: string[] = [];
  const collect = (d: import("@playwright/test").Dialog) => {
    dialogs.push(d.message());
    void d.dismiss();
  };
  page.on("dialog", collect);

  // ---- session B: reopen it from Recents, the way a user actually would ------
  // The welcome screen offers it as "Resume Last Project" — click that rather
  // than calling fileOpenRecent(), so this exercises the real entry point.
  await page.getByText("Resume Last Project").click();
  await expect(page.locator(".welcome-backdrop")).toHaveCount(0);
  await page.waitForTimeout(500); // let the load + solve + fit settle
  page.off("dialog", collect);

  const entityStillThere = await page.evaluate(
    () =>
      (window as any).__app.project.doc.entities.filter(
        (e: { type: string }) => e.type === "image",
      ).length,
  );
  const whiteAfter = await whitePixelCount(page);
  await page.locator("canvas").first().screenshot({ path: "test-results/B-from-recents.png" });

  const savedB = await saveAndRead(page, "Image Probe 2");
  const fileB = JSON.parse(savedB);

  console.log("\n================ RESULT ================");
  console.log("recent entry carries images[]      :", recentHasImages);
  console.log("white px (image body), session A     :", whiteBefore);
  console.log("white px (image body), session B     :", whiteAfter);
  console.log("image entities still in doc        :", entityStillThere);
  console.log("session A saved file  images[]     :", fileA.images?.length ?? 0);
  console.log("session B saved file  images[]     :", fileB.images?.length ?? 0);
  console.log("session B saved file  image ents   :",
    fileB.entities.filter((e: { type: string }) => e.type === "image").length);
  console.log("dialogs shown on the reopen        :", dialogs.length ? dialogs : "(none)");
  console.log("========================================\n");

  // The claims under test.
  expect(entityStillThere, "the image entity should still be in the document").toBe(1);
  expect(whiteAfter, "the image should still be visible after reopening from Recents").toBeGreaterThan(100);
  expect(fileB.images ?? [], "re-saving must not drop the embedded pixels").toHaveLength(1);
});

/**
 * The IndexedDB payload fixes the Recents path, but a file can still arrive with
 * an image it has no pixels for — an AI-authored .rcam, a hand-written one, a
 * recent saved before the payload store existed, or any load when IndexedDB is
 * unavailable. Fonts have warned about exactly this for years; images did not,
 * which is what let the loss happen in silence. This is that warning.
 */
test("an image with no pixels warns on load instead of failing silently", async ({ page }) => {
  await page.goto(await buildOpenUrl(design(false), APP_URL));
  await waitForApp(page);

  await expect(
    page.getByRole("status").filter({ hasText: "could not be loaded" }),
    "the user must be told the pixels are missing",
  ).toBeVisible();

  // And the drawing shows the dashed placeholder, not the picture.
  expect(await whitePixelCount(page), "no pixels to draw").toBe(0);
});
