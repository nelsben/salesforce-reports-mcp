import type { Cell, DetailColumn, Dimension, Measure, ReportResult } from "./shape.js";

export interface CombineInput {
  alias: string;
  result: ReportResult;
}

export class CombineError extends Error {}

export function combineResults(
  mode: "stack" | "join",
  inputs: CombineInput[],
  options: { joinOn?: string[] } = {},
): ReportResult {
  if (inputs.length < 2 || inputs.length > 5) throw new CombineError("combine_reports takes 2 to 5 inputs.");
  const aliases = inputs.map((i) => i.alias);
  if (new Set(aliases).size !== aliases.length) throw new CombineError("Each input needs its own alias.");

  const base = {
    report: {
      id: null,
      name: `combined: ${aliases.join(", ")}`,
      format: mode === "join" ? "SUMMARY" : "TABULAR",
      reportType: "combined",
    },
    filters: inputs.flatMap((i) => i.result.filters.map((f) => `${i.alias}: ${f}`)),
    notes: inputs.flatMap((i) => i.result.notes.map((n) => `${i.alias}: ${n}`)),
  };
  const body = mode === "join" ? join(inputs, options.joinOn) : stack(inputs);
  return { ...base, ...body };
}

function stack(inputs: CombineInput[]): Pick<ReportResult, "groups" | "detail"> {
  if (inputs.every((i) => i.result.groups)) {
    const dims = unionBy(inputs.flatMap((i) => i.result.groups!.dimensions), (d) => d.name);
    const measures = unionBy(inputs.flatMap((i) => i.result.groups!.measures), (m) => m.name);
    const rows: Cell[][] = [];
    for (const { alias, result } of inputs) {
      const g = result.groups!;
      const dimIdx = g.dimensions.map((d) => d.name);
      const measureIdx = g.measures.map((m) => m.name);
      for (const row of g.rows) {
        rows.push([
          alias,
          ...dims.map((d) => pick(row, dimIdx.indexOf(d.name))),
          ...measures.map((m) => pick(row, measureIdx.indexOf(m.name) < 0 ? -1 : dimIdx.length + measureIdx.indexOf(m.name))),
        ]);
      }
    }
    return { groups: { dimensions: [{ name: "source", label: "Source", axis: "down" }, ...dims], measures, rows } };
  }
  if (inputs.every((i) => i.result.detail)) {
    const columns = unionBy(inputs.flatMap((i) => i.result.detail!.columns), (c) => c.name);
    const rows: Cell[][] = [];
    for (const { alias, result } of inputs) {
      const d = result.detail!;
      const idx = d.columns.map((c) => c.name);
      for (const row of d.rows) rows.push([alias, ...columns.map((c) => pick(row, idx.indexOf(c.name)))]);
    }
    const all: DetailColumn[] = [{ name: "source", label: "Source", dataType: "string" }, ...columns];
    return { detail: { columns: all, rows, rowCount: rows.length, truncated: inputs.some((i) => i.result.detail!.truncated) } };
  }
  throw new CombineError(
    "To stack, every input must return grouped rows, or every input must return detail rows. Group all of them the same way, or run all of them with detail.",
  );
}

function join(inputs: CombineInput[], joinOn?: string[]): Pick<ReportResult, "groups"> {
  const plans = inputs.map(({ alias, result }) => {
    const g = result.groups;
    if (!g) throw new CombineError(`Input "${alias}" has no groupings. Join needs grouped reports; use stack for flat tables.`);
    const downs = g.dimensions.filter((d) => d.axis === "down");
    const keys = joinOn ?? (downs[0] ? [downs[0].name] : []);
    if (!keys.length) throw new CombineError(`Input "${alias}" has no down grouping to join on.`);
    const idx = keys.map((k) => g.dimensions.findIndex((d) => d.name === k));
    const missing = keys.filter((_, n) => idx[n] < 0);
    if (missing.length) {
      throw new CombineError(
        `Input "${alias}" is not grouped by ${missing.join(", ")}. It has: ${g.dimensions.map((d) => d.name).join(", ")}.`,
      );
    }
    if (g.dimensions.length > keys.length) {
      throw new CombineError(
        `Input "${alias}" is grouped by more than the join key (${g.dimensions.map((d) => d.name).join(", ")}). Set joinOn to all of its groupings, or remove the extra groupings.`,
      );
    }
    return { alias, g, idx };
  });

  const first = plans[0]!;
  const keyDims: Dimension[] = first.idx.map((i) => ({ ...first.g.dimensions[i]!, axis: "down" as const }));
  const measures: Measure[] = plans.flatMap((p) =>
    p.g.measures.map((m) => ({ name: `${p.alias}:${m.name}`, label: `${p.alias}: ${m.label}`, dataType: m.dataType })),
  );

  const table = new Map<string, { labels: Cell[]; values: Map<string, Cell[]> }>();
  for (const p of plans) {
    for (const row of p.g.rows) {
      const labels = p.idx.map((i) => row[i] ?? null);
      const key = labels.map((l) => String(l ?? "").trim().toLowerCase()).join("\u0000");
      let entry = table.get(key);
      if (!entry) {
        entry = { labels, values: new Map() };
        table.set(key, entry);
      }
      entry.values.set(p.alias, row.slice(p.g.dimensions.length));
    }
  }

  const rows: Cell[][] = [];
  for (const entry of table.values()) {
    const out: Cell[] = [...entry.labels];
    for (const p of plans) {
      const values = entry.values.get(p.alias);
      for (let m = 0; m < p.g.measures.length; m++) out.push(values?.[m] ?? null);
    }
    rows.push(out);
  }
  return { groups: { dimensions: keyDims, measures, rows } };
}

function pick(row: Cell[], index: number): Cell {
  return index < 0 ? null : (row[index] ?? null);
}

function unionBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(item);
    }
  }
  return out;
}
