import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { getTextInkBox, loadFromFile } from "../src/core/fontManager";
import { makeConstraint } from "../src/model/constraints";
import { dimensionMeasure, makeDimension } from "../src/model/dimensions";
import { CADDocument } from "../src/model/document";
import { RectEntity, TextEntity } from "../src/model/entities";
import { solve } from "../src/solver/solver";

// The text BOX (its rotated ink box) exposes corners + edge midpoints + centre as
// derived points, so a dimension can hang off them — to measure the block, or to
// drive its placement off nearby geometry. These lock that in.

let fontId: string;
const geoOf = (doc: CADDocument) => {
  const m = new Map(doc.entities.map((e) => [e.id, e]));
  return (id: string) => m.get(id);
};
const near = (p: { x: number; y: number }, x: number, y: number, d = 4) => {
  expect(p.x).toBeCloseTo(x, d);
  expect(p.y).toBeCloseTo(y, d);
};

beforeAll(async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const bytes = readFileSync(join(here, "..", "public", "fonts", "roboto-regular.woff"));
  const fakeFile = {
    name: "roboto.woff",
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as File;
  ({ id: fontId } = await loadFromFile(fakeFile));
});

describe("text box points", () => {
  it("exposes corners + edge midpoints + centre matching the ink box", () => {
    const t = new TextEntity("Ag", fontId, 10, { x: 0, y: 0 });
    const b = getTextInkBox(fontId, "Ag", 10)!;
    near(t.getPoint("bl"), b.min.x, b.min.y);
    near(t.getPoint("br"), b.max.x, b.min.y);
    near(t.getPoint("tr"), b.max.x, b.max.y);
    near(t.getPoint("tl"), b.min.x, b.max.y);
    near(t.getPoint("mid_b"), (b.min.x + b.max.x) / 2, b.min.y);
    near(t.getPoint("mid_t"), (b.min.x + b.max.x) / 2, b.max.y);
    near(t.getPoint("mid_l"), b.min.x, (b.min.y + b.max.y) / 2);
    near(t.getPoint("mid_r"), b.max.x, (b.min.y + b.max.y) / 2);
    near(t.getPoint("center"), (b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2);

    const keys = t.pickablePoints().map((p) => p.key);
    for (const k of ["pos", "bl", "br", "tr", "tl", "mid_b", "mid_r", "mid_t", "mid_l", "center"])
      expect(keys).toContain(k);
    // Snap kinds are sensible: corners endpoint, edges midpoint, centre centre.
    const snaps = new Map(t.snapPoints().map((s) => [s.key, s.kind]));
    expect(snaps.get("bl")).toBe("endpoint");
    expect(snaps.get("mid_l")).toBe("midpoint");
    expect(snaps.get("center")).toBe("center");
  });

  it("rotates the box points with the text (90° CCW: local +x → world +y)", () => {
    const b = getTextInkBox(fontId, "Ag", 10)!;
    const t = new TextEntity("Ag", fontId, 10, { x: 0, y: 0 }, Math.PI / 2);
    // bl local (b.min.x, b.min.y) → world (-b.min.y, b.min.x)
    near(t.getPoint("bl"), -b.min.y, b.min.x);
    near(t.getPoint("br"), -b.min.y, b.max.x);
  });
});

describe("dimensioning the text box", () => {
  it("a horizontal dim across the box measures the ink width; vertical measures height", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const t = doc.add(new TextEntity("CUT ONCE", fontId, 10, { x: 20, y: 20 }));
    const b = getTextInkBox(fontId, "CUT ONCE", 10)!;
    const geo = geoOf(doc);

    const wDim = makeDimension("horizontal", {
      points: [
        { entityId: t.id, key: "bl" },
        { entityId: t.id, key: "br" },
      ],
      value: 0,
      offset: -8,
      driving: false, // reference/annotation — a rigid text can't be resized by it
    });
    const hDim = makeDimension("vertical", {
      points: [
        { entityId: t.id, key: "bl" },
        { entityId: t.id, key: "tl" },
      ],
      value: 0,
      offset: -8,
      driving: false,
    });
    expect(dimensionMeasure(wDim, geo)).toBeCloseTo(b.max.x - b.min.x, 3);
    expect(dimensionMeasure(hDim, geo)).toBeCloseTo(b.max.y - b.min.y, 3);
  });

  it("a driving dim from a fixed rectangle edge to the text places the text", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const rect = doc.add(new RectEntity({ x: 0, y: 0 }, { x: 120, y: 60 }));
    // Pin the rectangle so it's the fixed reference frame.
    doc.addConstraint(
      makeConstraint("fixedPoint", { points: [{ entityId: rect.id, key: "bl" }], params: [0, 0] }),
    );
    doc.addConstraint(
      makeConstraint("fixedPoint", {
        points: [{ entityId: rect.id, key: "tr" }],
        params: [120, 60],
      }),
    );
    const t = doc.add(new TextEntity("Ag", fontId, 10, { x: 80, y: 25 }));

    // Left rectangle edge → text's left edge = 30 mm (drives the text right/left).
    doc.addDimension(
      makeDimension("horizontal", {
        points: [
          { entityId: rect.id, key: "bl" },
          { entityId: t.id, key: "mid_l" },
        ],
        value: 30,
        offset: -10,
      }),
    );
    expect(solve(doc).converged).toBe(true);
    expect(t.getPoint("mid_l").x).toBeCloseTo(30, 2); // text left edge now 30mm from x=0
  });
});
