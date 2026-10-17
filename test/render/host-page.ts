/**
 * The Node side of the test host, shared by the render spec and scripts/demo-gif.ts.
 * It bundles host.ts for the browser, serves the host page through page.route (no web server),
 * loads the real view from the built server, and draws an anonymised fixture ReportResult.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import type { Frame, Page } from "@playwright/test";

const RENDER_DIR = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(RENDER_DIR, "..", "..");
const BUILD_DIR = join(RENDER_DIR, ".build");
const ORIGIN = "http://test-host.localhost";

export type Theme = "light" | "dark";
export type ReportResult = { report: Record<string, unknown> } & Record<string, unknown>;

/** Bundle the browser half of the host into test/render/.build/host.js (ignored by git). */
export async function bundleHost(): Promise<void> {
  await build({
    entryPoints: [join(RENDER_DIR, "host.ts")],
    outfile: join(BUILD_DIR, "host.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    logLevel: "warning",
  });
}

/** A view exactly as the server serves it: dist/widget/view.js after npm run build. */
export async function viewHtml(which: "report" | "dashboard" = "report"): Promise<string> {
  const path = join(ROOT, "dist", "widget", "view.js");
  let mod: { reportViewHtml: () => string; dashboardViewHtml: () => string };
  try {
    mod = await import(pathToFileURL(path).href);
  } catch {
    throw new Error("The built view is missing. Run npm run build first.");
  }
  const html = which === "dashboard" ? mod.dashboardViewHtml() : mod.reportViewHtml();
  if (!html.includes("ontoolresult")) throw new Error(`The built ${which} view did not load: ` + html.slice(0, 300));
  return html;
}

export type DashboardResult = { dashboard: Record<string, unknown>; components: Record<string, unknown>[] } & Record<string, unknown>;

/**
 * A DashboardResult as run_dashboard returns it, built by the built server's own code from a captured fixture
 * (test/fixtures/dashboard-results*.json), with a fixed clock so the notes do not change with the date.
 */
export async function dashboardFixture(name: string, filterWords = ["Stage: all (no option chosen)"]): Promise<DashboardResult> {
  const dist = (file: string) => pathToFileURL(join(ROOT, "dist", file)).href;
  const { shapeDashboard } = await import(dist("reports/dashboards.js"));
  const { dashboardView } = await import(dist("server.js"));
  const raw = JSON.parse(readFileSync(join(ROOT, "test", "fixtures", `${name}.json`), "utf8"));
  const base = "https://example.my.salesforce.com";
  const shaped = shapeDashboard(raw, { baseUrl: base, maxRows: 20, filterWords, now: new Date("2026-10-17T03:00:00Z") });
  return dashboardView(raw, shaped, base) as DashboardResult;
}

/** An anonymised fixture from test/fixtures, for example expected-summary. */
export function fixture(name: string): ReportResult {
  return JSON.parse(readFileSync(join(ROOT, "test", "fixtures", `${name}.json`), "utf8")) as ReportResult;
}

/** The tool result as run_report and query_report return it: the same object as text and as structuredContent. */
export function toolResult(result: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
}

/** Serve the host page and its bundle from disk, then open it. */
export async function openHost(page: Page): Promise<void> {
  const files: Record<string, { path: string; type: string }> = {
    "/host.html": { path: join(RENDER_DIR, "host.html"), type: "text/html" },
    "/host.js": { path: join(BUILD_DIR, "host.js"), type: "text/javascript" },
  };
  await page.route(`${ORIGIN}/**`, async (route) => {
    const file = files[new URL(route.request().url()).pathname];
    if (!file) return route.fulfill({ status: 404, body: "not found" });
    return route.fulfill({ status: 200, contentType: file.type, body: readFileSync(file.path) });
  });
  await page.goto(`${ORIGIN}/host.html`);
}

export interface DrawOptions {
  result: Record<string, unknown>;
  theme?: Theme;
  width?: number;
  input?: Record<string, unknown>;
}

/** Mount the view with a host context, send the tool input and result, and wait for the card to settle. */
export async function drawReport(page: Page, html: string, options: DrawOptions): Promise<Frame> {
  const { result, theme = "light", width = 720, input = {} } = options;
  await page.evaluate(
    async ({ html, theme, width, input, result }) => {
      await window.testHost.mount({ html, theme, width });
      await window.testHost.draw(input, result);
    },
    { html, theme, width, input, result: toolResult(result) },
  );
  const frame = await viewFrame(page);
  await frame.locator("h1").waitFor();
  await settle(page, frame);
  return frame;
}

export async function viewFrame(page: Page): Promise<Frame> {
  const handle = await page.locator("#frame-box iframe").elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error("The view iframe has no frame.");
  return frame;
}

/** Wait until the iframe is as tall as the view's content, so a screenshot shows the whole card. */
export async function settle(page: Page, frame: Frame): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const content = await frame.evaluate(() => document.documentElement.getBoundingClientRect().height);
    const box = await page.locator("#frame-box iframe").evaluate((el) => (el as HTMLIFrameElement).clientHeight);
    if (Math.abs(box - Math.ceil(content)) <= 2) return;
    await page.waitForTimeout(50);
  }
}
