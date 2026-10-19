/**
 * Check the hosted MCP door: the Salesforce Reports server that salesforce/scripts/mcp-setup.ts wires up.
 * Usage: SF_MCP_TOKEN=<token> npm run mcp-check -- --org <alias> [--url <endpoint>] [--dump <file>]
 *
 * The bearer token comes only from SF_MCP_TOKEN: an access token with the mcp_api scope, from the External
 * Client App's OAuth flow (the CLI's own token is refused). --org finds the endpoint in the org's API Catalog
 * through the Salesforce CLI; --url gives it directly. The check calls tools/list, requires the door tool
 * names exactly, then calls search_reports and run_report on a report it finds. It prints no token.
 * --dump writes the hosted tools/list result to a file, for the findings doc.
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { DOOR_TOOLS } from "../salesforce/scripts/door-tools.js";
import { Org, SERVER } from "../salesforce/scripts/org.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

process.on("uncaughtException", (error) => {
  console.error(`FAIL  ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

const { values } = parseArgs({ options: { org: { type: "string" }, url: { type: "string" }, dump: { type: "string" } }, strict: true });
const token = process.env.SF_MCP_TOKEN;
if (!token) {
  console.error("Set SF_MCP_TOKEN to an access token with the mcp_api scope. The check never prints it.");
  process.exit(2);
}
if (!values.org && !values.url) {
  console.error("Pass --org <alias> (to find the endpoint in the org's API Catalog) or --url <endpoint>. There is no default org.");
  process.exit(2);
}

async function endpoint(): Promise<string> {
  if (values.url) return values.url;
  const org = new Org(values.org!);
  const server = await org.server();
  if (!server) throw new Error(`The org has no McpServerDefinition named ${SERVER}.`);
  const entry = await org.catalogServer(server.Id);
  if (!entry?.serverUrl) throw new Error(`The API Catalog has no endpoint for ${SERVER}.`);
  if (!entry.isActive) console.log(`Note: the API Catalog says ${SERVER} is not active. Run salesforce/scripts/mcp-setup.ts.`);
  return entry.serverUrl;
}

const url = await endpoint();
let sessionId: string | undefined;
let nextId = 1;

/** One JSON-RPC call over streamable HTTP. Answers with the result, or throws with the status and body. */
async function rpc(method: string, params?: Json, notify = false): Promise<Json> {
  const message: Json = { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) };
  if (!notify) message.id = nextId++;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    },
    body: JSON.stringify(message),
  });
  sessionId = response.headers.get("mcp-session-id") ?? sessionId;
  const text = await response.text();
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status} ${text.slice(0, 500)}`);
  if (notify) return undefined;
  const type = response.headers.get("content-type") ?? "";
  const payloads = type.includes("text/event-stream")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => JSON.parse(line.slice(5)))
    : [JSON.parse(text)];
  const reply = payloads.find((p) => p.id === message.id);
  if (!reply) throw new Error(`${method}: no reply in ${text.slice(0, 500)}`);
  if (reply.error) throw new Error(`${method}: ${JSON.stringify(reply.error)}`);
  return reply.result;
}

let failed = false;
function check(ok: boolean, label: string, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `: ${detail}` : ""}`);
  if (!ok) failed = true;
}

/** The tool's arguments, wrapped if the hosted schema nests the request body under one property. */
function argsFor(tool: Json, args: Record<string, unknown>): Record<string, unknown> {
  const props = Object.keys(tool?.inputSchema?.properties ?? {});
  if (Object.keys(args).every((k) => props.includes(k))) return args;
  if (props.length === 1) return { [props[0]!]: args };
  return args;
}

/** The JSON body a tool call returns: structured content, or the text content parsed. */
function body(result: Json): Json {
  if (result?.structuredContent) return result.structuredContent;
  const text = result?.content?.find((c: Json) => c.type === "text")?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

console.log(`Endpoint: ${url}`);
const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp-check", version: "0.0.0" } });
console.log(`Server: ${init?.serverInfo?.name ?? "?"} ${init?.serverInfo?.version ?? ""}, protocol ${init?.protocolVersion}`);
await rpc("notifications/initialized", undefined, true);

const { tools } = await rpc("tools/list", {});
if (values.dump) writeFileSync(values.dump, JSON.stringify(tools, null, 2));
const names: string[] = tools.map((t: Json) => t.name).sort();
const expected = [...DOOR_TOOLS].sort();
check(expected.length === 15, "the door lists 15 tools", String(expected.length));
check(JSON.stringify(names) === JSON.stringify(expected), "tools/list has the door tools exactly", names.join(", "));
for (const t of tools) console.log(`      ${t.name}: input ${Object.keys(t.inputSchema?.properties ?? {}).join(", ") || "(none)"}`);
const byName = (name: string) => tools.find((t: Json) => t.name === name);

const search = await rpc("tools/call", { name: "search_reports", arguments: argsFor(byName("search_reports"), { limit: 5 }) });
const found = body(search);
const reportId: string | undefined = found?.reports?.[0]?.id;
check(!search.isError && typeof found?.count === "number", "search_reports answers", `${found?.count ?? "?"} reports${search.isError ? `, error ${JSON.stringify(found).slice(0, 300)}` : ""}`);

if (reportId) {
  const run = await rpc("tools/call", { name: "run_report", arguments: argsFor(byName("run_report"), { reportId, maxRows: 5 }) });
  const result = body(run);
  check(!run.isError && Boolean(result?.report), "run_report answers", run.isError ? JSON.stringify(result).slice(0, 300) : `${result?.report?.name ?? reportId}, ${result?.report?.format ?? "?"}`);
} else {
  check(false, "run_report answers", "search_reports found no report to run");
}

process.exit(failed ? 1 : 0);
