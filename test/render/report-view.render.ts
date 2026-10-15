import { expect, test, type Frame, type Page } from "@playwright/test";
import { drawReport, fixture, openHost, viewHtml, type ReportResult } from "./host-page.js";

// The report view drawn by Chromium through a test host that speaks the real AppBridge protocol.
// Each case checks the DOM first, then the pixels.

let html: string;

test.beforeAll(async () => {
  html = await viewHtml();
});

test.beforeEach(async ({ page }) => {
  await openHost(page);
});

const SUMMARY_INPUT = { reportType: "Opportunity", groupingsDown: [{ column: "STAGE_NAME" }, { column: "CLOSE_DATE" }], aggregates: ["s!AMOUNT", "RowCount"] };
const FILTERS = ["Close Date: THIS_YEAR", "Scope: organization", "Standard filter open: all", "Standard filter probability: >0"];
const SAVED_ID = "00O000000000001AAA";
const SAVED_URL = `https://example.my.salesforce.com/lightning/r/Report/${SAVED_ID}/view`;

function saved(result: ReportResult): ReportResult {
  return { ...result, report: { ...result.report, id: SAVED_ID, name: "Pipeline by stage", url: SAVED_URL } };
}

function section(frame: Frame, title: string) {
  return frame.locator("section").filter({ has: frame.getByRole("heading", { name: title, exact: true }) });
}

async function headers(frame: Frame, title: string) {
  return section(frame, title).locator("thead th").allTextContents();
}

async function expectSummaryDom(frame: Frame) {
  await expect(frame.locator("h1")).toHaveText("Unsaved report");
  await expect(frame.locator(".meta")).toHaveText("SUMMARY · Opportunity · not saved");
  await expect(frame.locator(".chips li")).toHaveText(FILTERS);
  expect(await headers(frame, "Groups")).toEqual(["Stage", "Close Date", "Sum of Amount", "Record Count"]);
  const groups = section(frame, "Groups");
  await expect(groups.locator("tbody tr:not(.total)")).toHaveCount(8);
  await expect(groups.locator("tr.total td")).toHaveText(["Total", "$3,091,000", "8"]);
  await expect(groups.locator("tr.total td").first()).toHaveAttribute("colspan", "2");
  await expect(frame.locator(".kpi .kpi-value")).toHaveText(["$3,091,000", "8", "38.5%"]);
  const detail = section(frame, "Detail rows");
  expect(await headers(frame, "Detail rows")).toEqual(["Stage", "Close Date", "Opportunity Name", "Amount"]);
  await expect(detail.locator("tbody tr")).toHaveCount(8);
  await expect(detail.locator(".cut")).toHaveCount(0);
  // A null amount draws as a muted dash, the same as every other blank.
  await expect(detail.locator("tbody tr").first().locator("td")).toHaveText(["Prospecting", "December 2026", "Opportunity 8", "-"]);
  await expect(detail.locator("tbody tr").first().locator("td.blank")).toHaveCount(1);
  await expect(frame.locator(".notes")).toHaveCount(0);
}

async function screenshot(page: Page, name: string) {
  await expect(page.locator("#frame-box iframe")).toHaveScreenshot(name);
}

