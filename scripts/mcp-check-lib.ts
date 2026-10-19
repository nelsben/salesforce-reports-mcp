/**
 * The logic behind scripts/mcp-check.ts, with no side effects at import: where the bearer token comes from,
 * how the tool list is compared, and the steps the check runs. The runner for `sf` and the `rpc` are injected,
 * so tests need no network and no real `sf`.
 */
import { DOOR_TOOLS } from "../salesforce/scripts/door-tools.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

/** Runs `sf` with the given arguments and answers its exit code and stdout. It never throws. */
export type SfRunner = (args: string[]) => Promise<{ code: number; stdout: string }>;
export type Rpc = (method: string, params?: Json) => Promise<Json>;
export interface StepResult {
  ok: boolean;
  label: string;
  detail: string;
}

/** The refusal when no token source is given. It names both ways. */
export const NO_TOKEN_MESSAGE =
  "No token. Set SF_MCP_TOKEN to an access token with the mcp_api scope, or pass --auth <alias> to read one from a Salesforce CLI sign-in. The check never prints it.";

/** The arguments `sf` gets to print the access token of a signed-in alias. */
export function showTokenArgs(alias: string): string[] {
  return ["org", "auth", "show-access-token", "--json", "--target-org", alias];
}

/**
 * The bearer token. SF_MCP_TOKEN wins when set. Otherwise --auth reads it from the CLI. A failed call says only that
 * it failed and the exit code: the output of `sf` is never put in a message.
 */
export async function resolveToken(options: { env: string | undefined; auth: string | undefined; run: SfRunner }): Promise<string> {
  if (options.env) return options.env;
  if (!options.auth) throw new Error(NO_TOKEN_MESSAGE);
  const { code, stdout } = await options.run(showTokenArgs(options.auth));
  if (code !== 0) throw new Error(`sf org auth show-access-token failed (exit code ${code}).`);
  let token: unknown;
  try {
    token = JSON.parse(stdout)?.result?.accessToken;
  } catch {
    token = undefined;
  }
  if (typeof token !== "string" || !token) throw new Error("sf org auth show-access-token returned no access token.");
  return token;
}

/** Compares the listed tool names with the door tools. Counts only: the check prints no name from the org. */
export function compareTools(listed: readonly string[], expected: readonly string[] = DOOR_TOOLS): { ok: boolean; missing: number; extra: number } {
  const have = new Set(listed);
  const want = new Set(expected);
  const missing = [...want].filter((n) => !have.has(n)).length;
  const extra = [...have].filter((n) => !want.has(n)).length;
  return { ok: missing === 0 && extra === 0 && listed.length === expected.length, missing, extra };
}

/** The last line of the check. */
export function summaryLine(tools: number, steps: readonly StepResult[]): string {
  return `mcp-check: tools=${tools} steps=${steps.filter((s) => s.ok).length}/${steps.length}`;
}

/** The tool's arguments, wrapped if the hosted schema nests the request body under one property. */
export function argsFor(tool: Json, args: Record<string, unknown>): Record<string, unknown> {
  const props = Object.keys(tool?.inputSchema?.properties ?? {});
  if (Object.keys(args).every((k) => props.includes(k))) return args;
  if (props.length === 1) return { [props[0]!]: args };
  return args;
}

/** The JSON body a tool call returns: structured content, or the text content parsed. */
export function body(result: Json): Json {
  if (result?.structuredContent) return result.structuredContent;
  const text = result?.content?.find((c: Json) => c.type === "text")?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * The steps after tools/list: the tool list, then search_reports and run_report, then list_dashboards and, when one
 * is listed, describe_dashboard and run_dashboard on the first. Nothing is refreshed or saved. Details are counts.
 */
export async function runSteps(rpc: Rpc, tools: Json[]): Promise<StepResult[]> {
  const steps: StepResult[] = [];
  const add = (ok: boolean, label: string, detail = "") => steps.push({ ok, label, detail });
  const byName = (name: string) => tools.find((t) => t.name === name);
  const call = (name: string, args: Record<string, unknown>) => rpc("tools/call", { name, arguments: argsFor(byName(name), args) });
  const failure = (result: Json) => (result?.isError ? "the tool answered an error" : "");

  const cmp = compareTools(tools.map((t) => t.name));
  add(DOOR_TOOLS.length === 15, "the door lists 15 tools", String(DOOR_TOOLS.length));
  add(cmp.ok, "tools/list has the door tools exactly", `${tools.length} listed, ${cmp.missing} missing, ${cmp.extra} extra`);

  const search = await call("search_reports", { limit: 5 });
  const found = body(search);
  const reportId: string | undefined = found?.reports?.[0]?.id;
  add(!search.isError && typeof found?.count === "number", "search_reports answers", search.isError ? failure(search) : `${found?.count ?? "?"} reports`);

  if (reportId) {
    const run = await call("run_report", { reportId, maxRows: 5 });
    add(!run.isError && Boolean(body(run)?.report), "run_report answers", failure(run));
  } else {
    add(false, "run_report answers", "search_reports found no report to run");
  }

  const list = await call("list_dashboards", { limit: 5 });
  const listed = body(list);
  const dashboardId: string | undefined = listed?.dashboards?.[0]?.id;
  add(!list.isError && typeof listed?.count === "number", "list_dashboards answers", list.isError ? failure(list) : `${listed?.count ?? "?"} dashboards`);

  if (dashboardId) {
    const describe = await call("describe_dashboard", { dashboardId });
    add(!describe.isError && typeof body(describe) === "object", "describe_dashboard answers", failure(describe));
    const run = await call("run_dashboard", { dashboardId, maxRows: 5 });
    add(!run.isError && typeof body(run) === "object", "run_dashboard answers", failure(run));
  }
  return steps;
}
