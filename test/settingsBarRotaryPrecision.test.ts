// @vitest-environment happy-dom
import { expect, test } from "vitest";
import { SettingsBar } from "../src/ui/settingsBar";
import { CADDocument } from "../src/model/document";

/**
 * commitSize() re-parses whatever's currently DISPLAYED in the Length/Diameter
 * fields, which refresh() rounds for readability (formatLength, 2dp in mm).
 * It used to do that for BOTH fields unconditionally on every commit — so
 * editing ONLY the Length field also silently truncated the exact stored
 * diameter down to its rounded display value, drifting the wrap circumference
 * (π·⌀) off the true cylinder by up to ~0.005mm × π per touch and opening a
 * seam gap. Only the field the user actually changed should commit.
 */

function rotaryDoc(diameter: number): CADDocument {
  const doc = new CADDocument({ width: 200, height: Math.PI * diameter });
  doc.machineKind = "mill-rotary";
  doc.stockThickness = 10;
  doc.rotary = { axisWord: "A", diameter, wrapAxis: "y" };
  return doc;
}

/** The `.dim` input inside the `.settings-field-group` labelled `label`. */
function fieldInput(host: HTMLElement, label: string): HTMLInputElement {
  const group = [...host.querySelectorAll(".settings-field-group")].find(
    (g) => g.querySelector("label")?.textContent === label,
  );
  if (!group) throw new Error(`no field labelled "${label}"`);
  const input = group.querySelector("input.dim") as HTMLInputElement | null;
  if (!input) throw new Error(`field "${label}" has no .dim input`);
  return input;
}

test("editing Length does not truncate the stored diameter's precision", () => {
  const PRECISE_DIAMETER = 47.746478834529; // 150/π, deliberately many decimals
  const doc = rotaryDoc(PRECISE_DIAMETER);
  const host = document.createElement("div");
  document.body.appendChild(host);
  new SettingsBar(host, doc, () => {});

  // wrapAxis "y" → Width field is relabelled "Length", Height field "Diameter".
  const lenInput = fieldInput(host, "Length");
  lenInput.value = "250";
  lenInput.dispatchEvent(new Event("change"));

  expect(doc.canvas.width).toBe(250); // the field the user DID edit commits
  expect(doc.rotary?.diameter).toBe(PRECISE_DIAMETER); // the untouched one keeps full precision
});

test("editing Diameter still updates it and re-locks the circumference", () => {
  const doc = rotaryDoc(47.746478834529);
  const host = document.createElement("div");
  document.body.appendChild(host);
  new SettingsBar(host, doc, () => {});

  const diaInput = fieldInput(host, "Diameter");
  diaInput.value = "60";
  diaInput.dispatchEvent(new Event("change"));

  expect(doc.rotary?.diameter).toBe(60);
  expect(doc.canvas.height).toBeCloseTo(Math.PI * 60, 9);
});

test("laser-rotary machine kind presents Cylinder controls and hides Stock section", () => {
  const doc = new CADDocument({ width: 200, height: Math.PI * 50 });
  doc.machineKind = "laser-rotary";
  doc.stockThickness = 5;
  doc.rotary = { axisWord: "A", diameter: 50, wrapAxis: "y" };
  const host = document.createElement("div");
  document.body.appendChild(host);
  new SettingsBar(host, doc, () => {});

  // Stock section (Fills sheet, etc.) should be hidden for laser-rotary
  const stockGroup = [...host.querySelectorAll(".settings-section")].find(
    (g) => g.querySelector(".settings-section-title")?.textContent === "Stock",
  ) as HTMLElement | undefined;
  expect(stockGroup?.style.display).toBe("none");

  // Should have Length and Diameter fields
  const diaInput = fieldInput(host, "Diameter");
  expect(diaInput.value).toBe("50.00");

  diaInput.value = "75";
  diaInput.dispatchEvent(new Event("change"));

  expect(doc.rotary?.diameter).toBe(75);
  expect(doc.canvas.height).toBeCloseTo(Math.PI * 75, 9);
});

