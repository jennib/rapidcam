/**
 * A properties section's title may not overlap the controls beneath it.
 *
 * `.props-section-title` is a faux fieldset legend: absolutely positioned so it
 * sits ON the section's border. Being out of flow, it pushes nothing aside, and
 * `.props-section` budgets exactly one line of top padding for it — so a title
 * long enough to WRAP drops its second line straight onto the section's first
 * row. That shipped: "Feature · Kumiko Panel (Asanoha)" laid its second line
 * over the group's Name field and its input.
 *
 * `unreachable-controls.e2e.ts` guards the neighbouring bug class and stayed
 * green throughout, correctly — it looks for content laid out past a hard
 * horizontal edge, and this is a vertical collision between two elements that
 * are each inside their container. Same root lesson though: happy-dom has no
 * layout engine, so every structural assertion passed while the panel was
 * visibly broken.
 *
 * The guard is written against the geometry rather than against the one title
 * that broke, so any future section title — a long generator name, a freely
 * typed feature name — is covered.
 */
import { test, expect, waitForApp } from "./appFixture";
import type { Page } from "@playwright/test";

interface Collision {
  title: string;
  overlapPx: number;
}

/** Section titles whose box intrudes into the first row of their own section. */
async function collisions(page: Page): Promise<Collision[]> {
  return page.evaluate(() => {
    const out: Collision[] = [];
    for (const t of document.querySelectorAll<HTMLElement>(".props-section-title")) {
      const sec = t.parentElement;
      if (!sec) continue;
      const cs = getComputedStyle(t);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const first = [...sec.children].find(
        (c): c is HTMLElement => c instanceof HTMLElement && c !== t,
      );
      if (!first) continue;
      const tb = t.getBoundingClientRect();
      const fb = first.getBoundingClientRect();
      if (tb.height === 0 || fb.height === 0) continue;
      // Horizontal ranges always overlap here (the title is inset from the same
      // left edge), so a vertical intrusion is a real collision.
      const overlapPx = tb.bottom - fb.top;
      if (overlapPx > 1) out.push({ title: t.textContent ?? "", overlapPx: Math.round(overlapPx) });
    }
    return out;
  });
}

test("no properties section title overlaps its own first row", async ({ page }) => {
  await page.goto("/");
  await waitForApp(page);

  const welcome = page.locator(".welcome-backdrop");
  await welcome.locator(".welcome-card", { hasText: "New Project" }).click();
  await page.locator("#npd-backdrop .tp-apply-btn").click();
  await expect(welcome).toHaveCount(0);

  // The generator with the longest name in the registry — the one that broke.
  await page.getByRole("button", { name: "Insert" }).click();
  await page.locator(".fmenu-item", { hasText: /^Kumiko/ }).click();
  const dialog = page.locator(".tp-dialog");
  await expect(dialog).toBeVisible();
  await dialog.locator(".tp-apply-btn").click();
  await expect(dialog).toHaveCount(0);

  // Selecting the whole feature renders the "Feature · <generator name>"
  // section, which is where the wrap happened.
  await page.keyboard.press("Control+a");
  const featureTitle = page.locator(".props-section-title", { hasText: /^Feature/ });
  await expect(featureTitle).toBeVisible();

  // The defect itself, asserted first: reverting the CSS fix reports this
  // section overlapping its Name row by ~13px.
  expect(await collisions(page)).toEqual([]);

  // Positive control: the title really is long enough that it WOULD wrap, so
  // the clean result above means the fix holds rather than that the case never
  // arose. (Checked after the collision assertion — as a guard on a guard, it
  // must not be what fails when the real bug returns.)
  const clipped = await featureTitle.evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(clipped).toBe(true);
  // ...and the full text stays reachable despite the clip.
  await expect(featureTitle).toHaveAttribute("title", /Kumiko Panel \(Asanoha\)/);
});
