import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
// vitest's defineConfig is vite's plus the `test` block below; vite itself reads
// the result unchanged and ignores that key.
import { defineConfig } from "vitest/config";
import pkg from "./package.json" with { type: "json" };

const repoRoot = dirname(fileURLToPath(import.meta.url));

/**
 * /llms-full.txt — the llms.txt convention's single-fetch variant: the index
 * plus every document it links, inlined into one plain-text file. Field
 * testing showed some AI fetch tools may only open URLs the user handed them
 * (no second hop to links found in a fetched page); this one URL carries the
 * whole authoring contract. Exported for the tripwire test.
 */
export function llmsFullText(): string {
  const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8").trimEnd();
  const banner = (title: string, url: string) =>
    `\n\n${"=".repeat(78)}\nSECTION: ${title}\nCanonical URL: ${url}\n${"=".repeat(78)}\n\n`;
  return (
    read("public/llms.txt") +
    banner(".rcam format guide", "https://rapidcam.app/docs/rcam-format-v3.md") +
    read("docs/rcam-format-v3.md") +
    banner(
      ".rcam JSON Schema (draft 2020-12)",
      "https://rapidcam.app/schema/rcam-v3.schema.json",
    ) +
    "```json\n" +
    read("public/schema/rcam-v3.schema.json") +
    "\n```" +
    banner("AI integration guide", "https://rapidcam.app/docs/ai-integration.md") +
    read("docs/ai-integration.md") +
    "\n"
  );
}

/**
 * Publishes the .rcam authoring contract for external tools (including LLMs)
 * at stable URLs, next to the schema already served from public/schema:
 *
 *   /docs/<name>.md           ← docs/<name>.md (format guide, AI guide, …)
 *   /examples/index.json      ← generated list of bundled examples
 *   /examples/<name>.rcam     ← examples/<name>.rcam
 *
 * The repo files stay the single source of truth; this plugin serves them in
 * dev and emits them into dist/ on build, so nothing can drift.
 */
function aiDocsPlugin(): Plugin {
  function entries(): { route: string; type: string; body: () => Buffer }[] {
    const examples = readdirSync("examples")
      .filter((f) => f.endsWith(".rcam"))
      .sort();
    const docs = readdirSync("docs")
      .filter((f) => f.endsWith(".md"))
      .sort();
    return [
      ...docs.map((f) => ({
        route: `/docs/${f}`,
        type: "text/markdown; charset=utf-8",
        body: () => readFileSync(join("docs", f)),
      })),
      {
        route: "/llms-full.txt",
        type: "text/plain; charset=utf-8",
        body: () => Buffer.from(llmsFullText()),
      },
      {
        route: "/examples/index.json",
        type: "application/json",
        body: () => Buffer.from(JSON.stringify(examples, null, 2)),
      },
      ...examples.map((f) => ({
        route: `/examples/${f}`,
        type: "application/json",
        body: () => readFileSync(join("examples", f)),
      })),
    ];
  }
  return {
    name: "rapidcam-ai-docs",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        // A query string means it's Vite's own module request for the same path
        // (the app imports examples/*.rcam via `?raw` glob) — leave those alone
        // and serve only bare document fetches.
        if (url.includes("?")) return next();
        const hit = entries().find((e) => e.route === url);
        if (!hit) return next();
        res.setHeader("Content-Type", hit.type);
        res.end(hit.body());
      });
    },
    generateBundle() {
      for (const e of entries()) {
        this.emitFile({ type: "asset", fileName: e.route.slice(1), source: e.body() });
      }
    },
  };
}

export default defineConfig({
  root: ".",
  plugins: [aiDocsPlugin()],
  // The version the About dialog shows, taken from package.json so the two
  // cannot disagree. It was typed out by hand there, which meant a release
  // silently shipped the previous number unless someone remembered a file with
  // no other reason to be opened.
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: {
    port: 5173,
    open: false,
  },
  build: {
    target: "es2022",
    outDir: "dist",
    sourcemap: true,
    /**
     * Set just above the current main chunk (~1044 kB) so real growth still
     * warns, rather than silenced outright.
     *
     * The default 1000 kB had been firing on every build for weeks and was
     * measured rather than obeyed: it counts UNCOMPRESSED bytes, while what
     * crosses the wire is ~295 kB gzipped. On a production build served by
     * `vite preview`, with the browser cache disabled and the server warmed,
     * time-to-interactive (the welcome screen on screen) was 306ms unthrottled,
     * 591ms on fast 4G and 1,279ms on slow 4G. There is no user-visible problem
     * to fix, and code-splitting for its own sake would add real complexity for
     * no measured benefit. Re-measure with scripts/load-probe.e2e.ts before
     * acting on this warning.
     */
    chunkSizeWarningLimit: 1100,
  },
  test: {
    /**
     * Vitest's 5s default is sized for tests that do almost no work. This suite
     * is CAM: a single test legitimately generates ~290k G-code moves into a
     * ~9MB string, and several gzip or rasterise real designs. Those run in
     * ~1-2.4s alone, which looks safe and is not — the files run in parallel
     * worker processes, so on a loaded machine (or a slower CI runner) each gets
     * a fraction of the CPU and memory, and a ~1s test on a 5s budget only needs
     * a 5x slowdown to fail. That is not a flake to retry: a test whose result
     * depends on what else is running is a benchmark with an assertion on it.
     *
     * 30s restores real headroom (~12-40x) across the suite and lets the two
     * per-test `}, 30_000)` overrides go away. It costs nothing on a passing
     * run — a timeout only elapses when something is already wrong — and still
     * catches the hangs it exists for: a stack overflow or infinite loop throws
     * or spins immediately, it does not finish in 29 seconds.
     */
    testTimeout: 30_000,
  },
});
