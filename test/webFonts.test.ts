/**
 * Fonts pulled from the web: catalogue search, URL handling, and the glyph-path
 * fallback that makes ~1 family in 8 usable at all.
 *
 * Run with: npx vitest run test/webFonts.test.ts
 */

import { test, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  searchFamilies,
  variantUrl,
  variantName,
  previewCssUrl,
  normalizeFontUrl,
  addFontFromUrl,
  loadCatalogue,
  resetCatalogueCache,
  CATALOGUE_URL,
  type FontCatalogue,
  type FetchLike,
} from "../src/core/webFonts";
import { textPath, isWoff2, registerFontBytes } from "../src/core/fontManager";
import type { Font } from "opentype.js";

const CAT: FontCatalogue = {
  generated: "2026-08-08",
  source: "google/fonts@main",
  cdn: "https://cdn.example/gh/google/fonts@main/",
  families: [
    { n: "Roboto", c: "sans-serif", v: [{ s: "Regular", p: "ofl/roboto/Roboto[wdth,wght].ttf" }] },
    {
      n: "Lobster",
      c: "display",
      v: [
        { s: "Regular", p: "ofl/lobster/Lobster-Regular.ttf" },
        { s: "Bold", p: "ofl/lobster/Lobster-Bold.ttf" },
      ],
    },
    { n: "Baloo Robot", c: "display", v: [{ s: "Regular", p: "ofl/baloorobot/BalooRobot.ttf" }] },
  ],
};

// --- search ------------------------------------------------------------------
test("a name that starts with the query outranks one that merely contains it", () => {
  const hits = searchFamilies(CAT, "rob");
  expect(hits.map((f) => f.n)).toEqual(["Roboto", "Baloo Robot"]);
});

test("search is case-insensitive and matches the category too", () => {
  expect(searchFamilies(CAT, "LOBSTER").map((f) => f.n)).toEqual(["Lobster"]);
  expect(searchFamilies(CAT, "display").map((f) => f.n)).toEqual(["Lobster", "Baloo Robot"]);
});

test("an empty query lists the head of the catalogue, and limit is honoured", () => {
  expect(searchFamilies(CAT, "").map((f) => f.n)).toEqual(["Roboto", "Lobster", "Baloo Robot"]);
  expect(searchFamilies(CAT, "", 2)).toHaveLength(2);
  expect(searchFamilies(CAT, "o", 2)).toHaveLength(2);
});

// --- URLs --------------------------------------------------------------------
test("a variable font's bracketed axes are encoded, so the URL is legal", () => {
  const url = variantUrl(CAT, CAT.families[0].v[0]);
  // Raw "[" and "]" would make this an invalid URL and 400 at the CDN.
  expect(url).toBe(
    "https://cdn.example/gh/google/fonts@main/ofl/roboto/Roboto%5Bwdth%2Cwght%5D.ttf",
  );
  expect(() => new URL(url)).not.toThrow();
});

test("path separators survive encoding", () => {
  expect(variantUrl(CAT, CAT.families[1].v[0])).toContain("/ofl/lobster/Lobster-Regular.ttf");
});

test("a font is named for its family, with the style only when it isn't Regular", () => {
  const lobster = CAT.families[1];
  expect(variantName(lobster, lobster.v[0])).toBe("Lobster");
  expect(variantName(lobster, lobster.v[1])).toBe("Lobster Bold");
});

test("the preview stylesheet asks for every family in one request, glyphs narrowed", () => {
  const url = new URL(previewCssUrl(["Open Sans", "Roboto"]));
  expect(url.searchParams.getAll("family")).toEqual(["Open Sans", "Roboto"]);
  // Only the characters actually on screen — a full charset for 60 families
  // would be megabytes.
  const text = url.searchParams.get("text") ?? "";
  expect([...text].sort().join("")).toBe([...new Set("Open SansRoboto")].sort().join(""));
});

