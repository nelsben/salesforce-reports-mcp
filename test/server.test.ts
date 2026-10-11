import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { ReportsApi } from "../src/reports/api.js";
import { SalesforceError, type SalesforceApi } from "../src/salesforce/client.js";
import { buildServer, type ServerOptions } from "../src/server.js";
import { fixture } from "./helpers.js";

type Handler = (method: string, path: string, body: unknown) => unknown;

function fakeApi(handler: Handler): { api: SalesforceApi; requests: { method: string; path: string; body: unknown }[] } {
  const requests: { method: string; path: string; body: unknown }[] = [];
  const api: SalesforceApi = {
    apiVersion: "62.0",
    instanceUrl: async () => "https://example.my.salesforce.com",
    request: async <T>(method: string, path: string, body?: unknown) => {
      requests.push({ method, path, body });
      return handler(method, path, body) as T;
    },
  };
  return { api, requests };
}

async function connect(handler: Handler, options: Partial<ServerOptions> = {}) {
  const { api, requests } = fakeApi(handler);
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

const ID = "00O000000000001AAA";

const routes: Handler = (method, path) => {
  if (path.startsWith("/analytics/reports/query")) return fixture("summary");
  if (method === "GET" && path.startsWith(`/analytics/reports/${ID}/describe`)) return fixture("summary");
  if (method === "GET" && path.startsWith(`/analytics/reports/${ID}`)) return fixture("tabular");
  if (path === "/analytics/reportTypes") return fixture("report-types");
  if (path.startsWith("/analytics/reportTypes/")) return fixture("report-type-opportunity");
  if (path.startsWith("/query?q=")) return { records: [] };
  throw new Error(`unexpected request ${method} ${path}`);
};

describe("tool registration", () => {
  const names = async (options: Partial<ServerOptions>) => {
    const { client } = await connect(routes, options);
    return (await client.listTools()).tools.map((t) => t.name).sort();
  };
  const readTools = [
    "combine_reports",
    "describe_report",
    "describe_report_type",
    "list_report_folders",
    "list_report_types",
    "query_report",
    "run_report",
    "search_reports",
  ];

  it("registers the write tools but not delete by default", async () => {
    expect(await names({})).toEqual([...readTools, "clone_report", "create_report", "update_report"].sort());
  });

  it("registers no write tool in read-only mode, even with allowDelete", async () => {
    expect(await names({ readOnly: true, allowDelete: true })).toEqual(readTools);
  });

  it("registers delete_report only with allowDelete", async () => {
    expect(await names({ allowDelete: true })).toEqual([...readTools, "clone_report", "create_report", "delete_report", "update_report"].sort());
  });

  it("marks tools with the right hints and describes every input", async () => {
    const { client } = await connect(routes, { allowDelete: true });
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.annotations?.openWorldHint, tool.name).toBe(true);
      expect(tool.description!.length, tool.name).toBeGreaterThan(80);
      const props = (tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
      for (const [key, prop] of Object.entries(props)) {
        if (key !== "reportId") expect(prop.description, `${tool.name}.${key}`).toBeTruthy();
      }
    }
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.run_report!.annotations?.readOnlyHint).toBe(true);
    expect(byName.query_report!.annotations?.readOnlyHint).toBe(true);
    expect(byName.create_report!.annotations?.readOnlyHint).toBe(false);
    expect(byName.delete_report!.annotations?.destructiveHint).toBe(true);
  });
});

