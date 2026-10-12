import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// docs/decisions/0003: the in-org core never names its REST adapter, and only the adapter sets HTTP status codes.
const classes = join(__dirname, "..", "salesforce", "force-app", "main", "default", "classes");
const core = readdirSync(classes).filter((f) => f.endsWith(".cls") && !f.endsWith("Test.cls") && f !== "ReportsApi.cls");
const source = (f: string) => readFileSync(join(classes, f), "utf8");

describe("Apex layers", () => {
  it("finds the core classes", () => {
    expect(core).toContain("ReportsService.cls");
  });

  it.each(core)("%s does not name ReportsApi", (f) => {
    expect(source(f)).not.toMatch(/\bReportsApi\s*[.(]/);
  });

  it.each(core.filter((f) => f !== "ReportsCallout.cls"))("%s sets no HTTP status", (f) => {
    expect(source(f)).not.toMatch(/statusCode|RestContext/);
  });
});
