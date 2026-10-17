import { expect, test, type Frame, type Page } from "@playwright/test";
import { dashboardFixture, drawReport, openHost, viewHtml, type DashboardResult } from "./host-page.js";

// The dashboard card drawn by Chromium through the same test host as the report view.
// The result is the probe dashboard's captured fixture, shaped by the built server's own code.

let html: string;

test.beforeAll(async () => {
  html = await viewHtml("dashboard");
});

test.beforeEach(async ({ page }) => {
  await openHost(page);
});

const HEADERS = ["Won to Date", "Won vs Target", "Pipeline Mix", "Pipeline by Stage", "Amount by Close Month", "Stage Table", "Stage Funnel", "Close Month Columns"];
const TYPES = ["Metric", "Gauge", "Donut", "Bar", "Line", "Table", "Funnel", "Column"];
const BASE = "https://example.my.salesforce.com";
// The SLDS data-visualization Default Palette, as Chromium reports a computed colour (decision 0018).
const DEFAULT_PALETTE = ["rgb(82, 183, 216)", "rgb(225, 96, 50)", "rgb(255, 176, 59)", "rgb(84, 167, 123)", "rgb(79, 210, 210)", "rgb(226, 135, 178)"];

function tile(frame: Frame, header: string) {
  return frame.locator("li.tile").filter({ has: frame.getByRole("heading", { name: header, exact: true }) });
}

async function draw(page: Page, options: { result?: DashboardResult; theme?: "light" | "dark"; width?: number } = {}) {
  const result = options.result ?? (await dashboardFixture("dashboard-results"));
  return drawReport(page, html, { result, theme: options.theme, width: options.width ?? 720 });
}

// How many tiles sit side by side in the first row of the grid.
async function columnsAcross(frame: Frame) {
  const tops = await frame.locator("li.tile").evaluateAll((nodes) => nodes.map((n) => Math.round(n.getBoundingClientRect().top)));
  return tops.filter((t) => t === tops[0]).length;
}

// The WCAG contrast of every piece of text in the tiles and the header, HTML and SVG, against the card's background.
async function textContrast(frame: Frame) {
  return frame.locator("main").evaluate((main) => {
    const parse = (color: string) => {
      const n = (color.match(/-?\d*\.?\d+(e-?\d+)?/g) ?? []).map(Number);
      const scale = color.startsWith("color(") ? 255 : 1;
      return [n[0]! * scale, n[1]! * scale, n[2]! * scale];
    };
    const luminance = (rgb: number[]) => {
      const f = (v: number) => {
        const c = v / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(rgb[0]!) + 0.7152 * f(rgb[1]!) + 0.0722 * f(rgb[2]!);
    };
    const backdrop = (node: Element) => {
      for (let n: Element | null = node; n; n = n.parentElement) {
        const bg = getComputedStyle(n).backgroundColor;
        if (bg && bg !== "transparent" && !/,\s*0\)$/.test(bg)) return bg;
      }
      return getComputedStyle(document.body).backgroundColor;
    };
    const out: { text: string; ratio: number }[] = [];
    for (const node of main.querySelectorAll("*")) {
      const own = [...node.childNodes].some((c) => c.nodeType === Node.TEXT_NODE && c.textContent!.trim());
      if (!own || node.closest("title, desc, button")) continue;
      const style = getComputedStyle(node);
      const ink = node instanceof SVGElement ? style.fill : style.color;
      const [hi, lo] = [luminance(parse(backdrop(node instanceof SVGElement ? node.closest("svg")! : node))), luminance(parse(ink))].sort((a, b) => b - a);
      out.push({ text: node.textContent!.trim(), ratio: (hi! + 0.05) / (lo! + 0.05) });
    }
    return out;
  });
}

async function expectReadable(frame: Frame) {
  const texts = await textContrast(frame);
  expect(texts.length).toBeGreaterThan(15);
  for (const t of texts) expect(t.ratio, `contrast of "${t.text}"`).toBeGreaterThanOrEqual(4.5);
}

