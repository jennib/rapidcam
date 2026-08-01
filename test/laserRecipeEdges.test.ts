// @vitest-environment happy-dom
/**
 * What a layer beam recipe does at its edges.
 *
 * These numbers go to a machine that burns things, so the question worth asking
 * is not "does it round-trip" but "what reaches the controller if someone types
 * a zero".
 *
 * A zero FEED was reachable through the layers panel and nowhere else: the
 * toolpath dialog clamps its feed field to 1, and the file schema forbids
 * anything at or below zero (exclusiveMinimum 0), but the panel field I added
 * had no floor. `F0` is not a slow cut — a controller rejects or stalls on it.
 *
 * A zero POWER stays legal on purpose: it traces the path with the beam off,
 * which is a dry run, and the schema allows it (minimum 0).
 */

import { beforeEach, expect, test } from "vitest";
import { LayersBar } from "../src/ui/layersBar";
import { buildJobFromLayers } from "../src/cam/laserJob";
import { generateLaserGCode } from "../src/cam/lasergcode";
import { estimateGCodeTime } from "../src/cam/timeEstimate";
import { CADDocument } from "../src/model/document";
import { RectEntity } from "../src/model/entities";
import type { LaserRecipe } from "../src/cam/types";

beforeEach(() => {
  document.body.innerHTML = "";
});

function docWith(recipe: LaserRecipe): CADDocument {
  const doc = new CADDocument({ width: 300, height: 200 });
  doc.machineKind = "laser";
  doc.origin = { x: "left", y: "front", z: "top" };
  doc.layers[0].name = "Cut";
  doc.layers[0].laser = recipe;
  doc.entities.push(new RectEntity({ x: 20, y: 20 }, { x: 120, y: 100 }, "outline"));
  doc.operations = buildJobFromLayers(doc).operations;
  return doc;
}

/**
 * Mount the layers panel ONCE and switch a recipe on.
 *
 * Returns a live accessor rather than the elements: the panel re-renders on
 * every change, so the inputs are replaced each time and a held reference goes
 * stale. (Re-mounting instead would click the ⚡ toggle again and switch the
 * recipe back OFF — which is how this test failed the first time.)
 */
function mountPanel(doc: CADDocument): () => HTMLInputElement[] {
  const host = document.createElement("div");
  document.body.appendChild(host);
  new LayersBar(host, doc, () => {});
  host.querySelector<HTMLButtonElement>("button.layer-beam-toggle")?.click();
  return () => [...host.querySelectorAll<HTMLInputElement>(".layer-beam-row input[type=number]")];
}

function typeInto(inp: HTMLInputElement, v: string): void {
  inp.value = v;
  inp.dispatchEvent(new Event("change", { bubbles: true }));
}

test("100% power reaches the controller as its full scale", () => {
  const doc = docWith({ kind: "cut", feedrate: 300, laserPower: 100, laserPasses: 1 });
  expect(generateLaserGCode(doc.operations, doc)).toContain("S1000");
});

test("0% power is allowed — it is a dry run, tracing the path with the beam off", () => {
  const doc = docWith({ kind: "cut", feedrate: 300, laserPower: 0, laserPasses: 1 });
  const g = generateLaserGCode(doc.operations, doc);
  expect(g).toContain("S0");
  expect(g).toMatch(/G1 /); // it still moves, which is the point of a dry run
});

test("the panel refuses a zero feed, matching the toolpath dialog", () => {
  const doc = new CADDocument({ width: 300, height: 200 });
  doc.machineKind = "laser";
  const fields = mountPanel(doc);
  expect(fields()).toHaveLength(3); // control: power, speed, passes
  expect(doc.layers[0].laser?.feedrate).toBeGreaterThan(0);

  typeInto(fields()[1], "0");
  expect(doc.layers[0].laser?.feedrate).toBe(1);
});

test("power keeps its own rules: zero is legal, 100 is the ceiling", () => {
  const doc = new CADDocument({ width: 300, height: 200 });
  doc.machineKind = "laser";
  const fields = mountPanel(doc);

  typeInto(fields()[0], "0");
  expect(doc.layers[0].laser?.laserPower).toBe(0);

  typeInto(fields()[0], "150");
  expect(doc.layers[0].laser?.laserPower).toBe(100);
});

test("passes cannot drop below one", () => {
  const doc = new CADDocument({ width: 300, height: 200 });
  doc.machineKind = "laser";
  const fields = mountPanel(doc);

  typeInto(fields()[2], "0");
  expect(doc.layers[0].laser?.laserPasses).toBe(1);
});

test("a floored feed gives a sane run-time estimate", () => {
  const doc = docWith({ kind: "cut", feedrate: 1, laserPower: 100, laserPasses: 1 });
  const est = estimateGCodeTime(generateLaserGCode(doc.operations, doc));
  expect(Number.isFinite(est.seconds)).toBe(true);
  expect(est.seconds).toBeGreaterThan(0);
});
