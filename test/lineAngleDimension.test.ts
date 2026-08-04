// @vitest-environment happy-dom
import { beforeEach, describe, expect, test } from "vitest";
import { CADDocument } from "../src/model/document";
import { LineEntity } from "../src/model/entities";
import {
  dimensionLayout,
  dimensionMeasure,
  dimensionResiduals,
  makeDimension,
} from "../src/model/dimensions";
import { solve } from "../src/solver/solver";
import { makeVariable } from "../src/model/variables";
import { evaluateAll } from "../src/model/variables";
import { PropertiesBar } from "../src/ui/propertiesBar";

/**
 * `angle-x` — a line's direction measured from the +X axis.
 *
 * This exists so a line's Angle property can be driven by a formula. Both
 * SolidWorks and Fusion express the same idea by dimensioning against the
 * sketch's origin axes; naming the axis in the dimension TYPE rather than adding
 * axis entities was a maintenance-cost decision (see the type's doc comment) and
 * is invisible to the user either way.
 *
 * The assertions that matter are about the SOLVER, not the field: a formula is
 * only worth anything if the constraint actually holds the direction when
 * something else moves.
 */

/** angle-x stores DEGREES — see the type's doc comment. */
const dirDeg = (l: LineEntity) =>
  (Math.atan2(l.b.y - l.a.y, l.b.x - l.a.x) * 180) / Math.PI;
const geoOf = (doc: CADDocument) => {
  const byId = new Map(doc.entities.map((e) => [e.id, e]));
  return (id: string) => byId.get(id);
};

let doc: CADDocument;
let line: LineEntity;

beforeEach(() => {
  document.body.innerHTML = "";
  doc = new CADDocument({ width: 200, height: 150 }, "mm");
  doc.addVariable(makeVariable("tilt", "30", "mm"));
  line = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 40, y: 0 }));
});

describe("measurement", () => {
  test("reads the direction from +X, signed", () => {
    const dim = makeDimension("angle-x", { entities: [line.id], value: 0, offset: 0 });
    expect(dimensionMeasure(dim, geoOf(doc))!).toBeCloseTo(0, 6);

    line.b = { x: 0, y: 40 };
    expect(dimensionMeasure(dim, geoOf(doc))!).toBeCloseTo(90, 6);

    line.b = { x: 40, y: -40 };
    expect(dimensionMeasure(dim, geoOf(doc))!).toBeCloseTo(-45, 6);
  });

  test("takes the SHORT way round the ±180° seam", () => {
    // 179° vs a target of -179° is 2° apart, not 358°. A raw subtraction would
    // report the long way and drive the solver away from the answer.
    line.b = { x: -40, y: 0.7 }; // just under +180°
    const dim = makeDimension("angle-x", { entities: [line.id], value: -179, offset: 0 });
    const [residual] = dimensionResiduals(dim, geoOf(doc));
    expect(Math.abs(residual)).toBeLessThan(5);
  });
});

describe("the solver holds it", () => {
  test("a driving angle rotates the line to the target", () => {
    doc.addDimension(
      makeDimension("angle-x", { entities: [line.id], value: 30, offset: 0 }),
    );
    solve(doc);
    expect(dirDeg(line)).toBeCloseTo(30, 1);
  });

  test("a formula means the SAME unit as a typed literal", () => {
    // The bug this type's degree storage exists to prevent: `45` meant 45° but
    // a variable worth 30 meant 30 RADIANS, putting the line at -81°.
    doc.addDimension(
      makeDimension("angle-x", {
        entities: [line.id],
        value: 0,
        offset: 0,
        expr: "tilt",
        hidden: true,
      }),
    );
    evaluateAll(doc.variables, doc.dimensions, doc.displayUnit, doc.stockThickness);
    solve(doc);
    expect(dirDeg(line), "tilt = 30 means 30 degrees").toBeCloseTo(30, 1);
  });
});

describe("the property field", () => {
  function mount(): HTMLElement {
    const host = document.createElement("div");
    document.body.appendChild(host);
    new PropertiesBar(
      host,
      doc,
      () => {},
      () => {},
      () => {},
      () => true,
    );
    doc.emitChange();
    return host;
  }
  const field = (host: HTMLElement, label: string): HTMLInputElement => {
    for (const row of host.querySelectorAll(".props-row"))
      if (row.querySelector("span")?.textContent === label) {
        const i = row.querySelector("input");
        if (i) return i as HTMLInputElement;
      }
    throw new Error(`no row "${label}"`);
  };

  test("a literal rotates the line and creates no dimension", () => {
    line.selected = true;
    const host = mount();
    const inp = field(host, "Angle");
    inp.value = "45";
    inp.dispatchEvent(new Event("change"));

    expect(dirDeg(line)).toBeCloseTo(45, 3);
    expect(line.length, "length preserved").toBeCloseTo(40, 3);
    expect(doc.dimensions, "a plain number stays a plain number").toHaveLength(0);
  });

  test("accepts a negative angle", () => {
    line.selected = true;
    const host = mount();
    const inp = field(host, "Angle");
    inp.value = "-30";
    inp.dispatchEvent(new Event("change"));
    expect(dirDeg(line)).toBeCloseTo(-30, 3);
  });

  test("a formula parks in a hidden driving dimension, and suggests variables", () => {
    line.selected = true;
    const host = mount();
    expect(field(host, "Angle").hasAttribute("list"), "offers variable names").toBe(true);

    const inp = field(host, "Angle");
    inp.value = "tilt";
    inp.dispatchEvent(new Event("change"));

    const dim = doc.dimensions.find((d) => d.type === "angle-x");
    expect(dim, "created an angle-x dimension").toBeDefined();
    expect(dim?.expr).toBe("tilt");
    expect(dim?.hidden, "hidden — a property formula draws nothing").toBe(true);
    expect(dim?.entities).toEqual([line.id]);
  });
});

describe("drawn on the canvas", () => {
  test("lays out an arc from +X to the line, at the line's start", () => {
    const l = doc.add(new LineEntity({ x: 10, y: 10 }, { x: 40, y: 40 })); // 45°
    const dim = makeDimension("angle-x", { entities: [l.id], value: 45, offset: 8 });
    const layout = dimensionLayout(dim, geoOf(doc), "mm")!;

    expect(layout, "angle-x is drawable — it used to return null").not.toBeNull();
    expect(layout.arc, "has an arc").toBeDefined();
    // Pivot at the line's start, not the world origin.
    expect(layout.arc!.center).toEqual({ x: 10, y: 10 });
    expect(layout.arc!.startDir).toEqual({ x: 1, y: 0 }); // from +X
    expect(layout.arc!.endDir.x).toBeCloseTo(Math.SQRT1_2, 6);
    expect(layout.arc!.endDir.y).toBeCloseTo(Math.SQRT1_2, 6);
    expect(layout.arrows).toHaveLength(2);
    // The +X reference has no geometry of its own, so it must be stroked or the
    // arc floats with nothing showing what it is measured from.
    const drawsAxis = layout.segments.some(
      ([a, b]) => a.y === 10 && b.y === 10 && b.x > a.x,
    );
    expect(drawsAxis, "draws the +X reference ray").toBe(true);
  });

  test("labels in degrees — formatAngle would read the value as radians", () => {
    const l = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 10, y: 10 }));
    const dim = makeDimension("angle-x", { entities: [l.id], value: 45, offset: 8 });
    const layout = dimensionLayout(dim, geoOf(doc), "mm")!;
    // 45 treated as radians would render as 2578.31°.
    expect(layout.label).toContain("45.00");
    expect(layout.label).not.toContain("2578");
  });
});
