// @vitest-environment happy-dom
import { afterEach, expect, test } from "vitest";
import { chooseDxfUnits, recommendDxfUnit } from "../src/ui/dxfUnitsDialog";
import type { Bounds } from "../src/model/entities";

/**
 * The "what units?" prompt shown for a DXF that declares none. Its whole job is
 * to stop a pre-R13 inch drawing importing 25.4× too small, so what's tested is
 * that each button resolves to the scale it advertises, and that the sizes on
 * the buttons are the sizes the user will actually get.
 */

const bounds = (w: number, h: number): Bounds => ({ min: { x: 0, y: 0 }, max: { x: w, y: h } });

afterEach(() => {
  document.body.innerHTML = "";
});

const dialog = () => document.querySelector(".tp-dialog") as HTMLElement;
const unitBtn = (u: "mm" | "in") =>
  document.querySelector(`button[data-unit="${u}"]`) as HTMLButtonElement;

function open(w: number, h: number, recommended: "mm" | "in" = "in") {
  return chooseDxfUnits({ fileName: "clamps.dxf", bounds: bounds(w, h), recommended });
}

test("each button resolves to the unit it names", async () => {
  const inches = open(29, 9.08);
  unitBtn("in").click();
  expect(await inches).toBe("in");
  expect(document.querySelector(".tp-backdrop")).toBeNull();

  const mm = open(29, 9.08);
  unitBtn("mm").click();
  expect(await mm).toBe("mm");
});

test("buttons show the mm size each reading produces", async () => {
  const p = open(29, 9.08);
  // The real file that prompted this: 29 × 9.08 units of half-inch clamps.
  expect(unitBtn("in").textContent).toContain("736.6 × 230.6 mm");
  expect(unitBtn("mm").textContent).toContain("29 × 9.1 mm");
  expect(dialog().textContent).toContain("clamps.dxf");
  unitBtn("mm").click();
  await p;
});

test("cancelling resolves null so the import is abandoned, not guessed", async () => {
  const p = open(29, 9.08);
  const cancel = [...document.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Cancel"),
  ) as HTMLButtonElement;
  cancel.click();
  expect(await p).toBeNull();

  // Escape is the same answer — nothing may reach the document on a dismiss.
  const esc = open(29, 9.08);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(await esc).toBeNull();
});

test("the recommended reading is labelled and listed first", async () => {
  const p = open(29, 9.08, "in");
  const buttons = [...dialog().querySelectorAll("button[data-unit]")];
  expect(buttons[0].getAttribute("data-unit")).toBe("in");
  expect(unitBtn("in").textContent).toContain("Recommended");
  expect(unitBtn("mm").textContent).not.toContain("Recommended");
  unitBtn("in").click();
  await p;

  const q = open(600, 400, "mm");
  expect(dialog().querySelector("button[data-unit]")?.getAttribute("data-unit")).toBe("mm");
  unitBtn("mm").click();
  await q;
});

test("recommendDxfUnit: the file's own hint wins over the size heuristic", () => {
  expect(recommendDxfUnit(bounds(600, 400), "in")).toBe("in");
  expect(recommendDxfUnit(bounds(29, 9), "mm")).toBe("mm");
});

test("recommendDxfUnit: without a hint, a small span reads as inches", () => {
  expect(recommendDxfUnit(bounds(29, 9.08), null)).toBe("in"); // the clamps file
  expect(recommendDxfUnit(bounds(23.65, 23.59), null)).toBe("in"); // 12×9 ANSI-A sheet
  expect(recommendDxfUnit(bounds(600, 400), null)).toBe("mm"); // a metric sheet
  expect(recommendDxfUnit(bounds(0, 0), null)).toBe("mm"); // degenerate → no guess
});
