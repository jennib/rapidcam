/**
 * RapidCAM MCP server — gives AI agents (Claude Code, Claude Desktop, any MCP
 * client) the full author → check → look loop over .rcam files:
 *
 *   get_format_guide   the complete authoring guide (docs/rcam-format-v2.md)
 *   list_examples      bundled golden example projects
 *   get_example        one example's .rcam JSON
 *   validate_rcam      schema + load + reference + constraint-solve checks
 *   post_gcode         generate machine program(s) + Apollo pre-flight lint
 *   render_preview     render the design to a PNG the agent can actually see
 *
 * Run it with `npm run mcp`, or hook it into Claude Code with:
 *   claude mcp add rapidcam -- npx tsx mcp/server.ts
 * (from this repo's directory — the server needs the repo's node_modules.)
 *
 * stdio discipline: stdout is the MCP protocol channel; anything the shared
 * core logs goes through console.warn/error (stderr) so nothing corrupts it.
 */

import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { postRcamText, repoRoot, validateRcamText } from "../cli/core";
import type { RenderHost } from "../cli/render";
import { buildErrorReport } from "../src/io/aiCheck";

const server = new McpServer({ name: "rapidcam", version: "1.0.0" });

const contentArg = {
  content: z.string().describe("The complete .rcam file as a JSON string (format version 2)"),
};

function text(s: string): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text: s }] };
}

server.registerTool(
  "get_format_guide",
  {
    description:
      "The complete .rcam v2 authoring guide (markdown): entity/constraint/dimension vocabulary, CAM operations, machine kinds, and gotchas. Read this before authoring a file.",
  },
  async () => text(readFileSync(join(repoRoot, "docs", "rcam-format-v2.md"), "utf8")),
);

server.registerTool(
  "list_examples",
  {
    description:
      "List the bundled golden example .rcam projects (schema-validated on every commit), in learning order from minimal geometry to full CAM, laser, and rotary jobs.",
  },
  async () => {
    const files = readdirSync(join(repoRoot, "examples"))
      .filter((f) => f.endsWith(".rcam"))
      .sort();
    return text(files.join("\n"));
  },
);

server.registerTool(
  "get_example",
  {
    description: "Fetch one bundled example project's .rcam JSON by filename.",
    inputSchema: { name: z.string().describe('Example filename, e.g. "mounting-plate-cam.rcam"') },
  },
  async ({ name }) => {
    const clean = basename(name); // no path escapes
    try {
      return text(readFileSync(join(repoRoot, "examples", clean), "utf8"));
    } catch {
      return text(`No such example "${clean}". Use list_examples for the available names.`);
    }
  },
);

server.registerTool(
  "validate_rcam",
  {
    description:
      "Check a .rcam file the way RapidCAM does on import: JSON, schema, loader, dangling references, constraint-solver convergence, and work-area bounds. Returns a fix-it report; run it after every authoring step.",
    inputSchema: contentArg,
  },
  async ({ content }) => {
    const result = validateRcamText(content);
    if (result.issues.length === 0) {
      return text("OK — the file passed schema, load, reference, and solver checks.");
    }
    return text(buildErrorReport(result));
  },
);

server.registerTool(
  "post_gcode",
  {
    description:
      "Generate the machine program(s) for a .rcam file with CAM operations — routed by machine kind (mill / laser / rotary wrap / double-sided flip) — and run the Apollo pre-flight lint (bounds, over-deep, rapid-through-stock, fast plunge, fixture collisions, tool changes) on each program.",
    inputSchema: contentArg,
  },
  async ({ content }) => {
    let post: ReturnType<typeof postRcamText>;
    try {
      post = postRcamText(content, "program");
    } catch (e) {
      return text(`post failed: ${(e as Error).message}`);
    }
    const parts: string[] = [];
    for (const w of post.warnings) parts.push(`⚠ ${w}`);
    for (const p of post.programs) {
      parts.push(`## ${p.name} (${p.gcode.split("\n").length} lines)`);
      for (const f of p.lint) parts.push(`${f.severity === "error" ? "✗" : "⚠"} [${f.code}] ${f.message}`);
      if (p.lint.length === 0) parts.push("pre-flight lint: clean");
      parts.push("```gcode\n" + p.gcode + "\n```");
    }
    return text(parts.join("\n\n"));
  },
);

/** One browser+dev-server pair, booted on first render and reused after. */
let renderHost: Promise<RenderHost> | null = null;

server.registerTool(
  "render_preview",
  {
    description:
      "Render a .rcam design to a PNG image exactly as RapidCAM draws it (geometry, dimensions, stock outline). Look at it to catch geometry that validates but is wrong. First call boots a headless browser (~10 s); later calls are fast.",
    inputSchema: contentArg,
  },
  async ({ content }) => {
    renderHost ??= import("../cli/render").then((m) => m.startRenderHost());
    let host: RenderHost;
    try {
      host = await renderHost;
    } catch (e) {
      renderHost = null; // let a later call retry the boot
      return text(`could not start the render host: ${(e as Error).message}`);
    }
    try {
      const png = await host.render(content);
      return {
        content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }],
      };
    } catch (e) {
      return text(`render failed: ${(e as Error).message}`);
    }
  },
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
  console.error("[rapidcam-mcp] ready (stdio)");
}

main().catch((e) => {
  console.error("[rapidcam-mcp] fatal:", e);
  process.exit(1);
});
