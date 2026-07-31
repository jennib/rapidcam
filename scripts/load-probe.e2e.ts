import { test } from "@playwright/test";

/** Time-to-interactive on the PRODUCTION build, over a throttled link. */
const PROFILES = [
  { name: "fast 4G  (9 Mbps, 85ms RTT)", down: 9_000_000 / 8, up: 1_500_000 / 8, rtt: 85 },
  { name: "slow 4G  (3 Mbps, 150ms RTT)", down: 3_000_000 / 8, up: 750_000 / 8, rtt: 150 },
  { name: "unthrottled (localhost)", down: -1, up: -1, rtt: 0 },
];

for (const p of PROFILES) {
  test(`first load — ${p.name}`, async ({ page }) => {
    test.setTimeout(180_000);
    const client = await page.context().newCDPSession(page);
    await client.send("Network.enable");
    // Cache OFF: without it a later profile serves from memory and reports a
    // couple of KB, which is how the first attempt produced a "slow 4G" run
    // faster than "fast 4G".
    await client.send("Network.setCacheDisabled", { cacheDisabled: true });
    await client.send("Network.emulateNetworkConditions", {
      offline: false, downloadThroughput: p.down, uploadThroughput: p.up, latency: p.rtt,
    });
    // encodedDataLength is what actually crossed the wire (post-compression);
    // content-length is frequently absent and undercounts badly.
    let bytes = 0;
    client.on("Network.loadingFinished", (e: any) => { bytes += e.encodedDataLength ?? 0; });

    // Warm the preview server first: the very first request pays disk reads the
    // later ones do not, which made the first profile measured look slowest
    // regardless of its throttle.
    await page.goto("http://localhost:4173/", { waitUntil: "domcontentloaded" });
    await page.locator(".welcome-backdrop").waitFor({ timeout: 120_000 });
    bytes = 0;
    await page.goto("about:blank");

    const t0 = Date.now();
    await page.goto("http://localhost:4173/", { waitUntil: "domcontentloaded" });
    const domReady = Date.now() - t0;
    // `window.__app` is a DEV-only hook, so on a production build the honest
    // interactive signal is the start surface actually being on screen.
    await page.locator(".welcome-backdrop").waitFor({ timeout: 120_000 });
    const painted = Date.now() - t0;
    await page.locator(".welcome-example-card").first().waitFor({ timeout: 120_000 });
    const usable = Date.now() - t0;
    console.log(`LOAD ${p.name.padEnd(26)} dom=${domReady}ms  welcome=${painted}ms  examples=${usable}ms  transferred=${Math.round(bytes / 1024)}KB`);
  });
}
