// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from "vitest";
import { CADDocument } from "../src/model/document";
import { PolylineEntity } from "../src/model/entities";
import { PropertiesBar } from "../src/ui/propertiesBar";

/**
 * The polyline's corner rows — the whole-shape pair a rectangle gets, plus the
 * per-vertex row a rectangle does not need.
 *
 * That extra row is the difference between the two shapes in use. A rectangle
 * has four corners and they are usually the same, so a whole-shape field covers
 * it; filleting one vertex of five is the ordinary way to work on a polyline,
 * and without a per-vertex row that corner would show only as the word `mixed`
 * with no way to read or change it.
 *
 * Assertions go to the MODEL. A row that renders but commits nothing looks
 * identical from the DOM ([[dom-tests-cannot-see-layout]]).
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

function findRow(host: HTMLElement, label: string): Element | null {
  for (const r of host.querySelectorAll(".props-row")) {
    if (r.querySelector("span")?.textContent === label) return r;
  }
  return null;
}

function row(host: HTMLElement, label: string): Element {
  const r = findRow(host, label);
  if (r) return r;
  throw new Error(
    `no property row labelled "${label}" — have: ${[...host.querySelectorAll(".props-row")]
      .map((x) => x.querySelector("span")?.textContent)
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
let pl: PolylineEntity;

beforeEach(() => {
  document.body.replaceChildren();
  doc = new CADDocument({ width: 300, height: 200 }, "mm");
  pl = doc.add(
    new PolylineEntity(
      [
        { x: 0, y: 0 },
        { x: 80, y: 0 },
        { x: 80, y: 50 },
        { x: 0, y: 50 },
      ],
      true,
    ),
  );
  pl.selected = true;
});

test("the whole-shape field shapes every vertex", () => {
  const host = mount(doc);
  commit(host, "Radius", "6");
  expect(pl.points.map((_, i) => pl.cornerValueAt(i))).toEqual([6, 6, 6, 6]);
});

test("the corner type is the same dropdown a rectangle gets", () => {
  const host = mount(doc);
  const sel = row(host, "Corner").querySelector("select") as HTMLSelectElement;
  expect([...sel.options].map((o) => o.textContent)).toEqual(["Round", "Inverted", "Chamfer"]);
  chooseType(host, "chamfer");
  expect(pl.cornerType).toBe("chamfer");
});

test("the whole-shape field is labelled for the treatment it sets", () => {
  expect(findRow(mount(doc), "Radius")).not.toBeNull();
  pl.cornerType = "chamfer";
  document.body.replaceChildren();
  expect(findRow(mount(doc), "Chamfer")).not.toBeNull();
});

test("a per-vertex row exists for every shapeable vertex, and commits", () => {
  const host = mount(doc);
  commit(host, "1 R", "7");
  expect(pl.cornerValueAt(1)).toBe(7);
  // Only that one — a per-vertex field must not behave like the whole-shape one.
  expect(pl.points.map((_, i) => pl.cornerValueAt(i))).toEqual([0, 7, 0, 0]);
});

test("the per-vertex row is labelled for the treatment too", () => {
  pl.cornerType = "chamfer";
  const host = mount(doc);
  expect(findRow(host, "1 C")).not.toBeNull();
  expect(findRow(host, "1 R")).toBeNull();
});

test("an open polyline's ends get no per-vertex row — they cannot be shaped", () => {
  document.body.replaceChildren();
  const open = doc.add(
    new PolylineEntity(
      [
        { x: 0, y: 100 },
        { x: 50, y: 100 },
        { x: 50, y: 150 },
      ],
      false,
    ),
  );
  pl.selected = false;
  open.selected = true;
  const host = mount(doc);
  expect(findRow(host, "1 R"), "the middle vertex is shapeable").not.toBeNull();
  expect(findRow(host, "0 R"), "an end is not").toBeNull();
  expect(findRow(host, "2 R"), "nor is the other end").toBeNull();
});

test("the whole-shape field says `mixed` rather than flattening the others", () => {
  pl.setCornerValue(1, 4);
  const host = mount(doc);
  const inp = row(host, "Radius").querySelector("input") as HTMLInputElement;
  expect(inp.placeholder || inp.value).toContain("mixed");
  // And the per-vertex rows still report the truth behind that word.
  const at = (i: number) =>
    (row(host, `${i} R`).querySelector("input") as HTMLInputElement).value;
  expect(at(1)).toBe("4.000");
  expect(at(2)).toBe("0.000");
});

test("an open polyline's ends do not make the whole-shape field read `mixed`", () => {
  // They hold 0 because they CANNOT hold anything, which is not a different
  // radius. Counting them would leave the field permanently mixed.
  document.body.replaceChildren();
  const open = doc.add(
    new PolylineEntity(
      [
        { x: 0, y: 100 },
        { x: 50, y: 100 },
        { x: 100, y: 100 },
        { x: 100, y: 150 },
      ],
      false,
    ),
  );
  open.setCornerValue(1, 5);
  open.setCornerValue(2, 5);
  pl.selected = false;
  open.selected = true;
  const host = mount(doc);
  const inp = row(host, "Radius").querySelector("input") as HTMLInputElement;
  expect(inp.value).toBe("5.000");
  expect(inp.placeholder).not.toContain("mixed");
});

test("a value too big for its neighbours is clamped, and shown clamped", () => {
  // The panel must never report a corner the shape does not have.
  pl.setCornerValue(0, 60); // 60 of the 80mm bottom edge
  const host = mount(doc);
  commit(host, "1 R", "40"); // 60 + 40 > 80
  expect(pl.cornerValueAt(1)).toBeCloseTo(20, 6);
  expect(pl.fitsCornerValue(1, pl.cornerValueAt(1))).toBe(true);
});

test("a panel refresh does no per-vertex corner maths on a sharp polyline", () => {
  // The panel refreshes on every `emitChange`, which is every frame of a drag.
  // Deciding whether to OFFER the corner controls used to ask for the largest
  // radius the shape could hold, which is a hypot and an acos per vertex — 3.6ms
  // a frame on a 20,000-point polyline carrying no corners at all.
  //
  // Counted rather than timed, for the same reason as the hit-test guard.
  document.body.replaceChildren();
  const big = doc.add(
    new PolylineEntity(
      Array.from({ length: 400 }, (_, i) => {
        const a = (i / 400) * Math.PI * 2;
        return { x: 150 + 40 * Math.cos(a), y: 100 + 40 * Math.sin(a) };
      }),
      true,
    ),
  );
  pl.selected = false;
  big.selected = true;

  const spy = vi.spyOn(Math, "acos");
  try {
    mount(doc);
    expect(spy.mock.calls.length, "corner maths on a shape with no corners").toBe(0);
  } finally {
    spy.mockRestore();
  }
  // Positive control: the panel really did build the corner controls, so the
  // count above is zero because the work is cheap, not because nothing ran.
  expect(findRow(document.body as HTMLElement, "Corner")).not.toBeNull();
});

test("a two-point open polyline offers no corner controls at all", () => {
  document.body.replaceChildren();
  const line = doc.add(
    new PolylineEntity(
      [
        { x: 0, y: 180 },
        { x: 60, y: 180 },
      ],
      false,
    ),
  );
  pl.selected = false;
  line.selected = true;
  const host = mount(doc);
  expect(findRow(host, "Corner")).toBeNull();
  // Positive control: the panel did render the polyline's other rows.
  expect(findRow(host, "Vertices")).not.toBeNull();
});
