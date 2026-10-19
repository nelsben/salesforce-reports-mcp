/**
 * The tools on the in-org door, read from the local server's own tool list, so names, descriptions and
 * input schemas cannot drift from src/server.ts. Used by the registration generator, the MCP setup script
 * and scripts/mcp-check.ts.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ReportsApi } from "../../src/reports/api.js";
import type { SalesforceApi } from "../../src/salesforce/client.js";
import { buildServer, DASHBOARD_VIEW_HINT, VIEW_HINT } from "../../src/server.js";

/**
 * The fifteen tools ReportsApi answers, in the order the local server lists them: the six phase 1 tools, list_report_types
 * and query_report, which call the org's own REST API (phase 3a), the three dashboard readers, the three save tools
 * (phase 3b) and refresh_dashboard, which also need the Reports_Write custom permission. delete_report stays on the
 * local server only.
 */
export const DOOR_TOOLS = [
  "search_reports",
  "list_report_folders",
  "list_report_types",
  "describe_report",
  "describe_report_type",
  "run_report",
  "query_report",
  "combine_reports",
  "list_dashboards",
  "describe_dashboard",
  "run_dashboard",
  "create_report",
  "update_report",
  "clone_report",
  "refresh_dashboard",
] as const;

/** The tools that need the Reports_Write custom permission in the org: the save tools and the dashboard refresh. */
export const SAVE_TOOLS: readonly string[] = ["create_report", "update_report", "clone_report", "refresh_dashboard"];

/** The local refresh wait, and what the in-org door waits instead (20 back-to-back polls or about 30 seconds). */
const LOCAL_REFRESH_WAIT = "It waits up to 60 seconds for the refresh to finish.";
const DOOR_REFRESH_WAIT = "It waits up to 20 status checks or about 30 seconds for the refresh to finish, then returns the cached results with a note to call run_dashboard in a minute.";

/** Added after a save tool's local description on the door: the OpenAPI operation, the server, the tool row. */
export const WRITE_PERMISSION_SENTENCES =
  "In the org, this tool needs the permission set Salesforce_Reports_Write. Without it, the call answers WRITE_NOT_ALLOWED.";

/**
 * A tool's description on the door: the local description without the report and dashboard view hints (the hosted
 * door draws no card), the in-org refresh wait, plus the write permission sentences for a write tool.
 */
export function doorDescription(name: string, local: string): string {
  let base = local;
  for (const hint of [VIEW_HINT, DASHBOARD_VIEW_HINT]) if (base.endsWith(hint)) base = base.slice(0, -hint.length);
  base = base.replace(LOCAL_REFRESH_WAIT, DOOR_REFRESH_WAIT);
  return SAVE_TOOLS.includes(name) ? `${base} ${WRITE_PERMISSION_SENTENCES}` : base;
}

export interface DoorTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}

/** The hosted tool row flags, from the local server's annotations (MCP's defaults where one is missing). */
export function toolFlags(tool: DoorTool): { ReadOnly: boolean; Destructive: boolean; Idempotent: boolean; OpenWorld: boolean } {
  const a = tool.annotations;
  return {
    ReadOnly: a.readOnlyHint ?? false,
    Destructive: a.destructiveHint ?? true,
    Idempotent: a.idempotentHint ?? false,
    OpenWorld: a.openWorldHint ?? true,
  };
}

/**
 * The local server's tool list for the door tools, with each tool's door description. Nothing is called on
 * Salesforce.
 */
export async function doorTools(): Promise<DoorTool[]> {
  const offline: SalesforceApi = {
    apiVersion: "62.0",
    instanceUrl: async () => "https://example.my.salesforce.com",
    request: async () => {
      throw new Error("The tool list needs no Salesforce call.");
    },
  };
  const server = buildServer(new ReportsApi(offline, async () => undefined), { readOnly: false, allowDelete: false, maxRows: 200 });
  const client = new Client({ name: "door-tools", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const { tools } = await client.listTools();
  await client.close();
  return DOOR_TOOLS.map((name) => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`The local server has no tool named ${name}.`);
    return {
      name,
      title: tool.title ?? tool.annotations?.title ?? name,
      description: doorDescription(name, tool.description ?? ""),
      inputSchema: tool.inputSchema as Record<string, unknown>,
      annotations: tool.annotations ?? {},
    };
  });
}
