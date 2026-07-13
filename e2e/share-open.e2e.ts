import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { buildOpenUrl, writeRedirectPage } from "../cli/open";

/**
 * The `rapidcam open` / MCP `open_in_app` delivery path, end to end: a share
 * URL built headlessly in Node must load in the real app, both directly and
 * via the redirect page the launcher uses to dodge OS command-line limits.
 */

const here = dirname(fileURLToPath(import.meta.url));
const exampleText = readFileSync(join(here, "..", "examples", "bolt-circle.rcam"), "utf8");

function loadedEntityCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (window as unknown as { __app?: { project?: { doc?: { entities?: unknown[] } } } }).__app
        ?.project?.doc?.entities?.length ?? 0,
  );
}

test("a headlessly built share URL opens the design in the app", async ({ page }) => {
  const url = await buildOpenUrl(exampleText, "http://localhost:5173/");
  await page.goto(url);
  await expect.poll(() => loadedEntityCount(page)).toBeGreaterThan(1);
});

test("the redirect launcher page carries the design into the app", async ({ page }) => {
  const url = await buildOpenUrl(exampleText, "http://localhost:5173/");
  const redirect = pathToFileURL(writeRedirectPage(url)).href;
  await page.goto(redirect);
  await expect.poll(() => loadedEntityCount(page), { timeout: 15_000 }).toBeGreaterThan(1);
});
