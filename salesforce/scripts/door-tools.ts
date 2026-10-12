/**
 * The tools on the in-org door, read from the local server's own tool list, so names, descriptions and
 * input schemas cannot drift from src/server.ts. Used by the registration generator, the MCP setup script
 * and scripts/mcp-check.ts.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ReportsApi } from "../../src/reports/api.js";
import type { SalesforceApi } from "../../src/salesforce/client.js";
import { buildServer } from "../../src/server.js";

/**
 * The eleven tools ReportsApi answers, in the order the door lists them: the six phase 1 tools, list_report_types
 * and query_report, which call the org's own REST API (phase 3a), and the three save tools (phase 3b), which also
 * need the Reports_Write custom permission. delete_report stays on the local server only.
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
  "create_report",
  "update_report",
  "clone_report",
] as const;

/** The save tools, which need the Reports_Write custom permission in the org. */
export const SAVE_TOOLS: readonly string[] = ["create_report", "update_report", "clone_report"];

/** Added after a save tool's local description on the door: the OpenAPI operation, the server, the tool row. */
export const WRITE_PERMISSION_SENTENCES =
  "In the org, this tool needs the permission set Salesforce_Reports_Write. Without it, the call answers WRITE_NOT_ALLOWED.";

/** A tool's description on the door: the local description, plus the write permission sentences for a save tool. */
export function doorDescription(name: string, local: string): string {
  return SAVE_TOOLS.includes(name) ? `${local} ${WRITE_PERMISSION_SENTENCES}` : local;
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
