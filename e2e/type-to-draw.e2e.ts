/**
 * Type to Draw — the keyboard twin of drag-to-draw.e2e.ts.
 *
 * The endpoint arithmetic is unit-tested in test/lineTool.test.ts. What only a
 * browser can show is the part the unit tests stub out: that the Length/Angle
 * pair is actually BUILT and focused after the first click, that it lands where
 * the click did rather than off in a corner, that typing into it reaches the
 * tool, and that Enter commits and dismisses it.
 *
 * The editor is created on a `setTimeout(0)` from the pointer handler (see
 * App.openMultiValueEditor), so "does it exist yet" is a real question here in
 * a way it never is in a unit test.
 */
import { test, expect, waitForApp, APP_URL } from "./appFixture";
import type { Page } from "@playwright/test";

async function newProject(page: Page): Promise<void> {
  const welcome = page.locator(".welcome-backdrop");
  await welcome.locator(".welcome-card", { hasText: "New Project" }).click();
  await page.locator("#npd-backdrop .tp-apply-btn").click();
  await expect(welcome).toHaveCount(0);
}

/** Model millimetres -> viewport pixels, through the app's own viewport. */
async function toPx(page: Page, mm: [number, number]): Promise<{ x: number; y: number }> {
  return page.evaluate(([x, y]) => {
    const app = (
      window as unknown as {
        __app: {
          view: { worldToScreen(p: { x: number; y: number }): { x: number; y: number } };
          canvas: HTMLElement;
        };
      }
    ).__app;
    const p = app.view.worldToScreen({ x, y });
    const r = app.canvas.getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  }, mm);
}

/** Every line the user drew, as {a, b} in model mm. */
async function lines(page: Page): Promise<{ a: XY; b: XY }[]> {
  return page.evaluate(() =>
    (
      window as unknown as {
        __app: { doc: { entities: { id: string; a?: XY; b?: XY }[] } };
      }
    ).__app.doc.entities
      .filter((e) => e.id !== "__origin__" && e.a && e.b)
      .map((e) => ({ a: e.a as XY, b: e.b as XY })),
  );
}

interface XY {
  x: number;
  y: number;
}

const polar = (l: { a: XY; b: XY }) => ({
  length: Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y),
  degrees: (Math.atan2(l.b.y - l.a.y, l.b.x - l.a.x) * 180) / Math.PI,
});

test("press L, click once, type 50 and 30 — an exact 50mm line at 30° lands", async ({ page }) => {
  await page.goto(APP_URL);
  await waitForApp(page);
  await newProject(page);

  // The single-key shortcut, not the palette button — this is the keyboard path
  // start to finish.
  await page.keyboard.press("l");
  expect(
    await page.evaluate(
      () => (window as unknown as { __app: { tools: { active: { id: string } } } }).__app.tools.active.id,
    ),
  ).toBe("line");

  const start = await toPx(page, [60, 60]);
  await page.mouse.click(start.x, start.y);

  // 1. The pair exists, and it is a PAIR — Length and Angle, in that order.
  const editor = page.locator(".dim-multi-edit");
  await expect(editor).toBeVisible();
  const fields = editor.locator("input");
  await expect(fields).toHaveCount(2);
  await expect(fields.nth(0)).toHaveAttribute("placeholder", "Length (mm)");
  await expect(fields.nth(1)).toHaveAttribute("placeholder", "Angle (°)");

  // 2. It opened at the click, not somewhere else on the page. (It is offset a
  //    little so it does not sit under the crosshair.)
  const box = await editor.boundingBox();
  if (!box) throw new Error("the value editor has no box");
  expect(Math.abs(box.x - start.x), "editor is not near the click").toBeLessThan(80);
  expect(Math.abs(box.y - start.y), "editor is not near the click").toBeLessThan(80);

  // 3. It took focus, so you can type without clicking into it first.
  await expect(fields.nth(0)).toBeFocused();

  // 4. Type, Tab, type, Enter — no mouse.
  await page.keyboard.type("50");
  await page.keyboard.press("Tab");
  await page.keyboard.type("30");
  await page.keyboard.press("Enter");

  // 5. Exactly one line, at exactly the length and angle asked for.
  const drawn = await lines(page);
  expect(drawn).toHaveLength(1);
  const { length, degrees } = polar(drawn[0]);
  expect(length).toBeCloseTo(50, 6);
  expect(degrees).toBeCloseTo(30, 6);
  // It starts where the click landed — typing sets the far end, not both.
  expect(drawn[0].a.x).toBeCloseTo(60, 3);
  expect(drawn[0].a.y).toBeCloseTo(60, 3);

  // 6. And the editor is gone, not left floating over the canvas.
  await expect(editor).toHaveCount(0);
});

