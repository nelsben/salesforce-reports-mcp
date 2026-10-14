/**
 * Make the README demo GIF (docs/assets/report-view.gif) from the render test host.
 * It records the real view drawing the anonymised summary fixture in Chromium, switches the host
 * to dark, narrows it to 360 px, then turns the video into a GIF with ffmpeg (palettegen, paletteuse).
 *
 *   npm run build && npm run demo:gif
 *
 * Needs ffmpeg on PATH, or its path in FFMPEG_PATH.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { bundleHost, drawReport, fixture, openHost, settle, viewFrame, viewHtml } from "../test/render/host-page.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const VIDEO_DIR = join(ROOT, "test", "render", ".video");
const OUT = join(ROOT, "docs", "assets", "report-view.gif");
const SIZE = { width: 800, height: 1080 };
const FPS = 12;
const GIF_WIDTH = 720;
const HOLD_MS = 2500;
const MAX_BYTES = 3 * 1024 * 1024;

function findFfmpeg(): string {
  const candidate = process.env.FFMPEG_PATH || "ffmpeg";
  const probe = spawnSync(candidate, ["-version"], { stdio: "ignore" });
  if (probe.error || probe.status !== 0) {
    console.error("ffmpeg was not found. Install it (for example brew install ffmpeg) or set FFMPEG_PATH to its path.");
    process.exit(1);
  }
  return candidate;
}

function run(cmd: string, args: string[]) {
  const result = spawnSync(cmd, args, { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${cmd} failed:\n${result.stderr.slice(-2000)}`);
}

async function main() {
  const ffmpeg = findFfmpeg();
  const html = await viewHtml();
  await bundleHost();
  rmSync(VIDEO_DIR, { recursive: true, force: true });
  mkdirSync(VIDEO_DIR, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: SIZE,
    deviceScaleFactor: 1,
    colorScheme: "light",
    locale: "en-US",
    timezoneId: "UTC",
    recordVideo: { dir: VIDEO_DIR, size: SIZE },
  });
  const recordingStarted = Date.now();
  const page = await context.newPage();
  await openHost(page);
  await page.evaluate(() => window.testHost.setPrompt("Show this year's pipeline by stage and close month"));
  // Start the GIF just before the card draws, so it skips the blank page load.
  const startAt = (Date.now() - recordingStarted) / 1000;
  await page.waitForTimeout(600);
  const frame = await drawReport(page, html, {
    result: fixture("expected-summary"),
    input: { reportType: "Opportunity", groupingsDown: [{ column: "STAGE_NAME" }, { column: "CLOSE_DATE" }], aggregates: ["s!AMOUNT", "RowCount"] },
  });
  await page.waitForTimeout(HOLD_MS);

  await page.evaluate(() => window.testHost.setTheme("dark"));
  await frame.locator("html[data-theme=dark]").waitFor();
  await page.waitForTimeout(HOLD_MS);

  await page.evaluate(() => window.testHost.setWidth(360));
  await settle(page, await viewFrame(page));
  const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  if (pageHeight > SIZE.height) console.warn(`The narrow card is ${pageHeight}px tall; raise SIZE.height so the GIF shows all of it.`);
  await page.waitForTimeout(HOLD_MS);

  const video = page.video();
  await context.close();
  await browser.close();
  const videoPath = await video!.path();

  const palette = join(VIDEO_DIR, "palette.png");
  const filters = `fps=${FPS},scale=${GIF_WIDTH}:-1:flags=lanczos`;
  run(ffmpeg, ["-y", "-ss", startAt.toFixed(2), "-i", videoPath, "-vf", `${filters},palettegen=stats_mode=diff`, palette]);
  run(ffmpeg, [
    "-y", "-ss", startAt.toFixed(2), "-i", videoPath, "-i", palette,
    "-lavfi", `${filters}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
    "-loop", "0", OUT,
  ]);

  const bytes = statSync(OUT).size;
  console.log(`wrote docs/assets/report-view.gif (${(bytes / 1024).toFixed(0)} KB)`);
  if (bytes > MAX_BYTES) {
    console.error("The GIF is over 3 MB. Shorten the holds or lower the frame rate.");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
