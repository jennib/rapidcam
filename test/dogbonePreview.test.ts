import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { LineEntity } from "../src/model/entities";
import { rasterizeStock } from "../src/cam/stockRasterizer";
import type { CAMOperation } from "../src/cam/types";

// The 3-D preview carves the stock height-field independently of the emitted
// G-code, so dog-bone relief has to be applied there too or the sim would show
// filleted corners the real cut doesn't leave. These assert the sim removes
// strictly more material with dog-bone on — i.e. the relief is visible.

function squarePocket(doc: CADDocument): string[] {
  const p = [
    { x: 20, y: 20 },
    { x: 70, y: 20 },
    { x: 70, y: 70 },
    { x: 20, y: 70 },
  ];
  return p.map((a, i) => doc.add(new LineEntity(a, p[(i + 1) % 4])).id);
}
function op(kind: "pocket", ids: string[], cornerStyle?: "none" | "dogbone"): CAMOperation {
  return {
    id: "op",
    name: "p",
    type: kind,
    side: "outside",
    entityIds: ids,
    toolType: "end-mill",
    toolNumber: 1,
    diameter: 6,
    feedrate: 1000,
    plungeRate: 300,
    spindleSpeed: 10000,
    safeZ: 5,
    depth: -3,
    stepdown: 3,
    stepover: 0.4,
    cornerStyle,
  };
}

const carvedCells = (_ids: string[], cornerStyle?: "none" | "dogbone"): number => {
  const doc = new CADDocument({ width: 100, height: 100 });
  const ids2 = squarePocket(doc);
  const hm = rasterizeStock([op("pocket", ids2, cornerStyle)], doc);
  let n = 0;
  for (let i = 0; i < hm.data.length; i++) if (hm.data[i] < hm.stockT - 1e-6) n++;
  return n;
};

test("the 3-D preview carves the dog-bone relief (more material removed than a plain pocket)", () => {
  const plain = carvedCells([], "none");
  const dog = carvedCells([], "dogbone");
  expect(plain).toBeGreaterThan(0); // sanity: the pocket is carved at all
  expect(dog).toBeGreaterThan(plain); // dog-bone removes the extra corner material
});

test("an inside profile's dog-bone also shows in the preview", () => {
  const build = (cornerStyle?: "none" | "dogbone") => {
    const doc = new CADDocument({ width: 100, height: 100 });
    const ids = squarePocket(doc);
    const o: CAMOperation = { ...op("pocket", ids, cornerStyle), type: "profile", side: "inside" };
    const hm = rasterizeStock([o], doc);
    let n = 0;
    for (let i = 0; i < hm.data.length; i++) if (hm.data[i] < hm.stockT - 1e-6) n++;
    return n;
  };
  expect(build("dogbone")).toBeGreaterThan(build("none"));
});
