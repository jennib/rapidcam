/**
 * Shared setup for the specs that drive the real app (as opposed to the WebGL
 * harness pages under fixtures/).
 *
 * Its one job is the analytics consent banner. That banner and the welcome
 * screen are BOTH top-layer elements — `popover="manual"` and a modal
 * `<dialog>` — so whichever paints above swallows clicks meant for the other,
 * and which one that is shifts with the viewport and with how tall the New
 * Project dialog renders. Dismissing the banner first fails one way (at a short
 * viewport the welcome dialog covers it, so the "No thanks" click times out);
 * clicking through it first fails the other (the banner eats "Create Project").
 * Any click ordering is a coin toss on layout, which is why this kept coming
 * back — cb229ed, 4ee0148 and df797ee are three separate fixes for it.
 *
 * So don't click it: record the decision before the app boots and let
 * `showConsentBannerIfNeeded()` return early, and the banner never renders at
 * all. `main.ts` calls that synchronously *before* publishing `window.__app`,
 * which is also why the `if (await consent.count())` guard these specs used to
 * carry was never actually load-bearing — by the time `__app` exists the banner
 * is always already in the DOM, so the guard read as race protection while
 * protecting against nothing.
 *
 * `consent-clickthrough.e2e.ts` deliberately exercises the banner and must keep
 * using the plain `test` from @playwright/test.
 */
import { test as base, expect, type Page } from "@playwright/test";
import { buildOpenUrl } from "../cli/open";
import { ORIGIN_ENTITY_ID } from "../src/model/document";
import { StorageKeys } from "../src/core/storageKeys";

export { expect };

/** Where the Playwright-managed Vite dev server listens (see playwright.config.ts). */
export const APP_URL = "http://127.0.0.1:5173/";

/** `test`, but the consent banner never renders. Use this for app-driving specs. */
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(
      (key) => localStorage.setItem(key, "denied"),
      StorageKeys.analyticsConsent,
    );
    await use(page);
  },
});

/** Resolve once main.ts has published its dev hook, i.e. the app is fully wired. */
export async function waitForApp(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => "__app" in window && Boolean((window as { __app?: unknown }).__app)),
      { message: "app never published window.__app — it threw during boot, or this is a prod build" },
    )
    .toBe(true);
}

/**
 * Open a serialized .rcam document through the share-URL path and wait until
 * its geometry has landed.
 *
 * The readiness check ignores the implicit WCS origin point that CADDocument
 * keeps at `entities[0]`, so it means "the design loaded" rather than "the
 * document has some entities" — which is true even of an empty one.
 */
/**
 * A toolpath-dialog field row on the FINISHING/shared side — i.e. every row that
 * is not part of the Roughing stage.
 *
 * A 3-D Relief job puts two tools in one dialog, so "Tool Type", "Diameter",
 * "Stepdown" and "Stepover" each label two rows. The roughing rows are built even
 * while the stage is hidden, so a bare `.tp-field` filter is ambiguous in EVERY
 * document, relief or not — which is how a relief change broke `cam-units` and
 * `cam-parametric-fields`. `cam-units` had already papered over one case with
 * `.first()`, which reads as "whichever comes first" rather than "the one the
 * user means".
 *
 * Say which stage instead. `[data-stage="rough"]` is set in `reliefRoughSection`;
 * a spec that wants a roughing row asks for it by that attribute directly.
 *
 * `:visible` carries the other half, and it is not belt-and-braces: the LASER
 * section builds a second "Feed (…/min)" row that sits hidden in every mill
 * document, so that label was already ambiguous long before relief added a second
 * tool. `cam-units` pinned it with `.first()`, which happened to be right and says
 * nothing about why. Between them the two clauses state the actual predicate —
 * *the row the user is looking at* — rather than a DOM position.
 */
export const FINISH_FIELD = '.tp-field:visible:not([data-stage="rough"] *)';

export async function openDoc(page: Page, rcamText: string): Promise<void> {
  await page.goto(await buildOpenUrl(rcamText, APP_URL));
  await waitForApp(page);
  await expect
    .poll(
      () =>
        page.evaluate((originId) => {
          const doc = (
            window as unknown as { __app?: { project?: { doc?: { entities?: { id: string }[] } } } }
          ).__app?.project?.doc;
          return doc?.entities?.filter((e) => e.id !== originId).length ?? 0;
        }, ORIGIN_ENTITY_ID),
      { message: "the design never loaded from the share URL (0 entities beyond the WCS origin)" },
    )
    .toBeGreaterThan(0);
}
