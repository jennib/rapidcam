import { test, expect } from "vitest";
import { serializeDoc, applyFile } from "../src/io/fileio";
import { generateGCode } from "../src/cam/gcode";
import { CADDocument } from "../src/model/document";
import { RectEntity } from "../src/model/entities";
import type { CAMOperation } from "../src/cam/types";

function profileOp(doc: CADDocument): CAMOperation {
  return {
    id: "p", name: "cut", type: "profile",
    entityIds: [doc.entities.find((e) => e.type === "rectangle")!.id],
    side: "outside", toolType: "end-mill", toolNumber: 1, diameter: 3,
    feedrate: 1000, plungeRate: 300, spindleSpeed: 18000, safeZ: 5,
    depth: -2, stepdown: 2, stepover: 0.4,
  };
}

test("metadata round-trips through serialize/apply, dropping blanks", () => {
  const doc = new CADDocument({ width: 100, height: 100 });
  doc.metadata = { job: "  Bracket  ", revision: "B", notes: "" };
  const file = serializeDoc(doc, "Bracket");
  // Blank notes dropped, job trimmed.
  expect(file.metadata).toEqual({ job: "Bracket", revision: "B" });

  const restored = new CADDocument({ width: 1, height: 1 });
  applyFile(restored, file);
  expect(restored.metadata).toEqual({ job: "Bracket", revision: "B" });
});

test("all-blank metadata is omitted from the file", () => {
  const doc = new CADDocument({ width: 100, height: 100 });
  doc.metadata = { job: "   ", revision: "", notes: "  " };
  expect(serializeDoc(doc, "x").metadata).toBeUndefined();
});

test("non-empty metadata is emitted in the G-code header", () => {
  const doc = new CADDocument({ width: 100, height: 100 });
  doc.add(new RectEntity({ x: 0, y: 0 }, { x: 50, y: 50 }));
  doc.metadata = { job: "Bracket", revision: "B", notes: "two\nlines" };
  const g = generateGCode([profileOp(doc)], doc);
  expect(g).toMatch(/; Job: Bracket/);
  expect(g).toMatch(/; Revision: B/);
  // newlines collapsed to keep the comment on one line
  expect(g).toMatch(/; Notes: two lines/);
});

test("no metadata header lines when metadata is empty", () => {
  const doc = new CADDocument({ width: 100, height: 100 });
  doc.add(new RectEntity({ x: 0, y: 0 }, { x: 50, y: 50 }));
  const g = generateGCode([profileOp(doc)], doc);
  expect(g).not.toMatch(/; Job:/);
  expect(g).not.toMatch(/; Revision:/);
});
