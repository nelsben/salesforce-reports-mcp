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

/** The six phase 1 tools ReportsApi answers, in the order the door lists them. */
export const DOOR_TOOLS = ["search_reports", "list_report_folders", "describe_report", "describe_report_type", "run_report", "combine_reports"] as const;

export interface DoorTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}

/** The local server's tool list for the door tools. Nothing is called on Salesforce. */
export async function doorTools(): Promise<DoorTool[]> {
  const offline: SalesforceApi = {
    apiVersion: "62.0",
    instanceUrl: async () => "https://example.my.salesforce.com",
    request: async () => {
      throw new Error("The tool list needs no Salesforce call.");
    },
  };
  const server = buildServer(new ReportsApi(offline, async () => undefined), { readOnly: true, allowDelete: false, maxRows: 200 });
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
      description: tool.description ?? "",
      inputSchema: tool.inputSchema as Record<string, unknown>,
      annotations: tool.annotations ?? {},
    };
  });
}
