// @vitest-environment happy-dom
import { beforeEach, expect, test } from "vitest";
import { LayersBar } from "../src/ui/layersBar";
import { CamBar } from "../src/ui/camBar";
import { CADDocument } from "../src/model/document";
import { LineEntity, RectEntity } from "../src/model/entities";

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

test("the job kind picker writes through to the layer", () => {
  const doc = laserDoc();
  const host = mountLayers(doc);
  beamToggles(host)[0].click();

  const kind = host.querySelector<HTMLSelectElement>(".layer-beam-kind");
  expect(kind).toBeTruthy();
  // A recipe starts as tuning-only: enabling one must not silently enlist the
  // layer as a job that "Toolpaths from Layers" would then cut.
  expect(kind!.value).toBe("");
  expect(doc.layers[0].laser?.kind).toBeUndefined();

  kind!.value = "cut";
  kind!.dispatchEvent(new Event("change", { bubbles: true }));
  expect(doc.layers[0].laser?.kind).toBe("cut");
});

test("the job kind offers every laser job, and can be cleared back to tuning-only", () => {
  const doc = laserDoc();
  const host = mountLayers(doc);
  beamToggles(host)[0].click();
  const kind = host.querySelector<HTMLSelectElement>(".layer-beam-kind")!;

  expect([...kind.options].map((o) => o.value)).toEqual(["", "cut", "score", "engrave", "fill"]);

  kind.value = "fill";
  kind.dispatchEvent(new Event("change", { bubbles: true }));
  expect(doc.layers[0].laser?.kind).toBe("fill"); // control

  const cleared = host.querySelector<HTMLSelectElement>(".layer-beam-kind")!;
  cleared.value = "";
  cleared.dispatchEvent(new Event("change", { bubbles: true }));
  expect(doc.layers[0].laser?.kind).toBeUndefined();
});

test("\"Toolpaths from Layers\" is laser-only, and builds one path per job layer", async () => {
  const mill = new CADDocument({ width: 200, height: 100 });
  const millHost = document.createElement("div");
  document.body.appendChild(millHost);
  new CamBar(millHost, mill);
  const millBtn = millHost.querySelector<HTMLButtonElement>(".cam-from-layers-btn");
  expect(millBtn?.style.display).toBe("none");

  const doc = laserDoc();
  doc.layers[0].name = "Cut";
  doc.layers[0].laser = { kind: "cut", feedrate: 300, laserPower: 100, laserPasses: 3 };
  doc.layers.push({
    id: "l-score",
    name: "Score",
    color: "#e05a5a",
    visible: true,
    locked: false,
    laser: { kind: "score", feedrate: 1800, laserPower: 15, laserPasses: 1 },
  });
  doc.entities.push(new RectEntity({ x: 0, y: 0 }, { x: 40, y: 20 }, "R1"));
  const fold = new LineEntity({ x: 20, y: 0 }, { x: 20, y: 20 }, "L1");
  fold.layerId = "l-score";
  doc.entities.push(fold);

  const host = document.createElement("div");
  document.body.appendChild(host);
  new CamBar(host, doc);
  const btn = host.querySelector<HTMLButtonElement>(".cam-from-layers-btn")!;
  expect(btn.style.display).not.toBe("none");

  btn.click();
  await new Promise((r) => setTimeout(r, 0)); // the handler is async

  expect(doc.operations.map((o) => o.name)).toEqual(["Cut", "Score"]);
  expect(doc.operations[0].type).toBe("profile");
  expect(doc.operations[1].type).toBe("score");
  // And the CAM list shows them.
  expect(host.querySelectorAll(".tp-op-item")).toHaveLength(2);
});

test("mill-only actions are not offered on machines that refuse them", () => {
  // "Tile" and "Two-sided" both bail with a toast unless the machine is a flat
  // mill, but were only hidden for a rotary — so a laser document showed two
  // enabled buttons that refused every click.
  const shown = (doc: CADDocument) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    // Both buttons are only built when their preview callbacks are supplied, so
    // a CamBar without them has nothing to assert on (and `.every()` on the
    // empty result would pass vacuously — hence the length check below).
    new CamBar(host, doc, () => {}, () => {}, () => {});
    return [...host.querySelectorAll<HTMLButtonElement>("button.cam-add-btn")]
      .filter((b) => /Tile|Two-sided/i.test(b.textContent ?? ""))
      .map((b) => `${b.textContent?.trim()}:${b.style.display === "none" ? "hidden" : "shown"}`);
  };

  const mill = new CADDocument({ width: 200, height: 100 });
  // Control: on a flat mill they ARE offered, so a "hidden" below is the machine
  // kind rather than a selector that matches nothing.
  expect(shown(mill).every((s) => s.endsWith(":shown"))).toBe(true);
  expect(shown(mill)).toHaveLength(2);

  expect(shown(laserDoc()).every((s) => s.endsWith(":hidden"))).toBe(true);

  const rotary = new CADDocument({ width: 200, height: 100 });
  rotary.machineKind = "mill-rotary";
  expect(shown(rotary).every((s) => s.endsWith(":hidden"))).toBe(true);
});

