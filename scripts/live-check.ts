/**
 * End-to-end check against a real org, through the MCP server in memory.
 * Usage: npm run live -- --org <alias> --allow-delete [--door apex]
 * Creates private reports named zz-live-check-*, deletes them, and fails if any remain.
 * With --door apex, the read and save steps go through the in-org REST door (salesforce/, class ReportsApi). Saving
 * there needs the Salesforce_Reports_Write permission set. Reports are still deleted through the local server,
 * and steps for tools the door lacks print "skipped on the apex door".
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parseArgs } from "node:util";
import { ReportsApi } from "../src/reports/api.js";
import { createClient } from "../src/salesforce/client.js";
import { resolveConnection } from "../src/salesforce/connection.js";
import { buildServer } from "../src/server.js";

const { values } = parseArgs({
  options: { org: { type: "string" }, "allow-delete": { type: "boolean" }, door: { type: "string" } },
  strict: true,
});
if (!values.org) {
  console.error("Pass --org <alias>. The live check never uses a default org.");
  process.exit(2);
}
if (!values["allow-delete"]) {
  console.error("Pass --allow-delete: the check deletes the reports it creates.");
  process.exit(2);
}

if (values.door !== undefined && values.door !== "apex") {
  console.error('--door takes "apex". Leave it out to use the local server.');
  process.exit(2);
}
const apexDoor = values.door === "apex";
/** The tools the in-org door answers. Everything else runs on the local server. */
const APEX_TOOLS = new Set([
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
]);

const connection = resolveConnection({ org: values.org });
const reports = new ReportsApi(createClient(connection));
const server = buildServer(reports, { readOnly: false, allowDelete: true, maxRows: 200 });
const client = new Client({ name: "live-check", version: "0.0.0" });
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function call(name: string, args: Record<string, unknown> = {}): Promise<Json> {
  if (apexDoor && APEX_TOOLS.has(name)) return callApex(name, args);
  const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  const text = result.content[0]!.text;
  let body: Json;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${name} failed: ${text.slice(0, 300)}`);
  }
  if (result.isError) throw new Error(`${name} failed: ${body.error?.code}: ${body.error?.message}`);
  return body;
}

/** POST /services/apexrest/reports/v1/<tool> on the same connection. */
async function callApex(name: string, args: Record<string, unknown>): Promise<Json> {
  const send = (auth: { instanceUrl: string; accessToken: string }) =>
    fetch(`${auth.instanceUrl}/services/apexrest/reports/v1/${name}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${auth.accessToken}`, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
  let response = await send(await connection.getAuth());
  if (response.status === 401) response = await send(await connection.refresh());
  const text = await response.text();
  let body: Json;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${name} on the apex door answered ${response.status}: ${text.slice(0, 300)}`);
  }
  if (response.status !== 200) throw new Error(`${name} on the apex door answered ${response.status}: ${body.error?.code}: ${body.error?.message}`);
  return body;
}

let failures = 0;
/**
 * One step. On the apex door, `apex: "skip"` marks a step for a tool the door lacks, and `apex: "local"` a step
 * (the delete) that still runs on the local server, since the door has no delete_report.
 */
