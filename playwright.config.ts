import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

// Render tests for the report view: the real view in a test host page, drawn by Chromium.
// Baselines are kept per platform, since fonts differ between macOS and Linux.
// Paths are absolute, so test/render/playwright.config.ts can re-export this file (playwright test -c test/render).
const root = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  testDir: root("test/render"),
  testMatch: "**/*.render.ts",
  outputDir: root("test-results"),
  snapshotPathTemplate: "{testDir}/__screenshots__/{platform}/{arg}{ext}",
  globalSetup: root("test/render/global-setup.ts"),
  forbidOnly: !!process.env.CI,
  reporter: "list",
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: "disabled", caret: "hide" },
  },
  use: {
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 800, height: 900 },
        deviceScaleFactor: 1,
        colorScheme: "light",
        locale: "en-US",
        timezoneId: "UTC",
      },
    },
  ],
});
