import { defineConfig, devices } from "@playwright/test";

// Render tests for the report view: the real view in a test host page, drawn by Chromium.
// Baselines are kept per platform, since fonts differ between macOS and Linux.
export default defineConfig({
  testDir: "test/render",
  testMatch: "**/*.render.ts",
  outputDir: "test-results",
  snapshotPathTemplate: "{testDir}/__screenshots__/{platform}/{arg}{ext}",
  globalSetup: "./test/render/global-setup.ts",
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
