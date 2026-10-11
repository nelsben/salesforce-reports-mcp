import { z } from "zod";

/** Checked against a live org: the API silently turns any other value into `None`. */
export const DATE_GRANULARITIES = [
  "None",
  "Day",
  "Week",
  "Month",
  "Quarter",
  "Year",
  "FiscalPeriod",
  "FiscalQuarter",
  "FiscalWeek",
  "FiscalYear",
  "MonthInYear",
  "DayInMonth",
] as const;

const grouping = z.object({
  column: z.string().describe("Column API name, for example STAGE_NAME or CLOSE_DATE. Names come from describe_report_type."),
  sortOrder: z.enum(["Asc", "Desc"]).optional().describe("Sort direction. Default Asc."),
  dateGranularity: z
    .enum(DATE_GRANULARITIES)
    .optional()
    .describe("For date columns: the bucket to group by, for example Month or FiscalQuarter. Default None."),
});

const aggregateFn = z.enum(["sum", "avg", "min", "max", "unique"]);

const aggregate = z.union([
  z.object({
    fn: aggregateFn.describe("sum, avg, min, max or unique (unique count)."),
    column: z.string().describe("Column API name, for example AMOUNT."),
  }),
  z
    .string()
    .describe('"RowCount" for the record count, or a raw aggregate such as "s!AMOUNT" or a custom summary formula name.'),
]);

const filter = z.object({
  column: z.string().describe("Column API name, for example STAGE_NAME."),
  operator: z
    .string()
    .describe(
      "For example equals, notEqual, lessThan, greaterThan, lessOrEqual, greaterOrEqual, contains, notContain, startsWith, includes, excludes. The valid set per data type comes from describe_report_type.",
    ),
  value: z
    .union([z.string(), z.number(), z.boolean()])
    .describe("The value to compare with. Separate several values with a comma. Relative dates such as THIS_QUARTER are allowed."),
});

const dateFilter = z.object({
  column: z.string().describe("Date column API name, for example CLOSE_DATE or CREATED_DATE."),
  duration: z
    .string()
    .optional()
    .describe("Relative range such as THIS_FISCAL_QUARTER, LAST_N_DAYS:30, THIS_YEAR or CUSTOM. Omit when you give startDate and endDate."),
  startDate: z.string().optional().describe("ISO date, YYYY-MM-DD. Sends CUSTOM when there is no duration."),
  endDate: z.string().optional().describe("ISO date, YYYY-MM-DD."),
});

export const definitionShape = {
  reportType: z
    .string()
    .optional()
    .describe("Report type API name, for example Opportunity or AccountList. Find it with list_report_types. Required to create a report or to run one with query_report."),
  format: z
    .enum(["TABULAR", "SUMMARY", "MATRIX"])
    .optional()
    .describe("TABULAR is a flat list, SUMMARY groups rows down, MATRIX groups down and across. When omitted it follows from the groupings. Joined reports are not supported."),
  columns: z
    .array(z.string())
    .optional()
    .describe("Detail columns, by API name from describe_report_type, for example OPPORTUNITY_NAME and AMOUNT. A column that is also a grouping is left out."),
  groupingsDown: z.array(grouping).max(3).optional().describe("Up to 3 row groupings. Makes the report SUMMARY or MATRIX."),
  groupingsAcross: z.array(grouping).max(2).optional().describe("Up to 2 column groupings. MATRIX only."),
  aggregates: z
    .array(aggregate)
    .optional()
    .describe('Measures to compute per group. Default ["RowCount"]. Example: ["RowCount", {"fn":"sum","column":"AMOUNT"}].'),
  filters: z.array(filter).optional().describe("Row filters. Sending filters replaces the saved list when updating a report."),
  filterLogic: z
    .string()
    .optional()
    .describe("How the numbered filters combine, for example \"1 AND (2 OR 3)\". Filters are numbered from 1 in the order given."),
  dateFilter: dateFilter.optional().describe("The standard date filter (the date range at the top of a report)."),
  sortBy: z
    .array(z.object({ column: z.string(), order: z.enum(["Asc", "Desc"]) }))
    .optional()
    .describe("Sort for a tabular report."),
  topRows: z
    .object({ rowLimit: z.number().int().positive(), direction: z.enum(["Asc", "Desc"]) })
    .optional()
    .describe("Keep only the top or bottom N rows by the sort column."),
  scope: z
    .string()
    .optional()
    .describe("Whose records: for example organization, user (my records) or team. Valid values depend on the report type."),
  reportMetadata: z
    .record(z.unknown())
    .optional()
    .describe("Advanced: raw Salesforce reportMetadata fields, merged last and sent unchanged. Use for settings this shape does not cover, such as standardFilters."),
};