test("normalizeFontUrl takes http(s) and refuses anything else", () => {
  expect(normalizeFontUrl("  https://x.test/a.ttf ")).toBe("https://x.test/a.ttf");
  expect(normalizeFontUrl("http://x.test/a.ttf")).toBe("http://x.test/a.ttf");
  expect(normalizeFontUrl("Open Sans")).toBeNull();
  expect(normalizeFontUrl("file:///C:/fonts/a.ttf")).toBeNull();
  expect(normalizeFontUrl("")).toBeNull();
});

// --- catalogue loading -------------------------------------------------------
beforeEach(() => resetCatalogueCache());

test("concurrent openings share one catalogue request", async () => {
  let calls = 0;
  const fetchImpl: FetchLike = async (url) => {
    expect(url).toBe(CATALOGUE_URL);
    calls++;
    return { ok: true, json: async () => CAT } as Response;
  };
  const [a, b] = await Promise.all([loadCatalogue(fetchImpl), loadCatalogue(fetchImpl)]);
  expect(a).toBe(b);
  expect(calls).toBe(1);
  // ...and a later call is served from the cache rather than the network.
  await loadCatalogue(fetchImpl);
  expect(calls).toBe(1);
});

test("a failed catalogue fetch rejects and doesn't poison the next attempt", async () => {
  const bad: FetchLike = async () => ({ ok: false, status: 404 }) as Response;
  await expect(loadCatalogue(bad)).rejects.toThrow();
  const good: FetchLike = async () => ({ ok: true, json: async () => CAT }) as Response;
  await expect(loadCatalogue(good)).resolves.toBe(CAT);
});

// --- fetching a font ---------------------------------------------------------
const here = dirname(fileURLToPath(import.meta.url));
const ROBOTO = readFileSync(join(here, "..", "public", "fonts", "roboto-regular.woff"));
const robotoBuf = (): ArrayBuffer =>
  ROBOTO.buffer.slice(ROBOTO.byteOffset, ROBOTO.byteOffset + ROBOTO.byteLength) as ArrayBuffer;

test("a real font downloads, parses and registers", async () => {
  const fetchImpl: FetchLike = async () =>
    ({ ok: true, arrayBuffer: async () => robotoBuf() }) as Response;
  const res = await addFontFromUrl("https://x.test/roboto.woff", "Roboto", fetchImpl);
  expect(res.id).toMatch(/^font-[0-9a-f]{8}$/);
  expect(res.embeddable).toBe(true);
  // Content-addressed: the same bytes from anywhere are the same font.
  const again = await registerFontBytes(robotoBuf(), "Whatever");
  expect(again.id).toBe(res.id);
});

test("a WOFF2 is refused by name, not by a parse error", async () => {
  const woff2 = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0]).buffer;
  expect(isWoff2(woff2)).toBe(true);
  const fetchImpl: FetchLike = async () =>
    ({ ok: true, arrayBuffer: async () => woff2 }) as Response;
  await expect(addFontFromUrl("https://x.test/a.woff2", "A", fetchImpl)).rejects.toThrow(/WOFF2/);
  // Positive control: the same route accepts a font it can actually read.
  expect(isWoff2(robotoBuf())).toBe(false);
});

test("a blocked or unreachable host explains both possibilities", async () => {
  const fetchImpl: FetchLike = async () => {
    throw new TypeError("Failed to fetch");
  };
  await expect(addFontFromUrl("https://blocked.test/a.ttf", "A", fetchImpl)).rejects.toThrow(
    /blocked\.test[\s\S]*CORS/,
  );
});

test("an HTTP error reports its status", async () => {
  const fetchImpl: FetchLike = async () => ({ ok: false, status: 403 }) as Response;
  await expect(addFontFromUrl("https://x.test/a.ttf", "A", fetchImpl)).rejects.toThrow(/403/);
});

// --- the committed catalogue -------------------------------------------------
/**
 * The catalogue is generated by a script that is run by hand, so nothing else
 * would notice if a run half-failed and committed a broken file. These are the
 * invariants the picker relies on.
 */
