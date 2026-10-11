import { describe, expect, it } from "vitest";
import { aggregateColumns, toReportMetadata } from "../src/reports/definition.js";

describe("toReportMetadata", () => {
  it("maps reportType, format, columns and defaults the aggregates", () => {
    const { metadata } = toReportMetadata({ reportType: "Opportunity", format: "TABULAR", columns: ["AMOUNT", "STAGE_NAME"] });
    expect(metadata).toEqual({
      reportType: { type: "Opportunity" },
      reportFormat: "TABULAR",
      detailColumns: ["AMOUNT", "STAGE_NAME"],
      aggregates: ["RowCount"],
    });
  });

  it("maps groupings with their defaults", () => {
    const { metadata } = toReportMetadata({
      reportType: "Opportunity",
      columns: ["AMOUNT"],
      groupingsDown: [{ column: "STAGE_NAME" }, { column: "CLOSE_DATE", sortOrder: "Desc", dateGranularity: "Month" }],
      groupingsAcross: [{ column: "OWNER" }],
    });
    expect(metadata.groupingsDown).toEqual([
      { name: "STAGE_NAME", sortOrder: "Asc", dateGranularity: "None" },
      { name: "CLOSE_DATE", sortOrder: "Desc", dateGranularity: "Month" },
    ]);
    expect(metadata.groupingsAcross).toEqual([{ name: "OWNER", sortOrder: "Asc", dateGranularity: "None" }]);
  });

  it("infers the format from the groupings, and lets an explicit format win", () => {
    expect(toReportMetadata({ reportType: "A" }).metadata.reportFormat).toBe("TABULAR");
    expect(toReportMetadata({ reportType: "A", groupingsDown: [{ column: "X" }] }).metadata.reportFormat).toBe("SUMMARY");
    expect(
      toReportMetadata({ reportType: "A", groupingsDown: [{ column: "X" }], groupingsAcross: [{ column: "Y" }] }).metadata.reportFormat,
    ).toBe("MATRIX");
    expect(toReportMetadata({ reportType: "A", format: "SUMMARY" }).metadata.reportFormat).toBe("SUMMARY");
  });

  it("maps every aggregate function to its prefix and passes raw strings through", () => {
    const { metadata } = toReportMetadata({
      reportType: "A",
      aggregates: [
        "RowCount",
        { fn: "sum", column: "AMOUNT" },
        { fn: "avg", column: "AMOUNT" },
        { fn: "min", column: "AMOUNT" },
        { fn: "max", column: "AMOUNT" },
        { fn: "unique", column: "ACCOUNT_NAME" },
        "s!PROBABILITY",
      ],
    });
    expect(metadata.aggregates).toEqual([
      "RowCount",
      "s!AMOUNT",
      "a!AMOUNT",
      "m!AMOUNT",
      "mx!AMOUNT",
      "u!ACCOUNT_NAME",
      "s!PROBABILITY",
    ]);
  });

  it("adds an aggregated column to the detail columns, because Salesforce requires it", () => {
    const { metadata, notes } = toReportMetadata({
      reportType: "A",
      groupingsDown: [{ column: "STAGE_NAME" }],
      aggregates: [{ fn: "sum", column: "AMOUNT" }],
    });
    expect(metadata.detailColumns).toEqual(["AMOUNT"]);
    expect(notes[0]).toMatch(/AMOUNT/);
  });

  it("leaves out a grouped column from the detail columns", () => {
    const { metadata, notes } = toReportMetadata({
      reportType: "A",
      columns: ["STAGE_NAME", "AMOUNT"],
      groupingsDown: [{ column: "STAGE_NAME" }],
    });
    expect(metadata.detailColumns).toEqual(["AMOUNT"]);
    expect(notes[0]).toMatch(/STAGE_NAME/);
  });

  it("maps filters (values become strings) and the filter logic", () => {
    const { metadata } = toReportMetadata({
      reportType: "A",
      filters: [
        { column: "AMOUNT", operator: "greaterThan", value: 1000 },
        { column: "STAGE_NAME", operator: "equals", value: "Closed Won" },
        { column: "CLOSED", operator: "equals", value: true },
      ],
      filterLogic: "1 AND (2 OR 3)",
    });
    expect(metadata.reportFilters).toEqual([
      { column: "AMOUNT", operator: "greaterThan", value: "1000" },
      { column: "STAGE_NAME", operator: "equals", value: "Closed Won" },
      { column: "CLOSED", operator: "equals", value: "true" },
    ]);
    expect(metadata.reportBooleanFilter).toBe("1 AND (2 OR 3)");
  });

  it("maps the date filter: duration, and CUSTOM when only dates are given", () => {
    expect(toReportMetadata({ dateFilter: { column: "CLOSE_DATE", duration: "LAST_N_DAYS:30" } }, { partial: true }).metadata.standardDateFilter).toEqual({
      column: "CLOSE_DATE",
      durationValue: "LAST_N_DAYS:30",
    });
    expect(
      toReportMetadata({ dateFilter: { column: "CLOSE_DATE", startDate: "2026-01-01", endDate: "2026-03-31" } }, { partial: true }).metadata.standardDateFilter,
    ).toEqual({ column: "CLOSE_DATE", durationValue: "CUSTOM", startDate: "2026-01-01", endDate: "2026-03-31" });
  });

  it("maps sortBy, topRows and scope", () => {
    const { metadata } = toReportMetadata(
      { sortBy: [{ column: "AMOUNT", order: "Desc" }], topRows: { rowLimit: 5, direction: "Desc" }, scope: "user" },
      { partial: true },
    );
    expect(metadata).toEqual({
      sortBy: [{ sortColumn: "AMOUNT", sortOrder: "Desc" }],
      topRows: { rowLimit: 5, direction: "Desc" },
      scope: "user",
    });
  });

  it("sends raw reportMetadata unchanged and lets it win", () => {
    const { metadata } = toReportMetadata({
      reportType: "A",
      scope: "user",
      reportMetadata: { scope: "organization", standardFilters: [{ name: "open", value: "all" }] },
    });
    expect(metadata.scope).toBe("organization");
    expect(metadata.standardFilters).toEqual([{ name: "open", value: "all" }]);
  });

  it("produces only the given fields when partial", () => {
    expect(toReportMetadata({ filters: [] }, { partial: true }).metadata).toEqual({ reportFilters: [] });
    expect(toReportMetadata({}, { partial: true }).metadata).toEqual({});
  });
});

describe("aggregateColumns", () => {
  it("reads the column out of each prefixed aggregate", () => {
    expect(aggregateColumns(["RowCount", "s!AMOUNT", { fn: "max", column: "AMOUNT" }, "u!X", "FORMULA1"])).toEqual(["AMOUNT", "X"]);
  });
});
