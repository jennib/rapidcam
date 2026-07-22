import { describe, it, expect } from "vitest";
import { formatFeed, formatLength, fromMM, toMM } from "../src/core/units";

describe("formatLength (mm -> display-unit rounding)", () => {
  it("never leaks a raw float when mm doesn't divide evenly into inches", () => {
    // Regression: the CAM Add-Toolpath dialog fix (camBar.ts) originally wired
    // several fields through raw `fromMM` with no rounding, reproducing the
    // exact "-19.049999999999997mm" bug the fix was meant to close — just in
    // the mm->in direction instead. 19.05mm = 0.75in exactly, but the raw JS
    // division is 0.7500000000000001 — formatLength must round that away.
    expect(formatLength(-19.05, "in")).toBe("-0.750");
    expect(formatLength(5, "in")).toBe("0.197"); // 3 decimals for inches
    expect(formatLength(6.35, "in")).toBe("0.250");
  });

  it("rounds mm to 2 decimals", () => {
    expect(formatLength(3, "mm")).toBe("3.00");
    expect(formatLength(19.05, "mm")).toBe("19.05");
  });

  it("round-trips through toMM without drift beyond its own rounding", () => {
    for (const mm of [3, -19.05, 6.35, 100, 0.1]) {
      const shown = formatLength(mm, "in");
      const back = toMM(parseFloat(shown), "in");
      expect(back).toBeCloseTo(mm, 2); // within the display's own precision
    }
  });
});

describe("formatFeed (mm/min -> display-unit/min rounding)", () => {
  it("rounds to whole mm/min and one decimal of in/min", () => {
    expect(formatFeed(1000, "mm")).toBe("1000");
    expect(formatFeed(1000, "in")).toBe(fromMM(1000, "in").toFixed(1));
    expect(formatFeed(1000, "in")).toBe("39.4");
  });

  it("never leaks a raw float in either unit", () => {
    expect(formatFeed(300, "in")).not.toMatch(/\d{5,}/); // no long decimal tail
    expect(formatFeed(300, "mm")).toBe("300");
  });
});
