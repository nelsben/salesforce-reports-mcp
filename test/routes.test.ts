import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DOOR_TOOLS, doorTools } from "../salesforce/scripts/door-tools.js";
import { openApiDocument } from "../salesforce/scripts/generate-metadata.js";

// docs/decisions/0007: the hosted MCP door has its own route, /reports/v1/mcp/<tool>, so ReportsApi knows the
// caller has no session before it asks for one. The REST door stays at /reports/v1/<tool>.
const registration = join(
  __dirname,
  "..",
  "salesforce",
  "mcp-app",
  "main",
  "default",
  "externalServiceRegistrations",
  "ReportsApi.externalServiceRegistration-meta.xml",
);

const expected = DOOR_TOOLS.map((tool) => `/reports/v1/mcp/${tool}`);

describe("The hosted MCP door's route", () => {
  it("the generated OpenAPI document puts one operation per door tool at /reports/v1/mcp/<tool>", async () => {
    const doc = openApiDocument(await doorTools());
    expect(Object.keys(doc.paths)).toEqual(expected);
    for (const tool of DOOR_TOOLS) expect(doc.paths[`/reports/v1/mcp/${tool}`].post.operationId).toBe(tool);
    // Salesforce refuses a registration whose description is over 255 characters.
    expect(doc.info.description.length).toBeLessThanOrEqual(255);
  });

  it("the committed registration puts one operation per door tool at /reports/v1/mcp/<tool>", () => {
    const xml = readFileSync(registration, "utf8");
    const paths = [...xml.matchAll(/^ {2}"(\/reports\/v1\/[^"]*)":$/gm)].map((m) => m[1]);
    expect(paths).toEqual(expected);
  });
});
