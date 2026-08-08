/**
 * Fonts pulled from the web, by two routes: a searchable catalogue of Google's
 * families, and a plain URL for anything else.
 *
 * Both end in the same place — {@link registerFontBytes} — so a web font behaves
 * exactly like one loaded off disk: content-addressed id, and embedded into the
 * .rcam on save so the design still cuts on a machine with no internet.
 *
 * Two things about the sources are worth knowing before changing any of this:
 *
 * - **The obvious URL is the wrong one.** `fonts.googleapis.com/css2` is CORS-
 *   open, but serves WOFF2, which is Brotli-compressed and unreadable here. The
 *   font files come from a mirror of the google/fonts repository instead, which
 *   serves the original TTFs with `access-control-allow-origin: *`.
 * - **The catalogue can't be fetched live.** Google publishes no family index a
 *   browser may read (`fonts.google.com/metadata/fonts` sends no CORS header),
 *   so `public/fonts/catalogue.json` is generated ahead of time by
 *   `scripts/build-font-catalogue.ts` and served from this app's own origin.
 */

import { registerFontBytes, isWoff2 } from "./fontManager";

/** One selectable font: a family/style pair backed by exactly one file. */
export interface CatalogueVariant {
  /** Style label, e.g. "Regular", "Bold Italic". */
  s: string;
  /** Path within the source repository. */
  p: string;
}

export interface CatalogueFamily {
  /** Display name, e.g. "Open Sans". */
  n: string;
  /** Category slug: sans-serif, serif, display, handwriting, monospace. */
  c: string;
  v: CatalogueVariant[];
}

export interface FontCatalogue {
  generated: string;
  source: string;
  /** URL prefix every variant path hangs off. */
  cdn: string;
  families: CatalogueFamily[];
}

export const CATALOGUE_URL = "/fonts/catalogue.json";

/** Injectable for tests; defaults to the global fetch. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

let cached: FontCatalogue | null = null;
let inFlight: Promise<FontCatalogue> | null = null;

/**
 * The catalogue, fetched once per session. Concurrent callers share one request
 * — the picker asks for it as the dialog opens, and a second open before the
 * first lands shouldn't start a second download.
 */
export async function loadCatalogue(fetchImpl: FetchLike = fetch): Promise<FontCatalogue> {
  if (cached) return cached;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = await fetchImpl(CATALOGUE_URL);
      if (!res.ok) throw new Error(`status ${res.status}`);
      const cat = (await res.json()) as FontCatalogue;
      if (!Array.isArray(cat?.families) || !cat.cdn) throw new Error("malformed catalogue");
      cached = cat;
      return cat;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Drop the cached catalogue. Tests only — the app fetches once and keeps it. */
export function resetCatalogueCache(): void {
  cached = null;
  inFlight = null;
}

/**
 * Families matching `query`, best matches first: a name that starts with the
 * query beats one that merely contains it, so typing "rob" puts Roboto above
 * "Baloo Bhaijaan Robot". An empty query returns the head of the list, which is
 * alphabetical.
 */
export function searchFamilies(
  cat: FontCatalogue,
  query: string,
  limit = 60,
): CatalogueFamily[] {
  const q = query.trim().toLowerCase();
  if (!q) return cat.families.slice(0, limit);
  const starts: CatalogueFamily[] = [];
  const contains: CatalogueFamily[] = [];
  for (const f of cat.families) {
    const n = f.n.toLowerCase();
    if (n.startsWith(q)) starts.push(f);
    else if (n.includes(q) || f.c.includes(q)) contains.push(f);
    if (starts.length >= limit) break;
  }
  return [...starts, ...contains].slice(0, limit);
}

/**
 * Absolute URL for a catalogue variant. Every path segment is encoded, because
 * variable-font filenames carry their axes in square brackets —
 * `Roboto[wdth,wght].ttf` — and an unencoded `[` is not a legal URL character.
 */
export function variantUrl(cat: FontCatalogue, variant: CatalogueVariant): string {
  return cat.cdn + variant.p.split("/").map(encodeURIComponent).join("/");
}

/** How a font from the web is named in the picker: "Open Sans Bold Italic". */
export function variantName(family: CatalogueFamily, variant: CatalogueVariant): string {
  return variant.s === "Regular" ? family.n : `${family.n} ${variant.s}`;
}

/**
 * Fetch font bytes from `url` and register them. Rejects with a message meant
 * for the user: a browser can't tell a blocked cross-origin request from an
 * unreachable host, so the failure is explained in terms of both.
 */
export async function addFontFromUrl(
  url: string,
  nameHint: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ id: string; name: string; embeddable: boolean }> {
  let res: Response;
  try {
    res = await fetchImpl(url);
  } catch {
    throw new Error(
      `Couldn't download the font from ${hostOf(url)}. Either the address is wrong, or that ` +
        `site doesn't allow other sites to read its files (CORS).`,
    );
  }
  if (!res.ok) throw new Error(`The font address returned ${res.status}.`);
  const buf = await res.arrayBuffer();
  // Checked here as well as in registerFontBytes so the commonest web mistake —
  // pasting a WOFF2 link off a stylesheet — names itself before parsing does.
  if (isWoff2(buf)) {
    throw new Error(
      "That's a WOFF2 file, which can't be read here (it's Brotli-compressed). " +
        "Look for the .ttf, .otf or .woff version.",
    );
  }
  return registerFontBytes(buf, nameHint);
}

/** Hostname of a URL for an error message, or the raw string if it won't parse. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Normalize what someone pasted into the URL box. Returns null when it isn't a
 * usable http(s) address — a bare family name, say, or a `file://` path.
 */
export function normalizeFontUrl(raw: string): string | null {
  const s = (raw || "").trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * A stylesheet URL that previews each of `families` in its own face.
 *
 * Preview is the one place WOFF2 is fine: the browser renders the list, not
 * opentype.js. One request covers the whole visible page, and `text=` — which
 * applies to every family in the request — is narrowed to just the characters
 * on screen, so a page of 60 families costs a few KB instead of several MB.
 */
export function previewCssUrl(families: string[]): string {
  const fams = families.map((f) => `family=${encodeURIComponent(f)}`).join("&");
  const chars = [...new Set(families.join(""))].join("");
  return `https://fonts.googleapis.com/css2?${fams}&text=${encodeURIComponent(chars)}&display=swap`;
}
