/**
 * Render .rcam designs to PNG without a visible browser: boot the app on an
 * ephemeral Vite dev server (dev mode exposes the `window.__app` hook), load
 * files through the same ProjectManager path the UI uses, and screenshot the
 * drawing canvas with headless Chromium.
 *
 * A {@link RenderHost} keeps the server + browser alive between renders so a
 * caller iterating on a design (the MCP server) pays the boot cost once.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./core";

export interface RenderHost {
  /** Render one .rcam text to a PNG buffer. */
  render(rcamText: string): Promise<Buffer>;
  close(): Promise<void>;
}

export async function startRenderHost(
  size = { width: 1400, height: 900 },
): Promise<RenderHost> {
  const [{ createServer }, { chromium }] = await Promise.all([
    import("vite"),
    import("playwright"),
  ]);

  const server = await createServer({
    configFile: join(repoRoot, "vite.config.ts"),
    root: repoRoot,
    server: { port: 0 },
    logLevel: "silent",
  });
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  if (!url) {
    await server.close();
    throw new Error("vite dev server did not report a local URL");
  }

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: size });
  // Pre-answer the analytics consent banner so no overlay crosses the canvas.
  await page.addInitScript(() => {
    localStorage.setItem("rapidcam_analytics_consent", "denied");
  });
  await page.goto(url);
  await page.waitForFunction(() => window.__app !== undefined);

  return {
    async render(rcamText: string): Promise<Buffer> {
      const problem = await page.evaluate((text: string) => {
        const app = window.__app!;
        try {
          const file = JSON.parse(text);
          app.project.loadDocument(file, file.name ?? "render");
        } catch (e) {
          return (e as Error).message;
        }
        // The start screen overlays the canvas on a fresh profile.
        document.querySelector(".welcome-backdrop")?.remove();
        return null;
      }, rcamText);
      if (problem) throw new Error(`could not load the design: ${problem}`);
      // Let async font loads and the next paint settle before capturing.
      await page.waitForTimeout(600);
      return page.locator("canvas").first().screenshot();
    },
    async close(): Promise<void> {
      await browser.close();
      await server.close();
    },
  };
}

/** One-shot render for the CLI: boot, render, write, tear down. */
export async function renderRcam(filePath: string, outPath: string): Promise<void> {
  const text = readFileSync(filePath, "utf8");
  const host = await startRenderHost();
  try {
    writeFileSync(outPath, await host.render(text));
  } finally {
    await host.close();
  }
}
