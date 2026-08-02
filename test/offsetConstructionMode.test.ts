import { describe, it, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { LineEntity, CircleEntity } from "../src/model/entities";

describe("Construction Mode offset test", () => {
  it("creates construction entity when doc.isConstructionMode is true", () => {
    const doc = new CADDocument({ width: 400, height: 400 });
    doc.isConstructionMode = true;

    const line = new LineEntity({ x: 0, y: 0 }, { x: 100, y: 0 });
    const addedLine = doc.add(line);

    expect(addedLine.isConstruction).toBe(true);

    const circle = new CircleEntity({ x: 50, y: 50 }, 20);
    const addedCircle = doc.addSelected(circle);

    expect(addedCircle.isConstruction).toBe(true);
  });
});
