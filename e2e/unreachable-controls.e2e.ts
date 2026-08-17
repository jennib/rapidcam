/**
 * No control may be laid out past the edge of a container that cannot scroll.
 *
 * This exists because of a real regression. The Layers panel is ~225px and its
 * row already carried six controls at its limit on a mill; adding the laser beam
 * toggle laid that button and **Delete Layer** out past the panel's right edge —
 * Delete by 30px, i.e. permanently unclickable on any laser document.
 *
 * Nothing else in the suite could have caught it. The unit tests assert the
 * model and the happy-dom component tests assert structure, but happy-dom has no
 * layout engine, so every `querySelector` was green while the UI was broken. It
 * took a screenshot to notice, which is not a method.
 *
 * So the guard is deliberately app-wide rather than scoped to the panel that
 * broke: a sweep for any element whose content overflows horizontally, which is
 * not scrollable, and which has a real control in the overflowing part. A
 * horizontal scrollbar is fine — the user can reach it. Content simply laid out
 * past a hard edge is not.
 *
 * The app measured clean in every scene below at the time of writing, so a
 * failure here is a new defect, not a pre-existing backlog item.
 */
import { test, expect, openDoc, waitForApp, APP_URL } from "./appFixture";
import type { Page } from "@playwright/test";
import { CADDocument } from "../src/model/document";
import { LineEntity, RectEntity } from "../src/model/entities";
import { makeConstraint } from "../src/model/constraints";
import { serializeDoc } from "../src/io/fileio";

/** A control laid out beyond a container that offers no way to scroll to it. */
interface Unreachable {
  container: string;
  overBy: number;
  controls: string[];
}

/**
 * Every unreachable control currently on screen.
 *
 * Skips containers that scroll horizontally, and reports only when an actual
 * button/input/select ends up outside — text spilling is a cosmetic question,
 * an out-of-reach control is a broken feature.
 */
async function unreachableControls(page: Page): Promise<Unreachable[]> {
  return page.evaluate(() => {
    const out: Unreachable[] = [];
    for (const el of document.querySelectorAll("*")) {
      if (!(el instanceof HTMLElement)) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      if (/auto|scroll/.test(cs.overflowX)) continue; // reachable by scrolling
      if (el.clientWidth === 0) continue; // not laid out
      const overBy = el.scrollWidth - el.clientWidth;
      if (overBy <= 1) continue;
      const box = el.getBoundingClientRect();
      const lost = [...el.querySelectorAll("button, input, select, textarea")].filter((c) => {
        const r = c.getBoundingClientRect();
        return r.width > 0 && r.right > box.right + 0.5;
      });
      if (lost.length === 0) continue;
      out.push({
        container:
          el.tagName.toLowerCase() +
          (el.id ? `#${el.id}` : "") +
          (typeof el.className === "string" && el.className.trim()
            ? `.${el.className.trim().split(/\s+/).join(".")}`
            : ""),
        overBy: Math.round(overBy),
        controls: lost
          .slice(0, 4)
          .map((c) =>
            (
              (c as HTMLElement).title ||
              c.textContent ||
              (c as HTMLInputElement).value ||
              c.tagName
            )
              .toString()
              .trim()
              .slice(0, 32),
          ),
      });
    }
    return out;
  });
}

