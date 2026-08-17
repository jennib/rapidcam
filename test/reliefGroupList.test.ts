// @vitest-environment happy-dom
import { beforeEach, describe, expect, test } from "vitest";
import { CamBar } from "../src/ui/camBar";
import { CADDocument } from "../src/model/document";
import { RasterImageEntity } from "../src/model/entities";
import { registerEmbeddedImage } from "../src/core/imageManager";
import type { CAMOperation } from "../src/cam/types";

function roughOp(entityIds: string[], over: Partial<CAMOperation> = {}): CAMOperation {
  return {
    id: "rr",
    name: "Relief Rough",
    type: "relief-rough",
    entityIds,
    side: "outside",
    toolType: "end-mill",
    toolNumber: 1,
    diameter: 8,
    feedrate: 1500,
    plungeRate: 300,
    spindleSpeed: 18000,
    safeZ: 5,
    depth: -10,
    stepdown: 2,
    stepover: 0.4,
    finishAllowance: 0.5,
    ...over,
  };
}

function finishOp(entityIds: string[], over: Partial<CAMOperation> = {}): CAMOperation {
  return {
    id: "ff",
    name: "Relief",
    type: "engrave",
    entityIds,
    side: "outside",
    toolType: "ball-nose",
    toolNumber: 2,
    diameter: 3,
    feedrate: 1500,
    plungeRate: 300,
    spindleSpeed: 18000,
    safeZ: 5,
    depth: -10,
    stepdown: 1,
    stepover: 0.4,
    rasterLineInterval: 0.3,
    rasterDotPitch: 0.3,
    ...over,
  };
}

let imgCounter = 0;
function imageDoc(): { doc: CADDocument; image: RasterImageEntity } {
  const id = `rel-group-${imgCounter++}`;
  registerEmbeddedImage({
    id,
    name: id,
    width: 8,
    height: 8,
    data: btoa(String.fromCharCode(...new Array(64).fill(0))),
  });
  const doc = new CADDocument({ width: 100, height: 80 });
  const image = doc.add(new RasterImageEntity(id, { x: 10, y: 10 }, 40, 40, 0));
  return { doc, image };
}

function mount(doc: CADDocument): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  new CamBar(host, doc);
  return host;
}

describe("grouped relief list", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  test("an adjacent relief pair renders as one grouped card with two child rows", () => {
    const { doc, image } = imageDoc();
    doc.operations.push(roughOp([image.id]), finishOp([image.id]));
    const host = mount(doc);

    const groups = host.querySelectorAll(".tp-op-item.tp-op-group");
    expect(groups).toHaveLength(1);
    const rows = groups[0].querySelectorAll(".tp-op-group-child");
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector(".tp-op-group-stage")?.textContent).toBe("Roughing");
    expect(rows[1].querySelector(".tp-op-group-stage")?.textContent).toBe("Finishing");
    // The pair collapses to a single list entry, not two.
    expect(host.querySelectorAll(".tp-op-item")).toHaveLength(1);
    // The parent header is named after the job (the finish op's name).
    expect(groups[0].querySelector(".tp-op-name")?.textContent).toBe("Relief");
  });

  test("a rough with no adjacent finish still renders as one flat card", () => {
    const { doc, image } = imageDoc();
    doc.operations.push(roughOp([image.id]));
    const host = mount(doc);

    expect(host.querySelectorAll(".tp-op-item.tp-op-group")).toHaveLength(0);
    expect(host.querySelectorAll(".tp-op-item")).toHaveLength(1);
  });

  test("deleting the parent removes both passes in one step", () => {
    const { doc, image } = imageDoc();
    doc.operations.push(roughOp([image.id]), finishOp([image.id]));
    const host = mount(doc);

    const del = host.querySelector<HTMLButtonElement>(
      ".tp-op-group .tp-op-top .tp-icon-btn[title='Delete both passes']",
    );
    expect(del).toBeTruthy();
    del!.click();

    expect(doc.operations.length).toBe(0);
    expect(host.querySelectorAll(".tp-op-item")).toHaveLength(0);
  });

  test("deleting only the roughing row keeps the finish", () => {
    const { doc, image } = imageDoc();
    doc.operations.push(roughOp([image.id]), finishOp([image.id]));
    const host = mount(doc);

    const del = host.querySelector<HTMLButtonElement>(
      ".tp-op-group .tp-op-group-child .tp-icon-btn[title='Delete roughing pass']",
    );
    expect(del).toBeTruthy();
    del!.click();

    expect(doc.operations.length).toBe(1);
    expect(doc.operations[0].type).toBe("engrave");
    // No pair left, so the finish renders as a plain (ungrouped) card.
    expect(host.querySelectorAll(".tp-op-item.tp-op-group")).toHaveLength(0);
    expect(host.querySelectorAll(".tp-op-item")).toHaveLength(1);
  });
});
