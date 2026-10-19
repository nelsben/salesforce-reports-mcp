/**
 * Check the hosted MCP door: the Salesforce Reports server that salesforce/scripts/mcp-setup.ts wires up.
 * Usage: npm run mcp-check -- --org <alias> [--auth <cli alias>] [--url <endpoint>] [--dump <file>]
 *
 * The bearer token is an access token with the mcp_api scope, from the External Client App's OAuth flow (the
 * CLI's own token is refused). SF_MCP_TOKEN wins when set. Otherwise --auth reads it from
 * `sf org auth show-access-token --json --target-org <alias>`, a CLI sign-in made through that app.
 * --org finds the endpoint in the org's API Catalog through the Salesforce CLI; --url gives it directly.
 * The check requires the fifteen door tool names exactly, calls search_reports and run_report, then
 * list_dashboards and, when one is listed, describe_dashboard and run_dashboard. It refreshes and saves nothing.
 * It prints counts only, and no token. --dump writes the hosted tools/list result to a file.
 * The logic lives in scripts/mcp-check-lib.ts.
 */
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Org, SERVER } from "../salesforce/scripts/org.js";
import { resolveToken, runSteps, summaryLine, NO_TOKEN_MESSAGE, type Json, type SfRunner } from "./mcp-check-lib.js";

process.on("uncaughtException", (error) => {
  console.error(`FAIL  ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

const { values } = parseArgs({ options: { org: { type: "string" }, url: { type: "string" }, auth: { type: "string" }, dump: { type: "string" } }, strict: true });
if (!process.env.SF_MCP_TOKEN && !values.auth) {
  console.error(NO_TOKEN_MESSAGE);
  process.exit(2);
}
if (!values.org && !values.url) {
  console.error("Pass --org <alias> (to find the endpoint in the org's API Catalog) or --url <endpoint>. There is no default org.");
  process.exit(2);
}

/** Runs `sf` through execFile, never a shell. Its output goes only to the caller. */
const runSf: SfRunner = (args) =>
  new Promise((resolve) => {
    execFile("sf", args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, stdout: String(stdout) });
    });
  });

const token = await resolveToken({ env: process.env.SF_MCP_TOKEN, auth: values.auth, run: runSf });

async function endpoint(): Promise<string> {
  if (values.url) return values.url;
  const org = new Org(values.org!);
  const server = await org.server();
  if (!server) throw new Error(`The org has no McpServerDefinition named ${SERVER}.`);
  const entry = await org.catalogServer(server.Id);
  if (!entry?.serverUrl) throw new Error(`The API Catalog has no endpoint for ${SERVER}.`);
  if (!entry.isActive) console.log("Note: the API Catalog says the server is not active. Run salesforce/scripts/mcp-setup.ts.");
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

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp-check", version: "0.0.0" } });
console.log(`Protocol ${init?.protocolVersion ?? "?"}`);
await rpc("notifications/initialized", undefined, true);

const { tools } = await rpc("tools/list", {});
if (values.dump) writeFileSync(values.dump, JSON.stringify(tools, null, 2));
const steps = await runSteps((method, params) => rpc(method, params), tools as Json[]);
for (const step of steps) console.log(`${step.ok ? "PASS" : "FAIL"}  ${step.label}${step.detail ? `: ${step.detail}` : ""}`);
console.log(summaryLine(tools.length, steps));
process.exit(steps.every((s) => s.ok) ? 0 : 1);
