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
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
