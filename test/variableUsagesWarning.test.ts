import { describe, it, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { makeVariable } from "../src/model/variables";

describe("CADDocument.variableUsages", () => {
  it("returns empty array for an unused variable", () => {
    const doc = new CADDocument({ width: 400, height: 400 });
    doc.addVariable(makeVariable("hole_dia", "6", "mm"));
    expect(doc.variableUsages("hole_dia")).toEqual([]);
  });

  it("finds usages in other variable expressions", () => {
    const doc = new CADDocument({ width: 400, height: 400 });
    doc.addVariable(makeVariable("hole_dia", "6", "mm"));
    doc.addVariable(makeVariable("hole_radius", "hole_dia / 2", "mm"));
    expect(doc.variableUsages("hole_dia")).toEqual(["Variable 'hole_radius'"]);
  });

  it("finds usages in dimensions", () => {
    const doc = new CADDocument({ width: 400, height: 400 });
    doc.addVariable(makeVariable("plateW", "100", "mm"));
    doc.dimensions.push({
      id: "dim1",
      type: "distance",
      points: [],
      entities: [],
      value: 100,
      expr: "plateW * 2",
      driving: true,
      offset: 10,
    });
    expect(doc.variableUsages("plateW")).toEqual(["Dimension (plateW * 2)"]);
  });
});