/** The worst case for width: several layers, a fixture, and beam recipes. */
async function crowdTheLayersPanel(page: Page): Promise<void> {
  await page.evaluate(() => {
    const doc = (window as unknown as { __app: { doc: Record<string, unknown> } }).__app.doc as {
      machineKind: string;
      layers: Record<string, unknown>[];
      emitChange: () => void;
    };
    doc.machineKind = "laser";
    // A name someone would really type, not "Cut" — the field flexes, so a long
    // one is what squeezes the buttons.
    doc.layers[0].name = "Cut through 6mm birch plywood";
    // A CUT kind renders the tallest the beam row ever gets: job-kind picker AND
    // kerf-side picker on top of the three number fields and the preset select.
    doc.layers[0].laser = {
      kind: "cut",
      feedrate: 300,
      laserPower: 100,
      laserPasses: 3,
      kerfWidth: 0.2,
    };
    doc.layers.push({
      id: "l-score",
      name: "Score",
      color: "#e05a5a",
      visible: true,
      locked: false,
      laser: { kind: "score", feedrate: 1800, laserPower: 15, laserPasses: 1 },
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
  // The controls added latest are the ones a layout guard is most likely to
  // miss — assert they are on screen, or a clean sweep says nothing about them.
  await expect(page.locator("#layersbar .layer-beam-kind")).toHaveCount(2);
  await expect(page.locator("#layersbar .layer-beam-side")).toHaveCount(1);
}

test("no control is laid out beyond a container that cannot scroll", async ({ page }) => {
  await page.goto(APP_URL);
  await waitForApp(page);

  expect(await unreachableControls(page)).toEqual([]);

  await crowdTheLayersPanel(page);
  // Positive control: the crowded row really was built, so a clean sweep means
  // "seven controls fit" rather than "the hard case never rendered".
  await expect(page.locator("#layersbar .layer-beam-toggle")).toHaveCount(2);
  expect(await unreachableControls(page)).toEqual([]);

  // The CAM panel, which the beam summary writes into.
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll(".rtab")].find((t) =>
      /CAM/i.test(t.textContent ?? ""),
    );
    (tab as HTMLElement | undefined)?.click();
  });
  expect(await unreachableControls(page)).toEqual([]);

  // And back on a mill, where the layer row was already at its limit before the
  // beam toggle existed.
  await page.evaluate(() => {
    const doc = (
      window as unknown as { __app: { doc: { machineKind: string; emitChange: () => void } } }
    ).__app.doc;
    doc.machineKind = "mill";
    doc.emitChange();
  });
  await expect(page.locator("#layersbar .layer-beam-toggle")).toHaveCount(0);
  expect(await unreachableControls(page)).toEqual([]);
});

test("the design tree fits its rows, including the eye and lock", async ({ page }) => {
  // Via a real document rather than `goto`: the tree only has rows to squeeze
  // if there is geometry, and this route also clears the welcome screen.
  const doc = new CADDocument({ width: 200, height: 150 }, "mm");
  doc.add(new RectEntity({ x: 10, y: 10 }, { x: 90, y: 60 }));
  // A constraint row is the densest in the panel — glyph, name, subject and a
  // delete button all inside 250px — so the sweep needs one present.
  const a = doc.add(new LineEntity({ x: 10, y: 100 }, { x: 90, y: 100 }));
  const b = doc.add(new LineEntity({ x: 10, y: 100 }, { x: 10, y: 140 }));
  doc.addConstraint(makeConstraint("perpendicular", { entities: [a.id, b.id] }));
  await openDoc(page, JSON.stringify(serializeDoc(doc, "one-rect")));
  await page.locator("#design-tree-toggle").click();
  // Settle the open animation before sweeping. The panel slides 0 → 250px and
  // its contents are a fixed-width shell it clips, so mid-flight the shell is
  // legitimately wider than its parent. This guard is about controls that are
  // permanently out of reach, not ones 100ms from arriving.
  await expect
    .poll(async () => (await page.locator(".design-tree-panel").boundingBox())?.width ?? 0)
    .toBe(250);

  // A long custom name is what squeezes a row: the label flexes and the two
  // action buttons sit to the right of it inside a 250px panel.
  await page.evaluate(() => {
    const doc = (
      window as unknown as {
        __app: {
          doc: {
            entities: { id: string; name?: string; locked?: boolean }[];
            layers: { name: string }[];
            groups: { id: string; name: string; entityIds: string[] }[];
            emitChange: () => void;
          };
        };
      }
    ).__app.doc;
    doc.layers[0].name = "Cut through 6mm birch plywood";
    // NOT entities[0] — that is the hidden WCS origin point, which the tree
    // filters out, so naming it renders nothing at all.
    const ent = doc.entities.find((e) => e.id !== "__origin__")!;
    ent.name = "Cabinet hinge cup bore, left stile";
    // A long name also lands in the constraint subjects below it.
    doc.entities[doc.entities.length - 1].name = "Left stile reference edge";
    ent.locked = true; // pins the lock button visible rather than hover-only
    doc.groups.push({
      id: "grp-long",
      name: "Concealed hinge boring pattern (35mm)",
      entityIds: [ent.id],
    });
    doc.emitChange();
  });

  // Positive control: the crowded rows really rendered, so a clean sweep below
  // means "they fit" and not "the hard case never appeared".
  await expect(
    page.locator(".tree-row", { hasText: "Cabinet hinge cup bore, left stile" }),
  ).toHaveCount(1);
  // Two: the entity's own lock, and its group's, which reads locked because
  // every member is. Both are pinned visible, which is the crowded case.
  await expect(page.locator(".tree-action-btn.on")).toHaveCount(2);
  // An object row is eye + lock + bin beside a flexing label; the constraint
  // row below adds a subject. Both must have been rendered for the sweep to
  // mean anything.
  await expect(
    page.locator(".tree-row", { hasText: "Cabinet hinge cup bore, left stile" })
      .locator(".tree-action-btn"),
  ).toHaveCount(3);
  // And the constraint row, whose long subject is the widest thing in the panel.
  await expect(
    page.locator(".tree-row", { hasText: "Perpendicular" }).locator(".tree-subject"),
  ).toHaveText(/Left stile reference edge/);

  expect(await unreachableControls(page)).toEqual([]);
});

test("the Add Toolpath dialog fits its controls too", async ({ page }) => {
  await page.goto(APP_URL);
  await waitForApp(page);
  await crowdTheLayersPanel(page);

  await page.evaluate(() => {
    const doc = (
      window as unknown as {
        __app: { doc: { entities: { selected: boolean }[]; emitChange: () => void } };
      }
    ).__app.doc;
    for (const e of doc.entities) e.selected = true;
    doc.emitChange();
    (document.querySelector(".cam-add-btn") as HTMLElement | null)?.click();
  });

  await expect(page.locator(".tp-dialog")).toBeVisible();
  expect(await unreachableControls(page)).toEqual([]);
});

test("the Add Toolpath dialog fits the tapered ball-nose's extra tip field", async ({ page }) => {
  await page.goto(APP_URL);
  await waitForApp(page);
  // Deliberately NOT crowdTheLayersPanel(): it switches the document to a LASER
  // to make the beam rows render, and a laser has no cutter — the tool-type
  // select is then correctly hidden, so selecting a milling tool in it can never
  // succeed. (That is what this test did when it was written, and it timed out
  // waiting for a control the app was right to hide.) The crowding is about the
  // layers panel anyway; this test is about the DIALOG, which is a modal of its
  // own and is swept whole below.

  await page.evaluate(() => {
    const doc = (
      window as unknown as {
        __app: { doc: { entities: { selected: boolean }[]; emitChange: () => void } };
      }
    ).__app.doc;
    for (const e of doc.entities) e.selected = true;
    doc.emitChange();
    (document.querySelector(".cam-add-btn") as HTMLElement | null)?.click();
  });

  await expect(page.locator(".tp-dialog")).toBeVisible();
  // The tapered tool reveals the V-angle and Ball-Tip rows — the one case the
  // default end-mill dialog never renders, and the one only a real layout sweep
  // (not a querySelector) can check.
  await page.locator('[data-testid="tool-type-select"]').selectOption("tapered-ball-nose");
  expect(await unreachableControls(page)).toEqual([]);
});

test("Delete Layer stays clickable — it is the control that was pushed out", async ({ page }) => {
  await page.goto(APP_URL);
  await waitForApp(page);
  await crowdTheLayersPanel(page);

  const del = page.locator("#layersbar .layer-row").first().locator("button.icon-btn").last();
  await expect(del).toHaveAttribute("title", "Delete Layer");
  await expect(del).toBeEnabled();

  // `toBeVisible` passes for an element sitting outside its parent's box, so
  // assert what actually broke: its right edge is inside the panel.
  const box = await del.boundingBox();
  const panel = await page.locator("#layersbar").boundingBox();
  if (!box || !panel) throw new Error("Delete button or panel has no box");
  expect(box.x + box.width).toBeLessThanOrEqual(panel.x + panel.width + 0.5);
});
