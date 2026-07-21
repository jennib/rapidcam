/**
 * Backs the SolidWorks-style geometry colouring: the renderer paints an entity
 * blue iff computeEntityDofStatus reports it "under-defined". These assert the
 * status the colour keys off — fresh geometry is under-defined (blue), fully
 * pinned geometry is defined (layer colour).
 */
import { describe, it, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { LineEntity } from "../src/model/entities";
import { makeConstraint } from "../src/model/constraints";
import { solve, computeEntityDofStatus } from "../src/solver/solver";

describe("entity DOF status drives the under-defined colour", () => {
  it("a freshly drawn line is under-defined (blue), with no constraints", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const line = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 50, y: 0 }));
    const status = computeEntityDofStatus(doc, solve(doc));
    expect(status.get(line.id)).toBe("under-defined");
  });

  it("a fully-fixed line is defined (reverts to layer colour)", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const line = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 50, y: 0 }));
    doc.addConstraint(makeConstraint("fixed", { entities: [line.id] }));
    const status = computeEntityDofStatus(doc, solve(doc));
    expect(status.get(line.id)).toBe("defined");
  });
});