async function expectNoSidewaysScroll(frame: Frame) {
  expect(await frame.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const boxes = await frame.locator("li.tile, .scroll, svg.chart").evaluateAll((nodes) =>
    nodes.map((n) => ({ what: n.tagName + "." + n.getAttribute("class"), scroll: n.scrollWidth, client: n.clientWidth, right: n.getBoundingClientRect().right })),
  );
  const edge = await frame.evaluate(() => document.documentElement.clientWidth);
  for (const box of boxes) {
    expect(box.scroll, `${box.what} scrolls sideways`).toBeLessThanOrEqual(box.client);
    expect(box.right, `${box.what} runs past the card`).toBeLessThanOrEqual(edge);
  }
}

async function expectEveryChart(frame: Frame) {
  await expect(frame.locator("h1")).toHaveText("Pipeline Overview");
  await expect(frame.locator(".refreshed")).toHaveText("Refreshed Oct 17, 2026, 2:13 AM");
  await expect(frame.locator(".chips li")).toHaveText(["Stage: all (no option chosen)"]);
  // Tiles in layout order, each with its type.
  await expect(frame.locator("li.tile h2")).toHaveText(HEADERS);
  expect(await frame.locator("li.tile").evaluateAll((nodes) => nodes.map((n) => (n as HTMLElement).dataset.type))).toEqual(TYPES);

  // Metric: one big number with the metric's own label.
  await expect(tile(frame, "Won to Date").locator(".metric-value")).toHaveText("$3,629,000");
  await expect(tile(frame, "Won to Date").locator(".metric-label")).toHaveText("Closed Won amount");

  // Gauge: three bands split at the breakpoints, a needle, the value and the range.
  const gauge = tile(frame, "Won vs Target").locator("svg.chart");
  await expect(gauge.locator("path.arc")).toHaveCount(3);
  await expect(gauge.locator("g.needle")).toHaveCount(1);
  await expect(gauge.locator("text")).toHaveText(["$2M", "$4M", "$0", "$5M", "$3,629,000"]);
  await expect(gauge.locator("desc")).toHaveText("Gauge of Sum of Amount: $3,629,000, on a range from $0 to $5,000,000, with breakpoints at $2,000,000 and $4,000,000.");

  // Donut: the five largest stages and Other, with a legend that names each.
  const donut = tile(frame, "Pipeline Mix");
  await expect(donut.locator("circle.slice")).toHaveCount(6);
  await expect(donut.locator(".legend .name")).toHaveText(["Closed Won", "Needs Analysis", "Negotiation/Review", "Proposal/Price Quote", "Id. Decision Makers", "Other (5)"]);
  await expect(donut.locator(".legend .share")).toHaveText(["39%", "16%", "14%", "10%", "8%", "12%"]);
  await expect(donut.locator("text.big")).toHaveText("$9.3M");

  // Bar and Funnel: one mark per stage, scaled to the largest.
  const bars = tile(frame, "Pipeline by Stage").locator("rect.bar");
  await expect(bars).toHaveCount(10);
  const widths = await bars.evaluateAll((nodes) => nodes.map((n) => Number(n.getAttribute("width"))));
  expect(widths[8]).toBe(Math.max(...widths));
  expect(widths[0]! / widths[8]!).toBeCloseTo(96000 / 3629000, 2);
  await expect(tile(frame, "Stage Funnel").locator("rect.band")).toHaveCount(10);

  // Line and Column: every month; the line labels its peak and its last point.
  await expect(tile(frame, "Amount by Close Month").locator("path.line")).toHaveCount(1);
  await expect(tile(frame, "Amount by Close Month").locator("circle.dot")).toHaveCount(2);
  await expect(tile(frame, "Close Month Columns").locator("rect.col")).toHaveCount(20);

  // Table: a compact table of the groups.
  const table = tile(frame, "Stage Table");
  expect(await table.locator("thead th").allTextContents()).toEqual(["Stage", "Sum of Amount"]);
  await expect(table.locator("tbody tr")).toHaveCount(10);
  await expect(table.locator("tbody tr").first().locator("td")).toHaveText(["Closed Won", "$3,629,000"]);

  // Every chart is an image with a title and a desc that says its values in words.
  const charts = frame.locator("svg.chart");
  await expect(charts).toHaveCount(6);
  for (const svg of await charts.all()) {
    await expect(svg).toHaveAttribute("role", "img");
    await expect(svg.locator(":scope > title")).not.toBeEmpty();
    await expect(svg.locator(":scope > desc")).not.toBeEmpty();
  }
  expect(await frame.locator("svg.chart > title").allTextContents()).toEqual(["Won vs Target", "Pipeline Mix", "Pipeline by Stage", "Amount by Close Month", "Stage Funnel", "Close Month Columns"]);
  await expect(tile(frame, "Pipeline by Stage").locator("desc")).toHaveText(/^Bar chart of Sum of Amount by Stage\. Prospecting: \$96,000\. .* Closed Lost: \$268,000\.$/);
}

test("dashboard card, light", async ({ page }) => {
  const frame = await draw(page);
  await expectEveryChart(frame);
  await expect(frame.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await columnsAcross(frame)).toBe(3);
  await expectNoSidewaysScroll(frame);
  await expectReadable(frame);
  await expect(frame.locator(".notes")).toHaveCount(0);

  // The charts draw with the SLDS data-visualization Default Palette in order ("unity" is not a palette the card
  // knows); the gauge keeps the dashboard's own band colours.
  await expect(frame.locator("html")).not.toHaveAttribute("data-palette", /./);
  const strokes = await frame.locator("circle.slice").evaluateAll((nodes) => nodes.map((n) => getComputedStyle(n).stroke));
  expect(strokes.slice(0, 5)).toEqual(DEFAULT_PALETTE.slice(0, 5));
  expect(await tile(frame, "Pipeline by Stage").locator("rect.bar").first().evaluate((n) => getComputedStyle(n).fill)).toBe(DEFAULT_PALETTE[0]);
  const bands = await frame.locator("rect.band").evaluateAll((nodes) => nodes.map((n) => getComputedStyle(n).fill));
  expect(bands.slice(0, 6)).toEqual(DEFAULT_PALETTE);
  const fixture = await dashboardFixture("dashboard-results");
  const gaugeColors = (fixture.components as { gauge?: { colors?: string[] } }[])[1]!.gauge!.colors!;
  const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
  expect(await frame.locator("path.arc").evaluateAll((nodes) => nodes.map((n) => getComputedStyle(n).stroke))).toEqual(gaugeColors.map(rgb));

  // Every chart grows in, unless the reader asked for less motion.
  const marks = ["g.needle", "g.ring", "rect.bar", "path.line", "rect.band", "rect.col", ".metric-value"];
  const names = (motion: string) => Promise.all(marks.map((m) => frame.locator(m).first().evaluate((n) => getComputedStyle(n).animationName).then((a) => `${motion} ${a}`)));
  expect(await names("full")).not.toContain("full none");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(new Set(await names("reduced"))).toEqual(new Set(["reduced none"]));
  await page.emulateMedia({ reducedMotion: "no-preference" });

  await expect(page.locator("#frame-box iframe")).toHaveScreenshot("dashboard-light.png");
});

test("dashboard card, dark", async ({ page }) => {
  const frame = await draw(page, { theme: "dark" });
  await expect(frame.locator("html")).toHaveAttribute("data-theme", "dark");
  await expectEveryChart(frame);
  await expectReadable(frame);
  await expect(page.locator("#frame-box iframe")).toHaveScreenshot("dashboard-dark.png");
});

test("dashboard card, 360 px wide", async ({ page }) => {
  const frame = await draw(page, { width: 360 });
  await expectEveryChart(frame);
  expect(await columnsAcross(frame)).toBe(1);
  await expectNoSidewaysScroll(frame);
  await expect(page.locator("#frame-box iframe")).toHaveScreenshot("dashboard-narrow.png");
});

test("dashboard card at tablet width shows two columns", async ({ page }) => {
  const frame = await draw(page, { width: 600 });
  expect(await columnsAcross(frame)).toBe(2);
  await expectNoSidewaysScroll(frame);
  // A redraw at a new width keeps the layout order and does not grow in again.
  await page.evaluate(() => window.testHost.setWidth(720));
  await expect.poll(() => columnsAcross(frame)).toBe(3);
  await expect(frame.locator("li.tile h2")).toHaveText(HEADERS);
  // Polled: the grid reflows before the resize redraw swaps the chart, and a swapped-out node reads "".
  await expect.poll(() => frame.locator("rect.col").first().evaluate((n) => getComputedStyle(n).animationName)).toBe("none");
});

test("dashboard card with no data", async ({ page }) => {
  const frame = await draw(page, { result: await dashboardFixture("dashboard-results-no-data") });
  await expect(frame.locator(".refreshed")).toHaveText("Not refreshed for these filters");
  await expect(frame.locator("li.tile h2")).toHaveText(HEADERS);
  await expect(frame.locator("li.tile.nodata")).toHaveCount(8);
  await expect(frame.locator("li.tile .nodata-text")).toHaveText(Array(8).fill("No data yet for these filters. Refresh the dashboard to fill it."));
  await expect(frame.locator("svg.chart")).toHaveCount(0);
  await expect(frame.locator(".notes li")).toHaveText([/^No component has data: .*refresh_dashboard/]);
  await expectReadable(frame);
  await expect(page.locator("#frame-box iframe")).toHaveScreenshot("dashboard-no-data.png");
});

test("dashboard card opens a tile's source report and the dashboard through the host", async ({ page }) => {
  const frame = await draw(page);
  await tile(frame, "Pipeline by Stage").getByRole("link", { name: "Pipeline by Stage" }).click();
  await tile(frame, "Won to Date").getByRole("link").click();
  await frame.getByRole("button", { name: "Open in Salesforce" }).click();
  await expect.poll(() => page.evaluate(() => window.hostLog.openLinks.length)).toBe(3);
  expect(await page.evaluate(() => window.hostLog.openLinks)).toEqual([
    { url: `${BASE}/lightning/r/Report/00O000000000004AAA/view` },
    { url: `${BASE}/lightning/r/Report/00O000000000002AAA/view` },
    { url: `${BASE}/lightning/r/Dashboard/01Z000000000017AAA/view` },
  ]);
  expect(await page.evaluate(() => window.hostLog.messages)).toEqual([]);
});

test("dashboard card shows a footer, a failed tile, a table for a type it does not draw, and a named palette", async ({ page }) => {
  const result = await dashboardFixture("dashboard-results");
  const [metric, gauge, donut] = result.components as Record<string, unknown>[];
  donut!.visualizationType = "Scatter";
  // A palette the card knows, on the dashboard and on one component; "unity" on another is unknown, so it inherits.
  (result as Record<string, unknown>).colorPalette = "Watermelon";
  const components = result.components as Record<string, unknown>[];
  components[6]!.colorPalette = "water";
  components[3]!.colorPalette = "unity";
  metric!.footer = "Booked revenue only";
  Object.assign(gauge!, { status: "error", result: undefined, error: { code: "ERROR", message: "The source report was deleted." } });
  const frame = await draw(page, { result });
  await expect(tile(frame, "Won to Date").locator(".foot")).toHaveText("Booked revenue only");
  await expect(tile(frame, "Won vs Target").locator(".error-text")).toHaveText("Salesforce could not run this component: The source report was deleted.");
  const fallback = tile(frame, "Pipeline Mix");
  await expect(fallback.locator("svg")).toHaveCount(0);
  expect(await fallback.locator("thead th").allTextContents()).toEqual(["Stage", "Sum of Amount"]);
  await expect(fallback.locator("tbody tr")).toHaveCount(10);
  await expect(frame.locator("html")).toHaveAttribute("data-palette", "watermelon");
  // Watermelon 1 on the bar chart (its own "unity" is unknown, so the dashboard's palette holds), Water in order on the funnel.
  expect(await tile(frame, "Pipeline by Stage").locator("rect.bar").first().evaluate((n) => getComputedStyle(n).fill)).toBe("rgb(245, 152, 167)");
  const bands = await tile(frame, "Stage Funnel").locator("rect.band").evaluateAll((nodes) => nodes.map((n) => getComputedStyle(n).fill));
  expect(bands.slice(0, 3)).toEqual(["rgb(150, 242, 238)", "rgb(104, 206, 238)", "rgb(45, 156, 237)"]);
  await expectReadable(frame);
});
