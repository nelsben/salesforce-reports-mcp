/**
 * Parity between the local server and the in-org REST door (salesforce/, class ReportsApi).
 * Usage: npm run parity -- --org <alias>
 * Creates three private reports named zz-parity-* through the local API, runs every case through both doors,
 * diffs the JSON, deletes the reports, and exits non-zero on any difference or on a report left behind.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parseArgs } from "node:util";
import { ReportsApi } from "../src/reports/api.js";
import { createClient } from "../src/salesforce/client.js";
import { resolveConnection } from "../src/salesforce/connection.js";
import { buildServer } from "../src/server.js";

const { values } = parseArgs({ options: { org: { type: "string" } }, strict: true });
if (!values.org) {
  console.error("Pass --org <alias>. The parity check never uses a default org.");
  process.exit(2);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
interface Answer {
  ok: boolean;
  status: number;
  body: Json;
}

const connection = resolveConnection({ org: values.org });
const reports = new ReportsApi(createClient(connection));
const server = buildServer(reports, { readOnly: false, allowDelete: true, maxRows: 200 });
const client = new Client({ name: "parity-check", version: "0.0.0" });
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

/** The local door: the MCP server in memory. The body is the JSON in the tool's text content. */
async function local(name: string, args: Record<string, unknown>): Promise<Answer> {
  const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  const text = result.content[0]?.text ?? "";
  let body: Json = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep the text */
  }
  return { ok: !result.isError, status: result.isError ? 0 : 200, body };
}

/** The in-org door: POST /services/apexrest/reports/v1/<tool>, on the repo's own connection. */
async function apex(name: string, args: Record<string, unknown>): Promise<Answer> {
  const send = (auth: { instanceUrl: string; accessToken: string }) =>
    fetch(`${auth.instanceUrl}/services/apexrest/reports/v1/${name}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${auth.accessToken}`, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
  let response = await send(await connection.getAuth());
  if (response.status === 401) response = await send(await connection.refresh());
  const text = await response.text();
  let body: Json = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep the text */
  }
  return { ok: response.status === 200, status: response.status, body };
}

/** The first path where two JSON values differ, or null when they are equal. */
function firstDiff(a: Json, b: Json, path = "$"): string | null {
  if (a === b) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") {
    return `${path}: local ${clip(a)} vs apex ${clip(b)}`;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: local ${clip(a)} vs apex ${clip(b)}`;
  if (Array.isArray(a)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const d = firstDiff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return a.length === b.length ? null : `${path}.length: local ${a.length} vs apex ${b.length}`;
  }
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!(key in a)) return `${path}.${key}: missing locally, apex ${clip(b[key])}`;
    if (!(key in b)) return `${path}.${key}: missing on apex, local ${clip(a[key])}`;
    const d = firstDiff(a[key], b[key], `${path}.${key}`);
    if (d) return d;
  }
  return null;
}

function clip(value: Json): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function without(body: Json, keys: string[]): Json {
  if (!body || typeof body !== "object") return body;
  const copy = { ...body };
  for (const k of keys) delete copy[k];
  return copy;
}

let failures = 0;
function line(pass: boolean, label: string, detail = ""): void {
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? `: ${detail}` : ""}`);
}

/** Run one case through both doors and diff. `ignore` names top-level keys a door is known to lack. */
async function same(label: string, tool: string, args: Record<string, unknown>, ignore: string[] = []): Promise<void> {
  try {
    const [l, a] = [await local(tool, args), await apex(tool, args)];
    if (!l.ok) return line(false, label, `local failed: ${clip(l.body)}`);
    if (!a.ok) return line(false, label, `apex answered ${a.status}: ${clip(a.body)}`);
    const diff = firstDiff(without(l.body, ignore), without(a.body, ignore));
    line(!diff, label, diff ?? (ignore.length ? `ignoring ${ignore.join(", ")}` : ""));
  } catch (error) {
    line(false, label, error instanceof Error ? error.message : String(error));
  }
}

/** A contract case for the in-org door only. */
async function apexAnswers(label: string, tool: string, args: Record<string, unknown>, status: number, code: string): Promise<void> {
  try {
    const a = await apex(tool, args);
    const got = a.body?.error?.code;
    line(a.status === status && got === code, label, a.status === status && got === code ? "" : `apex answered ${a.status} ${clip(a.body)}`);
  } catch (error) {
    line(false, label, error instanceof Error ? error.message : String(error));
  }
}

const prefix = "zz-parity";
const stamp = Date.now().toString(36);
const created: string[] = [];
const range = { column: "CLOSE_DATE", startDate: "2020-01-01", endDate: "2030-12-31" };

async function create(name: string, definition: Record<string, unknown>): Promise<string> {
  const out = await local("create_report", { name: `${prefix}-${name}-${stamp}`, ...definition });
  if (!out.ok) throw new Error(`create_report ${name} failed: ${clip(out.body)}`);
  created.push(out.body.id);
  return out.body.id as string;
}

