import { describe, expect, it } from "vitest";
import { cell, shapeResult } from "../src/reports/shape.js";
import { standardFilterNotes } from "../src/reports/summarize.js";
import { fixture } from "./helpers.js";

const BASE = "https://example.my.salesforce.com";

describe("shapeResult", () => {
  it("shapes a tabular report", () => {
    const result = shapeResult(fixture("tabular"), { maxRows: 200, includeDetail: true, baseUrl: BASE });
    expect(result).toEqual(fixture("expected-tabular"));
    expect(result.groups).toBeUndefined();
  });

  it("shapes a summary report with two grouping levels and detail rows", () => {
    const result = shapeResult(fixture("summary"), { maxRows: 200, includeDetail: true });
    expect(result).toEqual(fixture("expected-summary"));
    // Each detail row starts with its group labels.
    expect(result.detail!.rows[0]!.slice(0, 2)).toEqual(["Prospecting", "December 2026"]);
    expect(result.groups!.rows).toHaveLength(8);
  });

  it("shapes a matrix report as a tidy long table", () => {
    const result = shapeResult(fixture("matrix"), { maxRows: 200, includeDetail: false });
    expect(result).toEqual(fixture("expected-matrix"));
    expect(result.groups!.dimensions.map((d) => d.axis)).toEqual(["down", "across"]);
    expect(result.detail).toBeUndefined();
  });

  it("keeps a single grouping level and labels measures from the report", () => {
    const result = shapeResult(fixture("summary-by-owner"), { maxRows: 200, includeDetail: false });
    expect(result).toEqual(fixture("expected-summary-by-owner"));
  });

  it("says so when Salesforce stopped at 2,000 rows (allData: false)", () => {
    const result = shapeResult(fixture("tabular-all-data-false"), { maxRows: 200, includeDetail: true });
    expect(result).toEqual(fixture("expected-allData-false"));
    expect(result.detail!.truncated).toBe(true);
    expect(result.notes.join(" ")).toMatch(/2,000 rows/);
  });

  it("cuts detail rows at maxRows and says so", () => {
    const result = shapeResult(fixture("tabular"), { maxRows: 3, includeDetail: true });
    expect(result).toEqual(fixture("expected-max-rows"));
    expect(result.detail!.rows).toHaveLength(3);
    expect(result.detail!.rowCount).toBe(8);
    expect(result.notes[0]).toMatch(/Raise maxRows/);
  });

  it("never returns more than 2,000 detail rows", () => {
    const raw = fixture("tabular");
    const row = raw.factMap["T!T"].rows[0];
    raw.factMap["T!T"].rows = Array.from({ length: 2500 }, () => row);
    const result = shapeResult(raw, { maxRows: 99999, includeDetail: true });
    expect(result.detail!.rows).toHaveLength(2000);
    expect(result.detail!.rowCount).toBe(2500);
  });

  it("builds the report link from the instance URL and id", () => {
    const raw = fixture("tabular");
    raw.reportMetadata.id = "00O000000000001AAA";
    raw.reportMetadata.name = "Pipeline";
    const result = shapeResult(raw, { maxRows: 5, includeDetail: false, baseUrl: BASE });
    expect(result.report).toMatchObject({ id: "00O000000000001AAA", name: "Pipeline", url: `${BASE}/lightning/r/Report/00O000000000001AAA/view` });
  });

  it("carries the caller's notes first", () => {
    const result = shapeResult(fixture("tabular"), { maxRows: 5, includeDetail: false, notes: ["ran async"] });
    expect(result.notes[0]).toBe("ran async");
  });
});

describe("cell", () => {
  it("gives numbers for number, currency and percent cells", () => {
    expect(cell(5, "5", "int")).toBe(5);
    expect(cell({ amount: 12.5, currency: "USD" }, "$12.50", "currency")).toBe(12.5);
    expect(cell(90, "90%", "percent")).toBe(90);
  });
  it("gives booleans and ISO dates", () => {
    expect(cell(false, "false", "boolean")).toBe(false);
    expect(cell("2026-12-15", "12/15/2026", "date")).toBe("2026-12-15");
    expect(cell("2026-12-15T10:00:00Z", "12/15/2026", "datetime")).toBe("2026-12-15T10:00:00Z");
  });
  it("gives the display label for everything else, including lookups", () => {
    expect(cell("006000000000001AAA", "Opportunity 1", "string")).toBe("Opportunity 1");
    expect(cell("Prospecting", "Prospecting", "picklist")).toBe("Prospecting");
  });
  it("gives null for an empty cell", () => {
    expect(cell(null, "-", "currency")).toBeNull();
    expect(cell(undefined, "-", "string")).toBeNull();
  });
});

/** The same cases and words as notesWhatHappenedToStandardFilters in ReportsDefinitionTest.cls. */
describe("standardFilterNotes", () => {
  const applied = [
    { name: "open", value: "all" },
    { name: "probability", value: ">0" },
  ];
  const ignored =
    "Salesforce ignored reportMetadata.standardFilters: an empty list does not clear a report's standard filters, so these still apply: open: all, probability: >0. To change one, list it by name with another of its values.";

  it("says an empty or null list was ignored, and which filters still apply", () => {
    expect(standardFilterNotes([], applied)).toEqual([ignored]);
    expect(standardFilterNotes(null, applied)).toEqual([ignored]);
    expect(standardFilterNotes([], [])).toEqual([]);
  });

  it("says nothing when no standardFilters were sent", () => {
    expect(standardFilterNotes(undefined, applied)).toEqual([]);
  });

  it("names the standard filters a partial list left at their saved values", () => {
    expect(standardFilterNotes([{ name: "open", value: "all" }], applied)).toEqual([
      "Standard filters left out of reportMetadata.standardFilters keep their saved values: probability: >0.",
    ]);
  });

  it("says when Salesforce ran with another value than the one sent", () => {
    expect(standardFilterNotes([{ name: "open", value: "closed" }, { name: "probability", value: ">0" }], applied)).toEqual([
      "Salesforce ran with open: all, not the open: closed that was sent.",
    ]);
    expect(standardFilterNotes(applied, applied)).toEqual([]);
  });
});
