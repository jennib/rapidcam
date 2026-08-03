// @vitest-environment happy-dom
import { beforeEach, describe, expect, test } from "vitest";
import { CADDocument } from "../src/model/document";
import { CircleEntity, RectEntity } from "../src/model/entities";
import { makeVariable } from "../src/model/variables";
import { PropertiesBar } from "../src/ui/propertiesBar";

/**
 * Variable name type-ahead on the parametric property fields.
 *
 * These fields have always ACCEPTED a formula and have carried an ƒx badge that
 * opens a click-to-pick popup — but the popup does nothing for someone who has
 * already started typing, so `wid` suggested nothing while the identical field
 * in the on-canvas dimension editor suggested `width`. Reported as "Rectangle H
 * and W in properties does not have auto complete for variable".
 *
 * The assertions deliberately follow the `list` attribute through to the
 * datalist's actual options rather than just counting `<datalist>` elements: an
 * empty or unattached list renders exactly the same in a DOM snapshot and
 * autocompletes nothing, which is the bug being fixed.
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

/** The option values offered to `input`, via its `list` attribute. */
function suggestions(host: HTMLElement, input: HTMLInputElement): string[] {
  const id = input.getAttribute("list");
  if (!id) return [];
  const dl = host.querySelector(`#${id}`) as HTMLDataListElement | null;
  if (!dl) return [];
  return [...dl.querySelectorAll("option")].map((o) => (o as HTMLOptionElement).value);
}

/** The property row input labelled `label`. */
function field(host: HTMLElement, label: string): HTMLInputElement {
  for (const row of host.querySelectorAll(".props-row")) {
    if (row.querySelector("span")?.textContent === label) {
      const inp = row.querySelector("input");
      if (inp) return inp as HTMLInputElement;
    }
  }
  throw new Error(`no property row labelled "${label}"`);
}

let doc: CADDocument;

beforeEach(() => {
  document.body.innerHTML = "";
  doc = new CADDocument({ width: 200, height: 150 }, "mm");
  doc.addVariable(makeVariable("width", "80", "mm"));
  doc.addVariable(makeVariable("gap", "5", "mm"));
});

describe("rectangle W/H", () => {
  test("offer every variable, plus the implicit stock", () => {
    const rect = doc.add(new RectEntity({ x: 0, y: 0 }, { x: 40, y: 20 }));
    rect.selected = true;
    const host = mount(doc);

    for (const label of ["W", "H"]) {
      const offered = suggestions(host, field(host, label));
      expect(offered, `${label} suggestions`).toContain("width");
      expect(offered, `${label} suggestions`).toContain("gap");
      // `stock` is in scope for a formula, so it must be offered too — the
      // dimension editor already lists it and the two must not disagree.
      expect(offered, `${label} suggestions`).toContain("stock");
    }
  });

  test("track the document's variables rather than a snapshot", () => {
    const rect = doc.add(new RectEntity({ x: 0, y: 0 }, { x: 40, y: 20 }));
    rect.selected = true;
    let host = mount(doc);
    expect(suggestions(host, field(host, "W"))).not.toContain("depth");

    document.body.innerHTML = "";
    doc.addVariable(makeVariable("depth", "12", "mm"));
    host = mount(doc);
    expect(suggestions(host, field(host, "W"))).toContain("depth");
  });
});

describe("other parametric fields", () => {
  test("a circle's radius offers the same names", () => {
    const circle = doc.add(new CircleEntity({ x: 50, y: 50 }, 10));
    circle.selected = true;
    const host = mount(doc);

    // Whichever label the radius row carries, it is a formula field and must
    // suggest; find it by having a `list` rather than by guessing the wording.
    const wired = [...host.querySelectorAll<HTMLInputElement>("input[list]")];
    expect(wired.length).toBeGreaterThan(0);
    expect(suggestions(host, wired[0])).toContain("width");
  });

  test("a document with no variables wires no empty list", () => {
    const bare = new CADDocument({ width: 200, height: 150 }, "mm");
    const rect = bare.add(new RectEntity({ x: 0, y: 0 }, { x: 40, y: 20 }));
    rect.selected = true;
    const host = mount(bare);

    // `stock` is always in scope, so there IS something to offer even here —
    // asserting the count is non-zero keeps this honest rather than asserting
    // an absence that would pass if the feature were removed entirely.
    const offered = suggestions(host, field(host, "W"));
    expect(offered).toEqual(["stock"]);
  });
});