describe("run_report and query_report", () => {
  it("run_report returns a ReportResult for a saved report", async () => {
    const { call, requests } = await connect(routes);
    const { body, isError } = await call("run_report", { reportId: ID });
    expect(isError).toBe(false);
    expect(body.report.format).toBe("TABULAR");
    expect(body.detail.rows.length).toBe(8);
    expect(body.totals.values).toEqual([8]);
    expect(requests.find((r) => r.method === "GET")!.path).toBe(`/analytics/reports/${ID}?includeDetails=true`);
  });

  it("run_report with overrides posts them as partial reportMetadata and does not save", async () => {
    const { call, requests } = await connect(routes);
    await call("run_report", {
      reportId: ID,
      overrides: { dateFilter: { column: "CLOSE_DATE", duration: "LAST_N_DAYS:30" }, filters: [{ column: "AMOUNT", operator: "greaterThan", value: 5 }] },
    });
    const post = requests.find((r) => r.method === "POST")!;
    expect(post.path).toContain(`/analytics/reports/${ID}`);
    expect(post.body).toEqual({
      reportMetadata: {
        standardDateFilter: { column: "CLOSE_DATE", durationValue: "LAST_N_DAYS:30" },
        reportFilters: [{ column: "AMOUNT", operator: "greaterThan", value: "5" }],
      },
    });
    expect(requests.some((r) => r.method === "PATCH")).toBe(false);
  });

  it("query_report maps the definition and returns a ReportResult for a grouped report", async () => {
    const { call, requests } = await connect(routes);
    const { body } = await call("query_report", {
      reportType: "Opportunity",
      groupingsDown: [{ column: "STAGE_NAME" }, { column: "CLOSE_DATE", dateGranularity: "Month" }],
      aggregates: ["RowCount", { fn: "sum", column: "AMOUNT" }],
    });
    expect(body.report.format).toBe("SUMMARY");
    expect(body.groups.rows).toHaveLength(8);
    expect(body.detail).toBeUndefined(); // grouped reports return the group table by default
    const sent = (requests[0]!.body as { reportMetadata: Record<string, unknown> }).reportMetadata;
    expect(sent).toMatchObject({
      reportFormat: "SUMMARY",
      aggregates: ["RowCount", "s!AMOUNT"],
      detailColumns: ["AMOUNT"],
      groupingsDown: [
        { name: "STAGE_NAME", sortOrder: "Asc", dateGranularity: "None" },
        { name: "CLOSE_DATE", sortOrder: "Asc", dateGranularity: "Month" },
      ],
    });
  });

  it("query_report returns detail rows on request and honours maxRows", async () => {
    const { call } = await connect(routes);
    const { body } = await call("query_report", { reportType: "Opportunity", groupingsDown: [{ column: "STAGE_NAME" }], aggregates: ["RowCount"], detail: true, maxRows: 2 });
    expect(body.detail.rows).toHaveLength(2);
    expect(body.notes.join(" ")).toMatch(/Showing 2 of 8/);
  });

  it("query_report without reportType is an input error", async () => {
    const { call } = await connect(routes);
    const { body, isError } = await call("query_report", { columns: ["AMOUNT"] });
    expect(isError).toBe(true);
    expect(body.error.code).toBe("INVALID_INPUT");
    expect(body.error.message).toMatch(/reportType/);
  });

  it("maps a Salesforce error to code, message and a hint", async () => {
    const { call } = await connect(() => {
      throw new SalesforceError(400, "BAD_REQUEST", "The column NOPE is not a valid column.");
    });
    const { body, isError } = await call("query_report", { reportType: "Opportunity", columns: ["NOPE"] });
    expect(isError).toBe(true);
    expect(body.error).toMatchObject({ code: "BAD_REQUEST", message: "The column NOPE is not a valid column." });
    expect(body.error.hint).toMatch(/describe_report_type/);
  });

  it("runs async when the synchronous run times out", async () => {
    let polls = 0;
    const { call, requests } = await connect((method, path) => {
      if (method === "GET" && path === `/analytics/reports/${ID}?includeDetails=true`) throw new SalesforceError(504, "GATEWAY_TIMEOUT", "timed out");
      if (method === "POST" && path.includes("/instances")) return { id: "0LG000000000001", attributes: { status: "New" } };
      if (path.includes("/instances/")) {
        polls++;
        return polls < 2 ? { attributes: { status: "Running" } } : { ...fixture("tabular"), attributes: { status: "Success" } };
      }
      return routes(method, path, undefined);
    });
    const { body } = await call("run_report", { reportId: ID });
    expect(body.notes[0]).toMatch(/async/);
    expect(body.detail.rows).toHaveLength(8);
    expect(requests.filter((r) => r.path.includes("/instances/"))).toHaveLength(2);
  });
});

