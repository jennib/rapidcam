import { describe, it, expect } from "vitest";
import { parseLength } from "../src/core/units";
import { evalExpr } from "../src/core/expr";

describe("Variable and length input normalization", () => {
  it("parses numbers with decimal comma separators", () => {
    expect(parseLength("922,5", "mm")).toBeCloseTo(922.5);
    expect(parseLength("922,5mm", "mm")).toBeCloseTo(922.5);
    expect(parseLength("0922,5", "mm")).toBeCloseTo(922.5);
  });

  it("evaluates expressions with decimal comma separators", () => {
    const vars = new Map([["var1", 10]]);
    expect(evalExpr("922,5", vars)).toBeCloseTo(922.5);
    expect(evalExpr("0922,5 + var1", vars)).toBeCloseTo(932.5);
  });

  it("normalizes leading zeroes and commas", () => {
    const normalizeExpr = (val: string): string => {
      let s = val.trim();
      s = s.replace(/(\d+),(\d+)/g, "$1.$2");
      s = s.replace(/\b0+(?=[1-9])/g, "");
      return s;
    };

    expect(normalizeExpr("0922,5")).toBe("922.5");
    expect(normalizeExpr("0922.5")).toBe("922.5");
    expect(normalizeExpr("922,5")).toBe("922.5");
    expect(normalizeExpr("050")).toBe("50");
    expect(normalizeExpr("0.5")).toBe("0.5");
  });
});
