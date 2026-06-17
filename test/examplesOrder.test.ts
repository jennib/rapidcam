import { test, expect } from "vitest";
import { getExamples } from "../src/io/examples";

test("bundled examples are ordered by tier, not alphabetically", () => {
  const names = getExamples().map((e) => e.name);

  // Sanity: the known examples are present.
  for (const n of ["Keychain Tag", "Mounting Plate", "Enclosure Lid"]) {
    expect(names).toContain(n);
  }

  // Tier order must win: the Tier-1 keychain precedes the Tier-3 lid.
  // (Alphabetical would put "Enclosure Lid" first.)
  expect(names.indexOf("Keychain Tag")).toBeLessThan(names.indexOf("Enclosure Lid"));
  expect(names.indexOf("Mounting Plate")).toBeLessThan(names.indexOf("Mounting Plate + CAM"));
});
