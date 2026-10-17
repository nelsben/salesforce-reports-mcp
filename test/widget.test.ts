import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { ReportsApi } from "../src/reports/api.js";
import { SalesforceError, type SalesforceApi } from "../src/salesforce/client.js";
import { buildServer, DASHBOARD_VIEW_HINT, VIEW_HINT, type ServerOptions } from "../src/server.js";
import { doorDescription } from "../salesforce/scripts/door-tools.js";
import { inlineBundle } from "../src/widget/view.js";
import { fixture } from "./helpers.js";

// The report view: run_report and query_report carry an MCP App card on the local door.
// The dashboard view: run_dashboard and refresh_dashboard carry a second one.

const VIEW_URI = "ui://salesforce-reports/report";
const DASHBOARD_URI = "ui://salesforce-reports/dashboard";
const DASH = "01Z000000000017AAA";
const ID = "00O000000000001AAA";
const MISSING = "00O000000000009AAA";

type Handler = (method: string, path: string) => unknown;

const routes: Handler = (method, path) => {
  if (path.startsWith(`/analytics/reports/${MISSING}`)) throw new SalesforceError(404, "NOT_FOUND", "The requested resource does not exist.");
  if (path.startsWith("/analytics/reports/query")) return fixture("summary");
  if (method === "GET" && path.startsWith(`/analytics/reports/${ID}`)) return fixture("tabular");
  if (path.startsWith("/analytics/reportTypes/")) return fixture("report-type-opportunity");
  if (path.startsWith("/query?q=")) return { records: [] };
  if (method === "GET" && path === `/analytics/dashboards/${DASH}`) return fixture("dashboard-results");
  if (method === "GET" && path === `/analytics/dashboards/${DASH}/describe`) return fixture("dashboard-describe");
  throw new Error(`unexpected request ${method} ${path}`);
};

async function connect(options: Partial<ServerOptions> = {}) {
  const api: SalesforceApi = {
    apiVersion: "62.0",
    instanceUrl: async () => "https://example.my.salesforce.com",
    request: async <T>(method: string, path: string) => routes(method, path) as T,
  };
  const server = buildServer(new ReportsApi(api, async () => undefined), { readOnly: false, allowDelete: true, maxRows: 200, ...options });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}

type CallResult = { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: unknown };

describe("report view", () => {
  it("puts the view on run_report and query_report and on no other tool", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const withView = tools.filter((t) => (t._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri === VIEW_URI).map((t) => t.name).sort();
    expect(withView).toEqual(["query_report", "run_report"]);
    for (const name of withView) {
      const tool = tools.find((t) => t.name === name)!;
      expect((tool._meta as { ui: { resourceUri: string } }).ui.resourceUri).toBe(VIEW_URI);
      expect(tool.outputSchema).toBeUndefined();
    }
  });

  it("tells Claude not to repeat the card's rows on run_report and query_report only", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const withHint = tools.filter((t) => (t.description ?? "").includes("never repeat the card's rows,")).map((t) => t.name).sort();
    expect(withHint).toEqual(["query_report", "run_report"]);
    for (const name of withHint) {
      expect(tools.find((t) => t.name === name)!.description).toMatch(/report card above your reply\. There, lead with the one finding the card cannot show .*never repeat the card's rows, totals or a table\.$/);
    }
    // The hosted door draws no card, so its description drops the hint.
    const local = tools.find((t) => t.name === "run_report")!.description!;
    expect(doorDescription("run_report", local)).not.toContain("never repeat the card's rows");
  });

  it("run_report returns structuredContent equal to its text result", async () => {
    const client = await connect();
    const result = (await client.callTool({ name: "run_report", arguments: { reportId: ID } })) as CallResult;
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.report.format).toBe("TABULAR");
    expect(result.structuredContent).toEqual(parsed);
  });

  it("query_report returns structuredContent equal to its text result", async () => {
    const client = await connect();
    const result = (await client.callTool({
      name: "query_report",
      arguments: { reportType: "Opportunity", groupingsDown: [{ column: "STAGE_NAME" }], aggregates: ["RowCount"] },
    })) as CallResult;
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.groups.rows.length).toBeGreaterThan(0);
    expect(result.structuredContent).toEqual(parsed);
  });

  it("other tools return text only", async () => {
    const client = await connect();
    const result = (await client.callTool({ name: "list_report_folders", arguments: {} })) as CallResult;
    expect(result.structuredContent).toBeUndefined();
  });

  it("an error from run_report keeps the JSON error body and has no structuredContent", async () => {
    const client = await connect();
    const result = (await client.callTool({ name: "run_report", arguments: { reportId: MISSING } })) as CallResult;
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text).error.code).toBe("NOT_FOUND");
    expect(result.structuredContent).toBeUndefined();
  });

  it("lists the view resource", async () => {
    const client = await connect();
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain(VIEW_URI);
  });

  it("serves one self-contained HTML document", async () => {
    const client = await connect();
    const { contents } = await client.readResource({ uri: VIEW_URI });
    expect(contents).toHaveLength(1);
    const view = contents[0] as { uri: string; mimeType?: string; text?: string };
    expect(view.mimeType).toBe("text/html;profile=mcp-app");
    const html = view.text ?? "";
    expect(html.toLowerCase()).toContain("<!doctype html");
    expect(html).toContain("ontoolresult");
    expect(html).not.toMatch(/<script[^>]*src=/i);
    expect(html).not.toMatch(/<link[^>]*rel=.stylesheet/i);
    expect(html).not.toMatch(/\bfetch\(/);
    // The ext-apps client is inlined in place of the marker.
    expect(html).toContain("ui/notifications/initialized");
    expect(html).not.toContain("/*@ext-apps-bundle*/");
  });

  it("sets no markup from data: the view script never writes innerHTML or outerHTML", () => {
    const template = readFileSync(new URL("../src/widget/report.html", import.meta.url), "utf8");
    expect(template).not.toMatch(/\.(innerHTML|outerHTML)\s*[+]?=/);
    expect(template).not.toMatch(/insertAdjacentHTML|document\.write/);
    // The chart is inline SVG built with createElementNS, with no chart library.
    expect(template).toContain("createElementNS");
  });

  it("serves the view in read-only mode too", async () => {
    const client = await connect({ readOnly: true });
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain(VIEW_URI);
  });
});

