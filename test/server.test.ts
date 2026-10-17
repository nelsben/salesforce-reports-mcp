import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { ReportsApi } from "../src/reports/api.js";
import { SalesforceError, type SalesforceApi } from "../src/salesforce/client.js";
import { doorTools } from "../salesforce/scripts/door-tools.js";
import { buildServer, VIEW_HINT, type ServerOptions } from "../src/server.js";
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
    "describe_dashboard",
    "describe_report",
    "describe_report_type",
    "list_dashboards",
    "list_report_folders",
    "list_report_types",
    "query_report",
    "run_dashboard",
    "run_report",
    "search_reports",
  ];

  it("registers the write tools but not delete by default", async () => {
    expect(await names({})).toEqual([...readTools, "clone_report", "create_report", "refresh_dashboard", "update_report"].sort());
  });

  it("registers no write tool in read-only mode, even with allowDelete (refresh_dashboard counts as a write)", async () => {
    expect(await names({ readOnly: true, allowDelete: true })).toEqual(readTools);
  });

  it("registers delete_report only with allowDelete", async () => {
    expect(await names({ allowDelete: true })).toEqual([...readTools, "clone_report", "create_report", "delete_report", "refresh_dashboard", "update_report"].sort());
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

  it("run_report says when Salesforce ignored an empty standardFilters override (the summary fixture keeps both)", async () => {
    const { call, requests } = await connect((method, path, body) =>
      method === "POST" && path.startsWith(`/analytics/reports/${ID}`) ? fixture("summary") : routes(method, path, body),
    );
    const { body } = await call("run_report", { reportId: ID, overrides: { reportMetadata: { standardFilters: [] } } });
    expect(requests.find((r) => r.method === "POST")!.body).toEqual({ reportMetadata: { standardFilters: [] } });
    expect(body.filters).toContain("Standard filter probability: >0");
    expect(body.notes).toContain(
      "Salesforce ignored reportMetadata.standardFilters: an empty list does not clear a report's standard filters, so these still apply: open: all, probability: >0. To change one, list it by name with another of its values.",
    );
    const plain = await call("run_report", { reportId: ID, overrides: { filters: [{ column: "AMOUNT", operator: "greaterThan", value: 5 }] } });
    expect(plain.body.notes.some((n: string) => n.includes("standardFilters"))).toBe(false);
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

  it("describe_report returns developerName and the folder for a private report", async () => {
    const { call } = await connect((method, path) => {
      if (method === "GET" && path.endsWith("/describe")) {
        const base = fixture<Record<string, any>>("summary"); // eslint-disable-line @typescript-eslint/no-explicit-any
        return { ...base, reportMetadata: { ...base.reportMetadata, id: ID, developerName: "Pipeline_abc", folderId: "005000000000013AAA" } };
      }
      return routes(method, path, undefined);
    });
    const { body } = await call("describe_report", { reportId: ID });
    expect(body.developerName).toBe("Pipeline_abc");
    expect(body.folder).toEqual({ id: "005000000000013AAA", name: "Private Reports", developerName: null, isPrivate: true });
  });

  it("describe_report reads a shared folder's name and developerName", async () => {
    const { call, requests } = await connect((method, path) => {
      if (method === "GET" && path.endsWith("/describe")) {
        const base = fixture<Record<string, any>>("summary"); // eslint-disable-line @typescript-eslint/no-explicit-any
        return { ...base, reportMetadata: { ...base.reportMetadata, id: ID, developerName: "Pipeline_abc", folderId: "00l000000000001AAA" } };
      }
      if (path.startsWith("/query?q=")) return { records: [{ Id: "00l000000000001AAA", Name: "Sales Reports", DeveloperName: "Sales_Reports" }] };
      return routes(method, path, undefined);
    });
    const { body } = await call("describe_report", { reportId: ID });
    expect(body.folder).toEqual({ id: "00l000000000001AAA", name: "Sales Reports", developerName: "Sales_Reports", isPrivate: false });
    expect(decodeURIComponent(requests.find((r) => r.path.startsWith("/query?q="))!.path)).toContain("FROM Folder WHERE Id = '00l000000000001AAA'");
  });

  it("list_report_folders adds the org-wide Public Reports folder", async () => {
    const { call } = await connect((method, path) => {
      const q = decodeURIComponent(path);
      if (q.includes("FROM Organization")) return { records: [{ Id: "00D000000000001AAA" }] };
      if (q.includes("FROM Folder")) return { records: [{ Id: "00l000000000001AAA", Name: "Sales Reports", DeveloperName: "Sales_Reports", AccessType: "Shared" }] };
      return routes(method, path, undefined);
    });
    const { body } = await call("list_report_folders");
    expect(body.folders[0]).toEqual({ id: "00D000000000001AAA", name: "Public Reports", developerName: "unfiled$public", accessType: "Public" });
    expect(body.folders[1]).toMatchObject({ name: "Sales Reports", developerName: "Sales_Reports" });
    const searched = await call("list_report_folders", { search: "sales" });
    expect(searched.body.folders.map((f: { name: string }) => f.name)).toEqual(["Sales Reports"]);
  });

  it("describe_report names the org-wide Public Reports folder unfiled$public", async () => {
    const { call } = await connect((method, path) => {
      if (method === "GET" && path.endsWith("/describe")) {
        const base = fixture<Record<string, any>>("summary"); // eslint-disable-line @typescript-eslint/no-explicit-any
        return { ...base, reportMetadata: { ...base.reportMetadata, id: ID, folderId: "00D000000000001AAA" } };
      }
      return routes(method, path, undefined);
    });
    const { body } = await call("describe_report", { reportId: ID });
    expect(body.folder).toEqual({ id: "00D000000000001AAA", name: "Public Reports", developerName: "unfiled$public", isPrivate: false });
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

  describe("fromReportId", () => {
    const flat = () => {
      const base = fixture<Record<string, any>>("summary"); // eslint-disable-line @typescript-eslint/no-explicit-any
      return {
        ...base,
        reportMetadata: {
          ...base.reportMetadata,
          id: ID,
          name: "Original",
          developerName: "Original_abc",
          folderId: "00l000000000001AAA",
          reportFormat: "TABULAR",
          groupingsDown: [],
          aggregates: ["RowCount"],
          detailColumns: ["OPPORTUNITY_NAME", "AMOUNT", "STAGE_NAME"],
          reportFilters: [{ column: "AMOUNT", operator: "greaterThan", value: "1000" }],
        },
      };
    };
    const harness = () =>
      connect((method, path) => {
        if (method === "GET" && path === `/analytics/reports/${ID}/describe`) return flat();
        if (method === "POST" && path === "/analytics/reports") return created();
        if (path.startsWith("/query?q=")) return { records: [{ FolderName: "Private Reports" }] };
        return routes(method, path, undefined);
      });
    const sentOf = (requests: { method: string; body: unknown }[]) =>
      (requests.find((r) => r.method === "POST")!.body as { reportMetadata: Record<string, any> }).reportMetadata; // eslint-disable-line @typescript-eslint/no-explicit-any

    it("copies the saved report and applies the changes, with no reportType given", async () => {
      const { call, requests } = await harness();
      const { isError, body } = await call("create_report", {
        name: "Copy",
        fromReportId: ID,
        groupingsDown: [{ column: "STAGE_NAME", sortOrder: "Desc" }],
        aggregates: ["RowCount", { fn: "sum", column: "AMOUNT" }],
      });
      expect(isError).toBe(false);
      expect(requests.map((r) => `${r.method} ${r.path}`).slice(0, 2)).toEqual([`GET /analytics/reports/${ID}/describe`, "POST /analytics/reports"]);
      const sent = sentOf(requests);
      expect(sent.name).toBe("Copy");
      expect(sent.reportType).toEqual({ label: "Opportunities", type: "Opportunity" });
      expect(sent.reportFormat).toBe("SUMMARY");
      expect(sent.groupingsDown).toEqual([{ name: "STAGE_NAME", sortOrder: "Desc", dateGranularity: "None" }]);
      expect(sent.aggregates).toEqual(["RowCount", "s!AMOUNT"]);
      // the old report's identity is not carried over, and a grouped column leaves the detail columns
      expect(sent).not.toHaveProperty("id");
      expect(sent).not.toHaveProperty("developerName");
      expect(sent).not.toHaveProperty("folderId");
      expect(sent.detailColumns).toEqual(["OPPORTUNITY_NAME", "AMOUNT"]);
      // what was not changed is kept
      expect(sent.reportFilters).toEqual([{ column: "AMOUNT", operator: "greaterThan", value: "1000" }]);
      expect(body).toMatchObject({ id: ID, folder: "Private Reports" });
    });

    it("a list that is sent replaces the saved list, and a folder is passed on", async () => {
      const { call, requests } = await harness();
      await call("create_report", { name: "Copy", fromReportId: ID, folderId: "00l000000000009AAA", filters: [], columns: ["OPPORTUNITY_NAME"] });
      const sent = sentOf(requests);
      expect(sent.reportFilters).toEqual([]);
      expect(sent.detailColumns).toEqual(["OPPORTUNITY_NAME"]);
      expect(sent.reportFormat).toBe("TABULAR");
      expect(sent.folderId).toBe("00l000000000009AAA");
    });

    it("never touches the original report", async () => {
      const { call, requests } = await harness();
      await call("create_report", { name: "Copy", fromReportId: ID, description: "d" });
      expect(requests.filter((r) => r.method === "PATCH" || r.method === "DELETE")).toHaveLength(0);
    });
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

describe("view hint", () => {
  it("tells Claude on run_report and query_report to lead with the insight the card cannot show and never repeat its rows", async () => {
    const { client } = await connect(routes);
    const { tools } = await client.listTools();
    const withHint = tools.filter((t) => (t.description ?? "").endsWith(VIEW_HINT)).map((t) => t.name).sort();
    expect(withHint).toEqual(["query_report", "run_report"]);
    expect(VIEW_HINT).toMatch(/Claude Desktop/);
    expect(VIEW_HINT).toMatch(/report card above your reply/);
    expect(VIEW_HINT).toMatch(/lead with the one finding the card cannot show/);
    expect(VIEW_HINT).toMatch(/concentration, change, risk, the next question/);
    expect(VIEW_HINT).toMatch(/keep the reply short/);
    expect(VIEW_HINT).toMatch(/never repeat the card's rows, totals or a table/);
  });

  it("the hosted door's descriptions carry none of the view hint", async () => {
    const tools = await doorTools();
    expect(tools.map((t) => t.name)).toContain("run_report");
    for (const tool of tools) {
      expect(tool.description, tool.name).not.toContain(VIEW_HINT.trim());
      expect(tool.description, tool.name).not.toMatch(/report card|Claude Desktop|MCP Apps|cannot show|repeat the/);
    }
  });
});
