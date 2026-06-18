import { normalizeRcam, type RcamFile } from "./fileio";

export interface ExampleEntry {
  name: string;
  file: RcamFile;
}

/**
 * Bundled example projects. Every `.rcam` in the repo's top-level `examples/`
 * folder is inlined at build time as a raw string, so examples ship with the
 * app and load with no network request.
 */
const modules = import.meta.glob("../../examples/*.rcam", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/**
 * Curated learning order (the tier progression documented in examples/README.md).
 * Listed files appear in this order; any others sort after them, alphabetically.
 * Keyed on filename so renaming the display `name` doesn't reshuffle the list.
 */
const ORDER = [
  "keychain-tag.rcam",      // Tier 1 — first contact
  "mounting-plate.rcam",
  "bracket.rcam",           // Tier 2 — constraints / variables / patterns
  "bolt-circle.rcam",
  "mounting-plate-cam.rcam", // Tier 3 — full CAM pipeline
  "enclosure-lid.rcam",
];

let cache: ExampleEntry[] | null = null;

export function getExamples(): ExampleEntry[] {
  if (cache) return cache;
  const items: { entry: ExampleEntry; base: string }[] = [];
  for (const [path, raw] of Object.entries(modules)) {
    try {
      const file = normalizeRcam(JSON.parse(raw));
      const base = path.split("/").pop()!;
      const fallback = base.replace(/\.rcam$/i, "");
      items.push({ entry: { name: file.name || fallback, file }, base });
    } catch {
      // Skip a malformed example rather than breaking the menu.
    }
  }
  items.sort((a, b) => {
    const ia = ORDER.indexOf(a.base);
    const ib = ORDER.indexOf(b.base);
    if (ia !== -1 && ib !== -1) return ia - ib;     // both curated → tier order
    if (ia !== -1) return -1;                        // curated before un-curated
    if (ib !== -1) return 1;
    return a.entry.name.localeCompare(b.entry.name); // neither → alphabetical
  });
  cache = items.map((i) => i.entry);
  return cache;
}
