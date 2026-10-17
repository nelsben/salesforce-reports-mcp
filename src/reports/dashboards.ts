import { InputError } from "../format.js";
import { SalesforceError } from "../salesforce/client.js";
import { soqlLike, type ReportsApi } from "./api.js";
import { shapeResult, type ReportResult } from "./shape.js";
import { humanize, reportUrl } from "./summarize.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Seconds between status polls after a refresh, and how many polls: 20 polls 3 seconds apart is 60 seconds. */
export const REFRESH_POLL_MS = 3000;
export const REFRESH_POLLS = 20;
/** Default cap on detail rows per component. */
export const COMPONENT_ROWS = 20;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DashboardFilterChoice {
  /** The filter's name, as describe_dashboard lists it. */
  name: string;
  /** An option label, value, alias or option id. */
  option: string;
}

export interface ResolvedFilters {
  /** "?filter1=<optionId>…" for the REST calls, or "" for the unfiltered dashboard. */
  query: string;
  /** Every dashboard filter with its value in words. */
  words: string[];
  /** Only the filters that were set, in words. */
  applied: string[];
}

export interface DashboardComponentResult {
  id: string;
  header: string | null;
  title: string | null;
  footer: string | null;
  visualizationType: string | null;
  /** "data": the result is here. "no data": never refreshed for these filters. "error": Salesforce could not run it. */
  status: "data" | "no data" | "error";
  refreshedAt: string | null;
  error?: { code: string; message: string };
  result?: ReportResult;
}

export interface DashboardResult {
  dashboard: { id: string; name: string; developerName: string | null; folder: { id: string | null; name: string | null }; url?: string };
  runningUser: string;
  filters: string[];
  /** The oldest refresh among the components that have data, or null when none has. */
  refreshedAt: string | null;
  components: DashboardComponentResult[];
  notes: string[];
}

export interface DashboardComponentSummary {
  id: string;
  header: string | null;
  title: string | null;
  footer: string | null;
  visualizationType: string | null;
  report: { id: string | null; name: string | null; url?: string };
  groupings: string[];
  measures: { name: string; label: string }[];
  /** Grid position: row and column of the top left cell, and the span. */
  position: { row: number; column: number; rows: number; columns: number } | null;
}

export interface DashboardSummary {
  id: string;
  name: string;
  developerName: string | null;
  description: string | null;
  folder: { id: string | null; name: string | null };
  type: string | null;
  runningUser: string;
  owner: string | null;
  url?: string;
  filters: { name: string; dataType: string | null; options: string[] }[];
  layout: string;
  components: DashboardComponentSummary[];
}

export function dashboardUrl(baseUrl: string | undefined, id: string | null | undefined): string | undefined {
  return baseUrl && id ? `${baseUrl}/lightning/r/Dashboard/${id}/view` : undefined;
}

/**
 * SOQL on Dashboard. GET /analytics/dashboards lists only recently viewed dashboards, so listing goes through SOQL,
 * which returns the dashboards the signed-in user can see. One row past the limit tells whether the list was cut.
 */
export function dashboardListSoql(input: { query?: string; folder?: string; limit: number }): string {
  const where: string[] = [];
  if (input.query) where.push(`(Title LIKE '%${soqlLike(input.query)}%' OR DeveloperName LIKE '%${soqlLike(input.query)}%')`);
  if (input.folder) where.push(`FolderName LIKE '%${soqlLike(input.folder)}%'`);
  return `SELECT Id, Title, DeveloperName, FolderName, FolderId, Description, Type, LastModifiedDate FROM Dashboard${
    where.length ? ` WHERE ${where.join(" AND ")}` : ""
  } ORDER BY LastModifiedDate DESC LIMIT ${input.limit + 1}`;
}

/** The newest refresh date in a status answer, or null when no component was ever refreshed. */
export function latestRefresh(status: Json | undefined): string | null {
  const dates = ((status?.componentStatus ?? []) as Json[]).map((c) => c.refreshDate as string | null).filter((d): d is string => Boolean(d));
  if (!dates.length) return null;
  return dates.reduce((a, b) => (time(b) > time(a) ? b : a));
}

export function optionLabel(option: Json): string {
  if (option.alias) return String(option.alias);
  if (option.value !== null && option.value !== undefined && option.value !== "") return String(option.value);
  const start = option.startValue;
  const end = option.endValue;
  if (start && end) return `${start} to ${end}`;
  if (start) return `${start} or more`;
  if (end) return `up to ${end}`;
  return String(option.id);
}

