import { describe, expect, it } from "vitest";
import { CombineError, combineResults } from "../src/reports/combine.js";
import type { ReportResult } from "../src/reports/shape.js";

function grouped(rows: (string | number | null)[][], notes: string[] = []): ReportResult {
  return {
    report: { id: null, name: "r", format: "SUMMARY", reportType: "Opportunity" },
    filters: ["Close Date: THIS_YEAR"],
    groups: {
      dimensions: [{ name: "OWNER", label: "Owner", axis: "down" }],
      measures: [
        { name: "s!AMOUNT", label: "Sum of Amount", dataType: "currency" },
        { name: "RowCount", label: "Record Count", dataType: "int" },
      ],
      rows,
    },
    notes,
  };
}

describe("combineResults stack", () => {
  it("puts rows under each other with a leading source column", () => {
    const out = combineResults("stack", [
      { alias: "this_q", result: grouped([["Ann", 100, 2], ["Bob", 50, 1]]) },
      { alias: "last_q", result: grouped([["Ann", 80, 1]]) },
    ]);
    expect(out.report.name).toBe("combined: this_q, last_q");
    expect(out.groups!.dimensions.map((d) => d.name)).toEqual(["source", "OWNER"]);
    expect(out.groups!.rows).toEqual([
      ["this_q", "Ann", 100, 2],
      ["this_q", "Bob", 50, 1],
      ["last_q", "Ann", 80, 1],
    ]);
  });

  it("matches columns by name and fills a missing column with null", () => {
    const a = grouped([["Ann", 100, 2]]);
    const b = grouped([["Ann", 7]]);
    b.groups!.measures = [{ name: "RowCount", label: "Record Count", dataType: "int" }];
    const out = combineResults("stack", [
      { alias: "a", result: a },
      { alias: "b", result: b },
    ]);
    expect(out.groups!.measures.map((m) => m.name)).toEqual(["s!AMOUNT", "RowCount"]);
    expect(out.groups!.rows).toEqual([
      ["a", "Ann", 100, 2],
      ["b", "Ann", null, 7],
    ]);
  });

  it("stacks detail tables when no input is grouped", () => {
    const flat = (rows: (string | number | null)[][], columns: string[]): ReportResult => ({
      report: { id: null, name: "t", format: "TABULAR", reportType: "Opportunity" },
      filters: [],
      detail: { columns: columns.map((c) => ({ name: c, label: c, dataType: "string" })), rows, rowCount: rows.length, truncated: false },
      notes: [],
    });
    const out = combineResults("stack", [
      { alias: "x", result: flat([["a", 1]], ["NAME", "AMOUNT"]) },
      { alias: "y", result: flat([["b", "open"]], ["NAME", "STAGE"]) },
    ]);
    expect(out.detail!.columns.map((c) => c.name)).toEqual(["source", "NAME", "AMOUNT", "STAGE"]);
    expect(out.detail!.rows).toEqual([
      ["x", "a", 1, null],
      ["y", "b", null, "open"],
    ]);
  });

  it("keeps each input's notes and filters with the alias in front", () => {
    const out = combineResults("stack", [
      { alias: "a", result: grouped([], ["cut"]) },
      { alias: "b", result: grouped([]) },
    ]);
    expect(out.notes).toEqual(["a: cut"]);
    expect(out.filters).toEqual(["a: Close Date: THIS_YEAR", "b: Close Date: THIS_YEAR"]);
  });
});

describe("combineResults join", () => {
  it("full outer joins on the first grouping, with keys on one side only", () => {
    const pipeline = grouped([["Ann", 100, 2], ["Bob", 50, 1]]);
    const won = grouped([["ann", 30, 1], ["Cy", 10, 1]]);
    const out = combineResults("join", [
      { alias: "pipeline", result: pipeline },
      { alias: "won", result: won },
    ]);
    expect(out.groups!.dimensions.map((d) => d.name)).toEqual(["OWNER"]);
    expect(out.groups!.measures.map((m) => m.label)).toEqual([
      "pipeline: Sum of Amount",
      "pipeline: Record Count",
      "won: Sum of Amount",
      "won: Record Count",
    ]);
    expect(out.groups!.rows).toEqual([
      ["Ann", 100, 2, 30, 1], // keys match trimmed and case-insensitively
      ["Bob", 50, 1, null, null],
      ["Cy", null, null, 10, 1],
    ]);
  });

  it("honours joinOn", () => {
    const withTwo = (rows: (string | number | null)[][]): ReportResult => {
      const r = grouped(rows);
      r.groups!.dimensions = [
        { name: "OWNER", label: "Owner", axis: "down" },
        { name: "STAGE", label: "Stage", axis: "down" },
      ];
      return r;
    };
    const out = combineResults(
      "join",
      [
        { alias: "a", result: withTwo([["Ann", "Won", 1, 1]]) },
        { alias: "b", result: withTwo([["Ann", "Won", 2, 2]]) },
      ],
      { joinOn: ["OWNER", "STAGE"] },
    );
    expect(out.groups!.rows).toEqual([["Ann", "Won", 1, 1, 2, 2]]);
  });

  it("explains an input that is not grouped", () => {
    const flat: ReportResult = { report: { id: null, name: "t", format: "TABULAR", reportType: "x" }, filters: [], notes: [] };
    expect(() =>
      combineResults("join", [
        { alias: "a", result: grouped([]) },
        { alias: "b", result: flat },
      ]),
    ).toThrow(/no groupings/);
  });

  it("explains an input grouped more finely than the join key", () => {
    const fine = grouped([]);
    fine.groups!.dimensions.push({ name: "STAGE", label: "Stage", axis: "down" });
    expect(() =>
      combineResults("join", [
        { alias: "a", result: grouped([]) },
        { alias: "b", result: fine },
      ]),
    ).toThrow(/joinOn/);
  });
});

describe("combineResults input checks", () => {
  it("needs 2 to 5 inputs with distinct aliases", () => {
    expect(() => combineResults("stack", [{ alias: "a", result: grouped([]) }])).toThrow(CombineError);
    expect(() =>
      combineResults("stack", [
        { alias: "a", result: grouped([]) },
        { alias: "a", result: grouped([]) },
      ]),
    ).toThrow(/alias/);
  });
});
