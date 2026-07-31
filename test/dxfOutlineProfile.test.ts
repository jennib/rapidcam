import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { ArcEntity, PolylineEntity, type Entity } from "../src/model/entities";
import { checkOpSelection } from "../src/ui/camBarHelpers";
import { generateGCode } from "../src/cam/gcode";
import type { CAMOperation } from "../src/cam/types";

/**
 * An imported DXF outline must survive the whole way from "user picks it" to
 * "the post emits cutting moves".
 *
 * DXF outlines arrive as runs of **open** polyline joined by separate arcs
 * (bulged segments become true arcs on import, so a rounded shape is never one
 * entity). The CAM dialog's selection check used to require polylines be
 * `closed`, which quietly deleted every polyline run from the op — leaving the
 * arcs alone, no longer a closed chain, and a toolpath that cut nothing. The
 * dialog accepted it, so the only symptom was an empty 3-D preview.
 *
 * Testing the two halves separately would not have caught it: the selection
 * check was self-consistent, and the generator chains open polylines perfectly
 * well when it is actually handed them. Only the seam was broken, so this test
 * drives the seam — the op is built from `checkOpSelection`'s output, exactly
 * as the dialog builds it.
 */

/** A 10 × 10 stadium: two open polyline sides closed by two semicircular ends. */
function dxfStyleOutline(): Entity[] {
  return [
    new PolylineEntity(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      false,
    ),
    new ArcEntity({ x: 10, y: 5 }, 5, -Math.PI / 2, Math.PI / 2),
    new PolylineEntity(
      [
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ],
      false,
    ),
    new ArcEntity({ x: 0, y: 5 }, 5, Math.PI / 2, (3 * Math.PI) / 2),
  ];
}

const profileOp = (entityIds: string[]): CAMOperation => ({
  id: "p1",
  name: "Profile (outside) 1",
  type: "profile",
  entityIds,
  side: "outside",
  toolType: "end-mill",
  toolNumber: 1,
  diameter: 6.35,
  feedrate: 900,
  plungeRate: 250,
  spindleSpeed: 18000,
  safeZ: 5,
  depth: -12.7,
  stepdown: 5,
  stepover: 0.4,
});

test("an outside profile on a DXF-style outline emits cutting moves", () => {
  const doc = new CADDocument({ width: 200, height: 200 });
  doc.stockThickness = 12.7;
  const outline = dxfStyleOutline();
  for (const e of outline) doc.add(e);

  // The dialog stores the *checked* subset, so a drop here is invisible later.
  const check = checkOpSelection(
    doc.entities,
    outline.map((e) => e.id),
    "profile-outside",
  );
  expect(check.error).toBeNull();
  expect(check.validIds).toHaveLength(outline.length);

  const gcode = generateGCode([profileOp(check.validIds)], doc);
  const lines = gcode.split("\n").map((l) => l.trim());
  const cuts = lines.filter((l) => /^G1 .*[XY]/.test(l));
  const arcs = lines.filter((l) => /^G[23] /.test(l));

  // The regression: this was 0 and 0, with the whole outline noted as skipped.
  expect(cuts.length).toBeGreaterThan(0);
  expect(arcs.length).toBeGreaterThan(0);
  expect(lines.filter((l) => /NOTE:.*skipped/.test(l))).toEqual([]);
});

test("the outline's own polylines are what carry the cut, not just the arcs", () => {
  // Positive control for the test above: drop the polylines the way the old
  // check did and the same op must fall silent, proving the moves counted
  // above come from the chain closing rather than from the arcs alone.
  const doc = new CADDocument({ width: 200, height: 200 });
  doc.stockThickness = 12.7;
  const outline = dxfStyleOutline();
  for (const e of outline) doc.add(e);

  const arcsOnly = outline.filter((e) => e instanceof ArcEntity).map((e) => e.id);
  const gcode = generateGCode([profileOp(arcsOnly)], doc);
  const cuts = gcode.split("\n").filter((l) => /^G[123] .*[XY]/.test(l.trim()));
  expect(cuts).toEqual([]);
  expect(gcode).toMatch(/NOTE: arc .* skipped/);
});
