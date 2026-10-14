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
  await expect(groups.locator("tr.total td")).toHaveText(["Total", "3,091,000", "8"]);
  await expect(groups.locator("tr.total td").first()).toHaveAttribute("colspan", "2");
  const detail = section(frame, "Detail rows");
  expect(await headers(frame, "Detail rows")).toEqual(["Stage", "Close Date", "Opportunity Name", "Amount"]);
  await expect(detail.locator("tbody tr")).toHaveCount(8);
  await expect(detail.locator(".cut")).toHaveCount(0);
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
  await expect(groups.locator("tr.total td")).toHaveText(["Total", "3,091,000", "8"]);
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
  await expect(detail.locator(".cut")).toHaveText("3 rows shown, cut at the cap");
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
