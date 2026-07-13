import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

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
    banner(".rcam format guide", "https://rapidcam.app/docs/rcam-format-v2.md") +
    read("docs/rcam-format-v2.md") +
    banner(
      ".rcam JSON Schema (draft 2020-12)",
      "https://rapidcam.app/schema/rcam-v2.schema.json",
    ) +
    "```json\n" +
    read("public/schema/rcam-v2.schema.json") +
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
  server: {
    port: 5173,
    open: false,
  },
  build: {
    target: "es2022",
    outDir: "dist",
    sourcemap: true,
    chunkSizeWarningLimit: 1000,
  },
});