test("a length alone follows the cursor's direction", async ({ page }) => {
  await page.goto(APP_URL);
  await waitForApp(page);
  await newProject(page);

  await page.keyboard.press("l");
  const start = await toPx(page, [40, 40]);
  await page.mouse.click(start.x, start.y);
  await expect(page.locator(".dim-multi-edit")).toBeVisible();

  // Point up and to the right at 45°, a short way off, then ask for 80mm. The
  // direction comes from the mouse, the distance from the keyboard.
  const aim = await toPx(page, [50, 50]);
  await page.mouse.move(aim.x, aim.y);
  await page.keyboard.type("80");
  await page.keyboard.press("Enter");

  const drawn = await lines(page);
  expect(drawn).toHaveLength(1);
  const { length, degrees } = polar(drawn[0]);
  expect(length).toBeCloseTo(80, 6); // typed
  expect(degrees).toBeCloseTo(45, 1); // pointed
});

test("Circle takes an exact diameter", async ({ page }) => {
  await page.goto(APP_URL);
  await waitForApp(page);
  await newProject(page);

  await page.keyboard.press("c");
  const centre = await toPx(page, [80, 80]);
  await page.mouse.click(centre.x, centre.y);

  const editor = page.locator(".dim-multi-edit");
  await expect(editor).toBeVisible();
  // Diameter, not radius — a hole is specified the way it is drilled.
  await expect(editor.locator("input")).toHaveAttribute("placeholder", "Ø (mm)");

  await page.keyboard.type("12");
  await page.keyboard.press("Enter");

  const circle = await page.evaluate(
    () =>
      (
        window as unknown as {
          __app: { doc: { entities: { id: string; radius?: number }[] } };
        }
      ).__app.doc.entities.find((e) => typeof e.radius === "number") as { radius: number },
  );
  expect(circle.radius).toBeCloseTo(6, 6); // Ø12 -> r6
  await expect(editor).toHaveCount(0);
});

test("Escape dismisses the fields and draws nothing", async ({ page }) => {
  await page.goto(APP_URL);
  await waitForApp(page);
  await newProject(page);

  await page.keyboard.press("l");
  const start = await toPx(page, [70, 70]);
  await page.mouse.click(start.x, start.y);

  const editor = page.locator(".dim-multi-edit");
  await expect(editor).toBeVisible();
  await page.keyboard.type("120");
  await page.keyboard.press("Escape");

  await expect(editor).toHaveCount(0);
  expect(await lines(page)).toHaveLength(0);

  // The abandoned 120 must not leak into the next line: draw one by clicking
  // and check it is the length that was CLICKED.
  const a = await toPx(page, [20, 20]);
  const b = await toPx(page, [50, 20]);
  await page.mouse.click(a.x, a.y);
  await page.mouse.move(b.x, b.y);
  await page.mouse.click(b.x, b.y);

  const drawn = await lines(page);
  expect(drawn).toHaveLength(1);
  expect(polar(drawn[0]).length).toBeCloseTo(30, 1);
});
