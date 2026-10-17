/**
 * Captures real API responses into test/fixtures, anonymised.
 * Usage: npm run capture -- --org <alias>
 * Read-only: it runs ad hoc queries and describes; it saves nothing in the org.
 *
 * Dashboards: npm run capture -- --org <alias> --dashboard <id | developer name | title> [--refresh]
 * Captures only the dashboard fixtures (dashboard-describe, -results, -results-no-data, -status,
 * -results-filtered). Without --refresh it only reads what the org has cached, and skips any
 * fixture the cache cannot give. With --refresh it also refreshes the dashboard, which changes the
 * cached data in the org (twice: once with the first filter option, once without). Salesforce
 * allows one refresh a minute, so the script waits 65 seconds between them.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ReportsApi, soqlString } from "../src/reports/api.js";
import { toReportMetadata } from "../src/reports/definition.js";
import { createClient } from "../src/salesforce/client.js";
import { resolveConnection } from "../src/salesforce/connection.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const { values } = parseArgs({
  options: { org: { type: "string" }, dashboard: { type: "string" }, refresh: { type: "boolean", default: false } },
  strict: true,
});
if (!values.org) {
  console.error("Pass --org <alias>.");
  process.exit(2);
}
const client = createClient(resolveConnection({ org: values.org }));
const api = new ReportsApi(client);
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures");
mkdirSync(out, { recursive: true });

// ---- anonymisation ----

const KINDS: Record<string, string> = { Opportunity: "Opportunity", Account: "Account", Contact: "Contact", User: "User", Lead: "Lead" };
const counters = new Map<string, Map<string, string>>();
function neutral(kind: string, original: string): string {
  let names = counters.get(kind);
  if (!names) counters.set(kind, (names = new Map()));
  let name = names.get(original);
  if (!name) names.set(original, (name = `${kind} ${names.size + 1}`));
  return name;
}

const ids = new Map<string, string>();
// Key prefixes start with 0 and a digit or capital (00O report, 01Z dashboard, 01a component, 0IB filter, 0IC option).
const ID = /^0[0-9A-Z][0-9A-Za-z][A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;
function fakeId(id: string): string {
  let fake = ids.get(id);
  if (!fake) {
    const n = String(ids.size + 1).padStart(12, "0");
    fake = `${id.slice(0, 3)}${n}${id.length === 18 ? "AAA" : ""}`;
    ids.set(id, fake);
  }
  return fake;
}

function nameKind(info: Json | undefined): string | undefined {
  const match = /^(\w+)\.(Name|FirstName|LastName|Alias|Username|Email)$/.exec(info?.entityColumnName ?? "");
  return match ? KINDS[match[1]!] : undefined;
}

function anonymiseReport(raw: Json): Json {
  return scrub(maskNames(raw));
}

/** Replaces names in a report result with neutral ones. Returns a copy; ids and URLs are left for `scrub`. */
function maskNames(raw: Json): Json {
  const copy: Json = JSON.parse(JSON.stringify(raw));
  const ext = copy.reportExtendedMetadata ?? {};
  const detailNames: string[] = copy.reportMetadata?.detailColumns ?? [];
  const kinds = detailNames.map((n) => nameKind(ext.detailColumnInfo?.[n]));
  for (const fact of Object.values<Json>(copy.factMap ?? {})) {
    for (const row of fact.rows ?? []) {
      row.dataCells.forEach((c: Json, i: number) => {
        const kind = kinds[i];
        if (kind && typeof c.label === "string" && c.label !== "-") {
          const name = neutral(kind, c.label);
          if (c.value === c.label) c.value = name;
          c.label = name;
        }
      });
    }
  }
  const walkGroups = (nodes: Json[], names: string[], depth: number) => {
    for (const g of nodes ?? []) {
      const kind = nameKind(ext.groupingColumnInfo?.[names[depth] ?? ""]);
      if (kind && g.label !== "-") {
        const name = neutral(kind, g.label);
        g.label = name;
        g.value = name;
      }
      walkGroups(g.groupings, names, depth + 1);
    }
  };
  walkGroups(copy.groupingsDown?.groupings, (copy.reportMetadata?.groupingsDown ?? []).map((g: Json) => g.name), 0);
  walkGroups(copy.groupingsAcross?.groupings, (copy.reportMetadata?.groupingsAcross ?? []).map((g: Json) => g.name), 0);
  return copy;
}

