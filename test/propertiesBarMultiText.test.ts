// @vitest-environment happy-dom
import { beforeEach, expect, test } from "vitest";
import { CADDocument } from "../src/model/document";
import { LineEntity, TextEntity } from "../src/model/entities";
import { PropertiesBar } from "../src/ui/propertiesBar";

/**
 * Editing font / height / angle across several selected texts at once.
 *
 * Restyling a row of labels one at a time was the reported friction. This
 * follows the Layer section's idiom: a shared value shows, a differing one reads
 * "Mixed", and committing writes to every selected text.
 *
 * Assertions go to the MODEL, not to the presence of a row — a field that
 * renders but commits nothing looks identical from the DOM.
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

function field(host: HTMLElement, label: string): HTMLInputElement {
  for (const row of host.querySelectorAll(".props-row")) {
    if (row.querySelector("span")?.textContent === label) {
      const inp = row.querySelector("input");
      if (inp) return inp as HTMLInputElement;
    }
  }
  throw new Error(`no property row labelled "${label}"`);
}

function rowLabels(host: HTMLElement): string[] {
  return [...host.querySelectorAll(".props-row")].map(
    (r) => r.querySelector("span")?.textContent ?? "",
  );
}

function commit(host: HTMLElement, label: string, value: string): void {
  const inp = field(host, label);
  inp.value = value;
  inp.dispatchEvent(new Event("change"));
}

let doc: CADDocument;
let t1: TextEntity;
let t2: TextEntity;

beforeEach(() => {
  document.body.replaceChildren();
  doc = new CADDocument({ width: 300, height: 200 }, "mm");
  t1 = doc.add(new TextEntity("ONE", "f1", 10, { x: 0, y: 0 }, 0)) as TextEntity;
  t2 = doc.add(new TextEntity("TWO", "f1", 20, { x: 0, y: 40 }, 0)) as TextEntity;
  t1.selected = true;
  t2.selected = true;
});

test("a differing height reads Mixed, a shared angle shows its value", () => {
  const host = mount(doc);
  expect(field(host, "Height (mm)").placeholder).toBe("Mixed");
  expect(field(host, "Height (mm)").value).toBe("");
  // Both are at 0°, so that one is not mixed.
  expect(field(host, "Angle (°)").value).toBe("0.0");
});

test("committing a height writes it to every selected text", () => {
  const host = mount(doc);
  commit(host, "Height (mm)", "12");
  expect(t1.sizeMM).toBeCloseTo(12, 6);
  expect(t2.sizeMM).toBeCloseTo(12, 6);
});

test("a blank field commits nothing, so a mixed value survives editing another", () => {
  const host = mount(doc);
  commit(host, "Angle (°)", "30");
  // Height left blank — the two must keep their different sizes.
  expect(t1.sizeMM).toBeCloseTo(10, 6);
  expect(t2.sizeMM).toBeCloseTo(20, 6);
  expect(t1.angle).toBeCloseTo(Math.PI / 6, 6);
  expect(t2.angle).toBeCloseTo(Math.PI / 6, 6);
});

test("an unreadable value is rejected and the field reverts", () => {
  const host = mount(doc);
  commit(host, "Angle (°)", "not a number");
  expect(t1.angle).toBe(0);
  expect(t2.angle).toBe(0);
  // Positive control: the same row DOES commit a readable value, so the
  // assertion above is about the parse and not a dead handler.
  commit(host, "Angle (°)", "45");
  expect(t1.angle).toBeCloseTo(Math.PI / 4, 6);
});

test("the height field follows the document's unit", () => {
  doc.displayUnit = "in";
  const host = mount(doc);
  expect(rowLabels(host)).toContain("Height (in)");
  commit(host, "Height (in)", "1");
  expect(t1.sizeMM).toBeCloseTo(25.4, 6);
  expect(t2.sizeMM).toBeCloseTo(25.4, 6);
});

test("a mixed selection gets no text section — it would edit the wrong things", () => {
  doc.add(new LineEntity({ x: 0, y: 0 }, { x: 10, y: 0 })).selected = true;
  const host = mount(doc);
  expect(rowLabels(host)).not.toContain("Height (mm)");
  // Positive control: texts alone DO get it, so the absence above is about the
  // line being in the selection rather than the section never rendering.
  doc.entities.at(-1)!.selected = false;
  expect(rowLabels(mount(doc))).toContain("Height (mm)");
});
