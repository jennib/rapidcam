// @vitest-environment happy-dom
import { beforeEach, describe, expect, test } from "vitest";
import { CamBar } from "../src/ui/camBar";
import { CADDocument } from "../src/model/document";
import { RasterImageEntity } from "../src/model/entities";
import { registerEmbeddedImage } from "../src/core/imageManager";
import { createInitialOpState } from "../src/ui/camBar/dialog/opDialogState";
import type { CAMOperation } from "../src/cam/types";

function roughOp(entityIds: string[], over: Partial<CAMOperation> = {}): CAMOperation {
  return {
    id: "rr",
    name: "Rough",
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
    name: "Finish",
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
  const id = `rel-dlg-${imgCounter++}`;
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

describe("createInitialOpState: loading a relief pair", () => {
  test("editing the rough loads the finish's fields plus the rough stage", () => {
    const { doc, image } = imageDoc();
    const rough = roughOp([image.id]);
    doc.operations.push(rough, finishOp([image.id]));
    const s = createInitialOpState(rough, doc, []);
    expect(s.combo).toBe("relief");
    expect(s.toolType).toBe("ball-nose"); // the finish's tool
    expect(s.depth).toBe(-10);
    expect(s.reliefRough?.toolType).toBe("end-mill");
    expect(s.reliefRough?.finishAllowance).toBe(0.5);
    expect(s.includeRough).toBe(true);
  });

  test("editing the finish also finds the rough", () => {
    const { doc, image } = imageDoc();
    const rough = roughOp([image.id]);
    doc.operations.push(rough, finishOp([image.id]));
    const s = createInitialOpState(doc.operations[1], doc, []);
    expect(s.combo).toBe("relief");
    expect(s.includeRough).toBe(true);
    expect(s.reliefRough?.diameter).toBe(8);
  });

  test("a new relief on a selected image includes roughing by default", () => {
    const { doc, image } = imageDoc();
    image.selected = true;
    const s = createInitialOpState(null, doc, [image]);
    expect(s.combo).toBe("relief");
    expect(s.includeRough).toBe(true);
    expect(s.reliefRough?.toolType).toBe("end-mill");
    expect(s.toolType).toBe("ball-nose");
  });
});

describe("Add-Toolpath dialog: a relief writes two ops", () => {
  test("applying a new 3-D Relief writes a rough and a finish sharing one model", () => {
    const { doc, image } = imageDoc();
    image.selected = true;
    const host = document.createElement("div");
    document.body.appendChild(host);
    new CamBar(host, doc);

    const addBtn = [...host.querySelectorAll("button.cam-add-btn")].find((b) =>
      b.textContent?.includes("Add Toolpath"),
    ) as HTMLButtonElement;
    addBtn.click();

    const dialog = document.querySelector(".tp-dialog") as HTMLElement;
    const sel = dialog.querySelector('[data-testid="op-type-select"]') as HTMLSelectElement;
    expect(sel.value).toBe("relief"); // image selection defaults to the merged job

    const apply = [...dialog.querySelectorAll("button")].find(
      (b) => b.textContent === "Apply",
    ) as HTMLButtonElement;
    apply.click();

    expect(doc.operations.length).toBe(2);
    const rough = doc.operations.find((o) => o.type === "relief-rough");
    const finish = doc.operations.find((o) => o.type === "engrave");
    expect(rough).toBeTruthy();
    expect(finish).toBeTruthy();
    expect(rough!.depth).toBe(finish!.depth);
    expect(rough!.entityIds).toEqual(finish!.entityIds);
    // The rough cuts first.
    expect(doc.operations.indexOf(rough!)).toBeLessThan(doc.operations.indexOf(finish!));
  });
});

beforeEach(() => {
  document.body.innerHTML = "";
});
