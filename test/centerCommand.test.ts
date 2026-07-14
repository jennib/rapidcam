import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { loadFromFile } from "../src/core/fontManager";
import { CADDocument } from "../src/model/document";
import { CircleEntity, RectEntity, TextEntity } from "../src/model/entities";
import { solve } from "../src/solver/solver";
import { canCenter, centerKeyOf, planCenter } from "../src/tools/centerCommand";

// The one-click "Center" command, backed by a DIRECTIONAL `center` constraint.
// Invariants these lock in:
//   1. Centring moves ONLY the mover — the reference never budges.
//   2. Editing the mover (e.g. re-typing text) keeps it centred, no drift.
//   3. It's FULLY LIVE: moving OR resizing the reference re-centres the mover.

let fontId: string;
const rectCx = (r: RectEntity) => (r.getPoint("bl").x + r.getPoint("tr").x) / 2;
const rectCy = (r: RectEntity) => (r.getPoint("bl").y + r.getPoint("tr").y) / 2;

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

const applyCenter = (doc: CADDocument, axis: "h" | "v" | "both") => {
  const plan = planCenter(doc, axis);
  if (!plan.ok) throw new Error(plan.reason);
  for (const c of plan.constraints) doc.addConstraint(c);
  return solve(doc);
};

describe("selection inference", () => {
  it("finds centre keys per type and needs ≥2 candidates", () => {
    expect(centerKeyOf(new TextEntity("Ag", fontId, 10, { x: 0, y: 0 }))).toBe("center");
    expect(centerKeyOf(new RectEntity({ x: 0, y: 0 }, { x: 10, y: 10 }))).toBe("center");
    expect(centerKeyOf(new CircleEntity({ x: 0, y: 0 }, 5))).toBe("c");

    const doc = new CADDocument({ width: 100, height: 100 });
    const text = doc.add(new TextEntity("Ag", fontId, 10, { x: 0, y: 0 }));
    text.selected = true;
    expect(canCenter(doc)).toBe(false); // text alone
    doc.add(new RectEntity({ x: 0, y: 0 }, { x: 100, y: 60 })).selected = true;
    expect(canCenter(doc)).toBe(true); // text + rect
  });
});

describe("centring moves only the mover", () => {
  it("centres text horizontally without moving an UNPINNED rectangle", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const rect = doc.add(new RectEntity({ x: 0, y: 0 }, { x: 120, y: 60 }));
    const t = doc.add(new TextEntity("Ag", fontId, 10, { x: 10, y: 25 }));
    rect.selected = t.selected = true;
    const cx = rectCx(rect);
    const cyBefore = rectCy(rect);

    expect(applyCenter(doc, "h").converged).toBe(true);
    expect(t.getPoint("center").x).toBeCloseTo(cx, 3); // text centred in X
    expect(rectCx(rect)).toBeCloseTo(cx, 6); // rectangle DID NOT MOVE
    expect(rectCy(rect)).toBeCloseTo(cyBefore, 6);
  });

  it("'both' centres in X and Y; the rectangle stays put", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const rect = doc.add(new RectEntity({ x: 0, y: 0 }, { x: 120, y: 60 }));
    const t = doc.add(new TextEntity("Ag", fontId, 10, { x: 5, y: 5 }));
    rect.selected = t.selected = true;
    const cx = rectCx(rect);
    const cy = rectCy(rect);

    expect(applyCenter(doc, "both").converged).toBe(true);
    expect(t.getPoint("center").x).toBeCloseTo(cx, 3);
    expect(t.getPoint("center").y).toBeCloseTo(cy, 3);
    expect(rectCx(rect)).toBeCloseTo(cx, 6);
    expect(rectCy(rect)).toBeCloseTo(cy, 6);
  });

  it("horizontal centring leaves the Y axis free", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const rect = doc.add(new RectEntity({ x: 0, y: 0 }, { x: 120, y: 60 }));
    const t = doc.add(new TextEntity("Ag", fontId, 10, { x: 10, y: 25 }));
    rect.selected = t.selected = true;
    const yBefore = t.getPoint("center").y;
    applyCenter(doc, "h");
    expect(t.getPoint("center").y).toBeCloseTo(yBefore, 6);
  });
});

describe("fully live", () => {
  it("re-centres when the text is edited, WITHOUT drifting the rectangle", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const rect = doc.add(new RectEntity({ x: 0, y: 0 }, { x: 120, y: 60 }));
    const t = doc.add(new TextEntity("Ag", fontId, 10, { x: 10, y: 25 }));
    rect.selected = t.selected = true;
    const cx = rectCx(rect);
    applyCenter(doc, "h");

    t.text = "FORCE FIT ANYWAY"; // much wider
    expect(solve(doc).converged).toBe(true);
    expect(t.getPoint("center").x).toBeCloseTo(cx, 3); // still centred
    expect(rectCx(rect)).toBeCloseTo(cx, 6); // ← the redo's whole point: no drift
  });

  it("follows the rectangle when it MOVES", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const rect = doc.add(new RectEntity({ x: 0, y: 0 }, { x: 120, y: 60 }));
    const t = doc.add(new TextEntity("Ag", fontId, 10, { x: 10, y: 25 }));
    rect.selected = t.selected = true;
    applyCenter(doc, "h");

    rect.translate({ x: 40, y: 0 }); // shove the box right
    expect(solve(doc).converged).toBe(true);
    expect(t.getPoint("center").x).toBeCloseTo(rectCx(rect), 3); // text followed
  });

  it("follows the rectangle when it RESIZES", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const rect = doc.add(new RectEntity({ x: 0, y: 0 }, { x: 120, y: 60 }));
    const t = doc.add(new TextEntity("Ag", fontId, 10, { x: 10, y: 25 }));
    rect.selected = t.selected = true;
    applyCenter(doc, "h");

    rect.setPoint("tr", { x: 200, y: 60 }); // widen; centre-x 60 → 100
    expect(solve(doc).converged).toBe(true);
    expect(t.getPoint("center").x).toBeCloseTo(rectCx(rect), 3);
    expect(rectCx(rect)).toBeCloseTo(100, 6);
  });
});

describe("edge cases", () => {
  it("reports a reason when there's no reference", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    doc.add(new TextEntity("Ag", fontId, 10, { x: 0, y: 0 })).selected = true;
    expect(planCenter(doc, "h").ok).toBe(false);
  });

  it("stacks multiple texts onto the same reference centre-line", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const rect = doc.add(new RectEntity({ x: 0, y: 0 }, { x: 120, y: 60 }));
    const t1 = doc.add(new TextEntity("ONE", fontId, 10, { x: 5, y: 40 }));
    const t2 = doc.add(new TextEntity("TWO", fontId, 10, { x: 8, y: 15 }));
    rect.selected = t1.selected = t2.selected = true;
    const cx = rectCx(rect);
    expect(applyCenter(doc, "h").converged).toBe(true);
    expect(t1.getPoint("center").x).toBeCloseTo(cx, 3);
    expect(t2.getPoint("center").x).toBeCloseTo(cx, 3);
  });
});
