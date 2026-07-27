import { expect, test, waitForApp } from "./appFixture";

/**
 * Guard for the aiDocsPlugin dev middleware (vite.config.ts).
 *
 * The middleware serves /docs, /examples, and /llms-full.txt on the dev
 * server. Its one sharp edge: it MUST pass through URLs with a query string —
 * Vite requests `/examples/*.rcam?import&raw` for the app's example glob, and
 * intercepting those breaks module loading (blank app, MIME errors). That
 * regression only manifests on the dev server, so unit tests can't see it;
 * this spec pins both halves in the environment where they live.
 */

test("app still boots with the middleware active (module requests pass through)", async ({
  page,
}) => {
  await page.goto("/");
  await waitForApp(page);

  // The welcome screen's example gallery is fed by the `?raw` glob import —
  // if the middleware swallowed module requests, these cards cannot render.
  const welcome = page.locator(".welcome-backdrop");
  await expect(welcome).toBeVisible();
  await expect(welcome.locator(".welcome-example-grid .welcome-example-card").first()).toBeVisible();
});

test("bare document fetches are served with the right content", async ({ request }) => {
  const llms = await request.get("/llms.txt");
  expect(llms.ok()).toBe(true);
  expect(await llms.text()).toContain("RapidCAM");

  const full = await request.get("/llms-full.txt");
  expect(full.ok()).toBe(true);
  expect(full.headers()["content-type"]).toContain("text/plain");
  const fullText = await full.text();
  for (const url of [
    "https://rapidcam.app/docs/rcam-format-v3.md",
    "https://rapidcam.app/schema/rcam-v3.schema.json",
    "https://rapidcam.app/docs/ai-integration.md",
  ]) {
    expect(fullText).toContain(`Canonical URL: ${url}`);
  }

  const guide = await request.get("/docs/rcam-format-v3.md");
  expect(guide.ok()).toBe(true);
  expect(guide.headers()["content-type"]).toContain("markdown");
  expect(await guide.text()).toContain("## CAM operations");

  const index = await request.get("/examples/index.json");
  expect(index.ok()).toBe(true);
  const names = (await index.json()) as string[];
  expect(names.length).toBeGreaterThan(0);

  // A bare example fetch (no query) is the document; it must be valid JSON.
  const example = await request.get(`/examples/${names[0]}`);
  expect(example.ok()).toBe(true);
  const doc = (await example.json()) as { version: number };
  expect(doc.version).toBe(2);
});
