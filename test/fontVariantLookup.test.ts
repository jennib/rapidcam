import { expect, test } from "vitest";
import { familyOfLoadedFont, variantName } from "../src/core/webFonts";
import type { FontCatalogue } from "../src/core/webFonts";

/**
 * Finding a loaded font's family so its other weights can be offered.
 *
 * Switching an existing text from Regular to Bold looked like it needed
 * persisted metadata — `FontEntry` carries no family field — and was deferred on
 * that basis. It doesn't. The font's `name` was PRODUCED by `variantName`, and
 * `name` is already a required field on `embeddedFont`, so inverting that one
 * function recovers the family exactly, and it still works after a save/reload.
 *
 * Exact equality is what makes it safe. A tokenising or prefix-matching version
 * would confuse a family literally called "Sans Bold", or a weight whose own
 * name contains a space — both of which exist in the real catalogue.
 */

const cat = (families: { n: string; c: string; v: { s: string; p: string }[] }[]) =>
  ({ cdn: "https://x/", families }) as unknown as FontCatalogue;

const FIXTURE = cat([
  { n: "Open Sans", c: "sans-serif", v: [
    { s: "Regular", p: "a/OpenSans-Regular.ttf" },
    { s: "Bold", p: "a/OpenSans-Bold.ttf" },
    { s: "Bold Italic", p: "a/OpenSans-BoldItalic.ttf" },
  ] },
  // A family whose NAME ends in a weight word — the case a prefix match breaks on.
  { n: "Sans Bold", c: "display", v: [{ s: "Regular", p: "b/SansBold-Regular.ttf" }] },
]);

test("a Regular resolves to its family — the name IS the family name", () => {
  const hit = familyOfLoadedFont(FIXTURE, "Open Sans");
  expect(hit?.family.n).toBe("Open Sans");
  expect(hit?.variant.s).toBe("Regular");
});

test("a weight resolves, including one whose own name has a space", () => {
  expect(familyOfLoadedFont(FIXTURE, "Open Sans Bold")?.variant.s).toBe("Bold");
  expect(familyOfLoadedFont(FIXTURE, "Open Sans Bold Italic")?.variant.s).toBe("Bold Italic");
});

test("a family whose NAME ends in a weight word is not mistaken for a variant", () => {
  // "Sans Bold" is a family in its own right. A prefix/token matcher would read
  // it as the Bold of a family called "Sans" — which does not exist here.
  const hit = familyOfLoadedFont(FIXTURE, "Sans Bold");
  expect(hit?.family.n).toBe("Sans Bold");
  expect(hit?.variant.s).toBe("Regular");
});

test("a font loaded from disk resolves to nothing, rather than to something close", () => {
  expect(familyOfLoadedFont(FIXTURE, "MyCustomFont")).toBeNull();
  expect(familyOfLoadedFont(FIXTURE, "Open Sans Ultra")).toBeNull();
  // Positive control: the lookup is working, so the nulls are about these names
  // and not about a matcher that never matches.
  expect(familyOfLoadedFont(FIXTURE, "Open Sans Bold")).not.toBeNull();
});

test("it inverts variantName for every entry in the real catalogue", async () => {
  const real = JSON.parse(
    await import("node:fs/promises").then((fs) =>
      fs.readFile("public/fonts/catalogue.json", "utf8"),
    ),
  ) as FontCatalogue;

  // Every name the picker can produce must resolve back to what produced it.
  // Sampled across the file rather than all ~5000, to keep the suite quick.
  let checked = 0;
  for (let i = 0; i < real.families.length; i += 97) {
    const fam = real.families[i];
    for (const v of fam.v) {
      const hit = familyOfLoadedFont(real, variantName(fam, v));
      expect(hit?.family.n, `${fam.n} / ${v.s}`).toBe(fam.n);
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(20);
});
