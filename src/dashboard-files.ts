/**
 * The dashboard-files command: runs report definitions over the local door, read-only, and writes one ReportResult
 * JSON file per report, ready to attach to a Claude Dashboard. It is the `dashboard-files` subcommand of the server
 * binary: `salesforce-reports-mcp dashboard-files --org <alias> --defs <file.json> --out <dir>`. `--org <alias>` may
 * come from the SF_ORG environment variable instead; --org wins when both are set.
 *
 * The defs file is a JSON object mapping a short id to query_report arguments (the definition fields at the top
 * level). An entry with a string `reportId` runs a saved report with run_report instead, and may carry only
 * `reportId` and `overrides`. A failed report prints its error code, message and hint. The command never uses a default org and never prints a row value, a token or the instance URL. The last
 * line is `dashboard-files: written=<n> failed=<m>`.
 *
 * Importing this module has no side effects. The command runs the reports through a child server: this package's own
 * dist/index.js, read-only, on the local door.
 */
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** The part of the MCP SDK client this command uses. */
export interface ToolClient {
  callTool(request: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
  close(): Promise<void>;
}

export interface FileWriter {
  mkdir(dir: string): Promise<void>;
  writeFile(path: string, text: string): Promise<void>;
}

export const USAGE = "Usage: salesforce-reports-mcp dashboard-files --org <alias> --defs <file.json> --out <dir>\n--org <alias> may come from the SF_ORG environment variable.";

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Checks the defs object. Returns the entries in file order, or the first problem, naming the id. */
export function validateDefs(defs: unknown): { entries: [string, Record<string, unknown>][] } | { error: string } {
  if (typeof defs !== "object" || defs === null || Array.isArray(defs)) {
    return { error: "The defs file must be a JSON object mapping an id to query_report arguments." };
  }
  const entries: [string, Record<string, unknown>][] = [];
  for (const [id, value] of Object.entries(defs)) {
    if (!ID_PATTERN.test(id)) return { error: `Bad id "${id}": use letters, digits, dash and underscore only.` };
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { error: `The value for id "${id}" must be an object of query_report arguments.` };
    }
    const entry = value as Record<string, unknown>;
    if (typeof entry.reportId === "string") {
      const extra = Object.keys(entry).filter((k) => k !== "reportId" && k !== "overrides");
      if (extra.length > 0) {
        return { error: `The entry for id "${id}" has a reportId, so it may only have reportId and overrides. Remove: ${extra.join(", ")}.` };
      }
      if ("overrides" in entry && (typeof entry.overrides !== "object" || entry.overrides === null || Array.isArray(entry.overrides))) {
        return { error: `The overrides for id "${id}" must be an object.` };
      }
    }
    entries.push([id, entry]);
  }
  return { entries };
}

/** The last line of the command. */
export const summaryLine = (written: number, failed: number): string => `dashboard-files: written=${written} failed=${failed}`;

interface ToolAnswer {
  isError?: boolean;
  structuredContent?: unknown;
  content?: unknown;
}

const LINE_LIMIT = 300;

const firstLine = (text: string): string => text.split(/\r?\n/)[0].trim();

/** The failure line for one report: code, message and hint when the answer carries the error JSON, else the first line. */
function failureLine(id: string, text: string | undefined): string {
  let line = `${id}: failed`;
  if (text) {
    let body: { code?: unknown; message?: unknown; hint?: unknown } | undefined;
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed?.error === "object" && parsed.error !== null) body = parsed.error as typeof body;
    } catch {
      body = undefined;
    }
    if (body && typeof body.code === "string" && typeof body.message === "string") {
      line += ` ${body.code}: ${firstLine(body.message)}`;
      if (typeof body.hint === "string" && body.hint) line += ` (${firstLine(body.hint)})`;
    } else if (firstLine(text)) {
      line += `: ${firstLine(text)}`;
    }
  }
  return line.slice(0, LINE_LIMIT);
}

function answerText(answer: ToolAnswer): string | undefined {
  const first = Array.isArray(answer.content) ? (answer.content[0] as { text?: unknown } | undefined) : undefined;
  return typeof first?.text === "string" ? first.text : undefined;
}

