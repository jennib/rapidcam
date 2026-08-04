// @vitest-environment happy-dom
import { beforeEach, describe, expect, test } from "vitest";
import { CADDocument } from "../src/model/document";
import { ArcEntity } from "../src/model/entities";
import { dimensionMeasure, dimensionResiduals, makeDimension } from "../src/model/dimensions";
import { evaluateAll, makeVariable } from "../src/model/variables";
import { solve } from "../src/solver/solver";
import { PropertiesBar } from "../src/ui/propertiesBar";

/**
 * `arc-sweep` — an arc's included angle, and the Sweep property field it backs.
 *
 * Sweep used to be a DISABLED readout: you could see the angle but not set it,
 * let alone drive it from a variable, even though the arc's Start and End had
 * been parametric all along.
 *
 * The interesting distinction from `angle-x` is the residual. A direction wraps
 * — 350° and -10° are the same line — so that type compares on the circle. A
 * sweep does not: an arc of 350° and an arc of 10° are different arcs, and
 * "take the shortest path" would be the wrong answer. These tests pin that
 * difference, because it is the kind of thing a later tidy-up would unify.
 */

const DEG = Math.PI / 180;
const geoOf = (doc: CADDocument) => {
  const byId = new Map(doc.entities.map((e) => [e.id, e]));
  return (id: string) => byId.get(id);
};
/** The arc's current sweep in degrees, normalised the way the model reports it. */
const sweepDeg = (a: ArcEntity) => {
  const tau = Math.PI * 2;
  return ((((a.endAngle - a.startAngle) % tau) + tau) % tau) * (180 / Math.PI);
};

let doc: CADDocument;
let arc: ArcEntity;

beforeEach(() => {
  document.body.innerHTML = "";
  doc = new CADDocument({ width: 200, height: 150 }, "mm");
  doc.addVariable(makeVariable("fan", "120", "mm"));
  arc = doc.add(new ArcEntity({ x: 50, y: 50 }, 20, 0, 90 * DEG));
});

describe("measurement", () => {
  test("reads the included angle in degrees", () => {
    const dim = makeDimension("arc-sweep", { entities: [arc.id], value: 0, offset: 0 });
    expect(dimensionMeasure(dim, geoOf(doc))!).toBeCloseTo(90, 6);

    arc.endAngle = 270 * DEG;
    expect(dimensionMeasure(dim, geoOf(doc))!).toBeCloseTo(270, 6);
  });

  test("normalises into [0, 360) rather than reporting a negative span", () => {
    arc.startAngle = 350 * DEG;
    arc.endAngle = 10 * DEG; // crosses the seam
    const dim = makeDimension("arc-sweep", { entities: [arc.id], value: 0, offset: 0 });
    expect(dimensionMeasure(dim, geoOf(doc))!).toBeCloseTo(20, 4);
  });

  test("does NOT take the short way round — a sweep is not a direction", () => {
    // 350° of arc against a target of 10° is 340° of error, and must be
    // reported as such: shrinking to 10° is the correct move, not growing to
    // 360°. `angle-x` deliberately behaves the opposite way.
    arc.endAngle = 350 * DEG;
    const dim = makeDimension("arc-sweep", { entities: [arc.id], value: 10, offset: 0 });
    const [residual] = dimensionResiduals(dim, geoOf(doc));
    expect(residual).toBeCloseTo(340, 4);
  });

  test("returns null for a non-arc, rather than guessing", () => {
    const dim = makeDimension("arc-sweep", { entities: ["nope"], value: 0, offset: 0 });
    expect(dimensionMeasure(dim, geoOf(doc))).toBeNull();
  });
});

describe("the solver holds it", () => {
  test("a driving sweep opens the arc to the target", () => {
    doc.addDimension(makeDimension("arc-sweep", { entities: [arc.id], value: 200, offset: 0 }));
    solve(doc);
    expect(sweepDeg(arc)).toBeCloseTo(200, 1);
  });

  test("a formula drives it, in the same unit as a typed literal", () => {
    doc.addDimension(
      makeDimension("arc-sweep", {
        entities: [arc.id],
        value: 0,
        offset: 0,
        expr: "fan",
        hidden: true,
      }),
    );
    evaluateAll(doc.variables, doc.dimensions, doc.displayUnit, doc.stockThickness);
    solve(doc);
    expect(sweepDeg(arc), "fan = 120 means 120 degrees").toBeCloseTo(120, 1);
  });
});

describe("the property field", () => {
  function field(label: string): HTMLInputElement {
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
    for (const row of host.querySelectorAll(".props-row"))
      if (row.querySelector("span")?.textContent === label) {
        const i = row.querySelector("input");
        if (i) return i as HTMLInputElement;
      }
    throw new Error(`no row "${label}"`);
  }

  test("is editable at all — it used to be disabled", () => {
    arc.selected = true;
    const inp = field("Sweep");
    expect(inp.disabled).toBe(false);
    expect(inp.hasAttribute("list"), "suggests variable names").toBe(true);
  });

  test("a literal moves the END, keeping Start put", () => {
    arc.selected = true;
    const inp = field("Sweep");
    inp.value = "45";
    inp.dispatchEvent(new Event("change"));

    expect(sweepDeg(arc)).toBeCloseTo(45, 3);
    expect(arc.startAngle, "start unchanged").toBeCloseTo(0, 6);
    expect(doc.dimensions, "a plain number stays a plain number").toHaveLength(0);
  });

  test("refuses a sweep of zero — that is not an arc", () => {
    arc.selected = true;
    const inp = field("Sweep");
    inp.value = "0";
    inp.dispatchEvent(new Event("change"));
    expect(sweepDeg(arc)).toBeCloseTo(90, 3); // unchanged
  });

  test("a formula parks in a hidden driving dimension", () => {
    arc.selected = true;
    const inp = field("Sweep");
    inp.value = "fan";
    inp.dispatchEvent(new Event("change"));

    const dim = doc.dimensions.find((d) => d.type === "arc-sweep");
    expect(dim?.expr).toBe("fan");
    expect(dim?.hidden).toBe(true);
    expect(dim?.entities).toEqual([arc.id]);
  });
});
