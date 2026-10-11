/** Turns Salesforce describe responses into compact summaries that are cheap for Claude to read. */

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface ColumnInfoMaps {
  detail: Json;
  grouping: Json;
  aggregate: Json;
}

export function infoMaps(extended: Json | undefined): ColumnInfoMaps {
  return {
    detail: extended?.detailColumnInfo ?? {},
    grouping: extended?.groupingColumnInfo ?? {},
    aggregate: extended?.aggregateColumnInfo ?? {},
  };
}

const OPERATOR_WORDS: Record<string, string> = {
  equals: "equals",
  notEqual: "not equal to",
  lessThan: "less than",
  greaterThan: "greater than",
  lessOrEqual: "less or equal to",
  greaterOrEqual: "greater or equal to",
  contains: "contains",
  notContain: "does not contain",
  startsWith: "starts with",
  includes: "includes",
  excludes: "excludes",
  within: "within",
};

export function humanize(name: string): string {
  return name
    .replace(/^[a-z]+!/, "")
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

export function columnLabel(name: string, maps: ColumnInfoMaps): string {
  return maps.detail[name]?.label ?? maps.grouping[name]?.label ?? maps.aggregate[name]?.label ?? humanize(name);
}

/** Plain-language filter lines, including the date filter, scope and Salesforce's built-in standard filters. */
export function describeFilters(meta: Json, maps: ColumnInfoMaps): string[] {
  const lines: string[] = [];
  const dateFilter = meta.standardDateFilter;
  if (dateFilter?.column) {
    const label = columnLabel(dateFilter.column, maps);
    const range =
      dateFilter.durationValue && dateFilter.durationValue !== "CUSTOM"
        ? dateFilter.durationValue
        : `${dateFilter.startDate ?? "..."} to ${dateFilter.endDate ?? "..."}`;
    lines.push(`${label}: ${range}`);
  }
  const filters: Json[] = meta.reportFilters ?? [];
  filters.forEach((f, i) => {
    const op = OPERATOR_WORDS[f.operator] ?? f.operator;
    lines.push(`${filters.length > 1 ? `${i + 1}. ` : ""}${columnLabel(f.column, maps)} ${op} ${f.value ?? ""}`.trim());
  });
  if (meta.reportBooleanFilter && filters.length > 1) lines.push(`Filter logic: ${meta.reportBooleanFilter}`);
  if (meta.scope) lines.push(`Scope: ${meta.scope}`);
  for (const sf of (meta.standardFilters ?? []) as Json[]) {
    lines.push(`Standard filter ${sf.name}: ${sf.value}`);
  }
  return lines;
}

export interface FolderInfo {
  id: string;
  name: string | null;
  /** What `sf project retrieve` calls the folder. Public Reports is `unfiled$public`. Null for Private Reports. */
  developerName: string | null;
  /** True for Private Reports: the folder id is the owner's user id. Such a report cannot be retrieved or deployed. */
  isPrivate: boolean;
}

export function reportUrl(baseUrl: string | undefined, id: string | undefined | null): string | undefined {
  return baseUrl && id ? `${baseUrl}/lightning/r/Report/${id}/view` : undefined;
}

export interface ReportSummary {
  id: string | null;
  name: string | null;
  /** The developer name Metadata API and `sf project retrieve` use, for example MyReport_abc. */
  developerName?: string | null;
  description?: string | null;
  folderId?: string | null;
  format: string;
  reportType: string;
  url?: string;
  columns: { name: string; label: string; dataType?: string }[];
  groupingsDown: { name: string; label: string; sortOrder?: string; dateGranularity?: string }[];
  groupingsAcross: { name: string; label: string; sortOrder?: string; dateGranularity?: string }[];
  aggregates: { name: string; label: string }[];
  filters: string[];
  reportMetadata?: Json;
}

export function summarizeReport(
  describe: Json,
  options: { baseUrl?: string; includeMetadata?: boolean } = {},
): ReportSummary {
  const meta: Json = describe.reportMetadata ?? {};
  const maps = infoMaps(describe.reportExtendedMetadata);
  const grouping = (g: Json) => ({
    name: g.name as string,
    label: columnLabel(g.name, maps),
    sortOrder: g.sortOrder as string | undefined,
    dateGranularity: g.dateGranularity as string | undefined,
  });
  const summary: ReportSummary = {
    id: meta.id ?? describe.attributes?.reportId ?? null,
    name: meta.name ?? null,
    developerName: meta.developerName ?? null,
    description: meta.description ?? null,
    folderId: meta.folderId ?? null,
    format: meta.reportFormat,
    reportType: meta.reportType?.type,
    url: reportUrl(options.baseUrl, meta.id ?? describe.attributes?.reportId),
    columns: ((meta.detailColumns ?? []) as string[]).map((name) => ({
      name,
      label: columnLabel(name, maps),
      dataType: maps.detail[name]?.dataType,
    })),
    groupingsDown: ((meta.groupingsDown ?? []) as Json[]).map(grouping),
    groupingsAcross: ((meta.groupingsAcross ?? []) as Json[]).map(grouping),
    aggregates: ((meta.aggregates ?? []) as string[]).map((name) => ({ name, label: maps.aggregate[name]?.label ?? humanize(name) })),
    filters: describeFilters(meta, maps),
  };
  if (options.includeMetadata) summary.reportMetadata = meta;
  return summary;
}

export function summarizeReportTypes(
  categories: Json[],
  options: { search?: string; limit?: number },
): { total: number; shown: number; types: { type: string; label: string; category: string; description: string | null }[] } {
  const needle = options.search?.toLowerCase().trim();
  const all = categories.flatMap((cat) =>
    ((cat.reportTypes ?? []) as Json[]).map((t) => ({
      type: t.type as string,
      label: t.label as string,
      category: cat.label as string,
      description: (t.description as string | null) ?? null,
    })),
  );
  const matches = needle
    ? all.filter((t) => [t.type, t.label, t.category].some((s) => s.toLowerCase().includes(needle)))
    : all;
  const limit = options.limit ?? 50;
  return { total: matches.length, shown: Math.min(matches.length, limit), types: matches.slice(0, limit) };
}

export interface ReportTypeSummary {
  type: string;
  label?: string;
  fieldCount: number;
  fieldsShown: number;
  sections: { section: string; fields: { name: string; label: string; dataType: string }[] }[];
  dateFilterColumns: { name: string; label: string }[];
  dateFilterDurations: string[];
  dateGranularities: string[];
  filterOperators: Record<string, string[]>;
  scopes: string[];
}

export function summarizeReportType(
  describe: Json,
  type: string,
  options: { search?: string; limit?: number } = {},
): ReportTypeSummary {
  const tm: Json = describe.reportTypeMetadata ?? {};
  const needle = options.search?.toLowerCase().trim();
  const limit = options.limit ?? 150;
  const sections: ReportTypeSummary["sections"] = [];
  let fieldCount = 0;
  let shown = 0;
  const dateColumns: { name: string; label: string }[] = [];
  for (const cat of (tm.categories ?? []) as Json[]) {
    const fields: { name: string; label: string; dataType: string }[] = [];
    for (const [name, col] of Object.entries((cat.columns ?? {}) as Json)) {
      fieldCount++;
      if (col.dataType === "date" || col.dataType === "datetime") dateColumns.push({ name, label: col.label });
      const match = !needle || [name, col.label, cat.label].some((s: string) => String(s).toLowerCase().includes(needle));
      if (match && shown < limit) {
        fields.push({ name, label: col.label, dataType: col.dataType });
        shown++;
      }
    }
    if (fields.length) sections.push({ section: cat.label, fields });
  }
  const durations = ((tm.standardDateFilterDurationGroups ?? []) as Json[])
    .flatMap((g) => (g.standardDateFilterDurations ?? []) as Json[])
    .map((d) => d.value as string);
  const operators: Record<string, string[]> = {};
  for (const [dataType, ops] of Object.entries((tm.dataTypeFilterOperatorMap ?? {}) as Json)) {
    operators[dataType] = (ops as Json[]).map((o) => o.name as string);
  }
  return {
    type,
    label: describe.reportMetadata?.reportType?.label,
    fieldCount,
    fieldsShown: shown,
    sections,
    dateFilterColumns: dateColumns,
    dateFilterDurations: durations,
    dateGranularities: ((tm.dateGranularityInfos ?? []) as Json[]).map((g) => g.value as string),
    filterOperators: operators,
    scopes: ((tm.scopeInfo?.values ?? []) as Json[]).map((s) => s.value as string),
  };
}
