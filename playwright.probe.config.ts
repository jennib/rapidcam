import { defineConfig, devices } from "@playwright/test";

/**
 * Config for the performance probes in scripts/.
 *
 * They are deliberately OUT of the main e2e suite: each drives thousands of
 * entities through real mouse input and takes minutes, which is not something
 * to pay on every run. But `playwright.config.ts` pins `testDir: "./e2e"`, so
 * without this they cannot be run at all — which is how scripts/*.e2e.ts came
 * to sit there importing a `./appFixture` that does not exist.
 *
 * Run:  npx playwright test --config=playwright.probe.config.ts --reporter=list
 */
export default defineConfig({
  testDir: "./scripts",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  workers: 1,
  globalTimeout: 30 * 60_000,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:5173", trace: "off" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Two servers, because the probes measure two different things: the
  // interaction probes drive the dev server, while load-probe times
  // time-to-interactive on the PRODUCTION bundle and so needs `vite preview`
  // on 4173. Both reuse an already-running instance, so the build tax is paid
  // once rather than on every run.
  webServer: [
    {
      command: "node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173 --strictPort",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: "npm run build && npx vite preview --host 127.0.0.1 --port 4173 --strictPort",
      url: "http://127.0.0.1:4173",
      reuseExistingServer: true,
      timeout: 180_000,
    },
  ],
});
