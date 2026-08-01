/**
 * Layer beam recipes through the headless posting path.
 *
 * `postPrograms` is what the CLI and the MCP server call — the same entry the
 * export button uses, and the one that picks between a flat program, a rotary
 * wrap and a two-sided pair. A layer recipe is resolved deep inside
 * `generateLaserGCode`, so nothing here should need to know about it; this
 * proves that, rather than assuming it, for the consumers with no browser.
 */

import { test, expect } from "vitest";
import { buildJobFromLayers } from "../src/cam/laserJob";
import { postPrograms } from "../src/cam/postPrograms";
import { serializeDoc, applyFile } from "../src/io/fileio";
import { CADDocument } from "../src/model/document";
import { LineEntity, RectEntity } from "../src/model/entities";

/** A two-colour laser job: cut the outline, score the fold. */
function twoColour(machineKind: "laser" | "laser-rotary"): CADDocument {
  const doc = new CADDocument({ width: 300, height: 200 });
  doc.machineKind = machineKind;
  if (machineKind === "laser-rotary")
    doc.rotary = { axisWord: "A", diameter: 80, wrapAxis: "y", zero: "surface" };
  doc.origin = { x: "left", y: "front", z: "top" };

  doc.layers[0].name = "Cut";
  doc.layers[0].laser = { kind: "cut", feedrate: 300, laserPower: 100, laserPasses: 2 };
  doc.layers.push({
    id: "l-score",
    name: "Score",
    color: "#e05a5a",
    visible: true,
    locked: false,
    laser: { kind: "score", feedrate: 1800, laserPower: 15, laserPasses: 1 },
  });

  doc.entities.push(new RectEntity({ x: 20, y: 20 }, { x: 160, y: 100 }, "outline"));
  const fold = new LineEntity({ x: 90, y: 20 }, { x: 90, y: 100 }, "fold");
  fold.layerId = "l-score";
  doc.entities.push(fold);

  doc.operations = buildJobFromLayers(doc).operations;
  return doc;
}

test("a layer-built job posts headlessly with each layer's settings", () => {
  const doc = twoColour("laser");
  const out = postPrograms(doc, "job");

  expect(out.programs).toHaveLength(1);
  const g = out.programs[0].gcode;
  expect(g).toContain("S1000"); // cut at 100%
  expect(g).toContain("S150"); // score at 15%
  expect(g).toMatch(/F300\b/);
  expect(g).toMatch(/F1800\b/);
  expect(g).toContain("M30");
});

test("the rotary wrap keeps the per-layer settings, headlessly", () => {
  const out = postPrograms(twoColour("laser-rotary"), "job");
  const g = out.programs[0].gcode;

  expect(g.toLowerCase()).toContain("cylinder dia");
  expect(g).toContain("S1000");
  expect(g).toContain("S150");
  // Axis substitution: a laser rotary emits surface mm on a linear word, so no
  // rotary-axis word appears at all — and no laser program moves in Z.
  expect(g).not.toMatch(/(^|\s)A-?\d/m);
  for (const line of g.split("\n"))
    expect(line, `Z move in a laser program: ${line}`).not.toMatch(/^G[0-3].*\sZ-?\d/);
});

test("a file saved with recipes rebuilds and posts the same job when reopened", () => {
  // The whole chain an AI or CLI user travels: build, save, reopen, rebuild,
  // post. A recipe that failed to serialise would show up as a program at the
  // operations' own fallback numbers rather than the layer's.
  const original = twoColour("laser");
  const text = JSON.stringify(serializeDoc(original, "two-colour"));

  const reopened = new CADDocument({ width: 300, height: 200 });
  applyFile(reopened, JSON.parse(text));
  expect(reopened.layers.map((l) => l.laser?.kind)).toEqual(["cut", "score"]);

  reopened.operations = buildJobFromLayers(reopened).operations;
  expect(reopened.operations.map((o) => o.name)).toEqual(["Cut", "Score"]);

  const before = postPrograms(original, "job").programs[0].gcode;
  const after = postPrograms(reopened, "job").programs[0].gcode;
  // Operation ids differ across a rebuild, so compare the motion, not the text.
  const moves = (g: string) => g.split("\n").filter((l) => /^G[0-3] /.test(l));
  expect(moves(after)).toEqual(moves(before));
});

test("a hidden layer stays out of the job after a round trip", () => {
  const doc = twoColour("laser");
  doc.layers[1].visible = false;
  const text = JSON.stringify(serializeDoc(doc, "hidden"));

  const reopened = new CADDocument({ width: 300, height: 200 });
  applyFile(reopened, JSON.parse(text));
  expect(reopened.layers[1].visible).toBe(false);

  const { operations, skipped } = buildJobFromLayers(reopened);
  expect(operations.map((o) => o.name)).toEqual(["Cut"]);
  expect(skipped).toEqual([{ layer: "Score", why: "the layer is hidden" }]);
});
