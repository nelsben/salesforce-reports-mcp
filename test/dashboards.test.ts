import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReportsApi } from "../src/reports/api.js";
import { dashboardListSoql, resolveFilters, shapeDashboard, summarizeDashboard } from "../src/reports/dashboards.js";
import { SalesforceError, type SalesforceApi } from "../src/salesforce/client.js";
import { buildServer, type ServerOptions } from "../src/server.js";
import { fixture } from "./helpers.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Handler = (method: string, path: string, body: unknown) => unknown;

const DASH = "01Z000000000017AAA";
const PROSPECTING = "0IC000000000013AAA";
const BASE = "https://example.my.salesforce.com";
const REFRESHED = "2026-10-17T02:13:35.000+0000";

async function connect(handler: Handler, options: Partial<ServerOptions> = {}) {
  const requests: { method: string; path: string; body: unknown }[] = [];
  const api: SalesforceApi = {
    apiVersion: "62.0",
    instanceUrl: async () => BASE,
    request: async <T>(method: string, path: string, body?: unknown) => {
      requests.push({ method, path, body });
      return handler(method, path, body) as T;
    },
  };
  const server = buildServer(new ReportsApi(api, async () => undefined), { readOnly: false, allowDelete: false, maxRows: 200, ...options });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { isError: Boolean(result.isError), body: JSON.parse(result.content[0]!.text) };
  };
  return { client, call, requests };
}

/** Status with every component's refreshDate set to `date`. */
function statusAt(date: string | null): Json {
  const status = fixture<Json>("dashboard-status");
  return { componentStatus: status.componentStatus.map((c: Json) => ({ ...c, refreshDate: date })) };
}

