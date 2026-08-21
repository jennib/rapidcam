import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, test, expect } from "vitest";
import { loadFromFile } from "../src/core/fontManager";
import { applyFile } from "../src/io/fileio";
import { getExamples } from "../src/io/examples";
import { CADDocument } from "../src/model/document";
import type { RectEntity, TextEntity } from "../src/model/entities";
import { solve } from "../src/solver/solver";

beforeAll(async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const bytes = readFileSync(join(here, "..", "public", "fonts", "roboto-regular.woff"));
  const fakeFile = {
    name: "roboto.woff",
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as File;
  await loadFromFile(fakeFile);
});

test("bundled examples are ordered by tier, not alphabetically", () => {
  const names = getExamples().map((e) => e.name);

  // Sanity: the known examples are present.
  for (const n of ["Keychain Tag", "Mounting Plate", "Enclosure Lid"]) {
    expect(names).toContain(n);
  }

  expect(names.indexOf("Keychain Tag")).toBeLessThan(names.indexOf("Enclosure Lid"));
  expect(names.indexOf("Mounting Plate")).toBeLessThan(names.indexOf("Mounting Plate + CAM"));
});

test("keychain-tag example centers text and grows rectangle with text size", () => {
  const examples = getExamples();
  const keychain = examples.find((e) => e.name === "Keychain Tag");
  expect(keychain).toBeDefined();
  const con3 = (keychain!.file.constraints as any[])?.find((c) => c.id === "con3");
  expect(con3?.type).toBe("horizontal");
  expect(con3?.points).toEqual([
    { entityId: "ent3", key: "center" },
    { entityId: "ent2", key: "c" },
  ]);
  const dim1 = (keychain!.file.dimensions as any[])?.find((d) => d.id === "dim1");
  expect(dim1?.type).toBe("horizontal");
  expect(dim1?.points).toEqual([
    { entityId: "ent2", key: "c" },
    { entityId: "ent3", key: "mid_l" },
  ]);
  const dim4 = (keychain!.file.dimensions as any[])?.find((d) => d.id === "dim4");
  expect(dim4?.type).toBe("horizontal");
  expect(dim4?.points).toEqual([
    { entityId: "ent3", key: "mid_r" },
    { entityId: "ent1", key: "br" },
  ]);

  const doc = new CADDocument({ width: 200, height: 100 });
  applyFile(doc, keychain!.file);
  const res1 = solve(doc);
  expect(res1.converged).toBe(true);

  const rect = doc.entities.find((e) => e.type === "rectangle") as RectEntity;
  const text = doc.entities.find((e) => e.type === "text") as TextEntity;
  const initialWidth = rect.width;

  // Edit text to a long string (e.g. NAMEzcvzcv) -> rectangle must grow
  text.text = "NAMEzcvzcv";
  const res2 = solve(doc);
  expect(res2.converged).toBe(true);
  expect(rect.width).toBeGreaterThan(initialWidth + 20);
  expect(rect.p1.x).toBeCloseTo(text.getPoint("mid_r").x + 11.35, 2);
  expect(text.getPoint("mid_l").x).toBeCloseTo(25 + 11.35, 2);
  expect(text.getPoint("center").y).toBeCloseTo(24, 2);
});

