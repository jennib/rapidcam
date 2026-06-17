import type { RcamFile } from "./fileio";

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

let cache: ExampleEntry[] | null = null;

export function getExamples(): ExampleEntry[] {
  if (cache) return cache;
  const out: ExampleEntry[] = [];
  for (const [path, raw] of Object.entries(modules)) {
    try {
      const file = JSON.parse(raw) as RcamFile;
      if (file.version !== 1) continue;
      const fallback = path.split("/").pop()!.replace(/\.rcam$/i, "");
      out.push({ name: file.name || fallback, file });
    } catch {
      // Skip a malformed example rather than breaking the menu.
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  cache = out;
  return out;
}
