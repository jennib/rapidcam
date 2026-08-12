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
 *
 * It also drives an over-long title in by hand rather than relying on a real
 * one being long enough. The first version pinned that to "Kumiko Panel
 * (Asanoha)" and went vacuous the moment that generator was renamed to "Kumiko
 * Panel": the collision check still passed, but nothing in the run wrapped, so
 * the spec was no longer testing the thing it exists for.
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

  // Whatever the title is, the full text must stay reachable — the clip is only
  // acceptable because hovering still gives you the name.
  await expect(featureTitle).toHaveAttribute("title", /Kumiko Panel/);

  // Now force the case the CSS actually guards. The real title only wraps while
  // some generator's name happens to be long enough, which is not a property
  // this spec should depend on: it was originally pinned to "Kumiko Panel
  // (Asanoha)" and went vacuous the moment that generator was renamed. Driving
  // an over-long title in directly keeps the guard meaningful no matter what
  // anything is called.
  await featureTitle.evaluate((el) => {
    el.textContent = "Feature · A Preposterously Over-Long Generator Name That Must Not Wrap";
  });
  const clipped = await featureTitle.evaluate((el) => el.scrollWidth > el.clientWidth);
  // Collision first, control second — ALWAYS this way round here. Without the
  // fix the long title wraps rather than clipping, so `clipped` is false too,
  // and checking it first would fail the spec on the control while saying
  // nothing about the overlap that actually regressed.
  expect(await collisions(page)).toEqual([]);
  expect(clipped).toBe(true); // and the wrap case was genuinely exercised
});
