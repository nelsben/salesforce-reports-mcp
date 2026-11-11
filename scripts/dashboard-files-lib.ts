/**
 * The logic behind scripts/dashboard-files.ts, with no side effects at import: it validates a defs file, calls
 * query_report once per id through an injected client and writes one ReportResult JSON file per id. Tests use a
 * fake client and a fake writer, so they need no org and no child process. Output is ids and counts only.
 */
import { join } from "node:path";

/** The part of the MCP SDK client this command uses. */
export interface ToolClient {
  callTool(request: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
  close(): Promise<void>;
}

export interface FileWriter {
  mkdir(dir: string): Promise<void>;
  writeFile(path: string, text: string): Promise<void>;
}

export const USAGE = "Usage: npm run dashboard-files -- --org <alias> --defs <file.json> --out <dir>";

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
    entries.push([id, value as Record<string, unknown>]);
  }
  return { entries };
}

/** The last line of the command. */
export const summaryLine = (written: number, failed: number): string => `dashboard-files: written=${written} failed=${failed}`;

interface ToolAnswer {
  isError?: boolean;
  structuredContent?: unknown;
}

function rowCount(result: Record<string, unknown>): number {
  const detail = result.detail as { rowCount?: unknown } | undefined;
  if (detail && typeof detail.rowCount === "number") return detail.rowCount;
  const groups = result.groups as { rows?: unknown } | undefined;
  return Array.isArray(groups?.rows) ? groups.rows.length : 0;
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
      try {
        answer = (await client.callTool({ name: "query_report", arguments: args })) as ToolAnswer;
      } catch {
        answer = undefined;
      }
      const result = answer?.structuredContent;
      if (!answer || answer.isError || typeof result !== "object" || result === null) {
        failed++;
        print(`${id}: failed`);
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
