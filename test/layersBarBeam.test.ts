// @vitest-environment happy-dom
import { beforeEach, expect, test } from "vitest";
import { LayersBar } from "../src/ui/layersBar";
import { CamBar } from "../src/ui/camBar";
import { CADDocument } from "../src/model/document";
import { RectEntity } from "../src/model/entities";

/**
 * DOM cover for the per-layer beam recipe controls. cam/types.ts owns the
 * resolution rules (tested in laserLayerRecipe.test.ts); this file covers the
 * half a unit test on the model can't see — that the controls appear only where
 * they should, that editing them reaches the document, and that the toolpath
 * dialog tells the user which layer is driving the beam.
 *
 * The first version of this UI passed every DOM assertion while rendering
 * visibly broken (the power field clipped "100" to "1(" because Chrome's number
 * spinners ate the width), so a check on the layout structure is included too —
 * a screenshot caught what `querySelector` could not.
 */

function laserDoc(): CADDocument {
  const doc = new CADDocument({ width: 200, height: 100 });
  doc.machineKind = "laser";
  return doc;
}

/** Mount a LayersBar for `doc` and return its host. */
function mountLayers(doc: CADDocument): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  new LayersBar(host, doc, () => {});
  return host;
}

const beamToggles = (host: HTMLElement) =>
  [...host.querySelectorAll("button.layer-beam-toggle")] as HTMLButtonElement[];
const beamInputs = (host: HTMLElement) =>
  [...host.querySelectorAll(".layer-beam-row input[type=number]")] as HTMLInputElement[];

/** Type into an input the way a user committing a value does. */
function setValue(inp: HTMLInputElement, v: string | number): void {
  inp.value = String(v);
  inp.dispatchEvent(new Event("change", { bubbles: true }));
}

beforeEach(() => {
  document.body.innerHTML = "";
});

test("the beam toggle appears only on a laser document", () => {
  const mill = new CADDocument({ width: 200, height: 100 }); // machineKind defaults to mill
  expect(beamToggles(mountLayers(mill))).toHaveLength(0);
  // Control: the same panel on a laser doc does offer it, so the absence above
  // is the machine kind rather than a selector that never matches.
  expect(beamToggles(mountLayers(laserDoc()))).toHaveLength(1);
});

test("a workholding layer gets no beam recipe — a clamp is not cut", () => {
  const doc = laserDoc();
  const host = mountLayers(doc);
  expect(beamToggles(host)).toHaveLength(1); // control

  doc.layers[0].fixture = true;
  doc.emitChange();
  expect(beamToggles(host)).toHaveLength(0);
});

test("toggling the recipe on reveals power, speed and passes", () => {
  const doc = laserDoc();
  const host = mountLayers(doc);
  expect(beamInputs(host)).toHaveLength(0);

  beamToggles(host)[0].click();

  expect(doc.layers[0].laser).toBeTruthy();
  expect(beamInputs(host)).toHaveLength(3);
});

test("toggling it off again returns the layer to per-operation settings", () => {
  const doc = laserDoc();
  const host = mountLayers(doc);
  beamToggles(host)[0].click();
  expect(doc.layers[0].laser).toBeTruthy(); // control

  beamToggles(host)[0].click();
  expect(doc.layers[0].laser).toBeUndefined();
  expect(beamInputs(host)).toHaveLength(0);
});

test("editing the fields writes through to the layer", () => {
  const doc = laserDoc();
  const host = mountLayers(doc);
  beamToggles(host)[0].click();

  setValue(beamInputs(host)[0], 100); // power %
  setValue(beamInputs(host)[1], 300); // speed mm/min
  setValue(beamInputs(host)[2], 3); // passes

  expect(doc.layers[0].laser).toMatchObject({
    laserPower: 100,
    feedrate: 300,
    laserPasses: 3,
  });
});

test("speed is entered in the document's display unit, stored in mm", () => {
  const doc = laserDoc();
  doc.displayUnit = "in";
  const host = mountLayers(doc);
  beamToggles(host)[0].click();

  setValue(beamInputs(host)[1], 12); // 12 in/min
  expect(doc.layers[0].laser?.feedrate).toBeCloseTo(12 * 25.4, 6);
  // And it renders back in inches rather than as raw internal mm.
  expect(beamInputs(host)[1].value).toBe("12");
});

test("a nonsensical entry is rejected rather than stored", () => {
  const doc = laserDoc();
  const host = mountLayers(doc);
  beamToggles(host)[0].click();
  const before = { ...doc.layers[0].laser! };

  setValue(beamInputs(host)[0], "");
  setValue(beamInputs(host)[0], -5);

  expect(doc.layers[0].laser).toEqual(before);
});

test("the fields sit on their own lines so the narrow panel can't clip them", () => {
  // Structural stand-in for the layout bug this shipped with: three fields plus
  // their unit labels on ONE line overflowed a ~210px panel.
  const doc = laserDoc();
  const host = mountLayers(doc);
  beamToggles(host)[0].click();

  const lines = host.querySelectorAll(".layer-beam-row .layer-beam-line");
  expect(lines).toHaveLength(2);
  expect(lines[0].querySelectorAll("input")).toHaveLength(2); // power, speed
  expect(lines[1].querySelectorAll("input")).toHaveLength(1); // passes
});

test("the toolpath dialog names the layer driving the beam, and can fork off it", () => {
  const doc = laserDoc();
  doc.layers[0].name = "Cut";
  doc.layers[0].laser = { feedrate: 300, laserPower: 100, laserPasses: 3 };
  const rect = new RectEntity({ x: 0, y: 0 }, { x: 40, y: 20 }, "R1");
  rect.selected = true;
  doc.entities.push(rect);

  const host = document.createElement("div");
  document.body.appendChild(host);
  new CamBar(host, doc);
  (
    [...host.querySelectorAll("button.cam-add-btn")].find((b) =>
      b.textContent?.includes("Add Toolpath"),
    ) as HTMLButtonElement
  ).click();

  const banner = document.querySelector(".tp-beam-layer") as HTMLElement;
  expect(banner).toBeTruthy();
  expect(banner.style.display).not.toBe("none");
  expect(banner.querySelector("span")?.textContent).toContain("Cut");

  // The fields show the layer's numbers and are read-only while following.
  const power = [...document.querySelectorAll<HTMLInputElement>(".tp-dialog input[type=number]")]
    .find((i) => i.value === "100");
  expect(power?.disabled).toBe(true);

  // Forking is a deliberate click, not a side effect of typing.
  const forkBtn = banner.querySelector("button") as HTMLButtonElement;
  expect(forkBtn.textContent).toBe("Use custom settings");
  forkBtn.click();

  expect(banner.querySelector("span")?.textContent).toContain("Custom settings");
  expect(banner.querySelector("button")?.textContent).toBe("Follow the layer");
  expect(power?.disabled).toBe(false);
});
