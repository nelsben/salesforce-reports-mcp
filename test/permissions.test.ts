import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// docs/decisions/0011: permissions are named for the capability, not for the door that calls.
const repo = join(__dirname, "..");
const forceApp = join(repo, "salesforce", "force-app", "main", "default");

function read(...parts: string[]): string {
  return readFileSync(join(repo, ...parts), "utf8");
}

function walk(path: string): string[] {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((name) => (name === "node_modules" ? [] : walk(join(path, name))));
}

describe("permission names", () => {
  it("force-app holds exactly the two permission sets and the one custom permission", () => {
    expect(readdirSync(join(forceApp, "permissionsets")).sort()).toEqual([
      "Salesforce_Reports.permissionset-meta.xml",
      "Salesforce_Reports_Write.permissionset-meta.xml",
    ]);
    expect(readdirSync(join(forceApp, "customPermissions"))).toEqual(["Reports_Write.customPermission-meta.xml"]);
  });

  it("the write set grants the custom permission", () => {
    const xml = read("salesforce/force-app/main/default/permissionsets/Salesforce_Reports_Write.permissionset-meta.xml");
    expect(xml).toMatch(/<customPermissions>\s*<enabled>true<\/enabled>\s*<name>Reports_Write<\/name>/);
  });

  it("ReportsService names them", () => {
    const cls = read("salesforce/force-app/main/default/classes/ReportsService.cls");
    expect(cls).toContain("WRITE_PERMISSION = 'Reports_Write'");
    expect(cls).toContain("WRITE_PERMISSION_SET = 'Salesforce_Reports_Write'");
  });

  it("the door sentence names the write set", () => {
    expect(read("salesforce/scripts/door-tools.ts")).toContain("the permission set Salesforce_Reports_Write.");
  });

  it("the removal manifests name the new members", () => {
    const pre = read("salesforce/manifest/force-app/destructiveChangesPre.xml");
    expect(pre).toContain("<members>Salesforce_Reports</members>");
    expect(pre).toContain("<members>Salesforce_Reports_Write</members>");
    expect(read("salesforce/manifest/force-app/destructiveChanges.xml")).toContain("<members>Reports_Write</members>");
  });

  it("the read set grants every core class, the dashboard readers among them", () => {
    const xml = read("salesforce/force-app/main/default/permissionsets/Salesforce_Reports.permissionset-meta.xml");
    const granted = [...xml.matchAll(/<apexClass>([^<]+)<\/apexClass>\s*<enabled>true<\/enabled>/g)].map((m) => m[1]).sort();
    const classes = readdirSync(join(forceApp, "classes"))
      .filter((f) => f.endsWith(".cls") && !f.endsWith("Test.cls"))
      .map((f) => f.replace(/\.cls$/, ""))
      .sort();
    expect(classes).toContain("ReportsDashboards");
    expect(granted).toEqual(classes);
  });

  it("the removal manifest names every class, the dashboard readers and their test among them", () => {
    const post = read("salesforce/manifest/force-app/destructiveChanges.xml");
    const listed = [...post.matchAll(/<members>([^<]+)<\/members>/g)].map((m) => m[1]);
    const classes = readdirSync(join(forceApp, "classes")).filter((f) => f.endsWith(".cls")).map((f) => f.replace(/\.cls$/, ""));
    expect(classes).toContain("ReportsDashboards");
    expect(classes).toContain("ReportsDashboardsTest");
    for (const c of classes) expect(listed, c).toContain(c);
  });

  it("no shipped file still uses the old names", () => {
    const old = /Salesforce_Reports_MCP|Reports_MCP_Write/;
    const paths = [
      "salesforce/force-app", "salesforce/mcp-app", "salesforce/manifest", "salesforce/scripts",
      "src", "skills", "scripts", "salesforce/README.md", "README.md", "docs/architecture.md", "docs/design.md",
    ].flatMap((p) => walk(join(repo, p)));
    const hits = paths.filter((p) => old.test(readFileSync(p, "utf8")));
    expect(hits).toEqual([]);
  });
});
