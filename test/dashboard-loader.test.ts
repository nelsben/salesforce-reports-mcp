import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "skills/report-runner/dashboard-loader.js"), "utf8");
// Evaluate the file text the way the dashboard does: the function runs alone.
const load = new Function(`${source}\nreturn reportResultToRows;`)() as (input: { answer: unknown }) => {
  columns: string[];
  rows: Record<string, unknown>[];
  cut: boolean;
  meta: { label: string; value: string }[];
};
const fixture = (name: string) => JSON.parse(readFileSync(join(root, "test/fixtures", `expected-${name}.json`), "utf8"));

describe("dashboard loader source", () => {
  it("has one function with no import, require or export inside it", () => {
    const body = source.slice(source.indexOf("function reportResultToRows"), source.lastIndexOf("\n}") + 2);
    expect(body).not.toMatch(/\b(import|require|export)\b/);
    expect(source.trim().split("\n").pop()).toMatch(/module\.exports/);
  });
});

describe("dashboard loader", () => {
  it("summary: two dimensions, labels as headings, Total row", () => {
    const r = load({ answer: fixture("summary") });
    expect(r.columns).toEqual(["Stage", "Close Date", "Sum of Amount", "Record Count"]);
    expect(r.rows).toHaveLength(9);
    expect(r.rows[0]).toEqual({ Stage: "Prospecting", "Close Date": "December 2026", "Sum of Amount": 0, "Record Count": 1 });
    expect(r.rows[8]).toEqual({ Stage: "Total", "Close Date": "", "Sum of Amount": 3091000, "Record Count": 8 });
    expect(r.cut).toBe(false);
    expect(r.meta).toContainEqual({ label: "Filter", value: "Close Date: THIS_YEAR" });
    expect(r.meta.filter((m) => m.label === "Filter")).toHaveLength(4);
  });
  it("matrix", () => {
    const r = load({ answer: fixture("matrix") });
    expect(r.columns).toEqual(["Stage", "Close Date", "Sum of Amount", "Record Count"]);
    expect(r.rows).toHaveLength(7);
    expect(r.rows[6].Stage).toBe("Total");
    expect(r.rows[6]["Record Count"]).toBe(8);
  });
  it("summary by owner", () => {
    const r = load({ answer: fixture("summary-by-owner") });
    expect(r.columns).toEqual(["Opportunity Owner", "Sum of Amount", "Record Count"]);
    expect(r.rows).toHaveLength(3);
    expect(r.rows[2]).toEqual({ "Opportunity Owner": "Total", "Sum of Amount": 3091000, "Record Count": 8 });
  });
  it("tabular: detail rows by column name, no Total row, types kept", () => {
    const r = load({ answer: fixture("tabular") });
    expect(r.columns).toEqual(["OPPORTUNITY_NAME", "ACCOUNT_NAME", "AMOUNT", "PROBABILITY", "STAGE_NAME", "CLOSE_DATE", "CLOSED"]);
    expect(r.rows).toHaveLength(8);
    expect(r.rows[0].AMOUNT).toBe(900000);
    expect(r.rows[0].CLOSE_DATE).toBe("2026-12-15");
    expect(r.rows[0].CLOSED).toBe(false);
    expect(r.cut).toBe(false);
  });
  it("max rows: cut is true and the note reaches meta", () => {
    const r = load({ answer: fixture("max-rows") });
    expect(r.rows).toHaveLength(3);
    expect(r.cut).toBe(true);
    expect(r.meta).toContainEqual({ label: "Note", value: "Showing 3 of 8 detail rows. Raise maxRows (up to 2000) or add filters." });
  });
  it("meta carries report.url only when the answer has one", () => {
    const withUrl = { ...fixture("summary"), report: { ...fixture("summary").report, url: "https://example.my.salesforce.com/lightning/r/Report/00O1/view" } };
    expect(load({ answer: withUrl }).meta[0]).toEqual({ label: "Report", value: "https://example.my.salesforce.com/lightning/r/Report/00O1/view" });
    expect(load({ answer: fixture("summary") }).meta.some((m) => m.label === "Report")).toBe(false);
  });
  it("a note about cut rows sets cut without detail.truncated", () => {
    const a = { ...fixture("summary"), notes: ["Rows were cut at 200."] };
    expect(load({ answer: a }).cut).toBe(true);
  });
  it("accepts every wrapper form", () => {
    const o = fixture("summary-by-owner");
    const want = load({ answer: o });
    expect(load({ answer: JSON.stringify(o) })).toEqual(want);
    expect(load({ answer: { structuredContent: o } })).toEqual(want);
    expect(load({ answer: { content: [{ type: "text", text: JSON.stringify(o) }] } })).toEqual(want);
  });
  it("throws the server's own words on errors", () => {
    expect(() => load({ answer: { isError: true, content: [{ type: "text", text: "Report not found" }] } })).toThrow("Report not found");
    expect(() => load({ answer: { error: "Bad filter" } })).toThrow("Bad filter");
    expect(() => load({ answer: { error: { message: "Bad field", code: "X1", hint: "Use describe" } } })).toThrow(/Bad field.*Use describe/);
    expect(() => load({ answer: JSON.stringify({ error: "Nope" }) })).toThrow("Nope");
    expect(() => load({ answer: { hello: 1 } })).toThrow(/ReportResult/);
    expect(() => load({ answer: "not json" })).toThrow(Error);
    expect(() => load({ answer: undefined })).toThrow(Error);
  });
});
