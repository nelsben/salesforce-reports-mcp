/**
 * Wires the eleven door tools onto the Salesforce Reports hosted MCP server, idempotently, and activates the
 * server. Run it after deploying salesforce/force-app (the classes and the permission sets), then salesforce/mcp-app
 * on top of it (the registration, the server and the External Client App).
 *
 * Usage, from the repo root:  npx tsx salesforce/scripts/mcp-setup.ts --org <alias> [--yes]
 *
 * For each tool it creates or updates one McpServerToolDefinition (ToolName, ToolTitle and DescriptionOverride
 * from the local server, with the write permission sentences on the save tools, and ReadOnly, Destructive,
 * Idempotent and OpenWorld from its annotations, so the save tools are not marked read-only) and its child
 * McpServerToolApiDefinition (API_CATALOG, ar:ReportsApi, the operation named after the tool). Then it creates
 * or updates the server's McpServerAccess row with Active true, and reports the API Catalog operations that
 * are still inactive (those are activated in Setup).
 */
import { doorTools, toolFlags } from "./door-tools.js";
import { announce, API_IDENTIFIER, API_SOURCE, Org, orgFromArgs, REGISTRATION, SERVER, type Json } from "./org.js";

const org = new Org(orgFromArgs("npx tsx salesforce/scripts/mcp-setup.ts --org <alias> [--yes]"));
await announce(org);

const server = await org.server();
if (!server) {
  console.error(`The org has no McpServerDefinition named ${SERVER}. Deploy the MCP door first, from salesforce/: sf project deploy start -d mcp-app -o ${org.alias} (after force-app)`);
  process.exit(1);
}
const registration = (await org.tooling(`SELECT Id, Status FROM ExternalServiceRegistration WHERE DeveloperName = '${REGISTRATION}'`))[0];
if (registration?.Status !== "Complete") {
  console.error(`The ExternalServiceRegistration ${REGISTRATION} is ${registration ? `"${registration.Status}"` : "missing"}. Deploy it first, from salesforce/: sf project deploy start -d mcp-app -o ${org.alias} (after force-app)`);
  process.exit(1);
}

const tools = await doorTools();
const existing: Json[] = await org.tooling(
  `SELECT Id, ToolName, ToolTitle, DescriptionOverride, ReadOnly, Destructive, Idempotent, OpenWorld FROM McpServerToolDefinition WHERE McpServerId = '${server.Id}'`,
);
const rows: string[][] = [];

for (const tool of tools) {
  const fields = {
    ToolName: tool.name,
    ToolTitle: tool.title,
    DescriptionOverride: tool.description,
    ...toolFlags(tool),
  };
  const found = existing.find((r) => r.ToolName === tool.name);
  let toolId: string;
  let toolAction = "unchanged";
  if (!found) {
    toolId = await org.create("McpServerToolDefinition", { McpServerId: server.Id, ...fields });
    toolAction = "created";
  } else {
    toolId = found.Id;
    if (Object.entries(fields).some(([k, v]) => found[k] !== v)) {
      await org.update("McpServerToolDefinition", toolId, fields);
      toolAction = "updated";
    }
  }

  const api = { ApiSource: API_SOURCE, ApiIdentifier: API_IDENTIFIER, Operation: tool.name };
  const apiRows: Json[] = await org.tooling(`SELECT Id, ApiSource, ApiIdentifier, Operation FROM McpServerToolApiDefinition WHERE ToolId = '${toolId}'`);
  let apiAction = "unchanged";
  if (!apiRows.length) {
    await org.create("McpServerToolApiDefinition", { ToolId: toolId, ...api });
    apiAction = "created";
  } else {
    const [first, ...extra] = apiRows;
    if (Object.entries(api).some(([k, v]) => first[k] !== v)) {
      await org.update("McpServerToolApiDefinition", first.Id, api);
      apiAction = "updated";
    }
    for (const row of extra) await org.remove("McpServerToolApiDefinition", row.Id);
    if (extra.length) apiAction += `, ${extra.length} extra removed`;
  }
  rows.push([tool.name, toolAction, apiAction]);
}

const others = existing.filter((r) => !tools.some((t) => t.name === r.ToolName)).map((r) => r.ToolName);

// Activate the server: its McpServerAccess row, keyed by the server id.
const access: Json[] = await org.tooling(`SELECT Id, DeveloperName, Active FROM McpServerAccess WHERE McpServerId = '${server.Id}'`);
let accessAction = "unchanged";
if (!access.length) {
  await org.create("McpServerAccess", { DeveloperName: SERVER, MasterLabel: "Salesforce Reports", Active: true, McpServerId: server.Id });
  accessAction = "created, active";
} else if (!access[0].Active) {
  await org.update("McpServerAccess", access[0].Id, { Active: true });
  accessAction = "activated";
}

console.log(`Org ${org.alias}, server ${SERVER} (${server.Id})\n`);
console.log("| Tool | McpServerToolDefinition | McpServerToolApiDefinition |");
console.log("| --- | --- | --- |");
for (const r of rows) console.log(`| ${r.join(" | ")} |`);
console.log(`\nServer access (McpServerAccess): ${accessAction}`);
if (others.length) console.log(`Other tools on this server, left alone: ${others.join(", ")}`);

const catalog = await org.catalogServer(server.Id);
if (catalog?.serverUrl) console.log(`Endpoint: ${catalog.serverUrl} (API Catalog says active: ${catalog.isActive})`);
const inactive = (await org.catalogOperations()).filter((o) => !o.isActive).map((o) => o.name);
if (inactive.length) {
  console.log(
    `\nAPI Catalog operations still inactive: ${inactive.join(", ")}.\nIf a tool call fails for that reason, activate them in Setup: API Catalog, ${REGISTRATION}, select the operations, Activate. No API sets this.`,
  );
} else {
  console.log("All API Catalog operations for the registration are active.");
}