test("the committed catalogue is well-formed", () => {
  const cat = JSON.parse(
    readFileSync(join(here, "..", "public", "fonts", "catalogue.json"), "utf8"),
  ) as FontCatalogue;

  expect(cat.cdn.endsWith("/")).toBe(true);
  expect(cat.families.length).toBeGreaterThan(1000);

  const names = new Set<string>();
  for (const f of cat.families) {
    expect(f.n, "family with no name").toBeTruthy();
    expect(f.v.length, `${f.n} has no selectable font`).toBeGreaterThan(0);
    expect(names.has(f.n), `duplicate family ${f.n}`).toBe(false);
    names.add(f.n);

    const paths = new Set<string>();
    for (const v of f.v) {
      expect(v.s, `${f.n} variant with no style`).toBeTruthy();
      // Only TTF: the app has no Brotli decoder, so a WOFF2 in here would be a
      // dead entry the user can select and never use.
      expect(v.p, `${f.n}: ${v.p}`).toMatch(/^(ofl|apache|ufl)\/[^/]+\/.+\.ttf$/);
      // One file, one entry — the rule that keeps a variable font from offering
      // a "Bold" that would hand back Regular outlines.
      expect(paths.has(v.p), `${f.n} lists ${v.p} twice`).toBe(false);
      paths.add(v.p);
    }
  }

  // Sorted, because the picker shows the head of the list for an empty search.
  const sorted = [...cat.families].sort((a, b) => a.n.localeCompare(b.n));
  expect(cat.families.map((f) => f.n)).toEqual(sorted.map((f) => f.n));

  // A smoke check that generation actually read METADATA.pb rather than
  // inventing names from directory slugs.
  expect(names.has("Open Sans")).toBe(true);
  expect(names.has("Playfair Display")).toBe(true);
});

// --- the glyph-path fallback -------------------------------------------------
/**
 * A font whose `getPath` throws the way ~1 Google family in 8 does, but whose
 * individual glyphs are fine — which is exactly the shape of the real failure.
 */
function shapingBrokenFont(opts: { glyphsWork: boolean } = { glyphsWork: true }): Font {
  let getPathCalls = 0;
  const font = {
    unitsPerEm: 1000,
    get shapingCalls() {
      return getPathCalls;
    },
    getPath: () => {
      getPathCalls++;
      throw new Error("substitutionType : 62 lookupType: 6 - substFormat: 2 is not yet supported");
    },
    charToGlyph: () => {
      if (!opts.glyphsWork) throw new Error("no glyf table");
      return {
        advanceWidth: 500,
        getPath: (x: number) => ({ commands: [{ type: "M", x, y: 0 }] }),
      };
    },
    getKerningValue: () => 0,
  };
  return font as unknown as Font;
}

test("a font whose shaping throws still produces outlines", () => {
  const font = shapingBrokenFont();
  const path = textPath(font, "Hi", 10);
  expect(path?.commands).toHaveLength(2); // one per glyph
});

test("the broken shaper is tried once, not once per frame", () => {
  const font = shapingBrokenFont();
  for (let i = 0; i < 5; i++) textPath(font, "Hi", 10);
  // Throwing is expensive and the renderer draws every frame, so the first
  // failure has to be remembered.
  expect((font as unknown as { shapingCalls: number }).shapingCalls).toBe(1);
});

test("a font that can't produce glyphs at all returns null rather than throwing", () => {
  expect(textPath(shapingBrokenFont({ glyphsWork: false }), "Hi", 10)).toBeNull();
});

test("a working font is left to its own shaping", () => {
  let used = false;
  const font = {
    unitsPerEm: 1000,
    getPath: () => {
      used = true;
      return { commands: [{ type: "M", x: 0, y: 0 }] };
    },
    charToGlyph: () => {
      throw new Error("the fallback should not have been reached");
    },
  } as unknown as Font;
  expect(textPath(font, "Hi", 10)?.commands).toHaveLength(1);
  expect(used).toBe(true);
});
