import { describe, expect, it } from "vitest";
import { DOOR_TOOLS } from "../salesforce/scripts/door-tools.js";
import { compareTools, NO_TOKEN_MESSAGE, resolveToken, runSteps, showTokenArgs, summaryLine, type SfRunner } from "../scripts/mcp-check-lib.js";

const SECRET = "fake-token-value-not-real";

function runner(result: { code: number; stdout: string }) {
  const calls: string[][] = [];
  const run: SfRunner = async (args) => {
    calls.push(args);
    return result;
  };
  return { run, calls };
}

describe("resolveToken", () => {
  it("lets SF_MCP_TOKEN win and does not call sf", async () => {
    const { run, calls } = runner({ code: 0, stdout: JSON.stringify({ result: { accessToken: "from-cli" } }) });
    expect(await resolveToken({ env: "from-env", auth: "alias", run })).toBe("from-env");
    expect(calls).toHaveLength(0);
  });

  it("reads the token from sf org auth show-access-token with the alias", async () => {
    const { run, calls } = runner({ code: 0, stdout: JSON.stringify({ status: 0, result: { accessToken: SECRET } }) });
    expect(await resolveToken({ env: undefined, auth: "my-alias", run })).toBe(SECRET);
    expect(calls).toEqual([["org", "auth", "show-access-token", "--json", "--target-org", "my-alias"]]);
    expect(showTokenArgs("my-alias")).toEqual(calls[0]);
  });

  it("refuses with neither source, naming both ways", async () => {
    const { run } = runner({ code: 0, stdout: "" });
    const error = await resolveToken({ env: undefined, auth: undefined, run }).catch((e: Error) => e);
    expect((error as Error).message).toBe(NO_TOKEN_MESSAGE);
    expect((error as Error).message).toContain("SF_MCP_TOKEN");
    expect((error as Error).message).toContain("--auth");
  });

  it("reports only the exit code when sf fails, never its output", async () => {
    const { run } = runner({ code: 3, stdout: `error with ${SECRET}` });
    const error = (await resolveToken({ env: undefined, auth: "a", run }).catch((e: Error) => e)) as Error;
    expect(error.message).toContain("exit code 3");
    expect(error.message).not.toContain(SECRET);
  });

  it("does not echo output that has no token", async () => {
    const { run } = runner({ code: 0, stdout: `not json ${SECRET}` });
    const error = (await resolveToken({ env: undefined, auth: "a", run }).catch((e: Error) => e)) as Error;
    expect(error.message).toContain("no access token");
    expect(error.message).not.toContain(SECRET);
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