/**
 * Filter choices by name and option label, mapped to the option ids the data calls take. Salesforce reads the
 * option id from `filter<n>` on the query string, n being the filter's place in describe's `filters` (only
 * filter1 was proven, on a one-filter dashboard). The option text itself is refused with 400, so it is never sent.
 */
export function resolveFilters(meta: Json, choices: DashboardFilterChoice[] | undefined): ResolvedFilters {
  const filters = (meta.filters ?? []) as Json[];
  const all = (f: Json) => `${f.name}: all (no option chosen)`;
  if (!choices?.length) return { query: "", words: filters.map(all), applied: [] };
  const listing = () => filters.map((f) => `${f.name} (${((f.options ?? []) as Json[]).map(optionLabel).join(", ")})`).join("; ");
  if (!filters.length) throw new InputError("This dashboard has no filters. Leave out `filters`.");
  const chosen = new Map<number, Json>();
  for (const choice of choices) {
    const index = filters.findIndex((f) => same(f.name, choice.name));
    if (index < 0) throw new InputError(`No dashboard filter named "${choice.name}". This dashboard's filters: ${listing()}.`);
    const filter = filters[index]!;
    if (chosen.has(index)) throw new InputError(`The filter ${filter.name} is given twice. Give one option per filter.`);
    const options = (filter.options ?? []) as Json[];
    const option = options.find(
      (o) => o.id === choice.option || same(optionLabel(o), choice.option) || same(o.value, choice.option) || same(o.alias, choice.option),
    );
    if (!option) throw new InputError(`${filter.name} has no option "${choice.option}". Its options: ${options.map(optionLabel).join(", ")}.`);
    chosen.set(index, option);
  }
  const query = `?${[...chosen.entries()]
    .sort(([a], [b]) => a - b)
    .map(([i, o]) => `filter${i + 1}=${encodeURIComponent(String(o.id))}`)
    .join("&")}`;
  const words = filters.map((f, i) => (chosen.has(i) ? `${f.name}: ${optionLabel(chosen.get(i)!)}` : all(f)));
  return { query, words, applied: words.filter((_, i) => chosen.has(i)) };
}

/** Whose data the dashboard shows, in words. */
export function runningUserWords(meta: Json): string {
  const name: string | undefined = meta.runningUser?.displayName;
  switch (meta.dashboardType) {
    case "SpecifiedUser":
      return `${name ?? "A set user"}: the dashboard always runs as this user, so every viewer sees the same data.`;
    case "LoggedInUser":
      return "The viewer: each person sees the data they can see, so these results are the signed-in user's.";
    case "MyTeamUser":
      return "The viewer, who as a manager can also view it as someone on their team. These results are the signed-in user's.";
    default:
      return name ? `${name} (${meta.dashboardType ?? "unknown type"})` : "Unknown";
  }
}

/** describe's components in layout order (top to bottom, then left to right), each with its grid position. */
function inLayoutOrder(meta: Json): { component: Json; position: DashboardComponentSummary["position"] }[] {
  const components = (meta.components ?? []) as Json[];
  const cells = (meta.layout?.components ?? []) as Json[];
  const placed = components.map((component, i) => {
    const cell = cells[i];
    const position = cell ? { row: cell.row, column: cell.column, rows: cell.rowspan, columns: cell.colspan } : null;
    return { component, position, i };
  });
  placed.sort((a, b) => {
    if (!a.position || !b.position) return a.i - b.i;
    return a.position.row - b.position.row || a.position.column - b.position.column || a.i - b.i;
  });
  return placed.map(({ component, position }) => ({ component, position }));
}

const AGGREGATE_WORDS: Record<string, string> = { s: "Sum of", a: "Average of", m: "Smallest", mx: "Largest", u: "Unique" };

function measureLabel(name: string): string {
  if (name === "RowCount") return "Record Count";
  const prefix = /^([a-z]+)!/.exec(name)?.[1];
  const words = prefix ? AGGREGATE_WORDS[prefix] : undefined;
  return words ? `${words} ${humanize(name)}` : humanize(name);
}