test("summary, unsaved, light", async ({ page }) => {
  const frame = await drawReport(page, html, { result: fixture("expected-summary"), input: SUMMARY_INPUT });
  await expectSummaryDom(frame);
  await expect(frame.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(frame.getByRole("button", { name: "Save this report" })).toBeVisible();
  await screenshot(page, "summary-light.png");
});

test("summary, dark", async ({ page }) => {
  const frame = await drawReport(page, html, { result: fixture("expected-summary"), input: SUMMARY_INPUT, theme: "dark" });
  await expectSummaryDom(frame);
  await expect(frame.locator("html")).toHaveAttribute("data-theme", "dark");
  await screenshot(page, "summary-dark.png");
});

test("summary, 360 px wide", async ({ page }) => {
  const frame = await drawReport(page, html, { result: fixture("expected-summary"), input: SUMMARY_INPUT, width: 360 });
  await expectSummaryDom(frame);
  expect(await page.locator("#frame-box iframe").evaluate((el) => el.getBoundingClientRect().width)).toBe(360);
  // Wide tables scroll inside their own box; the card itself never scrolls sideways.
  expect(await frame.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await screenshot(page, "summary-narrow.png");
});

test("matrix", async ({ page }) => {
  const frame = await drawReport(page, html, { result: fixture("expected-matrix") });
  await expect(frame.locator("h1")).toHaveText("Unsaved report");
  await expect(frame.locator(".meta")).toHaveText("MATRIX · Opportunity · not saved");
  await expect(frame.locator(".chips li")).toHaveText(FILTERS);
  expect(await headers(frame, "Groups")).toEqual(["Stage", "Close Date", "Sum of Amount", "Record Count"]);
  const groups = section(frame, "Groups");
  await expect(groups.locator("tbody tr:not(.total)")).toHaveCount(6);
  await expect(groups.locator("tr.total td")).toHaveText(["Total", "$3,091,000", "8"]);
  // One column across, so the grid is one column wide, with its totals.
  const grid = section(frame, "Sum of Amount by Stage and Close Date");
  expect(await grid.locator("thead th").allTextContents()).toEqual(["Stage", "Q4 CY2026", "Total"]);
  await expect(grid.locator("tbody tr:not(.total)")).toHaveCount(6);
  await expect(grid.locator("tr.total td")).toHaveText(["Total", "$3,091,000", "$3,091,000"]);
  await expect(section(frame, "Detail rows")).toHaveCount(0);
  await expect(frame.locator(".notes")).toHaveCount(0);
  await screenshot(page, "matrix.png");
});

test("tabular with detail rows cut at the cap", async ({ page }) => {
  const frame = await drawReport(page, html, { result: fixture("expected-max-rows") });
  await expect(frame.locator("h1")).toHaveText("Unsaved report");
  await expect(frame.locator(".meta")).toHaveText("TABULAR · Opportunity · not saved");
  await expect(frame.locator(".chips li")).toHaveText(FILTERS);
  await expect(section(frame, "Groups")).toHaveCount(0);
  expect(await headers(frame, "Totals")).toEqual(["Record Count"]);
  await expect(section(frame, "Totals").locator("tbody td")).toHaveText(["8"]);
  expect(await headers(frame, "Detail rows")).toEqual(["Opportunity Name", "Account Name", "Amount", "Probability (%)", "Stage", "Close Date", "Closed"]);
  const detail = section(frame, "Detail rows");
  await expect(detail.locator("tbody tr")).toHaveCount(3);
  await expect(detail.locator("tbody tr").first().locator("td")).toHaveText(["Opportunity 1", "Account 1", "$900,000", "90%", "Negotiation/Review", "Dec 15, 2026", "No"]);
  await expect(detail.locator(".cut")).toHaveText("3 rows shown, cut at the cap");
  // Only a record count: the strip shows it once.
  await expect(frame.locator(".kpi .kpi-label")).toHaveText(["Record Count"]);
  await expect(frame.locator(".kpi .kpi-value")).toHaveText(["8"]);
  await expect(frame.locator(".notes li")).toHaveText(["Showing 3 of 8 detail rows. Raise maxRows (up to 2000) or add filters."]);
  await screenshot(page, "tabular-cut.png");
});

test("an unsaved result shows no Open in Salesforce", async ({ page }) => {
  const frame = await drawReport(page, html, { result: fixture("expected-tabular") });
  await expect(frame.locator("h1")).toHaveText("Unsaved report");
  await expect(frame.locator("h1 a")).toHaveCount(0);
  await expect(frame.getByRole("button", { name: "Open in Salesforce" })).toHaveCount(0);
});

test("Save this report asks Claude once to save it with create_report", async ({ page }) => {
  const frame = await drawReport(page, html, { result: fixture("expected-summary"), input: SUMMARY_INPUT });
  await frame.getByRole("button", { name: "Save this report" }).click();
  await expect.poll(() => page.evaluate(() => window.hostLog.messages.length)).toBe(1);
  const [message] = await page.evaluate(() => window.hostLog.messages);
  expect(message!.role).toBe("user");
  expect(message!.content.map((c) => c.text).join(" ")).toContain("create_report");
  await expect(frame.getByRole("button", { name: "Asked Claude to save it" })).toBeDisabled();
  expect(await page.evaluate(() => window.hostLog.openLinks)).toEqual([]);
});

test("a saved result opens in Salesforce through the host", async ({ page }) => {
  const frame = await drawReport(page, html, { result: saved(fixture("expected-summary")) });
  await expect(frame.locator("h1")).toHaveText("Pipeline by stage");
  await expect(frame.locator(".meta")).toHaveText("SUMMARY · Opportunity");
  await expect(frame.getByRole("button", { name: "Save this report" })).toHaveCount(0);
  await frame.getByRole("button", { name: "Open in Salesforce" }).click();
  await expect.poll(() => page.evaluate(() => window.hostLog.openLinks.length)).toBe(1);
  expect(await page.evaluate(() => window.hostLog.openLinks)).toEqual([{ url: SAVED_URL }]);
  expect(await page.evaluate(() => window.hostLog.messages)).toEqual([]);
});

// A matrix with three columns across, one missing cell and a zero, built in the shape shapeResult returns.
const MATRIX_GRID: ReportResult = {
  report: { id: null, name: "Unsaved report", format: "MATRIX", reportType: "Opportunity" },
  filters: ["Close Date: NEXT_N_QUARTERS:3"],
  notes: [],
  totals: { measures: ["s!AMOUNT", "RowCount"], values: [2896000, 14] },
  groups: {
    dimensions: [
      { name: "STAGE_NAME", label: "Stage", axis: "down" },
      { name: "CLOSE_DATE", label: "Close Date", axis: "across" },
    ],
    measures: [
      { name: "s!AMOUNT", label: "Sum of Amount", dataType: "currency" },
      { name: "RowCount", label: "Record Count", dataType: "int" },
    ],
    rows: [
      ["Prospecting", "Q4 CY2026", 120000, 1],
      ["Prospecting", "Q1 CY2027", 80000, 1],
      ["Needs Analysis", "Q3 CY2026", 60000, 1],
      ["Needs Analysis", "Q4 CY2026", 360000, 2],
      ["Needs Analysis", "Q1 CY2027", 0, 1],
      ["Proposal/Price Quote", "Q3 CY2026", 150000, 1],
      ["Proposal/Price Quote", "Q4 CY2026", 640000, 2],
      ["Proposal/Price Quote", "Q1 CY2027", 210000, 1],
      ["Negotiation/Review", "Q3 CY2026", 291000, 1],
      ["Negotiation/Review", "Q4 CY2026", 900000, 2],
      ["Negotiation/Review", "Q1 CY2027", 85000, 1],
    ],
  },
};

test("summary KPI strip and bars", async ({ page }) => {
  const frame = await drawReport(page, html, { result: fixture("expected-summary"), input: SUMMARY_INPUT });
  const strip = frame.getByRole("region", { name: "Key figures" });
  await expect(strip.locator(".kpi .kpi-label")).toHaveText(["Sum of Amount", "Record Count", "Largest Stage"]);
  await expect(strip.locator(".kpi .kpi-value")).toHaveText(["$3,091,000", "8", "38.5%"]);
  await expect(strip.locator(".kpi .kpi-sub")).toHaveText(["Negotiation/Review"]);

  // One bar per group row, on the first numeric measure, scaled to the largest row.
  const groups = section(frame, "Groups");
  const bars = groups.locator("tbody tr:not(.total) .bar i");
  await expect(bars).toHaveCount(8);
  const widths = await bars.evaluateAll((nodes) => nodes.map((n) => (n as HTMLElement).style.getPropertyValue("--bar")));
  expect(widths).toEqual(["0%", "40%", "46.667%", "53.333%", "71.111%", "6.333%", "26%", "100%"]);
  await expect(groups.locator("tr.total .bar")).toHaveCount(0);
  await expect(groups.locator("tbody tr:not(.total)").last().locator("td")).toHaveText(["Negotiation/Review", "December 2026", "$900,000", "1"]);

  // The bars grow in, unless the reader asked for less motion.
  expect(await bars.last().evaluate((n) => getComputedStyle(n).animationName)).toBe("grow");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await bars.last().evaluate((n) => getComputedStyle(n).animationName)).toBe("none");
  await page.emulateMedia({ reducedMotion: "no-preference" });

  await screenshot(page, "summary-kpi-bars.png");
});

test("matrix heat grid", async ({ page }) => {
  const frame = await drawReport(page, html, { result: MATRIX_GRID });
  await expect(frame.locator(".meta")).toHaveText("MATRIX · Opportunity · not saved");
  await expect(frame.locator(".kpi .kpi-value")).toHaveText(["$2,896,000", "14", "44.1%"]);
  await expect(frame.locator(".kpi .kpi-sub")).toHaveText(["Negotiation/Review"]);

  const grid = section(frame, "Sum of Amount by Stage and Close Date");
  expect(await grid.locator("thead th").allTextContents()).toEqual(["Stage", "Q3 CY2026", "Q4 CY2026", "Q1 CY2027", "Total"]);
  const rows = grid.locator("tbody tr:not(.total)");
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0).locator("th, td")).toHaveText(["Prospecting", "-", "$120,000", "$80,000", "$200,000"]);
  await expect(rows.nth(3).locator("th, td")).toHaveText(["Negotiation/Review", "$291,000", "$900,000", "$85,000", "$1,276,000"]);
  await expect(grid.locator("tr.total td")).toHaveText(["Total", "$501,000", "$2,020,000", "$375,000", "$2,896,000"]);

  // Cells are shaded by value against the largest cell; a blank cell is not shaded.
  const heat = await rows.nth(3).locator("td.heat").evaluateAll((nodes) => nodes.map((n) => (n as HTMLElement).style.getPropertyValue("--heat")));
  expect(heat).toEqual(["32.333%", "100%", "9.444%"]);
  await expect(rows.nth(0).locator("td.blank")).toHaveCount(1);
  await expect(rows.nth(0).locator("td.blank.heat")).toHaveCount(0);

  // The full group table stays below the grid, with every measure.
  await expect(section(frame, "Groups").locator("tbody tr:not(.total)")).toHaveCount(11);
  expect(await frame.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await screenshot(page, "matrix-heat.png");
});

test("matrix heat grid, dark", async ({ page }) => {
  const frame = await drawReport(page, html, { result: MATRIX_GRID, theme: "dark" });
  await expect(frame.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(section(frame, "Sum of Amount by Stage and Close Date").locator("td.heat")).toHaveCount(11);
  await screenshot(page, "matrix-heat-dark.png");
});
