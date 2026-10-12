/**
 * Removes what mcp-setup.ts writes: the eight door tools' McpServerToolApiDefinition and McpServerToolDefinition
 * rows on the Salesforce Reports server, and the server's McpServerAccess row. Metadata (the server, the
 * registration, the permission set, the classes) stays; remove it with the destructive manifest.
 *
 * Usage, from the repo root:  npx tsx salesforce/scripts/mcp-teardown.ts --org <alias> [--yes]
 */
import { DOOR_TOOLS } from "./door-tools.js";
import { announce, Org, orgFromArgs, SERVER, type Json } from "./org.js";

const org = new Org(orgFromArgs("npx tsx salesforce/scripts/mcp-teardown.ts --org <alias> [--yes]"));
await announce(org);

const server = await org.server();
if (!server) {
  console.log(`The org has no McpServerDefinition named ${SERVER}. Nothing to remove.`);
  process.exit(0);
}

const names = DOOR_TOOLS.map((t) => `'${t}'`).join(", ");
const tools: Json[] = await org.tooling(`SELECT Id, ToolName FROM McpServerToolDefinition WHERE McpServerId = '${server.Id}' AND ToolName IN (${names})`);
let apiCount = 0;
for (const tool of tools) {
  const apis: Json[] = await org.tooling(`SELECT Id FROM McpServerToolApiDefinition WHERE ToolId = '${tool.Id}'`);
  for (const api of apis) await org.remove("McpServerToolApiDefinition", api.Id);
  apiCount += apis.length;
  await org.remove("McpServerToolDefinition", tool.Id);
}
const access: Json[] = await org.tooling(`SELECT Id FROM McpServerAccess WHERE McpServerId = '${server.Id}'`);
for (const row of access) await org.remove("McpServerAccess", row.Id);

console.log(`Org ${org.alias}, server ${SERVER}: removed ${tools.length} tool rows, ${apiCount} tool API rows, ${access.length} access rows.`);
const left: Json[] = await org.tooling(`SELECT ToolName FROM McpServerToolDefinition WHERE McpServerId = '${server.Id}'`);
if (left.length) console.log(`Still on the server (not door tools, left alone): ${left.map((r) => r.ToolName).join(", ")}`);
