/**
 * The solve path, end to end, through the real app.
 *
 * `test/solveCoordinator.test.ts` covers the orchestration in isolation. This
 * covers the half that unit tests structurally cannot: that the coordinator is
 * actually CONSTRUCTED and WIRED — that its verdict reaches the status bar. A
 * green suite once coexisted with stock-thickness changes re-driving nothing,
 * because every assertion stopped at the model and none looked at the screen.
 *
 * Assertions read user-visible text rather than the App's fields. The status bar
 * is the contract; the wiring behind it is free to move.
 *
 * NB on fixtures: do NOT reach for a `fixed` constraint to build a
 * "fully constrained" case. Fixed geometry contributes no solver variables, so
 * `solveStatusLabel` returns null and the status bar goes BLANK — an assertion
 * that the bar does not say "Under-constrained" then passes against an app
 * rendering nothing at all. The cases below compare DOF *counts* instead, which
 * cannot pass on a blank bar.
 */
import { expect, openDoc, test } from "./appFixture";
import type { Page } from "@playwright/test";
import { CADDocument } from "../src/model/document";
import { LineEntity } from "../src/model/entities";
import { makeConstraint } from "../src/model/constraints";
import { serializeDoc } from "../src/io/fileio";

/** Two unconstrained lines: 8 solver variables, none removed → 8 DOF. */
function looseSketch(): string {
  const doc = new CADDocument({ width: 300, height: 200 }, "mm");
  doc.add(new LineEntity({ x: 20, y: 20 }, { x: 120, y: 20 }));
  doc.add(new LineEntity({ x: 120, y: 20 }, { x: 120, y: 90 }));
  return JSON.stringify(serializeDoc(doc, "solve-wiring-loose"));
}

/** The same two lines, pinned down to 4 DOF by three constraints. */
function constrainedSketch(): string {
  const doc = new CADDocument({ width: 300, height: 200 }, "mm");
  const a = doc.add(new LineEntity({ x: 20, y: 20 }, { x: 120, y: 20 }));
  const b = doc.add(new LineEntity({ x: 120, y: 20 }, { x: 120, y: 90 }));
  doc.addConstraint(makeConstraint("horizontal", { entities: [a.id] }));
  doc.addConstraint(makeConstraint("vertical", { entities: [b.id] }));
  doc.addConstraint(
    makeConstraint("coincident", {
      points: [
        { entityId: a.id, key: "b" },
        { entityId: b.id, key: "a" },
      ],
    }),
  );
  return JSON.stringify(serializeDoc(doc, "solve-wiring-constrained"));
}

const statusText = async (page: Page): Promise<string> =>
  (await page.locator(".status-item").allTextContents()).join(" | ");

test("the status bar reports the loose sketch's real DOF count", async ({ page }) => {
  await openDoc(page, looseSketch());
  await expect.poll(() => statusText(page), { timeout: 8000 }).toMatch(/Under-constrained/i);
  await expect.poll(() => statusText(page)).toMatch(/\b8\s*free/i);
});

test("adding constraints lowers the reported DOF", async ({ page }) => {
  // The positive control for the test above: 8 and 4 come from the same code
  // path on different documents, so neither can be a hardcoded label.
  await openDoc(page, constrainedSketch());
  await expect.poll(() => statusText(page), { timeout: 8000 }).toMatch(/\b4\s*free/i);
});

test("changing stock thickness re-drives the solve without throwing", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await openDoc(page, looseSketch());
  await expect.poll(() => statusText(page), { timeout: 8000 }).toMatch(/\b8\s*free/i);

  await page.evaluate(() => {
    const app = (
      window as unknown as {
        __app: { project: { doc: { stockThickness: number; emitChange(): void } } };
      }
    ).__app;
    app.project.doc.stockThickness = 25;
    app.project.doc.emitChange();
  });

  await expect.poll(() => statusText(page), { timeout: 8000 }).toMatch(/\b8\s*free/i);
  expect(errors, "changing stock thickness threw").toEqual([]);
});
