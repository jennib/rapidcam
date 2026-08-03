import { describe, expect, test } from "vitest";
import { generateGCode } from "../src/cam/gcode";
import { generateLaserGCode } from "../src/cam/lasergcode";
import { buildLintContext, lintGCode } from "../src/cam/lint";
import { isMachinable } from "../src/cam/machinable";
import { CADDocument } from "../src/model/document";
import { CircleEntity } from "../src/model/entities";
import type { CAMOperation } from "../src/cam/types";

/**
 * Hidden geometry is not cut.
 *
 * This is the rule with the sharpest consequences in the app: it decides what
 * the machine does, and getting it wrong in either direction wastes material.
 * So it is asserted against the *emitted program*, not against the predicate —
 * a unit test of `isMachinable` alone would pass just as happily if none of the
 * three generators had been wired to it, which is the failure mode that
 * matters. Both a hidden entity and an entity on a hidden layer are covered,
 * and every exclusion is paired with a visible sibling as a positive control,
 * so "no motion for the hidden hole" can't pass by way of no motion at all.
 *
 * The paired pre-flight warning is asserted here too rather than in a lint test
 * of its own: silent exclusion is the actual hazard, so the exclusion and the
 * warning about it are one behaviour and should fail together.
 */

const DRILL: Omit<CAMOperation, "entityIds"> = {
  id: "op1",
  name: "holes",
  type: "drill",
  side: "outside",
  toolType: "drill",
  toolNumber: 1,
  diameter: 3,
  stepover: 0.4,
  feedrate: 600,
  plungeRate: 200,
  spindleSpeed: 12000,
  safeZ: 5,
  depth: -5,
  stepdown: 2,
};

/** Two holes 60mm apart, both in one drill op; `hide` picks which vanishes. */
function twoHoles(hide: "none" | "entity" | "layer"): {
  doc: CADDocument;
  kept: CircleEntity;
  gone: CircleEntity;
} {
  const doc = new CADDocument({ width: 200, height: 150 }, "mm");
  doc.stockRect = { x: 0, y: 0, width: 200, height: 150 };
  const kept = doc.add(new CircleEntity({ x: 40, y: 75 }, 3));
  const gone = doc.add(new CircleEntity({ x: 100, y: 75 }, 3));

  if (hide === "entity") gone.visible = false;
  if (hide === "layer") {
    doc.layers.push({
      id: "layer-hidden",
      name: "Hidden",
      color: "#888888",
      visible: false,
      locked: false,
    });
    gone.layerId = "layer-hidden";
  }

  doc.operations.push({ ...DRILL, entityIds: [kept.id, gone.id] } as CAMOperation);
  return { doc, kept, gone };
}

/** Does the program command any motion at this X? */
const cutsAtX = (gcode: string, x: number): boolean =>
  new RegExp(`X${x}(\\D|$)`, "m").test(gcode);

describe("mill output", () => {
  test("both holes are drilled when nothing is hidden", () => {
    const { doc } = twoHoles("none");
    const g = generateGCode(doc.operations, doc);
    expect(cutsAtX(g, 40)).toBe(true);
    expect(cutsAtX(g, 100)).toBe(true);
  });

  test("a hidden entity is left out of the program", () => {
    const { doc } = twoHoles("entity");
    const g = generateGCode(doc.operations, doc);
    expect(cutsAtX(g, 40)).toBe(true); // positive control
    expect(cutsAtX(g, 100)).toBe(false);
  });

  test("an entity on a hidden layer is left out too", () => {
    const { doc } = twoHoles("layer");
    const g = generateGCode(doc.operations, doc);
    expect(cutsAtX(g, 40)).toBe(true);
    expect(cutsAtX(g, 100)).toBe(false);
  });

  test("showing it again brings the motion back", () => {
    const { doc, gone } = twoHoles("entity");
    expect(cutsAtX(generateGCode(doc.operations, doc), 100)).toBe(false);
    gone.visible = true;
    expect(cutsAtX(generateGCode(doc.operations, doc), 100)).toBe(true);
  });
});

describe("laser output", () => {
  test("a hidden entity is left out of the beam program", () => {
    const { doc, gone } = twoHoles("entity");
    doc.machineKind = "laser";
    doc.operations[0] = { ...doc.operations[0], type: "profile", name: "cut" };

    const g = generateLaserGCode(doc.operations, doc);
    expect(cutsAtX(g, 40) || /X4[0-9]/.test(g)).toBe(true); // positive control
    expect(/X10[0-3]/.test(g)).toBe(false);

    gone.visible = true;
    expect(/X10[0-3]/.test(generateLaserGCode(doc.operations, doc))).toBe(true);
  });
});

describe("pre-flight warning", () => {
  test("names the hidden geometry an op still references", () => {
    const { doc, gone } = twoHoles("entity");
    const g = generateGCode(doc.operations, doc);
    const findings = lintGCode(g, buildLintContext(doc));

    const hit = findings.find((f) => f.code === "hidden-geometry");
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe("warning");
    expect(hit?.entityIds).toEqual([gone.id]);
    expect(hit?.message).toContain("holes"); // the toolpath is named
    expect(hit?.message).toMatch(/NOT cut/);
  });

  test("stays silent when nothing is hidden", () => {
    const { doc } = twoHoles("none");
    const findings = lintGCode(generateGCode(doc.operations, doc), buildLintContext(doc));
    expect(findings.find((f) => f.code === "hidden-geometry")).toBeUndefined();
  });

  test("stays silent for construction geometry, which was never going to cut", () => {
    const { doc, gone } = twoHoles("none");
    gone.isConstruction = true;
    const findings = lintGCode(generateGCode(doc.operations, doc), buildLintContext(doc));
    expect(findings.find((f) => f.code === "hidden-geometry")).toBeUndefined();
  });
});

describe("isMachinable", () => {
  test("rejects construction, hidden entities and hidden layers alike", () => {
    const doc = new CADDocument({ width: 200, height: 150 }, "mm");
    const e = doc.add(new CircleEntity({ x: 10, y: 10 }, 3));
    expect(isMachinable(doc, e)).toBe(true);

    e.isConstruction = true;
    expect(isMachinable(doc, e)).toBe(false);
    e.isConstruction = false;

    e.visible = false;
    expect(isMachinable(doc, e)).toBe(false);
    e.visible = true;

    doc.layers[0].visible = false;
    expect(isMachinable(doc, e)).toBe(false);
  });

  test("a locked entity still cuts — locking is an editing guard, not a CAM one", () => {
    const doc = new CADDocument({ width: 200, height: 150 }, "mm");
    const e = doc.add(new CircleEntity({ x: 10, y: 10 }, 3));
    e.locked = true;
    expect(isMachinable(doc, e)).toBe(true);
  });
});