/** The org: --org when given, else the SF_ORG environment variable. Never the Salesforce CLI default. */
export function resolveOrg(values: { org?: string }, env: Record<string, string | undefined>): string | undefined {
  return values.org || env.SF_ORG || undefined;
}

function rowCount(result: Record<string, unknown>): number {
  const detail = result.detail as { rowCount?: unknown } | undefined;
  if (detail && typeof detail.rowCount === "number") return detail.rowCount;
  const groups = result.groups as { rows?: unknown } | undefined;
  return Array.isArray(groups?.rows) ? groups.rows.length : 0;
}

/** A saved report (string reportId) runs with run_report; every other entry runs with query_report. */
function toCall(args: Record<string, unknown>): { name: string; arguments: Record<string, unknown> } {
  if (typeof args.reportId !== "string") return { name: "query_report", arguments: args };
  const call: Record<string, unknown> = { reportId: args.reportId };
  if (typeof args.overrides === "object" && args.overrides !== null) call.overrides = args.overrides;
  return { name: "run_report", arguments: call };
}

export interface RunOptions {
  client: ToolClient;
  defs: [string, Record<string, unknown>][];
  outDir: string;
  writer: FileWriter;
  print: (line: string) => void;
}

/** Runs each definition in order, writes one file per success and always closes the client. */
export async function runDashboardFiles(options: RunOptions): Promise<{ written: number; failed: number }> {
  const { client, defs, outDir, writer, print } = options;
  let written = 0;
  let failed = 0;
  try {
    await writer.mkdir(outDir);
    for (const [id, args] of defs) {
      let answer: ToolAnswer | undefined;
      let thrown: string | undefined;
      try {
        answer = (await client.callTool(toCall(args))) as ToolAnswer;
      } catch (error) {
        answer = undefined;
        thrown = error instanceof Error ? error.message : undefined;
      }
      const result = answer?.structuredContent;
      if (!answer || answer.isError || typeof result !== "object" || result === null) {
        failed++;
        print(failureLine(id, answer ? (answer.isError ? answerText(answer) : undefined) : thrown));
        continue;
      }
      await writer.writeFile(join(outDir, `${id}.json`), JSON.stringify(result, null, 2) + "\n");
      written++;
      const truncated = (result as { detail?: { truncated?: unknown } }).detail?.truncated === true;
      print(`${id}: rows=${rowCount(result as Record<string, unknown>)} truncated=${truncated}`);
    }
  } finally {
    await client.close();
  }
  print(summaryLine(written, failed));
  return { written, failed };
}

/**
 * Runs the dashboard-files command on its arguments (everything after the subcommand name). Returns the exit code:
 * 0 when every report was written, 1 when any failed or the server could not be reached, 2 on a usage error.
 */
export async function dashboardFilesCommand(argv: string[]): Promise<number> {
  let values: { org?: string; defs?: string; out?: string };
  try {
    values = parseArgs({
      args: argv,
      options: { org: { type: "string" }, defs: { type: "string" }, out: { type: "string" } },
      strict: true,
    }).values;
  } catch {
    console.error(USAGE);
    return 2;
  }
  const org = resolveOrg(values, process.env);
  if (!org || !values.defs || !values.out) {
    console.error(USAGE);
    return 2;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(values.defs, "utf8"));
  } catch {
    console.error("The defs file could not be read as JSON.");
    return 2;
  }
  const checked = validateDefs(raw);
  if ("error" in checked) {
    console.error(checked.error);
    return 2;
  }

  const client = new Client({ name: "dashboard-files", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("./index.js", import.meta.url)), "--org", org, "--read-only"],
    stderr: "ignore",
  });

  let failed = 1;
  try {
    await client.connect(transport);
    ({ failed } = await runDashboardFiles({
      client,
      defs: checked.entries,
      outDir: resolve(values.out),
      writer: { mkdir: async (dir) => void (await mkdir(dir, { recursive: true })), writeFile: (path, text) => writeFile(path, text) },
      print: (line) => console.log(line),
    }));
  } catch {
    console.error("dashboard-files: the server could not be started or reached.");
    await client.close().catch(() => undefined);
  }
  return failed > 0 ? 1 : 0;
}
