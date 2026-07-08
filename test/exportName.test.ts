import { test, expect } from "vitest";
import { formatExportName, sanitizePart, timeStamp } from "../src/cam/exportName";

test("assembles project_scope_date_time.ext", () => {
  const stamp = timeStamp(new Date(2026, 6, 8, 14, 32, 7)); // month is 0-based → July
  expect(stamp).toBe("2026-07-08_143207");
  expect(formatExportName({ project: "bracket", scope: "all", stamp })).toBe(
    "bracket_all_2026-07-08_143207.nc",
  );
});

test("zero-pads date and time components", () => {
  expect(timeStamp(new Date(2026, 0, 3, 4, 5, 6))).toBe("2026-01-03_040506");
});

test("honours a custom extension (e.g. the two-sided zip)", () => {
  const stamp = "2026-07-08_144030";
  expect(formatExportName({ project: "bracket", scope: "two-sided", stamp, ext: "zip" })).toBe(
    "bracket_two-sided_2026-07-08_144030.zip",
  );
});

test("shares one stamp across a matched set of files", () => {
  const stamp = timeStamp(new Date(2026, 6, 8, 14, 40, 30));
  const a = formatExportName({ project: "bracket", scope: "sideA", stamp });
  const b = formatExportName({ project: "bracket", scope: "sideB", stamp });
  expect(a).toBe("bracket_sideA_2026-07-08_144030.nc");
  expect(b).toBe("bracket_sideB_2026-07-08_144030.nc");
});

test("reduces name parts to CNC-safe characters", () => {
  expect(sanitizePart("My Part (v2)/final")).toBe("My_Part_v2_final");
  expect(sanitizePart("  spaces  ")).toBe("spaces");
  expect(sanitizePart("__leading-trailing__")).toBe("leading-trailing");
});

test("falls back to sane defaults for empty parts", () => {
  const stamp = "2026-07-08_090000";
  expect(formatExportName({ project: "", scope: "", stamp })).toBe(
    "untitled_toolpath_2026-07-08_090000.nc",
  );
  // A name that sanitizes to nothing (all punctuation) also falls back.
  expect(formatExportName({ project: "!!!", scope: "###", stamp })).toBe(
    "untitled_toolpath_2026-07-08_090000.nc",
  );
});
