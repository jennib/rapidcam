import type { Page } from "@playwright/test";
import { expect, openDoc, test } from "./appFixture";
import { CADDocument } from "../src/model/document";
import { LineEntity } from "../src/model/entities";
import { makeConstraint } from "../src/model/constraints";
import { makeDimension } from "../src/model/dimensions";
import { serializeDoc } from "../src/io/fileio";

/**
 * Regression guard for the dim-editor retry-after-rejection path — the one place
 * commitDimValue's re-resolve-by-id actually matters, and the one thing a unit
 * test can't reach (App needs a real canvas/DOM). See test/dimRestoreIdentity.ts
 * for the model-level invariant this exercises end to end.
 *
 * Scenario: a triangle whose base A–B is pinned (two fixedPoint constraints) with
 * the apex C shared via coincident. Two driving distance dims give |CA| and |CB|.
 * Driving |CA| to an impossible length (circles no longer intersect) makes the
 * solver diverge, so the edit is rejected and the editor stays open. commitDimValue
 * rolls back with doc.restore(), which REBUILDS every Dimension object. If the retry
 * then targeted the editor's now-orphaned reference, the corrected value would be a
 * silent no-op; re-resolving by id is what makes the corrected retry actually land.
 */

/** Build the .rcam text for the pinned-base triangle described above. */
function trianglePinnedBase(): string {
  const doc = new CADDocument({ width: 300, height: 200 }, "mm");
  // Base A(0,0)–B(80,0); apex C starts at (40,40). CA is edited, CB is held at 40.
  const ca = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 40, y: 40 })) as LineEntity; // a=A, b=C
  const cb = doc.add(new LineEntity({ x: 80, y: 0 }, { x: 40, y: 40 })) as LineEntity; // a=B, b=C

  doc.addConstraint(
    makeConstraint("fixedPoint", { points: [{ entityId: ca.id, key: "a" }], params: [0, 0] }),
  );
  doc.addConstraint(
    makeConstraint("fixedPoint", { points: [{ entityId: cb.id, key: "a" }], params: [80, 0] }),
  );
  doc.addConstraint(
    makeConstraint("coincident", {
      points: [
        { entityId: ca.id, key: "b" },
        { entityId: cb.id, key: "b" },
      ],
    }),
  );
  // |CA| = 50 — the dimension the test edits.
  doc.addDimension(
    makeDimension("distance", {
      points: [
        { entityId: ca.id, key: "a" },
        { entityId: ca.id, key: "b" },
      ],
      value: 50,
      offset: 12,
    }),
  );
  // |CB| = 40 — held, so |CA| has a feasible band (~[40,120]) but not 200.
  doc.addDimension(
    makeDimension("distance", {
      points: [
        { entityId: cb.id, key: "a" },
        { entityId: cb.id, key: "b" },
      ],
      value: 40,
      offset: 12,
    }),
  );
  return JSON.stringify(serializeDoc(doc, "dim-retry"));
}

/** Open the |CA| dimension's editor and return its stable id. */
function openCaDimEditor(page: Page): Promise<string> {
  return page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const app = (window as any).__app;
    const doc = app.project.doc;
    // The two distance dims are 50 (CA) and 40 (CB); pick the 50 one.
    const dim = doc.dimensions.find((d: { value: number }) => Math.round(d.value) === 50);
    app.openDimEditor(dim);
    return dim.id as string;
  });
}

function liveDimValue(page: Page, id: string): Promise<number> {
  return page.evaluate((dimId) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doc = (window as any).__app.project.doc;
    return doc.dimensions.find((d: { id: string }) => d.id === dimId).value as number;
  }, id);
}

test("a rejected dimension edit, then a corrected retry, actually applies the corrected value", async ({
  page,
}) => {
  await openDoc(page, trianglePinnedBase());

  const caDimId = await openCaDimEditor(page);
  const input = page.locator("input.dim-edit");
  await expect(input).toBeVisible();

  // 1) Impossible length → solver diverges → edit rejected → editor stays open.
  await input.fill("200");
  await input.press("Enter");
  await expect(input).toBeVisible();
  // The value the editor holds must NOT have been committed.
  expect(Math.round(await liveDimValue(page, caDimId))).toBe(50);

  // 2) Corrected, feasible length → converges → editor closes AND the value lands.
  await input.fill("70");
  await input.press("Enter");
  await expect(input).toHaveCount(0);
  expect(Math.round(await liveDimValue(page, caDimId))).toBe(70);
});