/** Final pass over every string: ids and instance URLs. */
function scrub(value: Json): Json {
  if (typeof value === "string") {
    if (ID.test(value)) return fakeId(value);
    return value
      .replace(/https:\/\/[a-z0-9.-]+\.salesforce\.com/gi, "https://example.my.salesforce.com")
      .replace(/(\/analytics\/(?:reports|dashboards)\/)(0[0-9A-Z][0-9A-Za-z][A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?)/g, (_m, path, id) => `${path}${fakeId(id)}`);
  }
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]));
  return value;
}

function save(name: string, data: Json): void {
  writeFileSync(join(out, `${name}.json`), `${JSON.stringify(data, null, 2)}\n`);
  console.log(`wrote test/fixtures/${name}.json`);
}

// ---- dashboards ----

/** Anonymises a dashboard response: user display names, the names inside each component's report result, then ids and URLs. */
function anonymiseDashboard(raw: Json): Json {
  const copy: Json = JSON.parse(JSON.stringify(raw));
  const walk = (value: Json): void => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== "object") return;
    if (typeof value.displayName === "string") value.displayName = neutral("User", value.displayName);
    if (typeof value.reportResult?.factMap === "object") value.reportResult = maskNames(value.reportResult);
    Object.values(value).forEach(walk);
  };
  walk(copy);
  return scrub(copy);
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const complete = (status: Json) =>
  (status.componentStatus ?? []).length > 0 &&
  (status.componentStatus ?? []).every((c: Json) => c.refreshStatus === "IDLE" && c.componentDataStatus === "DATA");

/** Salesforce allows one refresh a minute: PUT, then poll /status until every component is idle with data. */
async function refreshDashboard(id: string, query: string): Promise<void> {
  await client.request("PUT", `/analytics/dashboards/${id}${query}`);
  for (let attempt = 0; attempt < 40; attempt++) {
    await wait(3000);
    if (complete(await client.request<Json>("GET", `/analytics/dashboards/${id}/status${query}`))) return;
  }
  throw new Error("The dashboard refresh did not finish in two minutes.");
}

