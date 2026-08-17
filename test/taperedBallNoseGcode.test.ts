import { expect, test } from "vitest";
import { generateGCode } from "../src/cam/gcode";
import type { CAMOperation } from "../src/cam/types";
import { registerEmbeddedImage } from "../src/core/imageManager";
import { CADDocument } from "../src/model/document";
import { RasterImageEntity } from "../src/model/entities";

/**
 * A tapered ball-nose reaches the POSTED PROGRAM, under its own name.
 *
 * The geometry is covered by `toolProfile.test.ts` and the stepover by
 * `scallop.test.ts`, but nothing asserted that the new tool type survives the
 * trip through `generateGCode` — and that is exactly the gap that made a real
 * discrepancy unresolvable.
 *
 * While the feature was being built, `post_gcode` through the MCP server
 * reported the tool as `End Mill`. That was diagnosed as the tools running "a
 * separate reference build" and set aside. They do not: `mcp/server.ts` imports
 * `cli/core`, which imports `src/cam/gcode` — the same source. The real cause
 * was a long-running server process holding modules loaded before the change.
 *
 * The suite could not settle that either way, because no test read the emitted
 * text. This one does, so the next unexpected output is a failing assertion
 * rather than a judgement call.
 */

function reliefDoc() {
  const rows = [
    [0, 128],
    [200, 255],
  ];
  registerEmbeddedImage({
    id: "img-tapered-gcode",
    name: "img-tapered-gcode",
    width: 2,
    height: 2,
    data: btoa(String.fromCharCode(...rows.flat())),
  });
  const doc = new CADDocument({ width: 100, height: 100 });
  doc.add(new RasterImageEntity("img-tapered-gcode", { x: 0, y: 0 }, 8, 8, 0));
  return { doc, id: doc.entities.find((e) => e.type === "image")!.id };
}

function reliefOp(id: string, over: Record<string, unknown> = {}): CAMOperation {
  return {
    id: "r1",
    name: "relief",
    type: "engrave",
    entityIds: [id],
    side: "outside",
    toolType: "tapered-ball-nose",
    toolNumber: 1,
    diameter: 6,
    vAngle: 15,
    tipDiameter: 1,
    feedrate: 1500,
    plungeRate: 300,
    spindleSpeed: 18000,
    safeZ: 5,
    depth: -2,
    stepdown: 2,
    stepover: 0.4,
    rasterLineInterval: 1,
    rasterDotPitch: 1,
    ...over,
  } as unknown as CAMOperation;
}

const g1Count = (g: string) => (g.match(/\nG1 /g) || []).length;

test("a relief accepts a tapered ball-nose and actually cuts with it", () => {
  const { doc, id } = reliefDoc();
  const g = generateGCode([reliefOp(id)], doc);

  // The relief gate lists the tool types that can surface a depth field. Miss
  // the new one there and the op posts a NOTE and no motion — the "app says
  // something untrue" failure, in the one place it costs material.
  expect(g1Count(g), "the tool must be accepted by the relief gate").toBeGreaterThan(0);
  expect(g).not.toMatch(/NOTE:.*(skipped|needs a ball-nose)/);
});

test("it is named as itself in the header and the op label", () => {
  const { doc, id } = reliefDoc();
  const g = generateGCode([reliefOp(id)], doc);

  expect(g).toContain("TaperedBallNose");
  expect(g).toContain("Tapered Ball Nose");
  // The specific wrong answer that was observed and explained away.
  expect(g, "a tapered bit must never post as a plain end mill").not.toContain("End Mill");
});

test("a plain ball-nose still posts as itself — the label is read, not assumed", () => {
  // Positive control. Without it, the assertions above would pass just as well
  // against code that names every tool "Tapered Ball Nose".
  const { doc, id } = reliefDoc();
  const g = generateGCode([reliefOp(id, { toolType: "ball-nose", tipDiameter: undefined })], doc);

  expect(g1Count(g)).toBeGreaterThan(0);
  expect(g).not.toContain("TaperedBallNose");
});
