// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from "vitest";
import { CADDocument } from "../src/model/document";
import { TextEntity } from "../src/model/entities";

/**
 * The Style row: switching an existing text's weight.
 *
 * You could only choose a weight while ADDING a font, so changing Regular to
 * Bold meant going back through "Add a font from the web" — not where anyone
 * looks. I deferred this once as "a schema change", wrongly: a loaded font's
 * `name` was produced by `variantName`, and `name` is already required on
 * `embeddedFont`, so inverting that one function recovers the family exactly and
 * survives a save/reload. No persisted field.
 *
 * The catalogue is stubbed here rather than fetched — these test the ROW's
 * behaviour, and `test/fontVariantLookup.test.ts` already pins the inversion
 * against the real 2,022-family file.
 */

const CAT = {
  cdn: "https://x/",
  families: [
    {
      n: "Abhaya Libre",
      c: "serif",
      v: [
        { s: "Regular", p: "a/Reg.ttf" },
        { s: "Bold", p: "a/Bold.ttf" },
      ],
    },
    {
      // A family with nothing to choose BETWEEN — a dropdown of one option is a
      // control that cannot do anything, so the row must not appear at all.
      n: "Solo Face",
      c: "display",
      v: [{ s: "Regular", p: "s/Reg.ttf" }],
    },
  ],
};

vi.mock("../src/core/webFonts", async (orig) => ({
  ...(await orig<typeof import("../src/core/webFonts")>()),
  loadCatalogue: vi.fn(async () => CAT),
}));

let listed: { id: string; name: string }[] = [];
vi.mock("../src/core/fontManager", async (orig) => ({
  ...(await orig<typeof import("../src/core/fontManager")>()),
  listFonts: () => listed,
  initBundledFonts: vi.fn(async () => {}),
}));

const { PropertiesBar } = await import("../src/ui/propertiesBar");

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

const rowLabels = (host: HTMLElement) =>
  [...host.querySelectorAll(".props-row")].map((r) => r.querySelector("span")?.textContent ?? "");

function docWithText(fontId: string) {
  const doc = new CADDocument({ width: 200, height: 200 }, "mm");
  const t = doc.add(new TextEntity("HELLO", fontId, 10, { x: 0, y: 0 }, 0)) as TextEntity;
  t.selected = true;
  return { doc, t };
}

beforeEach(() => {
  document.body.replaceChildren();
});

test("a catalogue font gets a Style row listing its family's weights", async () => {
  listed = [{ id: "f1", name: "Abhaya Libre" }];
  const { doc } = docWithText("f1");
  mount(doc);
  await vi.waitFor(() => expect(rowLabels(mount(doc))).toContain("Style"));

  const host = mount(doc);
  const styleRow = [...host.querySelectorAll(".props-row")].find(
    (r) => r.querySelector("span")?.textContent === "Style",
  )!;
  const opts = [...styleRow.querySelectorAll("option")].map((o) => o.textContent);
  expect(opts).toEqual(["Regular", "Bold"]);
  // It shows the weight the text is actually using, not just the first option.
  expect(styleRow.querySelector<HTMLSelectElement>("select")!.value).toBe("Regular");
});

test("it reflects the CURRENT weight when the text is already Bold", async () => {
  listed = [
    { id: "f1", name: "Abhaya Libre" },
    { id: "f2", name: "Abhaya Libre Bold" },
  ];
  const { doc } = docWithText("f2");
  await vi.waitFor(() => expect(rowLabels(mount(doc))).toContain("Style"));
  const host = mount(doc);
  const sel = [...host.querySelectorAll(".props-row")]
    .find((r) => r.querySelector("span")?.textContent === "Style")!
    .querySelector<HTMLSelectElement>("select")!;
  expect(sel.value).toBe("Bold");
});

test("picking an already-loaded weight re-points the text, with no download", async () => {
  listed = [
    { id: "f1", name: "Abhaya Libre" },
    { id: "f2", name: "Abhaya Libre Bold" },
  ];
  const { doc, t } = docWithText("f1");
  await vi.waitFor(() => expect(rowLabels(mount(doc))).toContain("Style"));
  const host = mount(doc);
  const sel = [...host.querySelectorAll(".props-row")]
    .find((r) => r.querySelector("span")?.textContent === "Style")!
    .querySelector<HTMLSelectElement>("select")!;

  sel.value = "Bold";
  sel.dispatchEvent(new Event("change"));
  expect(t.fontId).toBe("f2");
});

test("a font loaded from DISK gets no Style row at all", async () => {
  // Its name never came from variantName, so its family is genuinely unknown.
  // An empty "Style" control would imply the app knows something it doesn't.
  listed = [{ id: "d1", name: "MyCustomFont" }];
  const { doc } = docWithText("d1");
  await vi.waitFor(() => expect(rowLabels(mount(doc))).toContain("Font"));
  expect(rowLabels(mount(doc))).not.toContain("Style");

  // Positive control: a catalogue font in the same panel DOES get one, so the
  // absence above is about this font and not about the row never rendering.
  listed = [{ id: "f1", name: "Abhaya Libre" }];
  const { doc: doc2 } = docWithText("f1");
  await vi.waitFor(() => expect(rowLabels(mount(doc2))).toContain("Style"));
});

test("a family with only ONE style gets no row — nothing to choose between", async () => {
  listed = [{ id: "s1", name: "Solo Face" }];
  const { doc } = docWithText("s1");
  await vi.waitFor(() => expect(rowLabels(mount(doc))).toContain("Font"));
  expect(rowLabels(mount(doc))).not.toContain("Style");

  // Positive control: the SAME panel shows it for a multi-style family, so the
  // absence is about the variant count and not about the catalogue stub.
  listed = [{ id: "f1", name: "Abhaya Libre" }];
  const { doc: doc2 } = docWithText("f1");
  await vi.waitFor(() => expect(rowLabels(mount(doc2))).toContain("Style"));
});
