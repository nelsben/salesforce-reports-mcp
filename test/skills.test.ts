import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { ReportsApi } from "../src/reports/api.js";
import type { SalesforceApi } from "../src/salesforce/client.js";
import { buildServer } from "../src/server.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const SKILLS = ["report-runner", "report-designer"];
/** Tools only the local server has: delete_report, and the v0.3 dashboard tools (no in-org door yet). */
const LOCAL_ONLY = ["delete_report", "list_dashboards", "describe_dashboard", "run_dashboard", "refresh_dashboard"];

async function serverToolSchemas(): Promise<Map<string, string[]>> {
  const api: SalesforceApi = {
    apiVersion: "62.0",
    instanceUrl: async () => "https://example.my.salesforce.com",
    request: async () => {
      throw new Error("no requests in this test");
    },
  };
  const server = buildServer(new ReportsApi(api, async () => undefined), { readOnly: false, allowDelete: true, maxRows: 200 });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const { tools } = await client.listTools();
  await client.close();
  return new Map(tools.map((t) => [t.name, Object.keys(t.inputSchema.properties ?? {})]));
}

async function serverTools(): Promise<string[]> {
  return [...(await serverToolSchemas()).keys()];
}

/** Tool names in the "Tools on the REST door" section of transport.md. */
function doorTools(transport: string): string[] {
  const section = transport.split(/^## Tools on the REST door\s*$/m)[1]?.split(/^## /m)[0];
  if (!section) throw new Error("transport.md has no 'Tools on the REST door' section");
  const names = [...section.matchAll(/^\|\s*`([a-z_]+)`\s*\|/gm)].map((m) => m[1]);
  return names;
}

describe("skills transport", () => {
  const files = SKILLS.map((s) => read(`skills/${s}/transport.md`));

  it("the two transport.md files are byte-identical", () => {
    expect(files[1]).toBe(files[0]);
  });

  it("every tool transport.md lists on the door is a tool of the server", async () => {
    const tools = await serverTools();
    const listed = doorTools(files[0]);
    expect(listed.length).toBeGreaterThan(0);
    for (const name of listed) expect(tools).toContain(name);
  });

  it("lists every server tool except the local-only ones, and none of those", async () => {
    const tools = await serverTools();
    const listed = doorTools(files[0]);
    for (const name of LOCAL_ONLY) {
      expect(tools).toContain(name);
      expect(listed).not.toContain(name);
    }
    expect([...listed].sort()).toEqual(tools.filter((t) => !LOCAL_ONLY.includes(t)).sort());
    expect(listed).toHaveLength(11);
  });

  it("names only real input fields as required", async () => {
    const schemas = await serverToolSchemas();
    const section = files[0].split(/^## Tools on the REST door\s*$/m)[1].split(/^## /m)[0];
    const rows = [...section.matchAll(/^\|\s*`([a-z_]+)`\s*\|.*\|(.*)\|\s*$/gm)];
    expect(rows.length).toBe(11);
    for (const [, tool, inputs] of rows) {
      for (const [, field] of inputs.matchAll(/\*\*`([A-Za-z]+)`\*\*/g)) expect(schemas.get(tool)).toContain(field);
    }
  });

  it("says the door call form and never shows a token", () => {
    expect(files[0]).toContain("/services/apexrest/reports/v1/<tool>");
    expect(files[0]).toContain("sf api request rest");
    expect(files[0]).not.toMatch(/Bearer|show-access-token|00D[A-Za-z0-9]{12,}!/);
  });

  for (const skill of SKILLS) {
    it(`${skill}/SKILL.md links transport.md`, () => {
      expect(read(`skills/${skill}/SKILL.md`)).toMatch(/\]\(transport\.md\)/);
    });
  }
});

describe("report-runner presenting results", () => {
  const skill = read("skills/report-runner/SKILL.md");

  it("leads with the insight the card cannot show and never repeats its rows where a card is drawn", () => {
    expect(skill).toMatch(/report card above your reply/);
    expect(skill).toMatch(/lead with the one finding the card cannot show/);
    expect(skill).toMatch(/never repeat the card's rows, totals or a table/);
  });

  it("keeps the headline and group table for a host without a card", () => {
    expect(skill).toMatch(/Without a card, give the headline and the group table/);
  });
});

describe("report-runner dashboards", () => {
  const skill = read("skills/report-runner/SKILL.md");
  const section = skill.split(/^## Dashboards\s*$/m)[1]?.split(/^## /m)[0] ?? "";

  it("has a Dashboards section naming the four dashboard tools, each a real server tool", async () => {
    const tools = await serverTools();
    for (const name of ["list_dashboards", "describe_dashboard", "run_dashboard", "refresh_dashboard"]) {
      expect(section, name).toContain(`\`${name}\``);
      expect(tools).toContain(name);
    }
  });

  it("says when to reach for a dashboard instead of a report run, and refreshes only with a yes", () => {
    expect(section).toMatch(/instead of a report run/);
    expect(section).toMatch(/run_report/);
    expect(section).toMatch(/Do not refresh without the user's yes/);
  });
});
