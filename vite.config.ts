import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";

/**
 * Publishes the .rcam authoring contract for external tools (including LLMs)
 * at stable URLs, next to the schema already served from public/schema:
 *
 *   /docs/rcam-format-v2.md   ← docs/rcam-format-v2.md
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
    return [
      {
        route: "/docs/rcam-format-v2.md",
        type: "text/markdown; charset=utf-8",
        body: () => readFileSync(join("docs", "rcam-format-v2.md")),
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