// Both cards are styled with Lightning Design System token values, vendored in src/widget/tokens.css (decision 0018).
describe("SLDS tokens", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  const styles = (html: string) => [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");

  it("tokens.css names the package, its version, the token files and the BSD-3-Clause notice, and holds no URL or font file", () => {
    const tokens = read("../src/widget/tokens.css");
    expect(tokens).toContain("@salesforce-ux/design-system 2.264.1");
    expect(tokens).toContain("BSD-3-Clause");
    expect(tokens).toContain("Copyright (c) 2015, salesforce.com, inc. All rights reserved.");
    for (const file of ["palettes.json", "theme-one-salesforce.json", "slds-hooks.raw.json", "font.raw.json"]) expect(tokens).toContain(file);
    expect(tokens).toMatch(/--slds-font-family:\s*"Salesforce Sans",/);
    // The data-visualization palette, in its order.
    expect([...tokens.matchAll(/--slds-dataviz-(\d):\s*(#[0-9a-f]{6})/gi)].map((m) => m[2]!.toLowerCase())).toEqual(["#52b7d8", "#e16032", "#ffb03b", "#54a77b", "#4fd2d2", "#e287b2"]);
    expect(tokens).not.toMatch(/url\(|@font-face|@import|\.woff|https?:/i);
  });

  it("the build inlines tokens.css into both cards, and the served cards load no font file or URL", async () => {
    const tokens = read("../src/widget/tokens.css").trim();
    for (const file of ["report.html", "dashboard.html"]) {
      expect(read(`../src/widget/${file}`)).toContain("/*@slds-tokens*/");
      const built = read(`../dist/widget/${file}`);
      expect(built).not.toContain("/*@slds-tokens*/");
      expect(styles(built)).toContain(tokens);
    }
    const client = await connect();
    for (const uri of [VIEW_URI, DASHBOARD_URI]) {
      const { contents } = await client.readResource({ uri });
      const html = (contents[0] as { text?: string }).text ?? "";
      expect(html).not.toContain("/*@slds-tokens*/");
      expect(styles(html)).toContain(tokens);
      expect(styles(html)).not.toMatch(/url\(|@font-face|@import/i);
      expect(html).not.toMatch(/\.woff2?\b|\.ttf\b|\.otf\b/i);
    }
  });

  it("both cards draw with the SLDS font stack, card look, brand blue, focus ring and data-visualization palette", () => {
    for (const file of ["report.html", "dashboard.html"]) {
      const css = styles(read(`../src/widget/${file}`));
      expect(css).toContain("font-family: var(--slds-font-family)");
      expect(css).toContain("var(--slds-card-radius)");
      expect(css).toContain("var(--slds-brand-accessible)");
      expect(css).toContain("var(--slds-link)");
      expect(css).toContain(":focus-visible");
      expect(css).toContain("var(--slds-dataviz-1)");
      // The host still sets the surface: background, text and border take the host's variables first.
      expect(css).toContain("var(--color-background-primary, ");
      expect(css).toContain("var(--color-text-primary, ");
      expect(css).toContain("var(--color-border-primary, ");
      // No ad hoc pixel font sizes: the type scale comes from the tokens.
      expect(css).not.toMatch(/font-size:\s*\d+px/);
    }
    expect(styles(read("../src/widget/dashboard.html"))).toContain("box-shadow: var(--slds-card-shadow)");
  });
});

describe("inlineBundle", () => {
  it("turns the module's export list into a scoped ExtApps object", () => {
    const out = inlineBundle('var a=1;class B{}var s="</script>";export{a as one,B as App};');
    expect(out).toContain('return {"one":a,"App":B};');
    expect(out).not.toMatch(/export\s*\{/);
    expect(out).not.toContain("</script");
    expect(new Function(`${out}; return ExtApps;`)()).toMatchObject({ one: 1 });
  });

  it("refuses a bundle without a trailing export list", () => {
    expect(() => inlineBundle("var a=1;")).toThrow(/unexpected shape/);
  });
});

describe("dashboard view", () => {
  type Meta = { ui?: { resourceUri?: string } } | undefined;

  it("puts the dashboard view on run_dashboard and refresh_dashboard and on no other tool", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const withView = tools.filter((t) => (t._meta as Meta)?.ui?.resourceUri === DASHBOARD_URI).map((t) => t.name).sort();
    expect(withView).toEqual(["refresh_dashboard", "run_dashboard"]);
    for (const name of withView) expect(tools.find((t) => t.name === name)!.outputSchema).toBeUndefined();
    // Every tool with a view carries one of the two.
    const anyView = tools.filter((t) => (t._meta as Meta)?.ui?.resourceUri).map((t) => (t._meta as Meta)!.ui!.resourceUri);
    expect(new Set(anyView)).toEqual(new Set([VIEW_URI, DASHBOARD_URI]));
  });

  it("tells Claude on the two dashboard tools to lead with what the card cannot show and not repeat its numbers", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const withHint = tools.filter((t) => (t.description ?? "").endsWith(DASHBOARD_VIEW_HINT)).map((t) => t.name).sort();
    expect(withHint).toEqual(["refresh_dashboard", "run_dashboard"]);
    expect(DASHBOARD_VIEW_HINT).toMatch(/dashboard card above your reply/);
    expect(DASHBOARD_VIEW_HINT).toMatch(/lead with the one finding the card cannot show/);
    expect(DASHBOARD_VIEW_HINT).toMatch(/never repeat the card's numbers/);
    // The report card's hint stays on the report tools.
    for (const name of withHint) expect(tools.find((t) => t.name === name)!.description).not.toContain(VIEW_HINT);
  });

  it("run_dashboard returns structuredContent equal to its text result, with each component's source report and gauge range", async () => {
    const client = await connect();
    const result = (await client.callTool({ name: "run_dashboard", arguments: { dashboardId: DASH } })) as CallResult;
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0]!.text);
    expect(result.structuredContent).toEqual(parsed);
    expect(parsed.components.map((c: { visualizationType: string }) => c.visualizationType)).toEqual(["Metric", "Gauge", "Donut", "Bar", "Line", "Table", "Funnel", "Column"]);
    const [metric, gauge, donut] = parsed.components;
    expect(metric.sourceReport).toEqual({ id: "00O000000000002AAA", url: "https://example.my.salesforce.com/lightning/r/Report/00O000000000002AAA/view" });
    expect(metric.measure).toEqual({ name: "s!AMOUNT", label: "Sum of Amount", dataType: "currency" });
    expect(metric.metricLabel).toBe("Closed Won amount");
    expect(metric.gauge).toBeUndefined();
    expect(gauge.gauge).toEqual({ min: 0, max: 5000000, breakpoints: [2000000, 4000000], colors: ["#c25454", "#c2c254", "#54c254"] });
    expect(donut.sourceReport.id).toBe("00O000000000004AAA");
  });

  it("serves the dashboard view as one self-contained HTML document, in read-only mode too", async () => {
    for (const readOnly of [false, true]) {
      const client = await connect({ readOnly });
      const { resources } = await client.listResources();
      expect(resources.map((r) => r.uri)).toEqual(expect.arrayContaining([VIEW_URI, DASHBOARD_URI]));
      const { contents } = await client.readResource({ uri: DASHBOARD_URI });
      const view = contents[0] as { mimeType?: string; text?: string };
      expect(view.mimeType).toBe("text/html;profile=mcp-app");
      const html = view.text ?? "";
      expect(html.toLowerCase()).toContain("<!doctype html");
      expect(html).toContain("ontoolresult");
      expect(html).toContain("salesforce-dashboard-view");
      expect(html).not.toMatch(/<script[^>]*src=/i);
      expect(html).not.toMatch(/<link[^>]*rel=.stylesheet/i);
      expect(html).not.toMatch(/\bfetch\(/);
      expect(html).toContain("ui/notifications/initialized");
      expect(html).not.toContain("/*@ext-apps-bundle*/");
    }
  });

  it("sets no markup from data and draws its charts as inline SVG", () => {
    const template = readFileSync(new URL("../src/widget/dashboard.html", import.meta.url), "utf8");
    expect(template).not.toMatch(/\.(innerHTML|outerHTML)\s*[+]?=/);
    expect(template).not.toMatch(/insertAdjacentHTML|document\.write/);
    expect(template).toContain("createElementNS");
    expect(template).toContain("prefers-reduced-motion");
  });
});