async function captureDashboard(target: string, refresh: boolean): Promise<void> {
  let id = target;
  if (!/^01Z[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(target)) {
    const rows = await api.soql(`SELECT Id FROM Dashboard WHERE DeveloperName = '${soqlString(target)}' OR Title = '${soqlString(target)}' LIMIT 2`);
    if (rows.length !== 1) throw new Error(`Expected one dashboard named "${target}", found ${rows.length}.`);
    id = rows[0]!.Id;
  }
  const path = `/analytics/dashboards/${id}`;
  const describe = await client.request<Json>("GET", `${path}/describe`);
  save("dashboard-describe", anonymiseDashboard(describe));

  // No data: ask for a filter option nobody has refreshed. The cache keeps one result per filter value.
  const options: Json[] = (describe.filters ?? []).flatMap((f: Json) => f.options ?? []);
  let noData = false;
  for (const option of options) {
    const result = await client.request<Json>("GET", `${path}?filter1=${encodeURIComponent(option.id)}`);
    if (result.componentData.every((c: Json) => c.status.componentDataStatus === "NO_DATA")) {
      save("dashboard-results-no-data", anonymiseDashboard(result));
      noData = true;
      break;
    }
  }
  if (!noData) console.log("Skipped dashboard-results-no-data: every filter option already has cached data (or the dashboard has no filter).");

  if (!refresh) {
    const result = await client.request<Json>("GET", path);
    if (result.componentData.some((c: Json) => c.status.componentDataStatus !== "DATA")) {
      console.log("Skipped dashboard-results and dashboard-status: the dashboard has no cached data. Run again with --refresh.");
      return;
    }
    save("dashboard-results", anonymiseDashboard(result));
    save("dashboard-status", anonymiseDashboard(await client.request<Json>("GET", `${path}/status`)));
    console.log("Skipped dashboard-results-filtered: it needs --refresh.");
    return;
  }

  // Filtered first, so the unfiltered refresh is the last one and leaves the cache fresh.
  const first = options[0];
  if (first) {
    const query = `?filter1=${encodeURIComponent(first.id)}`;
    await refreshDashboard(id, query);
    save("dashboard-results-filtered", anonymiseDashboard(await client.request<Json>("GET", `${path}${query}`)));
    await wait(65_000);
  }
  await refreshDashboard(id, "");
  save("dashboard-results", anonymiseDashboard(await client.request<Json>("GET", path)));
  save("dashboard-status", anonymiseDashboard(await client.request<Json>("GET", `${path}/status`)));
}

if (values.dashboard) {
  await captureDashboard(values.dashboard, values.refresh);
  console.log("Done. Review the fixtures before committing.");
  process.exit(0);
}

// ---- captures ----

const dateFilter = { column: "CLOSE_DATE", duration: "THIS_YEAR" };

const tabular = toReportMetadata({
  reportType: "Opportunity",
  columns: ["OPPORTUNITY_NAME", "ACCOUNT_NAME", "AMOUNT", "PROBABILITY", "STAGE_NAME", "CLOSE_DATE", "CLOSED"],
  sortBy: [{ column: "AMOUNT", order: "Desc" }],
  dateFilter,
}).metadata;
const tabularRaw = await api.query(tabular, true);
const tabularFixture = anonymiseReport(tabularRaw);
save("tabular", tabularFixture);

// Salesforce cuts at 2,000 rows; the seeded org is far too small to reach that, so the cut is simulated.
save("tabular-all-data-false", { ...tabularFixture, allData: false });

const summary = toReportMetadata({
  reportType: "Opportunity",
  columns: ["OPPORTUNITY_NAME", "AMOUNT"],
  groupingsDown: [{ column: "STAGE_NAME" }, { column: "CLOSE_DATE", dateGranularity: "Month" }],
  aggregates: ["RowCount", { fn: "sum", column: "AMOUNT" }],
  dateFilter,
}).metadata;
save("summary", anonymiseReport(await api.query(summary, true)));

const matrix = toReportMetadata({
  reportType: "Opportunity",
  columns: ["OPPORTUNITY_NAME", "AMOUNT"],
  groupingsDown: [{ column: "STAGE_NAME" }],
  groupingsAcross: [{ column: "CLOSE_DATE", dateGranularity: "Quarter" }],
  aggregates: ["RowCount", { fn: "sum", column: "AMOUNT" }],
  dateFilter,
}).metadata;
save("matrix", anonymiseReport(await api.query(matrix, true)));

const ownerSummary = toReportMetadata({
  reportType: "Opportunity",
  columns: ["AMOUNT"],
  groupingsDown: [{ column: "FULL_NAME" }],
  aggregates: ["RowCount", { fn: "sum", column: "AMOUNT" }],
  dateFilter,
}).metadata;
save("summary-by-owner", anonymiseReport(await api.query(ownerSummary, false)));

// Report types: keep two categories, and in the type description two sections of a few fields.
const types = await api.reportTypes();
// Types built on this org's custom fields (they contain "@") are left out.
const standardTypes = types.slice(0, 2).map((c: Json) => ({ ...c, reportTypes: c.reportTypes.filter((t: Json) => !String(t.type).includes("@")) }));
save("report-types", scrub(standardTypes));
const oppType = await api.describeReportType("Opportunity");
const trimmed: Json = JSON.parse(JSON.stringify(oppType));
trimmed.reportTypeMetadata.categories = trimmed.reportTypeMetadata.categories.slice(0, 2).map((c: Json) => ({
  ...c,
  columns: Object.fromEntries(Object.entries(c.columns).slice(0, 6)),
}));
trimmed.reportExtendedMetadata = { detailColumnInfo: {}, groupingColumnInfo: {}, aggregateColumnInfo: {} };
trimmed.reportTypeMetadata.objects = undefined;
trimmed.reportTypeMetadata.objectRelationships = undefined;
save("report-type-opportunity", scrub(trimmed));
console.log("Done. Review the fixtures before committing.");