test("the kerf side picker appears for a cut, and only for a cut", () => {
  const doc = laserDoc();
  const host = mountLayers(doc);
  beamToggles(host)[0].click();
  const setKind = (v: string) => {
    const k = host.querySelector<HTMLSelectElement>(".layer-beam-kind")!;
    k.value = v;
    k.dispatchEvent(new Event("change", { bubbles: true }));
  };

  setKind("engrave");
  expect(host.querySelector(".layer-beam-side")).toBeNull();

  setKind("cut");
  const side = host.querySelector<HTMLSelectElement>(".layer-beam-side");
  expect(side).toBeTruthy();
  // Auto by default: the builder reads the geometry so holes and outlines each
  // finish at the drawn size.
  expect(side!.value).toBe("");
  expect(doc.layers[0].laser?.side).toBeUndefined();

  side!.value = "inside";
  side!.dispatchEvent(new Event("change", { bubbles: true }));
  expect(doc.layers[0].laser?.side).toBe("inside");
});

test("the fields sit on their own lines so the narrow panel can't clip them", () => {
  // Structural stand-in for the layout bug this shipped with: three fields plus
  // their unit labels on ONE line overflowed a ~210px panel.
  const doc = laserDoc();
  const host = mountLayers(doc);
  beamToggles(host)[0].click();

  const lines = host.querySelectorAll(".layer-beam-row .layer-beam-line");
  expect(lines).toHaveLength(3); // kind, power+speed, passes+preset (no kerf side: not a cut)
  expect(lines[0].querySelectorAll("select.layer-beam-kind")).toHaveLength(1); // job kind
  expect(lines[1].querySelectorAll("input")).toHaveLength(2); // power, speed
  expect(lines[2].querySelectorAll("input")).toHaveLength(1); // passes
});

test("the operation list shows the layer's numbers, and follows a move between layers", () => {
  // Editing a layer recipe, or moving geometry onto a different layer, changes
  // what the machine runs. The CAM list has to show the resolved numbers or the
  // panel would confidently display settings that no longer apply.
  const doc = laserDoc();
  doc.layers[0].name = "Cut";
  doc.layers[0].laser = { feedrate: 300, laserPower: 100, laserPasses: 1 };
  doc.layers.push({
    id: "l-score",
    name: "Score",
    color: "#e05a5a",
    visible: true,
    locked: false,
    laser: { feedrate: 1800, laserPower: 15, laserPasses: 1 },
  });
  const rect = new RectEntity({ x: 0, y: 0 }, { x: 40, y: 20 }, "R1");
  doc.entities.push(rect);
  doc.operations.push({
    id: "op1",
    name: "Cut",
    type: "profile",
    entityIds: ["R1"],
    side: "outside",
    toolType: "end-mill",
    toolNumber: 1,
    diameter: 0,
    feedrate: 1200,
    plungeRate: 300,
    spindleSpeed: 0,
    safeZ: 5,
    depth: -3,
    stepdown: 1.5,
    stepover: 0.4,
    laserPower: 80,
    laserPasses: 1,
  });

  const host = document.createElement("div");
  document.body.appendChild(host);
  new CamBar(host, doc);

  const summary = () => host.querySelector(".tp-op-params")?.textContent ?? "";
  expect(summary()).toContain("100%");
  expect(summary()).toContain("⚡Cut"); // says where the numbers came from
  expect(summary()).not.toContain("80%"); // the op's own value is not what runs

  rect.layerId = "l-score";
  doc.emitChange();
  expect(summary()).toContain("15%");
  expect(summary()).toContain("⚡Score");
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
  const power = [...document.querySelectorAll<HTMLInputElement>(".tp-dialog input")]
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