export function summarizeDashboard(describe: Json, options: { baseUrl?: string; reportNames?: Map<string, string> }): DashboardSummary {
  const names = options.reportNames ?? new Map<string, string>();
  const nameOf = (id: string | null) => (id ? (names.get(id) ?? names.get(id.slice(0, 15)) ?? null) : null);
  return {
    id: describe.id,
    name: describe.name,
    developerName: describe.developerName ?? null,
    description: describe.description ?? null,
    folder: { id: describe.folderId ?? null, name: describe.folderName ?? null },
    type: describe.dashboardType ?? null,
    runningUser: runningUserWords(describe),
    owner: describe.owner?.displayName ?? null,
    url: dashboardUrl(options.baseUrl, describe.id),
    filters: ((describe.filters ?? []) as Json[]).map((f) => ({
      name: f.name,
      dataType: f.dataType ?? null,
      options: ((f.options ?? []) as Json[]).map(optionLabel),
    })),
    layout: `Components are listed in layout order: top to bottom, then left to right, on a grid ${describe.layout?.numColumns ?? 12} columns wide.`,
    components: inLayoutOrder(describe).map(({ component: c, position }) => {
      const props: Json = c.properties ?? {};
      const reportId: string | null = c.reportId ?? null;
      return {
        id: c.id,
        header: c.header ?? null,
        title: c.title ?? null,
        footer: c.footer ?? null,
        visualizationType: props.visualizationType ?? null,
        report: { id: reportId, name: nameOf(reportId), url: reportUrl(options.baseUrl, reportId) },
        groupings: ((props.groupings ?? []) as Json[]).map((g) => g.name as string),
        measures: ((props.aggregates ?? []) as Json[]).map((a) => ({ name: a.name as string, label: measureLabel(a.name) })),
        position,
      };
    }),
  };
}

export interface ShapeDashboardOptions {
  baseUrl?: string;
  /** Detail rows kept per component. */
  maxRows: number;
  /** Every dashboard filter with its value in words, from resolveFilters. */
  filterWords: string[];
  /** The filters that were set, in words; added to each filtered component's own filters. */
  appliedFilters?: string[];
  now: Date;
}

/** GET /analytics/dashboards/{id} to a DashboardResult. Each component's reportResult is shaped by shapeResult. */
export function shapeDashboard(results: Json, options: ShapeDashboardOptions): DashboardResult {
  const meta: Json = results.dashboardMetadata ?? {};
  const applied = options.appliedFilters ?? [];
  const data = new Map<string, Json>(((results.componentData ?? []) as Json[]).map((d) => [d.componentId, d]));
  const notes: string[] = [];
  const id: string = meta.id ?? results.attributes?.dashboardId;

  const components: DashboardComponentResult[] = inLayoutOrder(meta).map(({ component: c }) => {
    const entry = data.get(c.id);
    const status: Json = entry?.status ?? {};
    const props: Json = c.properties ?? {};
    const out: DashboardComponentResult = {
      id: c.id,
      header: c.header ?? null,
      title: c.title ?? null,
      footer: c.footer ?? null,
      visualizationType: props.visualizationType ?? null,
      status: componentStatus(entry),
      refreshedAt: status.refreshDate ?? null,
    };
    if (out.status === "error") {
      out.error = { code: String(status.errorCode ?? status.componentDataStatus ?? "UNKNOWN"), message: String(status.errorMessage ?? "Salesforce gave no message.") };
    }
    if (out.status === "data") {
      const raw: Json = entry!.reportResult;
      const result = shapeResult(raw, {
        maxRows: options.maxRows,
        includeDetail: raw.reportMetadata?.reportFormat === "TABULAR",
        baseUrl: options.baseUrl,
      });
      // reportMetadata shows the source report's own filters, never the dashboard's.
      if ((props.filterColumns ?? []).length) result.filters.push(...applied.map((w) => `Dashboard filter ${w}`));
      out.result = result;
    }
    return out;
  });

  const label = (c: DashboardComponentResult) => c.header ?? c.title ?? c.id;
  const withData = components.filter((c) => c.status === "data");
  const noData = components.filter((c) => c.status === "no data");
  const forWhat = applied.length ? ` for ${applied.join(", ")}` : "";
  if (components.length && noData.length === components.length) {
    notes.push(
      `No component has data${forWhat}: the dashboard has not been refreshed${forWhat ? " with these filters" : ""}. Call refresh_dashboard with the same filters to get numbers.`,
    );
  } else if (noData.length) {
    notes.push(`${noData.length} of ${components.length} components have no data${forWhat} (${noData.map(label).join(", ")}). Call refresh_dashboard with the same filters to fill them.`);
  }
  for (const c of components.filter((x) => x.status === "error")) notes.push(`${label(c)} failed in Salesforce: ${c.error!.code}: ${c.error!.message}`);

  const dates = withData.map((c) => c.refreshedAt).filter((d): d is string => Boolean(d));
  const refreshedAt = dates.length ? dates.reduce((a, b) => (time(b) < time(a) ? b : a)) : null;
  if (refreshedAt && withData.some((c) => data.get(c.id)?.status?.refreshStatus === "STALE")) {
    notes.push(
      `Salesforce marks this data stale: the dashboard was refreshed since with other filters. These numbers are from ${refreshedAt}; call refresh_dashboard with the same filters for current ones.`,
    );
  }
  if (refreshedAt) {
    const age = options.now.getTime() - time(refreshedAt);
    if (age > DAY_MS) {
      const days = Math.floor(age / DAY_MS);
      notes.push(`These numbers were refreshed ${days} day${days === 1 ? "" : "s"} ago, at ${refreshedAt}. Call refresh_dashboard for current ones.`);
    }
  }
  for (const c of withData) for (const n of c.result!.notes) notes.push(`${label(c)}: ${n}`);

  return {
    dashboard: {
      id,
      name: meta.name ?? results.attributes?.dashboardName ?? "Dashboard",
      developerName: meta.developerName ?? null,
      folder: { id: meta.folderId ?? null, name: meta.folderName ?? null },
      url: dashboardUrl(options.baseUrl, id),
    },
    runningUser: runningUserWords(meta),
    filters: options.filterWords,
    refreshedAt,
    components,
    notes,
  };
}

