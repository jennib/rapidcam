import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E config. Specs live in e2e/ and are named *.e2e.ts so vitest's
 * default {test,spec} glob never picks them up. Playwright starts the Vite dev
 * server itself (reusing an already-running one locally).
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // Cap the whole run so a hung dev server / stuck spec fails CI in minutes
  // instead of blocking the pipeline until the outer job timeout.
  globalTimeout: 10 * 60_000,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "list" : "html",
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Kill whatever holds :5173 before AND after the run — see e2e/freePort.ts.
  // Playwright's own teardown does not reliably stop the server it started on
  // Windows, and it fails *intermittently*, so the leak accumulates unnoticed.
  globalSetup: "./e2e/freePort.ts",
  globalTeardown: "./e2e/freePort.ts",
  webServer: {
    // Vite invoked directly rather than through `npm run dev`, which buries the
    // server four processes deep (cmd → npm → cmd → vite). Fewer wrappers is
    // not the fix — freePort.ts is — but there is no reason to make the tree
    // deeper than it needs to be.
    command: "node node_modules/vite/bin/vite.js --port 5173 --strictPort",
    url: "http://localhost:5173",
    // --strictPort matters as much as the command: without it Vite silently
    // moves to 5174 when 5173 is taken, so a leaked server from a previous run
    // leaves the suite testing a DIFFERENT server than the one it just
    // started — which fails in ways that look exactly like flaky tests.
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
