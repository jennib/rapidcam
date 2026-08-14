import { expect, test } from "vitest";
import { searchFamilies } from "../src/core/webFonts";
import type { FontCatalogue } from "../src/core/webFonts";

/**
 * Paginating the font list.
 *
 * The dialog used to show a fixed 60 families out of 2,022 with no way past
 * them, so browsing alphabetically stopped in the "A"s and the search box was
 * the only route — you had to already know the name of the font you wanted.
 *
 * The detail pagination rests on: `searchFamilies` applies its `limit` during
 * ranking (it breaks the scan early), and I assumed that made a bigger limit
 * reorder what a smaller one returned. It does not — the early break only fires
 * once `starts` alone fills the limit, and both buckets accumulate in catalogue
 * order, so the first N entries are identical for any limit >= N. These pin that
 * PREFIX STABILITY, because the dialog would silently reshuffle rows under the
 * user if it ever stopped holding.
 */

function catalogue(names: string[]): FontCatalogue {
  return {
    families: names.map((n) => ({ n, c: "sans-serif", v: ["regular"] })),
  } as unknown as FontCatalogue;
}

/** Names where a prefix match appears only AFTER several substring matches. */
const NAMES = [
  "Alpha Sans", // contains "sans"
  "Beta Sans", // contains "sans"
  "Gamma Sans", // contains "sans"
  "Sans Forgetica", // STARTS with "sans" — ranks above all of the above
  "Delta Sans",
  "Sansation", // starts with "sans" too
];

test("a smaller limit returns a stable prefix of a bigger one", () => {
  const cat = catalogue(NAMES);
  const few = searchFamilies(cat, "sans", 2).map((f) => f.n);
  const many = searchFamilies(cat, "sans", 6).map((f) => f.n);

  expect(many.slice(0, few.length)).toEqual(few);
  // Positive control: the two calls really did return different amounts, so the
  // equality above is about prefix stability and not about both being empty.
  expect(many.length).toBeGreaterThan(few.length);
});

test("ranking once with Infinity gives a stable list to paginate", () => {
  const cat = catalogue(NAMES);
  const all = searchFamilies(cat, "sans", Number.POSITIVE_INFINITY).map((f) => f.n);

  // Prefix matches lead, in catalogue order.
  expect(all.slice(0, 2)).toEqual(["Sans Forgetica", "Sansation"]);
  expect(all).toHaveLength(6);

  // Slicing that list is stable by construction — page 1 stays page 1.
  const page1 = all.slice(0, 2);
  const page2 = all.slice(0, 4);
  expect(page2.slice(0, 2)).toEqual(page1);
});

test("an empty query returns the catalogue in order, and Infinity returns all of it", () => {
  const cat = catalogue(NAMES);
  expect(searchFamilies(cat, "", 3).map((f) => f.n)).toEqual(NAMES.slice(0, 3));
  expect(searchFamilies(cat, "", Number.POSITIVE_INFINITY)).toHaveLength(NAMES.length);
  // Positive control: the default limit still caps, so Infinity is doing the
  // work rather than the cap having been removed outright.
  expect(searchFamilies(catalogue(Array.from({ length: 200 }, (_, i) => `F${i}`)), "")).toHaveLength(
    60,
  );
});