try {
  const tabular = await create("tabular", {
    reportType: "Opportunity",
    columns: [
      "OPPORTUNITY_NAME", "ACCOUNT_NAME", "FULL_NAME", "AMOUNT", "PROBABILITY", "STAGE_NAME", "TYPE",
      "CLOSE_DATE", "CLOSED", "FISCAL_YEAR", "AGE", "OPPORTUNITY_ID", "OWNER_EMAIL", "NEXT_STEP",
    ],
    sortBy: [{ column: "AMOUNT", order: "Desc" }],
    dateFilter: range,
  });
  const summary = await create("summary", {
    reportType: "Opportunity",
    columns: ["OPPORTUNITY_NAME", "AMOUNT", "CLOSE_DATE"],
    groupingsDown: [{ column: "STAGE_NAME" }],
    aggregates: ["RowCount", { fn: "sum", column: "AMOUNT" }],
    dateFilter: range,
  });
  const matrix = await create("matrix", {
    reportType: "Opportunity",
    columns: ["OPPORTUNITY_NAME", "AMOUNT", "PROBABILITY"],
    groupingsDown: [{ column: "STAGE_NAME", sortOrder: "Desc" }],
    groupingsAcross: [{ column: "CLOSE_DATE", dateGranularity: "Quarter" }],
    aggregates: ["RowCount", { fn: "sum", column: "AMOUNT" }, { fn: "avg", column: "PROBABILITY" }],
    filters: [{ column: "AMOUNT", operator: "greaterThan", value: 0 }],
    dateFilter: range,
  });
  console.log(`Created ${created.length} zz-parity reports.\n`);

  await same("run_report tabular as saved", "run_report", { reportId: tabular });
  await same("run_report summary as saved", "run_report", { reportId: summary });
  await same("run_report matrix as saved", "run_report", { reportId: matrix });
  await same("run_report summary with detail rows", "run_report", { reportId: summary, detail: true });
  await same("run_report matrix with detail rows", "run_report", { reportId: matrix, detail: true });
  await same("run_report tabular without detail rows", "run_report", { reportId: tabular, detail: false });
  await same("run_report overrides: a filter", "run_report", {
    reportId: tabular,
    overrides: { filters: [{ column: "AMOUNT", operator: "greaterThan", value: 100000 }] },
  });
  await same("run_report overrides: a grouping change", "run_report", {
    reportId: summary,
    overrides: { groupingsDown: [{ column: "ACCOUNT_NAME", sortOrder: "Desc" }] },
  });
  await same("run_report overrides: a column change", "run_report", {
    reportId: tabular,
    overrides: { columns: ["OPPORTUNITY_NAME", "STAGE_NAME", "AMOUNT"] },
  });
  await same("run_report overrides: date filter, aggregates and filter logic", "run_report", {
    reportId: matrix,
    overrides: {
      dateFilter: { column: "CLOSE_DATE", duration: "THIS_YEAR" },
      aggregates: ["RowCount", { fn: "max", column: "AMOUNT" }],
      filters: [
        { column: "AMOUNT", operator: "greaterThan", value: 0 },
        { column: "STAGE_NAME", operator: "notEqual", value: "Closed Lost" },
      ],
      filterLogic: "1 AND 2",
    },
  });
  await same("run_report maxRows cut", "run_report", { reportId: tabular, maxRows: 3 });
  await same("describe_report tabular", "describe_report", { reportId: tabular });
  await same("describe_report summary", "describe_report", { reportId: summary });
  await same("describe_report matrix", "describe_report", { reportId: matrix });
  await same("search_reports zz-parity", "search_reports", { query: prefix });
  await same("search_reports zz-parity, MATRIX only", "search_reports", { query: prefix, format: "MATRIX", limit: 5 });
  await same("search_reports most recent", "search_reports", {});
  await same("list_report_folders", "list_report_folders", {});
  await same("list_report_folders search public", "list_report_folders", { search: "public" });
  await same("combine_reports stack", "combine_reports", {
    mode: "stack",
    inputs: [
      { alias: "all", reportId: summary },
      { alias: "big", reportId: summary, overrides: { filters: [{ column: "AMOUNT", operator: "greaterThan", value: 100000 }] } },
    ],
  });
  await same("combine_reports stack of detail rows", "combine_reports", {
    mode: "stack",
    inputs: [
      { alias: "a", reportId: tabular },
      { alias: "b", reportId: tabular, overrides: { columns: ["OPPORTUNITY_NAME", "AMOUNT"] } },
    ],
    maxRows: 4,
  });
  await same("combine_reports join", "combine_reports", {
    mode: "join",
    inputs: [
      { alias: "all", reportId: summary },
      { alias: "big", reportId: summary, overrides: { filters: [{ column: "AMOUNT", operator: "greaterThan", value: 100000 }] } },
    ],
  });
  await same("describe_report_type Opportunity, search amount", "describe_report_type", { type: "Opportunity", search: "amount" }, [
    "filterOperators",
    "notes",
  ]);
  await same("describe_report_type Opportunity, limit 40", "describe_report_type", { type: "Opportunity", limit: 40 }, [
    "filterOperators",
    "notes",
  ]);
  await apexAnswers("apex: query_report is not on this door (404)", "query_report", { reportType: "Opportunity" }, 404, "UNKNOWN_TOOL");
  await apexAnswers("apex: an unknown tool answers 404", "no_such_tool", {}, 404, "UNKNOWN_TOOL");
  await apexAnswers("apex: a bad report id answers 400", "run_report", { reportId: "not-an-id" }, 400, "INVALID_INPUT");
} catch (error) {
  line(false, "setup", error instanceof Error ? error.message : String(error));
} finally {
  for (const id of created) {
    try {
      await reports.remove(id);
    } catch {
      /* caught by the check below */
    }
  }
}

try {
  const left = await reports.soql(`SELECT Id, Name FROM Report WHERE Name LIKE '${prefix}%'`);
  for (const r of left) await reports.remove(r.Id).catch(() => undefined);
  line(left.length === 0, "no zz-parity report left behind", left.length ? `${left.length} found and deleted` : "");
} catch (error) {
  line(false, "no zz-parity report left behind", error instanceof Error ? error.message : String(error));
}

console.log(failures === 0 ? "\nParity: every case matched." : `\nParity: ${failures} case(s) failed.`);
await client.close();
process.exit(failures === 0 ? 0 : 1);
