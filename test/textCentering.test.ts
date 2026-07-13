import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { loadFromFile } from "../src/core/fontManager";
import { applyFile, serializeDoc } from "../src/io/fileio";
import { makeConstraint } from "../src/model/constraints";
import { CADDocument } from "../src/model/document";
import { LineEntity, TextEntity } from "../src/model/entities";
import { solve } from "../src/solver/solver";

// Centring text horizontally in a rectangle: the user drops a vertical
// construction line on the rectangle's centreline, then constrains the text's
// (derived) `center` point onto it with Point-on-line. Because `center` is
// derived from the anchor + live ink extents, the text stays centred as it is
// edited — the crux these tests lock in.

let fontId: string;

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

describe("TextEntity derived centre point", () => {
  it("exposes `center` as a keyed pickable + snappable point (rotation-aware)", () => {
    const t = new TextEntity("Ab", fontId, 10, { x: 0, y: 0 });
    // centre = anchor + rotated midpoint of the ink box.
    const b = t.localBox();
    const cx = (b.min.x + b.max.x) / 2;
    const cy = (b.min.y + b.max.y) / 2;
    expect(t.getPoint("center").x).toBeCloseTo(cx, 6);
    expect(t.getPoint("center").y).toBeCloseTo(cy, 6);

    // Rotated 90° CCW about the anchor: local +x → world +y.
    const rot = new TextEntity("Ab", fontId, 10, { x: 0, y: 0 }, Math.PI / 2);
    expect(rot.getPoint("center").x).toBeCloseTo(-cy, 6);
    expect(rot.getPoint("center").y).toBeCloseTo(cx, 6);

    expect(
      t
        .pickablePoints()
        .map((p) => p.key)
        .sort(),
    ).toEqual(["center", "pos"]);
    expect(t.snapPoints().some((s) => s.key === "center" && s.kind === "center")).toBe(true);
  });

  it("writing `center` translates the text (anchor follows, size/angle unchanged)", () => {
    const t = new TextEntity("Ab", fontId, 10, { x: 0, y: 0 });
    const before = t.getPoint("center");
    t.setPoint("center", { x: before.x + 15, y: before.y - 4 });
    expect(t.position.x).toBeCloseTo(15, 6);
    expect(t.position.y).toBeCloseTo(-4, 6);
    expect(t.sizeMM).toBeCloseTo(10, 6);
    expect(t.angle).toBeCloseTo(0, 6);
  });
});

describe("Point-on-line centres text — and keeps it centred as it changes", () => {
  const buildCentred = (str: string) => {
    const doc = new CADDocument({ width: 200, height: 200 });
    // Vertical construction line pinned on the rectangle centreline (x = 100).
    const line = doc.add(new LineEntity({ x: 100, y: 0 }, { x: 100, y: 200 }));
    line.isConstruction = true;
    doc.addConstraint(
      makeConstraint("fixedPoint", { points: [{ entityId: line.id, key: "a" }], params: [100, 0] }),
    );
    doc.addConstraint(
      makeConstraint("fixedPoint", {
        points: [{ entityId: line.id, key: "b" }],
        params: [100, 200],
      }),
    );
    // Text starts off to the left; its centre gets pinned onto the line.
    const t = doc.add(new TextEntity(str, fontId, 10, { x: 5, y: 100 }));
    doc.addConstraint(
      makeConstraint("pointOnLine", {
        points: [{ entityId: t.id, key: "center" }],
        entities: [line.id],
      }),
    );
    return { doc, t };
  };

  it("solving lands the text's horizontal centre on the line", () => {
    const { doc, t } = buildCentred("CUT ONCE");
    expect(solve(doc).converged).toBe(true);
    expect(t.getPoint("center").x).toBeCloseTo(100, 3); // centred in X
    // The anchor sits its local ink-centre offset to the left of the centreline.
    const localCx = (t.localBox().min.x + t.localBox().max.x) / 2;
    expect(t.position.x).toBeCloseTo(100 - localCx, 2);
  });

  it("editing the text to a wider string re-centres on the next solve (live)", () => {
    const { doc, t } = buildCentred("CUT ONCE");
    solve(doc);
    const anchorBefore = t.position.x;

    // Simulate the double-click edit growing the string, then a re-solve.
    t.text = "FORCE FIT ANYWAY";
    expect(solve(doc).converged).toBe(true);

    expect(t.getPoint("center").x).toBeCloseTo(100, 3); // still centred
    expect(t.position.x).toBeLessThan(anchorBefore); // anchor shifted left to compensate
  });

  it("round-trips through save/load and still centres", () => {
    const { doc } = buildCentred("MEASURE TWICE");
    const doc2 = new CADDocument({ width: 1, height: 1 });
    applyFile(doc2, serializeDoc(doc, "tc"));
    expect(
      doc2.constraints.some(
        (c) => c.type === "pointOnLine" && c.points.some((p) => p.key === "center"),
      ),
    ).toBe(true);
    expect(solve(doc2).converged).toBe(true);
    const t2 = doc2.entities.find((e) => e.type === "text") as TextEntity;
    expect(t2.getPoint("center").x).toBeCloseTo(100, 3);
  });
});