export const ReportDefinitionSchema = z.object(definitionShape);
export type ReportDefinition = z.infer<typeof ReportDefinitionSchema>;

const PREFIX: Record<z.infer<typeof aggregateFn>, string> = {
  sum: "s!",
  avg: "a!",
  min: "m!",
  max: "mx!",
  unique: "u!",
};

export interface MappedMetadata {
  metadata: Record<string, unknown>;
  notes: string[];
}

/**
 * Map the friendly definition to `reportMetadata`.
 * With `partial`, only the fields that were given are produced (for PATCH and run overrides).
 */
export function toReportMetadata(def: ReportDefinition, options: { partial?: boolean } = {}): MappedMetadata {
  const partial = options.partial ?? false;
  const meta: Record<string, unknown> = {};
  const notes: string[] = [];

  if (def.reportType) meta.reportType = { type: def.reportType };

  const format = def.format ?? (partial ? undefined : inferFormat(def));
  if (format) meta.reportFormat = format;

  if (def.groupingsDown) meta.groupingsDown = def.groupingsDown.map(mapGrouping);
  if (def.groupingsAcross) meta.groupingsAcross = def.groupingsAcross.map(mapGrouping);

  // Salesforce requires every aggregated column to be a detail column too.
  const aggregated = aggregateColumns(def.aggregates);
  const columns = def.columns ?? (aggregated.length && !partial ? [] : undefined);
  if (columns) {
    const grouped = new Set([...(def.groupingsDown ?? []), ...(def.groupingsAcross ?? [])].map((g) => g.column));
    const kept = columns.filter((c) => !grouped.has(c));
    if (kept.length < columns.length) {
      notes.push(
        `Left out ${columns.filter((c) => grouped.has(c)).join(", ")} from the detail columns because it is a grouping; Salesforce rejects a grouped column there.`,
      );
    }
    const added = aggregated.filter((c) => !kept.includes(c) && !grouped.has(c));
    if (added.length) notes.push(`Added ${added.join(", ")} to the detail columns because an aggregate uses it; Salesforce requires that.`);
    meta.detailColumns = [...kept, ...added];
  }

  if (def.aggregates) meta.aggregates = def.aggregates.map(mapAggregate);
  else if (!partial) meta.aggregates = ["RowCount"];

  if (def.filters) {
    meta.reportFilters = def.filters.map((f) => ({ column: f.column, operator: f.operator, value: String(f.value) }));
  }
  if (def.filterLogic !== undefined) meta.reportBooleanFilter = def.filterLogic;

  if (def.dateFilter) {
    const { column, duration, startDate, endDate } = def.dateFilter;
    const filterOut: Record<string, unknown> = { column };
    const durationValue = duration ?? (startDate || endDate ? "CUSTOM" : undefined);
    if (durationValue) filterOut.durationValue = durationValue;
    if (startDate) filterOut.startDate = startDate;
    if (endDate) filterOut.endDate = endDate;
    meta.standardDateFilter = filterOut;
  }

  if (def.sortBy) meta.sortBy = def.sortBy.map((s) => ({ sortColumn: s.column, sortOrder: s.order }));
  if (def.topRows) meta.topRows = def.topRows;
  if (def.scope) meta.scope = def.scope;

  return { metadata: { ...meta, ...(def.reportMetadata ?? {}) }, notes };
}

/** Source columns of the aggregates, for example `s!AMOUNT` gives AMOUNT. `RowCount` and formulas give none. */
export function aggregateColumns(aggregates: ReportDefinition["aggregates"]): string[] {
  const out: string[] = [];
  for (const a of aggregates ?? []) {
    const name = typeof a === "string" ? a : `${PREFIX[a.fn]}${a.column}`;
    const match = /^(?:s|a|m|mx|u)!(.+)$/.exec(name);
    if (match && !out.includes(match[1]!)) out.push(match[1]!);
  }
  return out;
}

function inferFormat(def: ReportDefinition): "TABULAR" | "SUMMARY" | "MATRIX" {
  if (def.groupingsAcross?.length) return "MATRIX";
  if (def.groupingsDown?.length) return "SUMMARY";
  return "TABULAR";
}

function mapGrouping(g: { column: string; sortOrder?: "Asc" | "Desc"; dateGranularity?: string }) {
  return { name: g.column, sortOrder: g.sortOrder ?? "Asc", dateGranularity: g.dateGranularity ?? "None" };
}

function mapAggregate(a: string | { fn: z.infer<typeof aggregateFn>; column: string }): string {
  return typeof a === "string" ? a : `${PREFIX[a.fn]}${a.column}`;
}
