import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { doorTools } from "../salesforce/scripts/door-tools.js";
import { registrationXml, serverXml } from "../salesforce/scripts/generate-metadata.js";

// docs/decisions/0009: two shipping units. force-app is the REST door alone; mcp-app adds the hosted MCP
// metadata on top of it and holds no code.
const root = join(__dirname, "..", "salesforce");
const forceApp = join(root, "force-app");
const mcpApp = join(root, "mcp-app");

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [relative(root, path)];
  });
}

const MCP_METADATA = /\.(externalServiceRegistration|mcpServerDefinition|eca|ecaGlblOauth|ecaOauth)-meta\.xml$/;
const CODE = /\.(cls|trigger)(-meta\.xml)?$/;
const WRITE_SENTENCES = "In the org, this tool needs the permission set Salesforce_Reports_MCP_Write. Without it, the call answers WRITE_NOT_ALLOWED.";

describe("Salesforce packages", () => {
  it("sfdx-project.json lists exactly force-app (default) and mcp-app", () => {
    const project = JSON.parse(readFileSync(join(root, "sfdx-project.json"), "utf8"));
    expect(project.packageDirectories).toEqual([
      { path: "force-app", default: true },
      { path: "mcp-app", default: false },
    ]);
  });

  it("force-app holds the REST door and no hosted MCP metadata", () => {
    const all = files(forceApp);
    expect(all).toContain("force-app/main/default/classes/ReportsApi.cls");
    expect(all.filter((f) => MCP_METADATA.test(f))).toEqual([]);
    const folders = readdirSync(join(forceApp, "main", "default")).sort();
    expect(folders).toEqual(["classes", "customPermissions", "permissionsets"]);
  });

  it("mcp-app holds the registration, the server and the External Client App, and no code", () => {
    const all = files(mcpApp);
    expect(all.filter((f) => CODE.test(f))).toEqual([]);
    expect(all.sort()).toEqual([
      "mcp-app/main/default/externalClientApps/SalesforceReportsMcp.eca-meta.xml",
      "mcp-app/main/default/externalServiceRegistrations/ReportsApi.externalServiceRegistration-meta.xml",
      "mcp-app/main/default/extlClntAppGlobalOauthSets/SalesforceReportsMcp.ecaGlblOauth-meta.xml",
      "mcp-app/main/default/extlClntAppOauthSettings/SalesforceReportsMcp.ecaOauth-meta.xml",
      "mcp-app/main/default/mcpServerDefinitions/SalesforceReports.mcpServerDefinition-meta.xml",
    ]);
  });

  it("the old eca folder is gone", () => {
    expect(existsSync(join(root, "eca"))).toBe(false);
  });

  it("the committed registration and server match what generate-metadata.ts writes", async () => {
    const tools = await doorTools();
    const committed = (path: string) => readFileSync(join(mcpApp, "main", "default", path), "utf8");
    expect(committed("externalServiceRegistrations/ReportsApi.externalServiceRegistration-meta.xml")).toBe(registrationXml(tools));
    expect(committed("mcpServerDefinitions/SalesforceReports.mcpServerDefinition-meta.xml")).toBe(serverXml(tools));
  });

  it("only the three save tools name the write permission set in their door description", async () => {
    const tools = await doorTools();
    for (const tool of tools) {
      const save = ["create_report", "update_report", "clone_report"].includes(tool.name);
      expect(tool.description.endsWith(` ${WRITE_SENTENCES}`), tool.name).toBe(save);
    }
  });
});