describe("other read tools", () => {
  it("search_reports escapes user input in the LIKE clause and returns Lightning URLs", async () => {
    const { call, requests } = await connect((_m, path) => {
      if (path.startsWith("/query?q=")) {
        return { records: [{ Id: ID, Name: "Pipeline", DeveloperName: "Pipeline", FolderName: "Sales", Format: "Summary", Description: null, LastRunDate: null, LastModifiedDate: "2026-10-01T00:00:00.000+0000" }] };
      }
      throw new Error("unexpected");
    });
    const { body } = await call("search_reports", { query: "50% o'rep_", format: "SUMMARY" });
    const soql = decodeURIComponent(requests[0]!.path.slice("/query?q=".length));
    expect(soql).toContain("Name LIKE '%50\\% o\\'rep\\_%'");
    expect(soql).toContain("Format = 'Summary'");
    expect(soql).toContain("LIMIT 25");
    expect(body.reports[0].url).toBe(`https://example.my.salesforce.com/lightning/r/Report/${ID}/view`);
  });

  it("list_report_types filters by search", async () => {
    const { call } = await connect(routes);
    const { body } = await call("list_report_types", { search: "account" });
    expect(body.total).toBeGreaterThan(0);
    expect(body.types.every((t: { type: string; label: string; category: string }) => /account/i.test(`${t.type} ${t.label} ${t.category}`))).toBe(true);
  });

  it("describe_report_type lists fields by section, with operators and granularities", async () => {
    const { call } = await connect(routes);
    const { body } = await call("describe_report_type", { type: "Opportunity" });
    expect(body.sections[0].fields[0]).toHaveProperty("dataType");
    expect(body.filterOperators.string).toContain("equals");
    expect(body.dateGranularities).toContain("Month");
  });

  it("describe_report summarizes columns, groupings, aggregates and filters", async () => {
    const { call } = await connect(routes);
    const { body } = await call("describe_report", { reportId: ID, includeMetadata: true });
    expect(body.format).toBe("SUMMARY");
    expect(body.groupingsDown.map((g: { name: string }) => g.name)).toEqual(["STAGE_NAME", "CLOSE_DATE"]);
    expect(body.aggregates.map((a: { label: string }) => a.label)).toContain("Sum of Amount");
    expect(body.filters[0]).toMatch(/^Close Date: /);
    expect(body.reportMetadata).toBeDefined();
  });

  it("rejects a malformed report id before calling Salesforce", async () => {
    const { client, requests } = await connect(routes);
    const result = (await client.callTool({ name: "run_report", arguments: { reportId: "nope" } })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(0);
  });
});

describe("combine_reports", () => {
  it("runs the inputs one after another and stacks them", async () => {
    const { call, requests } = await connect((method, path, body) =>
      method === "POST" && path.startsWith(`/analytics/reports/${ID}`) ? fixture("summary") : routes(method, path, body),
    );
    const { body, isError } = await call("combine_reports", {
      mode: "stack",
      inputs: [
        { alias: "a", definition: { reportType: "Opportunity", groupingsDown: [{ column: "STAGE_NAME" }] } },
        { alias: "b", reportId: ID, overrides: { dateFilter: { column: "CLOSE_DATE", duration: "LAST_YEAR" } } },
      ],
    });
    expect(isError).toBe(false);
    expect(requests.filter((r) => r.path.startsWith("/analytics/reports"))).toHaveLength(2);
    expect(body.report.name).toBe("combined: a, b");
    expect(body.groups.dimensions[0].name).toBe("source");
  });

  it("needs exactly one of reportId and definition per input", async () => {
    const { call } = await connect(routes);
    const { body, isError } = await call("combine_reports", {
      mode: "stack",
      inputs: [{ alias: "a" }, { alias: "b", reportId: ID }],
    });
    expect(isError).toBe(true);
    expect(body.error.message).toMatch(/exactly one/);
  });
});

describe("write tools", () => {
  const created = () => {
    const base = fixture<Record<string, any>>("summary"); // eslint-disable-line @typescript-eslint/no-explicit-any
    return { ...base, attributes: { reportId: ID }, reportMetadata: { ...base.reportMetadata, id: ID, name: "Pipeline", folderId: "005000000000001AAA" } };
  };

  it("create_report sends no folderId by default and returns the summary and URL", async () => {
    const { call, requests } = await connect((method, path) => {
      if (method === "POST" && path === "/analytics/reports") return created();
      if (path.startsWith("/query?q=")) return { records: [{ FolderName: "Private Reports" }] };
      return routes(method, path, undefined);
    });
    const { body, isError } = await call("create_report", {
      name: "Pipeline",
      reportType: "Opportunity",
      groupingsDown: [{ column: "STAGE_NAME" }],
      aggregates: ["RowCount"],
    });
    expect(isError).toBe(false);
    const sent = (requests.find((r) => r.method === "POST")!.body as { reportMetadata: Record<string, unknown> }).reportMetadata;
    expect(sent.name).toBe("Pipeline");
    expect(sent).not.toHaveProperty("folderId");
    expect(body).toMatchObject({ id: ID, name: "Pipeline", folder: "Private Reports", url: `https://example.my.salesforce.com/lightning/r/Report/${ID}/view` });
  });

  it("create_report needs a report type", async () => {
    const { call } = await connect(routes);
    const { isError, body } = await call("create_report", { name: "x" });
    expect(isError).toBe(true);
    expect(body.error.message).toMatch(/reportType/);
  });

  it("update_report patches only what was given and lists the changes", async () => {
    const before = created();
    const after = { ...before, reportMetadata: { ...before.reportMetadata, name: "Renamed" } };
    const { call, requests } = await connect((method, path) => {
      if (method === "GET" && path.endsWith("/describe")) return before;
      if (method === "PATCH") return after;
      return routes(method, path, undefined);
    });
    const { body } = await call("update_report", { reportId: ID, name: "Renamed" });
    expect(requests.find((r) => r.method === "PATCH")!.body).toEqual({ reportMetadata: { name: "Renamed" } });
    expect(body.changes).toEqual(['name: "Pipeline" -> "Renamed"']);
  });

  it("update_report refuses an empty update", async () => {
    const { call, requests } = await connect(routes);
    const { isError } = await call("update_report", { reportId: ID });
    expect(isError).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it("clone_report clones by id", async () => {
    const { call, requests } = await connect((method, path) => {
      if (method === "POST" && path.startsWith("/analytics/reports?cloneId=")) return created();
      if (path.startsWith("/query?q=")) return { records: [{ FolderName: "Private Reports" }] };
      return routes(method, path, undefined);
    });
    const { body } = await call("clone_report", { reportId: ID, name: "Copy" });
    expect(requests[0]).toMatchObject({ method: "POST", path: `/analytics/reports?cloneId=${ID}`, body: { reportMetadata: { name: "Copy" } } });
    expect(body.folder).toBe("Private Reports");
  });

  it("delete_report deletes and says the report is in the Recycle Bin", async () => {
    const { call, requests } = await connect(() => undefined, { allowDelete: true });
    const { body } = await call("delete_report", { reportId: ID });
    expect(requests[0]).toMatchObject({ method: "DELETE", path: `/analytics/reports/${ID}` });
    expect(body).toMatchObject({ deleted: true, id: ID });
  });
});

describe("combine_reports errors", () => {
  it("explains a stack of grouped and flat results", async () => {
    const { call } = await connect(routes);
    const { body, isError } = await call("combine_reports", {
      mode: "stack",
      inputs: [
        { alias: "a", definition: { reportType: "Opportunity", groupingsDown: [{ column: "STAGE_NAME" }] } },
        { alias: "b", reportId: ID },
      ],
    });
    expect(isError).toBe(true);
    expect(body.error.message).toMatch(/every input must return grouped rows/);
  });
});