function componentStatus(entry: Json | undefined): DashboardComponentResult["status"] {
  const status: Json = entry?.status ?? {};
  if (status.errorCode || status.componentDataStatus === "ERROR") return "error";
  if (entry?.reportResult) return "data";
  if (!entry || status.componentDataStatus === "NO_DATA" || status.componentDataStatus === "DATA") return "no data";
  return "error";
}

/** The once-a-minute refusal: 403 FORBIDDEN, "You can't refresh this dashboard more than once in a minute." */
export function isRefreshLimit(error: unknown): boolean {
  return error instanceof SalesforceError && error.status === 403 && (error.code === "FORBIDDEN" || /minute/i.test(error.message));
}

/** A component is done when it is not running and has an error, or data newer than before the refresh. */
export function refreshDone(status: Json, before: Map<string, string | null>): boolean {
  return ((status.componentStatus ?? []) as Json[]).every((c) => {
    if (c.refreshStatus === "RUNNING") return false;
    if (c.errorCode || c.componentDataStatus === "ERROR") return true;
    return c.componentDataStatus === "DATA" && Boolean(c.refreshDate) && c.refreshDate !== before.get(c.componentId);
  });
}

/**
 * Starts a refresh and waits for it: PUT with the filters on the query string (a body is ignored), then the
 * status every 3 seconds until every component is done or 60 seconds pass. Returns notes for the result.
 * The once-a-minute 403 becomes a note; any other failure is thrown.
 */
export async function refreshAndWait(reports: ReportsApi, id: string, filters: string, now: () => Date): Promise<string[]> {
  const before = new Map<string, string | null>();
  try {
    for (const c of ((await reports.dashboardStatus(id, filters)).componentStatus ?? []) as Json[]) before.set(c.componentId, c.refreshDate ?? null);
  } catch {
    /* without the earlier dates, any data counts as new */
  }
  try {
    await reports.refreshDashboard(id, filters);
  } catch (error) {
    if (!isRefreshLimit(error)) throw error;
    // A minute after this filter's last refresh when that is still ahead, else a minute from now (the last refresh
    // may have been for other filters, which this status does not show).
    const last = [...before.values()].filter((d): d is string => Boolean(d)).map(time).reduce((a, b) => Math.max(a, b), 0);
    const nowMs = now().getTime();
    const retry = last + 60_000 > nowMs ? last + 60_000 : nowMs + 60_000;
    const after = new Date(retry).toISOString().replace(/\.\d{3}Z$/, "Z");
    return [
      `Salesforce refreshes a dashboard at most once a minute, and this one was refreshed less than a minute ago, so these are the cached results. Try again after ${after}.`,
    ];
  }
  for (let poll = 0; poll < REFRESH_POLLS; poll++) {
    await reports.pause(REFRESH_POLL_MS);
    try {
      if (refreshDone(await reports.dashboardStatus(id, filters), before)) return [];
    } catch {
      /* a failed poll is retried at the next one */
    }
  }
  return [`The refresh had not finished after ${(REFRESH_POLL_MS * REFRESH_POLLS) / 1000} seconds, so some components may show older data. Call run_dashboard in a minute to read the refreshed results.`];
}

function same(a: unknown, b: unknown): boolean {
  return typeof a === "string" && typeof b === "string" && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Salesforce dates end in "+0000", which is not ISO 8601; add the colon before parsing. */
function time(date: string): number {
  return Date.parse(date.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
}
