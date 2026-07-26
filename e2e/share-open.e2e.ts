import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Page } from "@playwright/test";
import { APP_URL, expect, openDoc, test } from "./appFixture";
import { buildOpenUrl, writeRedirectPage } from "../cli/open";
import { ORIGIN_ENTITY_ID } from "../src/model/document";

/**
 * The `rapidcam open` / MCP `open_in_app` delivery path, end to end: a share
 * URL built headlessly in Node must load in the real app, both directly and
 * via the redirect page the launcher uses to dodge OS command-line limits.
 */

const here = dirname(fileURLToPath(import.meta.url));
const exampleText = readFileSync(join(here, "..", "examples", "bolt-circle.rcam"), "utf8");

/**
 * Entities the *design* contributed — excluding the implicit WCS origin point
 * CADDocument always keeps, so this reads 0 for a document that failed to load
 * rather than 1.
 */
function loadedEntityCount(page: Page): Promise<number> {
  return page.evaluate(
    (originId) =>
      (
        window as unknown as { __app?: { project?: { doc?: { entities?: { id: string }[] } } } }
      ).__app?.project?.doc?.entities?.filter((e) => e.id !== originId).length ?? 0,
    ORIGIN_ENTITY_ID,
  );
}

test("a headlessly built share URL opens the design in the app", async ({ page }) => {
  await openDoc(page, exampleText);
  await expect.poll(() => loadedEntityCount(page)).toBeGreaterThan(0);
});

test("the redirect launcher page carries the design into the app", async ({ page }) => {
  const url = await buildOpenUrl(exampleText, APP_URL);
  const redirect = pathToFileURL(writeRedirectPage(url)).href;
  await page.goto(redirect);
  await expect.poll(() => loadedEntityCount(page), { timeout: 15_000 }).toBeGreaterThan(0);
});
