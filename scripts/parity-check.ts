/**
 * Parity between the local server and the in-org REST door (salesforce/, class ReportsApi).
 * Usage: npm run parity -- --org <alias>
 * Creates three private reports named zz-parity-* through the local API, runs every case through both doors,
 * diffs the JSON, deletes the reports, and exits non-zero on any difference or on a report left behind.
 * query_report, list_report_types and describe_report_type reach the org's REST API from Apex (phase 3a), so their
 * cases also check that callout. The save cases (phase 3b) let each door make its own zz-parity report, compare the
 * answers after normalize(), and delete every report through the local server. The org's user needs the
 * Salesforce_Reports_Write permission set for the door's save cases.
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

type Door = "local" | "apex";
const DOORS: Door[] = ["local", "apex"];

function door(name: Door, tool: string, args: Record<string, unknown>): Promise<Answer> {
  return name === "local" ? local(tool, args) : apex(tool, args);
}

/**
 * A save answer with the fields that must differ between the doors made equal: every report id (also inside the URL
 * and in strings), the door's own token in the report name (saveName puts it there), and every developerName, which
 * Salesforce derives from the name. Save answers carry no timestamps.
 */
function normalize(body: Json, from: Door): Json {
  if (typeof body === "string") return body.replace(/00O[A-Za-z0-9]{12,15}/g, "<report id>").split(`-${from}-`).join("-<door>-");
  if (Array.isArray(body)) return body.map((item) => normalize(item, from));
  if (!body || typeof body !== "object") return body;
  return Object.fromEntries(
    Object.entries(body).map(([key, value]) => [key, key === "developerName" && typeof value === "string" ? "<developer name>" : normalize(value, from)]),
  );
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

/** Both doors fail, with the same error body. */
async function sameError(label: string, tool: string, args: Record<string, unknown>): Promise<void> {
  try {
    const [l, a] = [await local(tool, args), await apex(tool, args)];
    if (l.ok) return line(false, label, `local succeeded: ${clip(l.body)}`);
    if (a.ok) return line(false, label, `apex succeeded: ${clip(a.body)}`);
    const diff = firstDiff(l.body, a.body);
    line(!diff, label, diff ?? `apex answered ${a.status}`);
  } catch (error) {
    line(false, label, error instanceof Error ? error.message : String(error));
  }
}

/**
 * A save case: each door makes or changes its own report, and the answers must match after normalize(). Every id a
 * door answers with is kept for deletion. Answers with each door's body, for the cases that build on it.
 */
async function sameSave(label: string, tool: string, args: (from: Door) => Record<string, unknown>): Promise<Partial<Record<Door, Json>>> {
  const bodies: Partial<Record<Door, Json>> = {};
  try {
    const answers: Partial<Record<Door, Answer>> = {};
    for (const d of DOORS) {
      const answer = await door(d, tool, args(d));
      answers[d] = answer;
      const id = answer.ok ? answer.body?.id : undefined;
      if (typeof id === "string" && !created.includes(id)) created.push(id);
      if (answer.ok) bodies[d] = answer.body;
    }
    const [l, a] = [answers.local!, answers.apex!];
    if (!l.ok) return (line(false, label, `local failed: ${clip(l.body)}`), bodies);
    if (!a.ok) return (line(false, label, `apex answered ${a.status}: ${clip(a.body)}`), bodies);
    const diff = firstDiff(normalize(l.body, "local"), normalize(a.body, "apex"));
    line(!diff, label, diff ?? "");
  } catch (error) {
    line(false, label, error instanceof Error ? error.message : String(error));
  }
  return bodies;
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
const tabularDef = {
  reportType: "Opportunity",
  columns: [
    "OPPORTUNITY_NAME", "ACCOUNT_NAME", "FULL_NAME", "AMOUNT", "PROBABILITY", "STAGE_NAME", "TYPE",
    "CLOSE_DATE", "CLOSED", "FISCAL_YEAR", "AGE", "OPPORTUNITY_ID", "OWNER_EMAIL", "NEXT_STEP",
  ],
  sortBy: [{ column: "AMOUNT", order: "Desc" }],
  dateFilter: range,
};
const summaryDef = {
  reportType: "Opportunity",
  columns: ["OPPORTUNITY_NAME", "AMOUNT", "CLOSE_DATE"],
  groupingsDown: [{ column: "STAGE_NAME" }],
  aggregates: ["RowCount", { fn: "sum", column: "AMOUNT" }],
  dateFilter: range,
};
const matrixDef = {
  reportType: "Opportunity",
  columns: ["OPPORTUNITY_NAME", "AMOUNT", "PROBABILITY"],
  groupingsDown: [{ column: "STAGE_NAME", sortOrder: "Desc" }],
  groupingsAcross: [{ column: "CLOSE_DATE", dateGranularity: "Quarter" }],
  aggregates: ["RowCount", { fn: "sum", column: "AMOUNT" }, { fn: "avg", column: "PROBABILITY" }],
  filters: [{ column: "AMOUNT", operator: "greaterThan", value: 0 }],
  dateFilter: range,
};

/**
 * A report type this user has no saved report of, for describe_report_type's callout path. Report.ReportTypeApiName
 * can carry a suffix after "@", so a saved report counts when its name is the type or starts with the type and "@".
 */
async function typeWithoutReport(): Promise<string> {
  const listed = await local("list_report_types", { limit: 500 });
  if (!listed.ok) throw new Error(`list_report_types failed: ${clip(listed.body)}`);
  const offered = new Set<string>(listed.body.types.map((t: Json) => t.type));
  const saved = (await reports.soql("SELECT ReportTypeApiName FROM Report")).map((r) => String(r.ReportTypeApiName ?? "").toLowerCase());
  for (const type of ["AccountList", "LeadList", "CaseList", "ContactList", "ContractList", "Activity"]) {
    const t = type.toLowerCase();
    if (offered.has(type) && !saved.some((s) => s === t || s.startsWith(`${t}@`))) return type;
  }
  throw new Error("Every candidate report type has a saved report here. Add a candidate to typeWithoutReport().");
}

/** A report name for one door's save, under the 40-character limit. normalize() reads the door back out of it. */
const saveName = (what: string, from: Door) => `${prefix}-${what}-${from}-${stamp}`;

async function create(name: string, definition: Record<string, unknown>): Promise<string> {
  const out = await local("create_report", { name: `${prefix}-${name}-${stamp}`, ...definition });
  if (!out.ok) throw new Error(`create_report ${name} failed: ${clip(out.body)}`);
  created.push(out.body.id);
  return out.body.id as string;
}

try {
  const tabular = await create("tabular", tabularDef);
  const summary = await create("summary", summaryDef);
  const matrix = await create("matrix", matrixDef);
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
  await same("describe_report_type Opportunity, search amount", "describe_report_type", { type: "Opportunity", search: "amount" });
  await same("describe_report_type Opportunity, limit 40", "describe_report_type", { type: "Opportunity", limit: 40 });
  const unsaved = await typeWithoutReport();
  await same(`describe_report_type ${unsaved}, a type with no saved report`, "describe_report_type", { type: unsaved });
  await same("list_report_types", "list_report_types", {});
  await same("list_report_types search opportunit", "list_report_types", { search: "opportunit" });
  await same("list_report_types search account, limit 3", "list_report_types", { search: "account", limit: 3 });
  await same("query_report tabular", "query_report", tabularDef);
  await same("query_report summary", "query_report", summaryDef);
  await same("query_report matrix", "query_report", matrixDef);
  await same("query_report summary with detail rows", "query_report", { ...summaryDef, detail: true });
  await same("query_report matrix with detail rows and a maxRows cut", "query_report", { ...matrixDef, detail: true, maxRows: 3 });
  await same("query_report tabular with sort, top rows and a maxRows cut", "query_report", {
    reportType: "Opportunity",
    columns: ["OPPORTUNITY_NAME", "AMOUNT", "STAGE_NAME", "CLOSE_DATE"],
    sortBy: [{ column: "AMOUNT", order: "Desc" }],
    topRows: { rowLimit: 5, direction: "Desc" },
    dateFilter: range,
    maxRows: 2,
  });
  await same("query_report grouped with no detail column (one is added)", "query_report", {
    reportType: "Opportunity",
    groupingsDown: [{ column: "CLOSE_DATE", dateGranularity: "Quarter" }],
    dateFilter: range,
  });
  await same("query_report filter logic and a column dropped for its grouping", "query_report", {
    reportType: "Opportunity",
    columns: ["STAGE_NAME", "OPPORTUNITY_NAME"],
    groupingsDown: [{ column: "STAGE_NAME" }],
    aggregates: [{ fn: "max", column: "AMOUNT" }],
    filters: [
      { column: "AMOUNT", operator: "greaterThan", value: 0 },
      { column: "STAGE_NAME", operator: "notEqual", value: "Closed Lost" },
    ],
    filterLogic: "1 AND 2",
    dateFilter: range,
  });
  await sameError("query_report with an unknown column gives the local error body", "query_report", {
    reportType: "Opportunity",
    columns: ["NO_SUCH_COLUMN"],
  });
  await same("combine_reports stack of a saved report and a definition", "combine_reports", {
    mode: "stack",
    inputs: [
      { alias: "saved", reportId: summary },
      { alias: "adhoc", definition: { ...summaryDef, filters: [{ column: "AMOUNT", operator: "greaterThan", value: 100000 }] } },
    ],
  });
  await same("combine_reports join of two definitions", "combine_reports", {
    mode: "join",
    inputs: [
      { alias: "all", definition: summaryDef },
      { alias: "big", definition: { ...summaryDef, filters: [{ column: "AMOUNT", operator: "greaterThan", value: 100000 }] } },
    ],
  });
  const fresh = await sameSave("create_report from a definition", "create_report", (d) => ({
    name: saveName("new", d),
    ...summaryDef,
    filters: [{ column: "AMOUNT", operator: "greaterThan", value: 1000 }],
  }));
  await sameSave("create_report from fromReportId with a change (a grouping on a tabular copy)", "create_report", (d) => ({
    name: saveName("copy", d),
    fromReportId: tabular,
    groupingsDown: [{ column: "STAGE_NAME" }],
    aggregates: ["RowCount", { fn: "sum", column: "AMOUNT" }],
  }));
  await sameSave("update_report: name, filters and an aggregate on a column the report lacks", "update_report", (d) => ({
    reportId: fresh[d]?.id ?? "00O000000000000AAA",
    name: saveName("renamed", d),
    filters: [{ column: "AMOUNT", operator: "greaterThan", value: 100000 }],
    aggregates: ["RowCount", { fn: "max", column: "PROBABILITY" }],
  }));
  await sameSave("clone_report", "clone_report", (d) => ({ reportId: summary, name: saveName("clone", d) }));
  await sameError("update_report with nothing to change gives the local error body", "update_report", { reportId: summary });
  await apexAnswers("apex: delete_report is not on this door (404)", "delete_report", { reportId: summary }, 404, "UNKNOWN_TOOL");
  await apexAnswers("apex: query_report without reportType answers 400", "query_report", { columns: ["AMOUNT"] }, 400, "INVALID_INPUT");
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
