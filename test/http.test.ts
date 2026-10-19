import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ReportsApi } from "../src/reports/api.js";
import type { SalesforceApi } from "../src/salesforce/client.js";
import { assertLoopbackHost, startHttpServer, type HttpHandle } from "../src/http.js";
import { buildServer } from "../src/server.js";
import { fixture } from "./helpers.js";

const ID = "00O000000000001AAA";

const api: SalesforceApi = {
  apiVersion: "62.0",
  instanceUrl: async () => "https://example.my.salesforce.com",
  request: async <T>(method: string, path: string) => {
    if (path.startsWith("/analytics/reports/query")) return fixture("summary") as T;
    if (method === "GET" && path.startsWith(`/analytics/reports/${ID}/describe`)) return fixture("summary") as T;
    if (method === "GET" && path.startsWith(`/analytics/reports/${ID}`)) return fixture("tabular") as T;
    throw new Error(`unexpected request ${method} ${path}`);
  },
};
const reports = new ReportsApi(api, async () => undefined);
const factory = () => buildServer(reports, { readOnly: false, allowDelete: true, maxRows: 200 });

let handle: HttpHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

describe("http transport", () => {
  it("serves the 16 tools and both ui:// resources, runs a report, and closes cleanly", async () => {
    handle = await startHttpServer({ port: 0, host: "127.0.0.1", createServer: factory });
    const client = new Client({ name: "test", version: "0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`));
    await client.connect(transport);
    expect(transport.sessionId).toBeTruthy();
    expect((await client.listTools()).tools).toHaveLength(16);
    const result = (await client.callTool({ name: "run_report", arguments: { reportId: ID } })) as { content: { text: string }[] };
    expect(JSON.parse(result.content[0]!.text)).toBeTruthy();
    const resources = await client.listResources();
    expect(resources.resources.filter((r) => r.uri.startsWith("ui://")).length).toBe(2);
    const view = await client.readResource({ uri: "ui://salesforce-reports/report" });
    expect(view.contents[0]!.uri).toBe("ui://salesforce-reports/report");
    await transport.terminateSession();
    await client.close();
  });

  it("refuses a foreign Host header", async () => {
    handle = await startHttpServer({ port: 0, host: "127.0.0.1", createServer: factory });
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port: handle!.port, path: "/mcp", method: "POST", headers: { Host: "evil.example.com", "content-type": "application/json" } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end("{}");
    });
    expect(status).toBe(403);
  });

  it("refuses a non-loopback host at start", async () => {
    expect(() => assertLoopbackHost("0.0.0.0")).toThrow(/OAuth layer/);
    await expect(startHttpServer({ port: 0, host: "0.0.0.0", createServer: factory })).rejects.toThrow(/OAuth layer/);
    for (const ok of ["127.0.0.1", "::1", "localhost"]) expect(() => assertLoopbackHost(ok)).not.toThrow();
  });
});
