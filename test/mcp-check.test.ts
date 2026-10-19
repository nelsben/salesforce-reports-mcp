import { describe, expect, it } from "vitest";
import { DOOR_TOOLS } from "../salesforce/scripts/door-tools.js";
import { compareTools, NO_TOKEN_MESSAGE, NO_AUTH_FILE_MESSAGE, resolveToken, runSteps, summaryLine } from "../scripts/mcp-check-lib.js";
import { authPath, type FileStore } from "../scripts/mcp-auth-lib.js";

const SECRET = "fake-token-value-not-real";
const HOME = "/home/u";
const STORED = { instanceUrl: "https://example.my.salesforce.com", clientId: "KEY", refreshToken: "fake-refresh" };

function store(files: Record<string, string>) {
  const fs: FileStore = { mkdir: () => undefined, writeFile: () => undefined, readFile: (path) => files[path] };
  return fs;
}
function fetcher(status: number, body: unknown) {
  const calls: { url: string; body: string }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: String(init.body) });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("resolveToken", () => {
  it("lets SF_MCP_TOKEN win and makes no request", async () => {
    const { fn, calls } = fetcher(200, { access_token: "x" });
    const files = { [authPath(HOME, "a")]: JSON.stringify(STORED) };
    expect(await resolveToken({ env: "from-env", auth: "a", fetch: fn, store: store(files), home: HOME })).toBe("from-env");
    expect(calls).toHaveLength(0);
  });

  it("exchanges the stored refresh token for a fresh access token on each call", async () => {
    const { fn, calls } = fetcher(200, { access_token: SECRET });
    const files = { [authPath(HOME, "a")]: JSON.stringify(STORED) };
    const opts = { env: undefined, auth: "a", fetch: fn, store: store(files), home: HOME };
    expect(await resolveToken(opts)).toBe(SECRET);
    expect(await resolveToken(opts)).toBe(SECRET);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe("https://example.my.salesforce.com/services/oauth2/token");
    expect(Object.fromEntries(new URLSearchParams(calls[0]!.body))).toEqual({ grant_type: "refresh_token", client_id: "KEY", refresh_token: "fake-refresh" });
  });

  it("refuses with neither source, naming both ways", async () => {
    const { fn } = fetcher(200, {});
    const error = (await resolveToken({ env: undefined, auth: undefined, fetch: fn, store: store({}), home: HOME }).catch((e: Error) => e)) as Error;
    expect(error.message).toBe(NO_TOKEN_MESSAGE);
    expect(error.message).toContain("SF_MCP_TOKEN");
    expect(error.message).toContain("--auth");
    expect(error.message).toContain("mcp-login");
  });

  it("tells the user to run mcp-login when --auth has no file", async () => {
    const { fn } = fetcher(200, {});
    const error = (await resolveToken({ env: undefined, auth: "gone", fetch: fn, store: store({}), home: HOME }).catch((e: Error) => e)) as Error;
    expect(error.message).toBe(NO_AUTH_FILE_MESSAGE("gone"));
    expect(error.message).toContain("npm run mcp-login");
  });

  it("reports only the status and error field when the exchange fails", async () => {
    const { fn } = fetcher(400, { error: "invalid_grant", error_description: `x ${SECRET}` });
    const files = { [authPath(HOME, "a")]: JSON.stringify(STORED) };
    const error = (await resolveToken({ env: undefined, auth: "a", fetch: fn, store: store(files), home: HOME }).catch((e: Error) => e)) as Error;
    expect(error.message).toContain("HTTP 400 invalid_grant");
    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain("fake-refresh");
  });
});

describe("compareTools", () => {
  it("accepts exactly the fifteen door tools in any order", () => {
    expect(DOOR_TOOLS).toHaveLength(15);
    expect(compareTools([...DOOR_TOOLS].reverse())).toEqual({ ok: true, missing: 0, extra: 0 });
  });
  it("counts one missing", () => {
    expect(compareTools(DOOR_TOOLS.slice(1))).toEqual({ ok: false, missing: 1, extra: 0 });
  });
  it("counts one extra", () => {
    expect(compareTools([...DOOR_TOOLS, "delete_report"])).toEqual({ ok: false, missing: 0, extra: 1 });
  });
});

function fakeRpc(options: { dashboards: number; searchError?: boolean }) {
  const called: string[] = [];
  const rpc = async (_method: string, params?: any) => {
    const name = params.name as string;
    called.push(name);
    const json = (value: unknown) => ({ structuredContent: value });
    if (name === "search_reports") return options.searchError ? { isError: true, content: [{ type: "text", text: "boom Account 1" }] } : json({ count: 1, reports: [{ id: "R1" }] });
    if (name === "run_report") return json({ report: { name: "Secret Name" } });
    if (name === "list_dashboards") return json({ count: options.dashboards, dashboards: options.dashboards ? [{ id: "D1" }] : [] });
    return json({ dashboard: { title: "Secret Title" } });
  };
  return { rpc, called };
}
const tools = DOOR_TOOLS.map((name) => ({ name, inputSchema: { properties: { reportId: {}, dashboardId: {}, maxRows: {}, limit: {} } } }));

describe("runSteps", () => {
  it("runs the report and dashboard steps, and refreshes and saves nothing", async () => {
    const { rpc, called } = fakeRpc({ dashboards: 1 });
    const steps = await runSteps(rpc, tools);
    expect(called).toEqual(["search_reports", "run_report", "list_dashboards", "describe_dashboard", "run_dashboard"]);
    expect(steps).toHaveLength(7);
    expect(steps.every((s) => s.ok)).toBe(true);
    expect(summaryLine(tools.length, steps)).toBe("mcp-check: tools=15 steps=7/7");
  });
  it("skips describe and run when no dashboard is listed", async () => {
    const { rpc, called } = fakeRpc({ dashboards: 0 });
    const steps = await runSteps(rpc, tools);
    expect(called).toEqual(["search_reports", "run_report", "list_dashboards"]);
    expect(steps).toHaveLength(5);
  });
  it("prints no name or id from the org in any step", async () => {
    const { rpc } = fakeRpc({ dashboards: 1 });
    const text = JSON.stringify(await runSteps(rpc, tools));
    for (const secret of ["Secret Name", "Secret Title", "R1", "D1"]) expect(text).not.toContain(secret);
  });
  it("fails the summary when a step fails, without echoing the error body", async () => {
    const { rpc } = fakeRpc({ dashboards: 0, searchError: true });
    const steps = await runSteps(rpc, tools);
    expect(JSON.stringify(steps)).not.toContain("Account 1");
    expect(summaryLine(15, steps)).toBe("mcp-check: tools=15 steps=3/5");
  });
  it("fails the tool-list step when one tool is missing", async () => {
    const { rpc } = fakeRpc({ dashboards: 0 });
    const steps = await runSteps(rpc, tools.slice(1));
    expect(steps[1]).toMatchObject({ ok: false, detail: "14 listed, 1 missing, 0 extra" });
  });
});