async function step(label: string, fn: () => Promise<void>, options: { apex?: "skip" | "local" } = {}): Promise<boolean> {
  if (apexDoor && options.apex === "skip") {
    console.log(`SKIP  ${label}: skipped on the apex door`);
    return true;
  }
  if (apexDoor && options.apex === "local") label = `${label} (local server: the apex door does not delete)`;
  try {
    await fn();
    console.log(`PASS  ${label}`);
    return true;
  } catch (error) {
    failures++;
    console.log(`FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
function expect(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

const prefix = "zz-live-check";
const stamp = Date.now().toString(36);
const created: string[] = [];
const summaryDefinition = {
  reportType: "Opportunity",
  groupingsDown: [{ column: "STAGE_NAME" }],
  aggregates: ["RowCount", { fn: "sum", column: "AMOUNT" }],
  dateFilter: { column: "CLOSE_DATE", duration: "THIS_YEAR" },
};

try {
  await step("tools/list in write mode shows all tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ["search_reports", "run_report", "query_report", "create_report", "update_report", "clone_report", "delete_report", "combine_reports"]) {
      expect(names.includes(n), `missing ${n}`);
    }
  }, { apex: "skip" });

  await step("1. list report types", async () => {
    const out = await call("list_report_types", { search: "opportunit" });
    expect(out.types.some((t: Json) => t.type === "Opportunity"), "no Opportunity type");
  });

  await step("2. describe Opportunity", async () => {
    const out = await call("describe_report_type", { type: "Opportunity", search: "amount" });
    const names = out.sections.flatMap((s: Json) => s.fields.map((f: Json) => f.name));
    expect(names.includes("AMOUNT"), "no AMOUNT field");
    expect(out.dateGranularities.includes("Month"), "no Month granularity");
    expect(out.filterOperators.string?.includes("equals"), "no string operators");
  });

  await step("2b. list_report_folders includes the org-wide Public Reports folder", async () => {
    const out = await call("list_report_folders");
    const pub = out.folders.find((f: Json) => f.developerName === "unfiled$public");
    expect(pub && /^00D/.test(pub.id), `folders ${JSON.stringify(out.folders.map((f: Json) => f.name))}`);
  });

  await step("3a. query a summary report with every aggregate", async () => {
    const out = await call("query_report", {
      reportType: "Opportunity",
      groupingsDown: [{ column: "STAGE_NAME" }],
      aggregates: [
        "RowCount",
        { fn: "sum", column: "AMOUNT" },
        { fn: "avg", column: "AMOUNT" },
        { fn: "min", column: "AMOUNT" },
        { fn: "max", column: "AMOUNT" },
        { fn: "unique", column: "OPPORTUNITY_NAME" },
      ],
      dateFilter: { column: "CLOSE_DATE", duration: "THIS_YEAR" },
    });
    expect(out.report.format === "SUMMARY", `format ${out.report.format}`);
    expect(out.groups.rows.length > 0, "no group rows");
    expect(out.groups.measures.length === 6, `measures ${out.groups.measures.length}`);
    const labels = out.groups.measures.map((m: Json) => m.label).join("|");
    for (const word of ["Sum", "Average", "Smallest", "Largest", "Unique"]) expect(labels.includes(word), `aggregate prefix gave no "${word}" measure: ${labels}`);
    expect(out.totals && out.totals.values.length === 6, "no totals");
  });

  await step("3b. date granularity changes the groups", async () => {
    const out = await call("query_report", {
      reportType: "Opportunity",
      groupingsDown: [{ column: "CLOSE_DATE", dateGranularity: "Quarter" }],
      dateFilter: { column: "CLOSE_DATE", duration: "THIS_YEAR" },
    });
    expect(/Q\d/.test(String(out.groups.rows[0]?.[0])), `label ${out.groups.rows[0]?.[0]}`);
  });

  await step("3c. query a matrix report", async () => {
    const out = await call("query_report", {
      reportType: "Opportunity",
      groupingsDown: [{ column: "STAGE_NAME" }],
      groupingsAcross: [{ column: "CLOSE_DATE", dateGranularity: "Quarter" }],
      aggregates: ["RowCount", { fn: "sum", column: "AMOUNT" }],
      dateFilter: { column: "CLOSE_DATE", duration: "THIS_YEAR" },
    });
    expect(out.report.format === "MATRIX", `format ${out.report.format}`);
    expect(out.groups.dimensions.length === 2, "expected two dimensions");
    expect(out.groups.rows.length > 0, "no matrix rows");
  });

  await step("3d. query a tabular report with detail rows, sort and top rows", async () => {
    const out = await call("query_report", {
      reportType: "Opportunity",
      columns: ["OPPORTUNITY_NAME", "AMOUNT", "STAGE_NAME", "CLOSE_DATE"],
      sortBy: [{ column: "AMOUNT", order: "Desc" }],
      topRows: { rowLimit: 3, direction: "Desc" },
      maxRows: 2,
    });
    expect(out.report.format === "TABULAR", `format ${out.report.format}`);
    expect(out.detail.rows.length === 2, `rows ${out.detail.rows.length}`);
    expect(out.detail.truncated === true && out.notes.length > 0, "cut by maxRows should be noted");
    expect(typeof out.detail.rows[0][1] === "number", "amount should be a number");
  });

  let firstId = "";
  await step("4a. create a report in Private Reports", async () => {
    const out = await call("create_report", { ...summaryDefinition, name: `${prefix}-a-${stamp}`, filters: [{ column: "AMOUNT", operator: "greaterThan", value: 1000 }] });
    firstId = out.id;
    created.push(out.id);
    expect(/^00O/.test(out.id), "no id");
    expect(out.folder === "Private Reports", `folder ${out.folder}`);
  });

  await step("4b. describe it", async () => {
    const out = await call("describe_report", { reportId: firstId });
    expect(out.name === `${prefix}-a-${stamp}` && out.format === "SUMMARY", "unexpected summary");
    expect(out.filters.some((f: string) => /Amount/.test(f)), `filters ${JSON.stringify(out.filters)}`);
    expect(typeof out.developerName === "string" && out.developerName.length > 0, `developerName ${out.developerName}`);
    expect(out.folder?.isPrivate === true && out.folder.name === "Private Reports" && out.folder.id === out.folderId, `folder ${JSON.stringify(out.folder)}`);
  });

  await step("4c. update its name and filters", async () => {
    const out = await call("update_report", {
      reportId: firstId,
      name: `${prefix}-a2-${stamp}`,
      filters: [{ column: "AMOUNT", operator: "greaterThan", value: 100000 }],
    });
    expect(out.summary.name === `${prefix}-a2-${stamp}`, "name not updated");
    expect(out.changes.some((c: string) => c.startsWith("reportFilters:") && !c.endsWith("unchanged")), `changes ${JSON.stringify(out.changes)}`);
    expect(out.summary.groupingsDown.length === 1, "partial update lost the grouping");
  });

  await step("4d. run it, then run it with overrides", async () => {
    const plain = await call("run_report", { reportId: firstId });
    expect(plain.groups.rows.length >= 0 && plain.report.id === firstId, "plain run failed");
    const over = await call("run_report", { reportId: firstId, overrides: { dateFilter: { column: "CLOSE_DATE", duration: "LAST_N_DAYS:30" }, filters: [] } });
    expect(over.filters.some((f: string) => f.includes("LAST_N_DAYS:30")), `filters ${JSON.stringify(over.filters)}`);
  });

  let secondId = "";
  await step("5. clone it", async () => {
    const out = await call("clone_report", { reportId: firstId, name: `${prefix}-b-${stamp}` });
    secondId = out.id;
    created.push(out.id);
    expect(out.folder === "Private Reports", `folder ${out.folder}`);
  });

  await step("5b. create_report fromReportId: a flat copy, then a grouped copy of that", async () => {
    // Start from the grouped report: drop its filters, keep its grouping, change the name only.
    const same = await call("create_report", { name: `${prefix}-c-${stamp}`, fromReportId: firstId, filters: [] });
    created.push(same.id);
    expect(same.id !== firstId && /^00O/.test(same.id), "no new id");
    expect(same.summary.format === "SUMMARY" && same.summary.groupingsDown.length === 1, `copy lost its grouping: ${JSON.stringify(same.summary.groupingsDown)}`);
    expect(!same.summary.filters.some((f: string) => /^Amount/.test(f)), `filters ${JSON.stringify(same.summary.filters)}`);
    expect(same.folder === "Private Reports", `folder ${same.folder}`);
    // A flat report, then a copy of it with a grouping added: format and detail columns follow.
    const flat = await call("create_report", {
      name: `${prefix}-d-${stamp}`,
      reportType: "Opportunity",
      columns: ["OPPORTUNITY_NAME", "AMOUNT", "STAGE_NAME"],
      dateFilter: { column: "CLOSE_DATE", duration: "THIS_YEAR" },
    });
    created.push(flat.id);
    expect(flat.summary.format === "TABULAR", `flat format ${flat.summary.format}`);
    const grouped = await call("create_report", {
      name: `${prefix}-e-${stamp}`,
      fromReportId: flat.id,
      groupingsDown: [{ column: "STAGE_NAME" }],
      aggregates: ["RowCount", { fn: "sum", column: "AMOUNT" }],
    });
    created.push(grouped.id);
    expect(grouped.summary.format === "SUMMARY", `grouped format ${grouped.summary.format}`);
    expect(grouped.summary.groupingsDown[0]?.name === "STAGE_NAME", "grouping missing");
    expect(grouped.summary.filters.some((f: string) => /Close Date/.test(f)), `the copy lost the date filter: ${JSON.stringify(grouped.summary.filters)}`);
    // The originals are untouched.
    const original = await call("describe_report", { reportId: flat.id });
    expect(original.format === "TABULAR" && original.groupingsDown.length === 0, "the original changed");
    const run = await call("run_report", { reportId: grouped.id });
    expect(run.groups.rows.length >= 0 && run.report.id === grouped.id, "the copy does not run");
  });

  await step("6a. combine with stack (this year against last 30 days)", async () => {
    const out = await call("combine_reports", {
      mode: "stack",
      inputs: [
        { alias: "year", reportId: firstId, overrides: { filters: [] } },
        { alias: "recent", reportId: firstId, overrides: { filters: [], dateFilter: { column: "CLOSE_DATE", duration: "LAST_N_DAYS:30" } } },
      ],
    });
    expect(out.groups.dimensions[0].name === "source", "no source column");
    const sources = new Set(out.groups.rows.map((r: Json) => r[0]));
    expect(sources.has("year"), "no rows from the first input");
  });

  await step("6b. combine with join (the two saved reports on stage)", async () => {
    const out = await call("combine_reports", {
      mode: "join",
      inputs: [
        { alias: "high", reportId: firstId },
        { alias: "all", reportId: secondId },
      ],
    });
    expect(out.groups.measures.some((m: Json) => m.label.startsWith("high: ")), "no aliased measure");
    expect(out.groups.rows.length > 0, "no joined rows");
  });

  await step("6c. combine a saved report with a definition (stack)", async () => {
    const out = await call("combine_reports", {
      mode: "stack",
      inputs: [
        { alias: "saved", reportId: firstId, overrides: { filters: [] } },
        { alias: "defined", definition: summaryDefinition },
      ],
    });
    const sources = new Set(out.groups.rows.map((r: Json) => r[0]));
    expect(sources.has("saved") && sources.has("defined"), `sources ${JSON.stringify([...sources])}`);
  });

  await step("7. delete everything the check created", async () => {
    for (const id of [...created]) {
      await call("delete_report", { reportId: id });
      created.splice(created.indexOf(id), 1);
    }
  }, { apex: "local" });
} finally {
  // Never leave anything behind, even after a failed step.
  for (const id of created) {
    try {
      await call("delete_report", { reportId: id });
    } catch {
      /* reported below by the search */
    }
  }
}

await step("8. search_reports finds no report left behind", async () => {
  const out = await call("search_reports", { query: prefix });
  const left = out.reports.filter((r: Json) => String(r.name).startsWith(prefix));
  for (const r of left) await call("delete_report", { reportId: r.id });
  expect(left.length === 0, `${left.length} report(s) were left behind and have now been deleted`);
});

console.log(failures === 0 ? "\nAll steps passed." : `\n${failures} step(s) failed.`);
await client.close();
process.exit(failures === 0 ? 0 : 1);
