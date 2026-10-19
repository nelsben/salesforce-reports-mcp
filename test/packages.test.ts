import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { CALLOUT_NAME, CALLOUT_PERMISSION_SET, FILES, PLACEHOLDERS } from "../salesforce/scripts/callout-app.js";
import { doorTools } from "../salesforce/scripts/door-tools.js";
import { registrationXml, serverXml } from "../salesforce/scripts/generate-metadata.js";

// docs/decisions/0009: force-app is the REST door alone; mcp-app adds the hosted MCP metadata on top of it and holds
// no code. docs/decisions/0012: callout-app is optional, holds no code, and force-app never depends on it.
const root = join(__dirname, "..", "salesforce");
const forceApp = join(root, "force-app");
const mcpApp = join(root, "mcp-app");
const calloutApp = join(root, "callout-app");

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [relative(root, path)];
  });
}

const MCP_METADATA = /\.(externalServiceRegistration|mcpServerDefinition|eca|ecaGlblOauth|ecaOauth)-meta\.xml$/;
const CODE = /\.(cls|trigger)(-meta\.xml)?$/;
const WRITE_SENTENCES = "In the org, this tool needs the permission set Salesforce_Reports_Write. Without it, the call answers WRITE_NOT_ALLOWED.";

describe("Salesforce packages", () => {
  it("sfdx-project.json lists exactly force-app (default), mcp-app and callout-app, in that order", () => {
    const project = JSON.parse(readFileSync(join(root, "sfdx-project.json"), "utf8"));
    expect(project.packageDirectories).toEqual([
      { path: "force-app", default: true },
      { path: "mcp-app", default: false },
      { path: "callout-app", default: false },
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

  it("callout-app holds the certificate, the External Client App, the credentials and the permission set, and no code", () => {
    const all = files(calloutApp);
    expect(all.filter((f) => CODE.test(f))).toEqual([]);
    const d = "callout-app/main/default";
    expect(all.sort()).toEqual([
      `${d}/certs/${CALLOUT_NAME}.crt`,
      `${d}/certs/${CALLOUT_NAME}.crt-meta.xml`,
      `${d}/externalClientApps/${CALLOUT_NAME}.eca-meta.xml`,
      `${d}/externalCredentials/${CALLOUT_NAME}.externalCredential-meta.xml`,
      `${d}/extlClntAppGlobalOauthSets/${CALLOUT_NAME}.ecaGlblOauth-meta.xml`,
      `${d}/extlClntAppOauthPolicies/${CALLOUT_NAME}.ecaOauthPlcy-meta.xml`,
      `${d}/extlClntAppOauthSettings/${CALLOUT_NAME}.ecaOauth-meta.xml`,
      `${d}/extlClntAppPolicies/${CALLOUT_NAME}.ecaPlcy-meta.xml`,
      `${d}/namedCredentials/${CALLOUT_NAME}.namedCredential-meta.xml`,
      `${d}/permissionsets/${CALLOUT_PERMISSION_SET}.permissionset-meta.xml`,
    ]);
  });

  it("force-app never depends on callout-app: no force-app metadata names its components, and Apex names the credential only in strings", () => {
    const names = [CALLOUT_NAME, CALLOUT_PERMISSION_SET];
    for (const f of files(forceApp).filter((f) => f.endsWith("-meta.xml"))) {
      const xml = readFileSync(join(root, f), "utf8");
      for (const name of names) expect(xml.includes(name), `${f} names ${name}`).toBe(false);
    }
    const callout = readFileSync(join(forceApp, "main", "default", "classes", "ReportsCallout.cls"), "utf8");
    expect(callout).toContain(`'${CALLOUT_NAME}'`);
    expect(callout).toContain(`'${CALLOUT_PERMISSION_SET}'`);
    // No compile-time reference: the credential's presence is read with a query, and its name is a string.
    expect(callout).toMatch(/FROM NamedCredential WHERE DeveloperName = :CREDENTIAL/);
    for (const f of files(forceApp).filter((f) => f.endsWith(".cls") && !f.endsWith("Test.cls") && !f.endsWith("ReportsCallout.cls"))) {
      expect(readFileSync(join(root, f), "utf8").includes(CALLOUT_NAME), f).toBe(false);
    }
  });

  it("callout-app holds placeholders only: no My Domain, consumer key or certificate body", () => {
    const d = join(calloutApp, "main", "default");
    expect(readFileSync(join(d, FILES.certificate), "utf8")).toBe("");
    expect(readFileSync(join(d, FILES.globalOauth), "utf8")).toContain(`<certificate>${PLACEHOLDERS.certificate}</certificate>`);
    for (const f of files(calloutApp)) {
      const text = readFileSync(join(root, f), "utf8");
      expect(text, f).not.toMatch(/BEGIN CERTIFICATE|PRIVATE KEY|\.my\.salesforce\.com|3MVG|00D[A-Za-z0-9]{12}/);
      expect(text, f).not.toMatch(/consumerSecret|consumerKey>/);
    }
  });

  it("the external credential keeps the probe's working claims: iss and sub unquoted, aud quoted, a per-user principal", () => {
    const xml = readFileSync(join(calloutApp, "main", "default", FILES.externalCredential), "utf8");
    const claim = (name: string) => new RegExp(`<parameterName>${name}</parameterName>\\s*<parameterType>JwtBodyClaim</parameterType>\\s*<parameterValue>([^<]*)</parameterValue>`).exec(xml)?.[1];
    expect(claim("iss")).toBe(PLACEHOLDERS.consumerKey);
    expect(claim("sub")).toBe("{!$User.Username}");
    expect(claim("aud")).toBe(`&quot;${PLACEHOLDERS.audience}&quot;`);
    expect(xml).toMatch(/<parameterName>Oauth<\/parameterName>\s*<parameterType>AuthProtocolVariant<\/parameterType>\s*<parameterValue>JwtBearer<\/parameterValue>/);
    expect(xml).toMatch(/<parameterName>RunningUser<\/parameterName>\s*<parameterType>PerUserPrincipal<\/parameterType>/);
    expect(xml).toContain(`<certificate>${CALLOUT_NAME}</certificate>`);
    const scopes = readFileSync(join(calloutApp, "main", "default", `extlClntAppOauthSettings/${CALLOUT_NAME}.ecaOauth-meta.xml`), "utf8");
    expect(scopes).toContain("<commaSeparatedOauthScopes>Api, RefreshToken</commaSeparatedOauthScopes>");
    const permissionSet = readFileSync(join(calloutApp, "main", "default", `permissionsets/${CALLOUT_PERMISSION_SET}.permissionset-meta.xml`), "utf8");
    expect(permissionSet).toContain(`<externalCredentialPrincipal>${CALLOUT_NAME}-RunningUser</externalCredentialPrincipal>`);
    const policy = readFileSync(join(calloutApp, "main", "default", `extlClntAppOauthPolicies/${CALLOUT_NAME}.ecaOauthPlcy-meta.xml`), "utf8");
    expect(policy).toContain(`<commaSeparatedPermissionSet>${CALLOUT_PERMISSION_SET}</commaSeparatedPermissionSet>`);
    expect(policy).toContain("<permittedUsersPolicyType>AdminApprovedPreAuthorized</permittedUsersPolicyType>");
  });

  it("callout-app has its own removal manifest naming every component", () => {
    const manifest = join(root, "manifest", "callout-app");
    const pre = readFileSync(join(manifest, "destructiveChangesPre.xml"), "utf8");
    const post = readFileSync(join(manifest, "destructiveChanges.xml"), "utf8");
    const types = (xml: string) => [...xml.matchAll(/<members>([^<]+)<\/members>\s*<name>([^<]+)<\/name>/g)].map((m) => `${m[2]}:${m[1]}`).sort();
    expect(types(pre)).toEqual([
      `ExtlClntAppConfigurablePolicies:${CALLOUT_NAME}`,
      `ExtlClntAppGlobalOauthSettings:${CALLOUT_NAME}`,
      `ExtlClntAppOauthConfigurablePolicies:${CALLOUT_NAME}`,
      `ExtlClntAppOauthSettings:${CALLOUT_NAME}`,
      `NamedCredential:${CALLOUT_NAME}`,
      `PermissionSet:${CALLOUT_PERMISSION_SET}`,
    ]);
    expect(types(post)).toEqual([`Certificate:${CALLOUT_NAME}`, `ExternalClientApplication:${CALLOUT_NAME}`, `ExternalCredential:${CALLOUT_NAME}`]);
    expect(readFileSync(join(manifest, "package.xml"), "utf8")).not.toContain("<types>");
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

  it("only the three save tools and refresh_dashboard name the write permission set in their door description", async () => {
    const tools = await doorTools();
    for (const tool of tools) {
      const save = ["create_report", "update_report", "clone_report", "refresh_dashboard"].includes(tool.name);
      expect(tool.description.endsWith(` ${WRITE_SENTENCES}`), tool.name).toBe(save);
    }
  });
});
