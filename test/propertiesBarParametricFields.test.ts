// @vitest-environment happy-dom
import { beforeEach, describe, expect, test } from "vitest";
import { CADDocument } from "../src/model/document";
import { BezierEntity, LineEntity, PolylineEntity, TextEntity } from "../src/model/entities";
import { makeVariable } from "../src/model/variables";
import { PropertiesBar } from "../src/ui/propertiesBar";

/**
 * Which property fields are parametric, and which values they accept.
 *
 * Two faults are covered, both found by auditing every row of every entity type
 * rather than by the report that started it:
 *
 *  - **Text Size and Angle took no formula at all.** They were hand-rolled
 *    parseFloat inputs, so a label could not be sized from a variable while an
 *    image — the other rigid body, with the same kind of scalar — could.
 *  - **Coordinates rejected 0 and negatives.** Positions share a helper with
 *    sizes, and the `> 0` rule that is right for a width or radius silently
 *    reverted `Ax = -10`. That one is a plain input bug, not a missing feature.
 *
 * Assertions go to the MODEL (does the entity change, is the binding legal to
 * the solver) rather than to the presence of a badge, since a badge that commits
 * nothing looks identical.
 */

function mount(doc: CADDocument): HTMLElement {
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

/** The input of the property row labelled `label`. */
function field(host: HTMLElement, label: string): HTMLInputElement {
  for (const row of host.querySelectorAll(".props-row")) {
    if (row.querySelector("span")?.textContent === label) {
      const inp = row.querySelector("input");
      if (inp) return inp as HTMLInputElement;
    }
  }
  throw new Error(`no property row labelled "${label}"`);
}

/** Type `value` into the row labelled `label` and commit it. */
function commit(host: HTMLElement, label: string, value: string): void {
  const inp = field(host, label);
  inp.value = value;
  inp.dispatchEvent(new Event("change"));
}

/** Does this row offer variable-name suggestions? */
const hasAutocomplete = (host: HTMLElement, label: string): boolean =>
  field(host, label).hasAttribute("list");

let doc: CADDocument;

beforeEach(() => {
  document.body.innerHTML = "";
  doc = new CADDocument({ width: 200, height: 150 }, "mm");
  doc.addVariable(makeVariable("plateW", "80", "mm"));
});

describe("text size and angle", () => {
  test("accept a literal", () => {
    const t = doc.add(new TextEntity("hi", "sans", 10, { x: 20, y: 20 }, 0));
    t.selected = true;
    const host = mount(doc);

    commit(host, "Size", "18");
    expect(t.sizeMM).toBeCloseTo(18, 6);

    commit(host, "Angle", "90");
    expect(t.angle).toBeCloseTo(Math.PI / 2, 6);
  });

  test("accept a formula, which lands as a solver binding", () => {
    const t = doc.add(new TextEntity("hi", "sans", 10, { x: 20, y: 20 }, 0));
    t.selected = true;
    const host = mount(doc);

    commit(host, "Size", "plateW/8");
    const b = doc.bindings.find((x) => x.entityId === t.id && x.scalarKey === "size");
    expect(b, "a size binding was created").toBeDefined();
    expect(b?.expr).toBe("plateW/8");
  });

  test("expose the scalars the binding engine needs — an unknown key is rejected", () => {
    const t = new TextEntity("hi", "sans", 10, { x: 0, y: 0 }, 0);
    // The solver throws on a scalar key the entity does not declare, so the
    // binding above is only legal because these exist.
    expect(t.dofScalars().map((s) => s.key).sort()).toEqual(["angle", "size"]);

    t.setScalar("size", 25);
    expect(t.sizeMM).toBe(25);
    t.setScalar("angle", 1);
    expect(t.angle).toBe(1);
  });

  test("refuse a size of zero — glyphs at scale 0 produce no contours", () => {
    const t = new TextEntity("hi", "sans", 10, { x: 0, y: 0 }, 0);
    t.setScalar("size", 0);
    expect(t.sizeMM).toBeGreaterThan(0);
  });

  test("suggest variable names", () => {
    const t = doc.add(new TextEntity("hi", "sans", 10, { x: 20, y: 20 }, 0));
    t.selected = true;
    const host = mount(doc);
    expect(hasAutocomplete(host, "Size")).toBe(true);
    expect(hasAutocomplete(host, "Angle")).toBe(true);
  });
});

describe("coordinates accept any position", () => {
  test("a line endpoint takes a negative X, and zero", () => {
    const line = doc.add(new LineEntity({ x: 10, y: 10 }, { x: 90, y: 10 }));
    line.selected = true;
    const host = mount(doc);

    commit(host, "Ax", "-10");
    expect(line.a.x, "negative coordinate").toBe(-10);

    commit(host, "Ay", "0");
    expect(line.a.y, "zero coordinate").toBe(0);
  });

  test("a SIZE still refuses zero and negatives", () => {
    // The guard being relaxed for coordinates must not leak into sizes: there
    // is no such thing as a line of length -5.
    const line = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 40, y: 0 }));
    line.selected = true;
    const host = mount(doc);

    commit(host, "Length", "-5");
    expect(line.length).toBeCloseTo(40, 6);
    commit(host, "Length", "0");
    expect(line.length).toBeCloseTo(40, 6);
  });
});

describe("polyline vertices", () => {
  test("are parametric per coordinate and suggest variables", () => {
    const poly = doc.add(
      new PolylineEntity([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], false),
    );
    poly.selected = true;
    const host = mount(doc);

    expect(hasAutocomplete(host, "0 X")).toBe(true);
    expect(hasAutocomplete(host, "1 Y")).toBe(true);

    commit(host, "1 X", "-25");
    expect(poly.points[1].x, "vertex takes a negative coordinate").toBe(-25);
    // Editing a vertex by hand drops any regular-polygon metadata.
    expect(poly.polygon).toBeUndefined();
  });

  test("a formula on a vertex creates a driving dimension", () => {
    const poly = doc.add(
      new PolylineEntity([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], false),
    );
    poly.selected = true;
    const host = mount(doc);

    commit(host, "1 X", "plateW/2");
    const driven = doc.dimensions.find((d) => d.expr === "plateW/2");
    expect(driven, "a hidden driving dimension was created").toBeDefined();
    // Keyed by the vertex's STABLE id, so the formula survives renumbering.
    expect(driven?.points.some((p) => p.key === `v${poly.vertexIds[1]}`)).toBe(true);
  });
});

describe("bezier control points", () => {
  test("are parametric per coordinate — the type had no properties at all", () => {
    const curve = doc.add(
      new BezierEntity({ x: 0, y: 0 }, { x: 10, y: 30 }, { x: 30, y: 30 }, { x: 40, y: 0 }),
    );
    curve.selected = true;
    const host = mount(doc);

    // Named for what they do: the middle two are handles the curve misses.
    for (const label of ["Start X", "Handle 1 Y", "Handle 2 X", "End Y"])
      expect(hasAutocomplete(host, label), `${label} suggests variables`).toBe(true);

    commit(host, "Handle 1 X", "-15"); // negative: a handle may sit behind the start
    expect(curve.p1.x).toBe(-15);

    commit(host, "End Y", "plateW/4");
    const dim = doc.dimensions.find((d) => d.expr === "plateW/4");
    expect(dim, "a formula parks in a driving dimension").toBeDefined();
  });
});
