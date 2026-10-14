import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { ReportsApi } from "../src/reports/api.js";
import { SalesforceError, type SalesforceApi } from "../src/salesforce/client.js";
import { buildServer, type ServerOptions } from "../src/server.js";
import { doorDescription } from "../salesforce/scripts/door-tools.js";
import { inlineBundle } from "../src/widget/view.js";
import { fixture } from "./helpers.js";

// The report view: run_report and query_report carry an MCP App card on the local door.

const VIEW_URI = "ui://salesforce-reports/report";
const ID = "00O000000000001AAA";
const MISSING = "00O000000000009AAA";

type Handler = (method: string, path: string) => unknown;

const routes: Handler = (method, path) => {
  if (path.startsWith(`/analytics/reports/${MISSING}`)) throw new SalesforceError(404, "NOT_FOUND", "The requested resource does not exist.");
  if (path.startsWith("/analytics/reports/query")) return fixture("summary");
  if (method === "GET" && path.startsWith(`/analytics/reports/${ID}`)) return fixture("tabular");
  if (path.startsWith("/analytics/reportTypes/")) return fixture("report-type-opportunity");
  if (path.startsWith("/query?q=")) return { records: [] };
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
    const withView = tools.filter((t) => (t._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri).map((t) => t.name).sort();
    expect(withView).toEqual(["query_report", "run_report"]);
    for (const name of withView) {
      const tool = tools.find((t) => t.name === name)!;
      expect((tool._meta as { ui: { resourceUri: string } }).ui.resourceUri).toBe(VIEW_URI);
      expect(tool.outputSchema).toBeUndefined();
    }
  });

  it("tells Claude not to repeat the table on run_report and query_report only", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const withHint = tools.filter((t) => (t.description ?? "").includes("do not repeat the table")).map((t) => t.name).sort();
    expect(withHint).toEqual(["query_report", "run_report"]);
    for (const name of withHint) {
      expect(tools.find((t) => t.name === name)!.description).toMatch(/report card above your reply; there, answer in words and do not repeat the table\.$/);
    }
    // The hosted door draws no card, so its description drops the hint.
    const local = tools.find((t) => t.name === "run_report")!.description!;
    expect(doorDescription("run_report", local)).not.toContain("do not repeat the table");
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

  it("serves the view in read-only mode too", async () => {
    const client = await connect({ readOnly: true });
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain(VIEW_URI);
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
