import { test, expect } from "vitest";
import { getExamples } from "../src/io/examples";

test("bundled examples are ordered by tier, not alphabetically", () => {
  const names = getExamples().map((e) => e.name);

  // Sanity: the known examples are present.
  for (const n of ["Keychain Tag", "Mounting Plate", "Enclosure Lid"]) {
    expect(names).toContain(n);
  }

  expect(names.indexOf("Keychain Tag")).toBeLessThan(names.indexOf("Enclosure Lid"));
  expect(names.indexOf("Mounting Plate")).toBeLessThan(names.indexOf("Mounting Plate + CAM"));
});

test("keychain-tag example centers text horizontally between circle and right edge and vertically in tag", () => {
  const examples = getExamples();
  const keychain = examples.find((e) => e.name === "Keychain Tag");
  expect(keychain).toBeDefined();
  const con3 = (keychain!.file.constraints as any[])?.find((c) => c.id === "con3");
  expect(con3?.type).toBe("midpoint");
  expect(con3?.points).toEqual([
    { entityId: "ent3", key: "center" },
    { entityId: "ent2", key: "c" },
    { entityId: "ent1", key: "mid_r" },
  ]);
});