const routes: Handler = (method, path) => {
  if (method === "GET" && path === `/analytics/dashboards/${DASH}/describe`) return fixture("dashboard-describe");
  if (method === "GET" && path === `/analytics/dashboards/${DASH}`) return fixture("dashboard-results");
  if (method === "GET" && path === `/analytics/dashboards/${DASH}?filter1=${PROSPECTING}`) return fixture("dashboard-results-filtered");
  if (method === "GET" && path.startsWith(`/analytics/dashboards/${DASH}?filter1=`)) return fixture("dashboard-results-no-data");
  if (method === "GET" && path.startsWith(`/analytics/dashboards/${DASH}/status`)) return fixture("dashboard-status");
  if (path.startsWith("/query?q=")) {
    const soql = decodeURIComponent(path.slice("/query?q=".length));
    if (soql.includes("FROM Report")) {
      return {
        records: [
          { Id: "00O000000000002AAA", Name: "Won by Stage" },
          { Id: "00O000000000004AAA", Name: "Pipeline by Stage" },
          { Id: "00O000000000008AAA", Name: "Amount by Close Month" },
        ],
      };
    }
    if (soql.includes("FROM Dashboard")) {
      return {
        records: [
          { Id: DASH, Title: "Pipeline Overview", DeveloperName: "Pipeline_Overview", FolderName: "Dashboard Probe Dashboards", FolderId: "00l000000000016AAA", Description: null, Type: "SpecifiedUser", LastModifiedDate: "2026-10-17T01:32:09.000+0000" },
        ],
      };
    }
  }
  throw new Error(`unexpected request ${method} ${path}`);
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-17T03:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("dashboards.ts", () => {
  it("builds the list SOQL with escaped LIKE terms and one row past the limit", () => {
    const soql = dashboardListSoql({ query: "50% o'pipe_", folder: "Probe", limit: 10 });
    expect(soql).toContain("FROM Dashboard");
    expect(soql).toContain("(Title LIKE '%50\\% o\\'pipe\\_%' OR DeveloperName LIKE '%50\\% o\\'pipe\\_%')");
    expect(soql).toContain("FolderName LIKE '%Probe%'");
    expect(soql).toContain("LIMIT 11");
  });

  it("maps a filter given by name and option label to filter1 and its option id", () => {
    const meta = fixture<Json>("dashboard-describe");
    const out = resolveFilters(meta, [{ name: "stage", option: "prospecting" }]);
    expect(out.query).toBe(`?filter1=${PROSPECTING}`);
    expect(out.words).toEqual(["Stage: Prospecting"]);
    expect(out.applied).toEqual(["Stage: Prospecting"]);
    expect(resolveFilters(meta, [{ name: "Stage", option: PROSPECTING }]).query).toBe(`?filter1=${PROSPECTING}`);
    expect(resolveFilters(meta, undefined)).toEqual({ query: "", words: ["Stage: all (no option chosen)"], applied: [] });
  });

  it("refuses an unknown filter name or label and lists the valid ones", () => {
    const meta = fixture<Json>("dashboard-describe");
    expect(() => resolveFilters(meta, [{ name: "Owner", option: "x" }])).toThrow(/No dashboard filter named "Owner".*Stage/);
    expect(() => resolveFilters(meta, [{ name: "Stage", option: "Won" }])).toThrow(/Stage has no option "Won".*Prospecting, Negotiation\/Review, Closed Won/);
  });

  it("summarizes a describe in layout order, with report names, groupings and measures", () => {
    const names = new Map([["00O000000000004AAA", "Pipeline by Stage"]]);
    const out = summarizeDashboard(fixture("dashboard-describe"), { baseUrl: BASE, reportNames: names });
    expect(out).toMatchObject({ id: DASH, name: "Pipeline Overview", developerName: "Pipeline_Overview", folder: { id: "00l000000000016AAA", name: "Dashboard Probe Dashboards" } });
    expect(out.url).toBe(`${BASE}/lightning/r/Dashboard/${DASH}/view`);
    expect(out.runningUser).toMatch(/^User 1: /);
    expect(out.filters).toEqual([{ name: "Stage", dataType: "picklist", options: ["Prospecting", "Negotiation/Review", "Closed Won"] }]);
    expect(out.components.map((c) => c.header)).toEqual([
      "Won to Date",
      "Won vs Target",
      "Pipeline Mix",
      "Pipeline by Stage",
      "Amount by Close Month",
      "Stage Table",
      "Stage Funnel",
      "Close Month Columns",
    ]);
    const bar = out.components.find((c) => c.header === "Pipeline by Stage")!;
    expect(bar).toMatchObject({
      visualizationType: "Bar",
      report: { id: "00O000000000004AAA", name: "Pipeline by Stage", url: `${BASE}/lightning/r/Report/00O000000000004AAA/view` },
      groupings: ["STAGE_NAME"],
      measures: [{ name: "s!AMOUNT", label: "Sum of Amount" }],
      position: { row: 4, column: 0, rows: 8, columns: 6 },
    });
  });

  it("shapes the results: every component a ReportResult, refreshed-at, filters in words", () => {
    const out = shapeDashboard(fixture("dashboard-results"), { baseUrl: BASE, maxRows: 20, filterWords: ["Stage: all (no option chosen)"], now: new Date("2026-10-17T03:00:00Z") });
    expect(out.dashboard).toMatchObject({ id: DASH, name: "Pipeline Overview", folder: { name: "Dashboard Probe Dashboards" } });
    expect(out.refreshedAt).toBe(REFRESHED);
    expect(out.filters).toEqual(["Stage: all (no option chosen)"]);
    expect(out.components).toHaveLength(8);
    expect(out.components.every((c) => c.status === "data")).toBe(true);
    const bar = out.components.find((c) => c.header === "Pipeline by Stage")!;
    expect(bar.result!.report.name).toBe("Pipeline by Stage");
    expect(bar.result!.totals!.values).toEqual([9322000]);
    expect(bar.result!.groups!.rows.length).toBeGreaterThanOrEqual(5);
    expect(out.notes).toEqual([]);
  });

  it("gives an error component its own status, and says when the cache is stale", () => {
    const results = fixture<Json>("dashboard-results");
    results.componentData[0] = {
      ...results.componentData[0],
      reportResult: null,
      status: { ...results.componentData[0].status, componentDataStatus: "ERROR", errorCode: "REPORT_ERROR", errorMessage: "The report failed." },
    };
    results.componentData[1].status.refreshStatus = "STALE";
    const out = shapeDashboard(results, { baseUrl: BASE, maxRows: 20, filterWords: [], now: new Date("2026-10-17T03:00:00Z") });
    const failed = out.components.find((c) => c.id === "01a000000000001AAA")!;
    expect(failed).toMatchObject({ status: "error", error: { code: "REPORT_ERROR", message: "The report failed." } });
    expect(failed.result).toBeUndefined();
    expect(out.notes.join(" ")).toMatch(/Won to Date failed in Salesforce: REPORT_ERROR/);
    expect(out.notes.join(" ")).toMatch(/stale/);
  });

  it("says the age of a result older than a day", () => {
    const out = shapeDashboard(fixture("dashboard-results"), { baseUrl: BASE, maxRows: 20, filterWords: [], now: new Date("2026-10-20T03:00:00Z") });
    expect(out.notes.join(" ")).toMatch(/refreshed 3 days ago/);
    expect(out.notes.join(" ")).toMatch(/refresh_dashboard/);
  });
});

describe("dashboard tools", () => {
  it("list_dashboards finds by text and folder, gives the last refresh, and caps the count with a note", async () => {
    const { call, requests } = await connect((method, path, body) => {
      if (path.startsWith("/query?q=") && decodeURIComponent(path).includes("FROM Dashboard")) {
        const row = (routes(method, path, body) as Json).records[0];
        return { records: [row, { ...row, Id: "01Z000000000099AAA", Title: "Pipeline Two" }] };
      }
      return routes(method, path, body);
    });
    const { body, isError } = await call("list_dashboards", { query: "Pipeline", folder: "Probe", limit: 1 });
    expect(isError).toBe(false);
    expect(body.count).toBe(1);
    expect(body.dashboards[0]).toMatchObject({
      id: DASH,
      title: "Pipeline Overview",
      developerName: "Pipeline_Overview",
      folder: "Dashboard Probe Dashboards",
      lastRefreshed: REFRESHED,
      url: `${BASE}/lightning/r/Dashboard/${DASH}/view`,
    });
    expect(body.notes.join(" ")).toMatch(/first 1/);
    const soql = decodeURIComponent(requests[0]!.path.slice("/query?q=".length));
    expect(soql).toContain("FolderName LIKE '%Probe%'");
    expect(soql).toContain("LIMIT 2");
  });

  it("describe_dashboard returns components, layout order and filters with option labels", async () => {
    const { call } = await connect(routes);
    const { body, isError } = await call("describe_dashboard", { dashboardId: DASH });
    expect(isError).toBe(false);
    expect(body.components).toHaveLength(8);
    expect(body.components[0]).toMatchObject({ header: "Won to Date", visualizationType: "Metric", report: { name: "Won by Stage" }, groupings: [] });
    expect(body.filters[0].options).toEqual(["Prospecting", "Negotiation/Review", "Closed Won"]);
  });

  it("run_dashboard reads the cache with no PUT", async () => {
    const { call, requests } = await connect(routes);
    const { body, isError } = await call("run_dashboard", { dashboardId: DASH });
    expect(isError).toBe(false);
    expect(requests.some((r) => r.method === "PUT")).toBe(false);
    expect(body.components).toHaveLength(8);
    expect(body.refreshedAt).toBe(REFRESHED);
  });

  it("run_dashboard maps a filter by name and label to filter1 and says it on every filtered component", async () => {
    const { call, requests } = await connect(routes);
    const { body } = await call("run_dashboard", { dashboardId: DASH, filters: [{ name: "Stage", option: "Prospecting" }] });
    expect(requests.map((r) => r.path)).toContain(`/analytics/dashboards/${DASH}?filter1=${PROSPECTING}`);
    expect(body.filters).toEqual(["Stage: Prospecting"]);
    const bar = body.components.find((c: Json) => c.header === "Pipeline by Stage");
    expect(bar.result.totals.values).toEqual([96000]);
    expect(bar.result.filters).toContain("Dashboard filter Stage: Prospecting");
  });

  it("run_dashboard says a no-data dashboard needs refresh_dashboard and does not refresh", async () => {
    const { call, requests } = await connect(routes);
    const { body, isError } = await call("run_dashboard", { dashboardId: DASH, filters: [{ name: "Stage", option: "Closed Won" }] });
    expect(isError).toBe(false);
    expect(body.components.every((c: Json) => c.status === "no data" && c.result === undefined)).toBe(true);
    expect(body.refreshedAt).toBeNull();
    expect(body.notes.join(" ")).toMatch(/No component has data/);
    expect(body.notes.join(" ")).toMatch(/refresh_dashboard/);
    expect(requests.some((r) => r.method === "PUT")).toBe(false);
  });

  it("run_dashboard refuses an unknown filter label and lists the valid ones, before reading the results", async () => {
    const { call, requests } = await connect(routes);
    const { body, isError } = await call("run_dashboard", { dashboardId: DASH, filters: [{ name: "Stage", option: "Closed Lost" }] });
    expect(isError).toBe(true);
    expect(body.error.code).toBe("INVALID_INPUT");
    expect(body.error.message).toMatch(/Prospecting, Negotiation\/Review, Closed Won/);
    expect(requests.some((r) => r.path === `/analytics/dashboards/${DASH}` || r.path.includes("?filter1="))).toBe(false);
  });

  it("refresh_dashboard PUTs with the filter on the query string, polls the status, then returns the results", async () => {
    let statusCalls = 0;
    const { call, requests } = await connect((method, path, body) => {
      if (method === "PUT") return { statusUrl: `/services/data/v62.0/analytics/dashboards/${DASH}/status` };
      if (path.startsWith(`/analytics/dashboards/${DASH}/status`)) {
        statusCalls++;
        return statusCalls <= 2 ? statusAt("2026-10-16T00:00:00.000+0000") : statusAt(REFRESHED);
      }
      return routes(method, path, body);
    });
    const { body, isError } = await call("refresh_dashboard", { dashboardId: DASH, filters: [{ name: "Stage", option: "Prospecting" }] });
    expect(isError).toBe(false);
    const put = requests.find((r) => r.method === "PUT")!;
    expect(put.path).toBe(`/analytics/dashboards/${DASH}?filter1=${PROSPECTING}`);
    expect(put.body).toBeUndefined();
    expect(requests.filter((r) => r.path === `/analytics/dashboards/${DASH}/status?filter1=${PROSPECTING}`)).toHaveLength(3);
    expect(body.components).toHaveLength(8);
    expect(body.filters).toEqual(["Stage: Prospecting"]);
    expect(body.notes.join(" ")).not.toMatch(/once a minute|60 seconds/);
  });

  it("refresh_dashboard gives up after 60 seconds of polls and says so", async () => {
    const { call, requests } = await connect((method, path, body) => {
      if (method === "PUT") return { statusUrl: "x" };
      if (path.startsWith(`/analytics/dashboards/${DASH}/status`)) return statusAt("2026-10-16T00:00:00.000+0000");
      return routes(method, path, body);
    });
    const { body, isError } = await call("refresh_dashboard", { dashboardId: DASH });
    expect(isError).toBe(false);
    expect(requests.filter((r) => r.path.includes("/status")).length).toBe(21); // one before the PUT, then 20 polls 3 seconds apart
    expect(body.notes.join(" ")).toMatch(/60 seconds/);
  });

  it("refresh_dashboard turns the once-a-minute 403 into a note with the cached results", async () => {
    const { call } = await connect((method, path, body) => {
      if (method === "PUT") throw new SalesforceError(403, "FORBIDDEN", "You can't refresh this dashboard more than once in a minute.");
      return routes(method, path, body);
    });
    const { body, isError } = await call("refresh_dashboard", { dashboardId: DASH });
    expect(isError).toBe(false);
    expect(body.components).toHaveLength(8);
    expect(body.notes.join(" ")).toMatch(/once a minute/);
    expect(body.notes.join(" ")).toMatch(/Try again after 2026-10-17T03:01:00/);
  });

  it("refresh_dashboard names a minute after the last refresh when that is still ahead", async () => {
    vi.setSystemTime(new Date("2026-10-17T02:13:50Z"));
    const { call } = await connect((method, path, body) => {
      if (method === "PUT") throw new SalesforceError(403, "FORBIDDEN", "You can't refresh this dashboard more than once in a minute.");
      return routes(method, path, body);
    });
    const { body } = await call("refresh_dashboard", { dashboardId: DASH });
    expect(body.notes.join(" ")).toMatch(/Try again after 2026-10-17T02:14:35Z/);
  });

  it("refresh_dashboard passes on any other 403 as a failure", async () => {
    const { call } = await connect((method, path, body) => {
      if (method === "PUT") throw new SalesforceError(403, "INSUFFICIENT_ACCESS", "insufficient access rights");
      return routes(method, path, body);
    });
    const { isError, body } = await call("refresh_dashboard", { dashboardId: DASH });
    expect(isError).toBe(true);
    expect(body.error.code).toBe("INSUFFICIENT_ACCESS");
  });

  it("registers refresh_dashboard as a write tool that --read-only removes, and the readers as reads", async () => {
    const all = await connect(routes);
    const tools = (await all.client.listTools()).tools;
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of ["list_dashboards", "describe_dashboard", "run_dashboard"]) {
      expect(byName[name]!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: true });
      expect(byName[name]!.description).toMatch(/run_report|report/);
    }
    expect(byName.refresh_dashboard!.annotations?.readOnlyHint).toBe(false);
    expect(byName.run_dashboard!.description).toMatch(/run_report/);
    expect(byName.refresh_dashboard!.description).toMatch(/once a minute/);
    const ro = await connect(routes, { readOnly: true });
    const names = (await ro.client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["list_dashboards", "describe_dashboard", "run_dashboard"]));
    expect(names).not.toContain("refresh_dashboard");
  });

  it("rejects a malformed dashboard id before calling Salesforce", async () => {
    const { client, requests } = await connect(routes);
    const result = (await client.callTool({ name: "run_dashboard", arguments: { dashboardId: "00O000000000001AAA" } })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(0);
  });
});
