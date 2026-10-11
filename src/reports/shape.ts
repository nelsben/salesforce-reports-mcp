import { columnLabel, describeFilters, humanize, infoMaps, reportUrl } from "./summarize.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export type Cell = string | number | boolean | null;

export interface Dimension {
  name: string;
  label: string;
  axis: "down" | "across";
}
export interface Measure {
  name: string;
  label: string;
  dataType: string;
}
export interface DetailColumn {
  name: string;
  label: string;
  dataType: string;
}

export interface ReportResult {
  report: { id: string | null; name: string; format: string; reportType: string; url?: string };
  filters: string[];
  groups?: { dimensions: Dimension[]; measures: Measure[]; rows: Cell[][] };
  totals?: { measures: string[]; values: Cell[] };
  detail?: { columns: DetailColumn[]; rows: Cell[][]; rowCount: number; truncated: boolean };
  notes: string[];
}

export interface ShapeOptions {
  /** Detail rows kept in the result. Hard ceiling 2,000. */
  maxRows: number;
  /** Whether to return detail rows at all. */
  includeDetail: boolean;
  /** Instance URL, used to build the report link. */
  baseUrl?: string;
  /** Notes already known to the caller, for example that the run went async. */
  notes?: string[];
}

export const HARD_ROW_CEILING = 2000;

export function shapeResult(raw: Json, options: ShapeOptions): ReportResult {
  const meta: Json = raw.reportMetadata ?? {};
  const maps = infoMaps(raw.reportExtendedMetadata);
  const factMap: Json = raw.factMap ?? {};
  const maxRows = Math.min(Math.max(options.maxRows, 0), HARD_ROW_CEILING);
  const notes = [...(options.notes ?? [])];
  const id = meta.id ?? raw.attributes?.reportId ?? null;
  const format: string = meta.reportFormat;

  const downNames = ((meta.groupingsDown ?? []) as Json[]).map((g) => g.name as string);
  const acrossNames = ((meta.groupingsAcross ?? []) as Json[]).map((g) => g.name as string);
  const dimensions: Dimension[] = [
    ...downNames.map((name) => ({ name, label: columnLabel(name, maps), axis: "down" as const })),
    ...acrossNames.map((name) => ({ name, label: columnLabel(name, maps), axis: "across" as const })),
  ];

  const downLeaves = leaves(raw.groupingsDown?.groupings ?? []);
  const acrossLeaves = leaves(raw.groupingsAcross?.groupings ?? []);
  const grouped = dimensions.length > 0;

  const measureNames: string[] = meta.aggregates ?? [];
  const measures: Measure[] = measureNames.map((name) => ({
    name,
    label: maps.aggregate[name]?.label ?? humanize(name),
    dataType: maps.aggregate[name]?.dataType ?? "double",
  }));

  const result: ReportResult = {
    report: {
      id,
      name: meta.name ?? raw.attributes?.reportName ?? "Unsaved report",
      format,
      reportType: meta.reportType?.type,
      url: reportUrl(options.baseUrl, id),
    },
    filters: describeFilters(meta, maps),
    notes,
  };

  const grandTotal: Json | undefined = factMap["T!T"];
  if (grandTotal?.aggregates) {
    result.totals = {
      measures: measureNames,
      values: (grandTotal.aggregates as Json[]).map((a, i) => cell(a.value, a.label, measures[i]?.dataType)),
    };
  }

  // Walk the leaf combinations once. They carry both the group rows and the detail rows.
  const detailInfo = (name: string) => maps.detail[name] ?? maps.grouping[name];
  const detailColumnNames: string[] = meta.detailColumns ?? [];
  const detailRows: Cell[][] = [];
  const groupRows: Cell[][] = [];
  const combos: { key: string; labels: Cell[] }[] = [];
  if (!grouped) {
    combos.push({ key: "T!T", labels: [] });
  } else {
    const downs = downNames.length ? downLeaves : [{ key: "T", labels: [] as Cell[] }];
    const acrosses = acrossNames.length ? acrossLeaves : [{ key: "T", labels: [] as Cell[] }];
    for (const d of downs) {
      for (const a of acrosses) {
        combos.push({ key: `${d.key}!${a.key}`, labels: [...d.labels, ...a.labels] });
      }
    }
  }
  for (const combo of combos) {
    const fact: Json | undefined = factMap[combo.key];
    if (!fact) continue;
    if (grouped) {
      groupRows.push([
        ...combo.labels,
        ...((fact.aggregates ?? []) as Json[]).map((a, i) => cell(a.value, a.label, measures[i]?.dataType)),
      ]);
    }
    for (const row of (fact.rows ?? []) as Json[]) {
      detailRows.push([
        ...combo.labels,
        ...((row.dataCells ?? []) as Json[]).map((c, i) => cell(c.value, c.label, detailInfo(detailColumnNames[i] ?? "")?.dataType)),
      ]);
    }
  }

  if (grouped) {
    result.groups = { dimensions, measures, rows: groupRows };
  }

  if (options.includeDetail && (!grouped || detailRows.length > 0 || format === "TABULAR")) {
    const columns: DetailColumn[] = [
      ...dimensions.map((d) => ({
        name: d.name,
        label: d.label,
        dataType: maps.grouping[d.name]?.dataType ?? "string",
      })),
      ...detailColumnNames.map((name) => ({
        name,
        label: columnLabel(name, maps),
        dataType: maps.detail[name]?.dataType ?? "string",
      })),
    ];
    const total = detailRows.length;
    const cut = total > maxRows;
    result.detail = {
      columns,
      rows: cut ? detailRows.slice(0, maxRows) : detailRows,
      rowCount: total,
      truncated: cut || raw.allData === false,
    };
    if (cut) {
      notes.push(`Showing ${maxRows} of ${total} detail rows. Raise maxRows (up to ${HARD_ROW_CEILING}) or add filters.`);
    }
  }

  if (raw.allData === false) {
    notes.push(`Salesforce stopped at 2,000 rows (allData is false), so the results are incomplete. Narrow the filters.`);
  }
  return result;
}

interface Leaf {
  key: string;
  labels: Cell[];
}

function leaves(nodes: Json[], trail: Cell[] = []): Leaf[] {
  const out: Leaf[] = [];
  for (const node of nodes) {
    const labels = [...trail, groupLabel(node)];
    const children = (node.groupings ?? []) as Json[];
    if (children.length) out.push(...leaves(children, labels));
    else out.push({ key: node.key as string, labels });
  }
  return out;
}

function groupLabel(node: Json): Cell {
  return node.label === "-" || node.label === undefined ? null : String(node.label);
}

/**
 * One cell to one value. Numbers, currency and percent give a number; booleans a boolean;
 * dates their ISO string; everything else its display label. An empty cell gives null.
 */
export function cell(value: unknown, label: unknown, dataType: string | undefined): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") {
    const amount = (value as { amount?: unknown }).amount;
    return typeof amount === "number" ? amount : amount === null ? null : String(label ?? "");
  }
  switch (dataType) {
    case "int":
    case "double":
    case "currency":
    case "percent":
      return typeof value === "number" ? value : Number.isFinite(Number(value)) ? Number(value) : String(label ?? value);
    case "boolean":
      return typeof value === "boolean" ? value : value === "true" ? true : value === "false" ? false : String(label ?? value);
    case "date":
    case "datetime":
    case "time":
      return String(value);
    default:
      // Lookup columns carry a record id in `value` and the readable name in `label`.
      if (label === "-" || label === undefined || label === null) return typeof value === "string" ? value : null;
      return String(label);
  }
}
