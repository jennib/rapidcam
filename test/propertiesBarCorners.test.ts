// @vitest-environment happy-dom
import { beforeEach, expect, test } from "vitest";
import { CADDocument } from "../src/model/document";
import { RectEntity } from "../src/model/entities";
import { PropertiesBar } from "../src/ui/propertiesBar";
import { makeVariable } from "../src/model/variables";
import { solve } from "../src/solver/solver";

/**
 * The rectangle's `Corner` type + radius rows.
 *
 * Vectric's rectangle form pairs a Corner Type control with one distance field,
 * and that pairing is the point: the type decides what the number below it
 * means, so they are read together. The field drives all four corners, which is
 * what a whole-shape control implies — but per-corner radii still exist (the
 * Fillet tool writes one at a time), so it has to say `mixed` rather than
 * display one of four and silently flatten the rest on commit.
 *
 * Assertions go to the MODEL. A row that renders but commits nothing looks
 * identical from the DOM.
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

function row(host: HTMLElement, label: string): Element {
  for (const r of host.querySelectorAll(".props-row")) {
    if (r.querySelector("span")?.textContent === label) return r;
  }
  throw new Error(
    `no property row labelled "${label}" — have: ${[...host.querySelectorAll(".props-row")]
      .map((r) => r.querySelector("span")?.textContent)
      .join(", ")}`,
  );
}

function commit(host: HTMLElement, label: string, value: string): void {
  const inp = row(host, label).querySelector("input") as HTMLInputElement;
  inp.value = value;
  inp.dispatchEvent(new Event("change"));
}

function chooseType(host: HTMLElement, value: string): void {
  const sel = row(host, "Corner").querySelector("select") as HTMLSelectElement;
  sel.value = value;
  sel.dispatchEvent(new Event("change"));
}

let doc: CADDocument;
let rect: RectEntity;

beforeEach(() => {
  document.body.replaceChildren();
  doc = new CADDocument({ width: 300, height: 200 }, "mm");
  rect = doc.add(new RectEntity({ x: 0, y: 0 }, { x: 80, y: 50 }));
  rect.selected = true;
});

test("a radius typed into the field shapes all four corners", () => {
  const host = mount(doc);
  commit(host, "Radius", "6");
  expect(rect.cornerRadii).toEqual([6, 6, 6, 6]);
});

test("the corner type is a dropdown of the three treatments", () => {
  const host = mount(doc);
  const sel = row(host, "Corner").querySelector("select") as HTMLSelectElement;
  expect([...sel.options].map((o) => o.textContent)).toEqual(["Round", "Inverted", "Chamfer"]);
  expect(sel.value).toBe("round");

  chooseType(host, "inverted");
  expect(rect.cornerType).toBe("inverted");
});

test("the field is labelled for the treatment it is setting", () => {
  // Vectric calls the same distance "Radius" for a round and "Chamfer" for a
  // bevel. Same number, but "Radius" on a straight bevel reads as a mistake.
  expect(() => row(mount(doc), "Radius")).not.toThrow();
  rect.cornerType = "chamfer";
  expect(() => row(mount(doc), "Chamfer")).not.toThrow();
});

test("differing radii read as mixed, not as one of them", () => {
  rect.cornerRadii = [5, 0, 0, 0]; // one corner filleted with the tool
  const host = mount(doc);
  const inp = row(host, "Radius").querySelector("input") as HTMLInputElement;
  expect(inp.value).toBe("");
  expect(inp.placeholder).toBe("mixed");

  // Committing from `mixed` sets every corner — the control is whole-shape.
  commit(host, "Radius", "3");
  expect(rect.cornerRadii).toEqual([3, 3, 3, 3]);
});

test("a radius bigger than the rectangle can hold is clamped, and SHOWN clamped", () => {
  // 80×50, so 25 is the most every corner can carry at once. Storing 40 and
  // drawing 25 would leave the panel reporting a radius the shape does not have.
  const host = mount(doc);
  commit(host, "Radius", "40");
  expect(rect.cornerRadii).toEqual([25, 25, 25, 25]);
  expect(rect.effectiveCornerRadii()).toEqual([25, 25, 25, 25]);

  const inp = row(mount(doc), "Radius").querySelector("input") as HTMLInputElement;
  expect(inp.value).toBe("25.000"); // 3dp, as W/H are
});

test("the rows read back what the Fillet tool wrote", () => {
  rect.cornerRadii = [4, 4, 4, 4];
  rect.cornerType = "inverted";
  const host = mount(doc);
  const sel = row(host, "Corner").querySelector("select") as HTMLSelectElement;
  expect(sel.value).toBe("inverted");
  expect((row(host, "Radius").querySelector("input") as HTMLInputElement).value).toBe("4.000");
});

test("zero clears the corners back to square", () => {
  rect.cornerRadii = [6, 6, 6, 6];
  const host = mount(doc);
  commit(host, "Radius", "0");
  expect(rect.hasShapedCorners()).toBe(false);
  expect(rect.outlinePoints()).toEqual(rect.corners());
});

test("the field respects the document's display unit", () => {
  // A length row parses in the document's unit; 0.5in is 12.7mm internally.
  doc.displayUnit = "in";
  const host = mount(doc);
  commit(host, "Radius", "0.5");
  expect(rect.cornerRadii[0]).toBeCloseTo(12.7, 6);
});

test("a formula in the radius field parks a binding on `cr`", () => {
  // The field is a bindingRow, like a circle's Radius: a number is a literal, a
  // formula becomes a ScalarBinding the solver drives.
  doc.variables.push(makeVariable("edge", "4", "mm"));
  const host = mount(doc);
  commit(host, "Radius", "edge * 2");

  const b = doc.bindings.find((x) => x.entityId === rect.id && x.scalarKey === "cr");
  expect(b, "a formula must create a binding, not be swallowed as 0").toBeDefined();
  expect(b!.expr).toBe("edge * 2");

  // …and it reaches the geometry through a real solve.
  solve(doc);
  expect(rect.cornerRadii[0]).toBeCloseTo(8, 4);
});

test("a bound field shows the formula, and unbinding leaves the resolved number", () => {
  doc.variables.push(makeVariable("edge", "4", "mm"));
  doc.bindings.push({ id: "b1", entityId: rect.id, scalarKey: "cr", expr: "edge * 2" });
  solve(doc);

  const host = mount(doc);
  const inp = row(host, "Radius").querySelector("input") as HTMLInputElement;
  expect(inp.value).toBe("edge * 2");

  // Typing a plain number clears the binding — the literal path.
  commit(host, "Radius", "5");
  expect(doc.bindings.filter((b) => b.scalarKey === "cr")).toHaveLength(0);
  expect(rect.cornerRadii).toEqual([5, 5, 5, 5]);
});

test("a formula wins over `mixed` — it is whole-shape by nature", () => {
  rect.cornerRadii = [5, 0, 0, 0];
  doc.variables.push(makeVariable("edge", "3", "mm"));
  const host = mount(doc);
  commit(host, "Radius", "edge");
  solve(doc);
  expect(rect.cornerRadii.every((r) => Math.abs(r - 3) < 1e-4)).toBe(true);
});
