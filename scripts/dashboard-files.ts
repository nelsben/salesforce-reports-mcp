/**
 * Runs report definitions over the local door, read-only, and writes one ReportResult JSON file per report, ready to
 * attach to a Claude Dashboard.
 * Usage: npm run dashboard-files -- --org <alias> --defs <file.json> --out <dir>
 *
 * The defs file is a JSON object mapping a short id to query_report arguments (the definition fields at the top
 * level). It builds nothing: run `npm run build` first. It never uses a default org and never prints a row value,
 * a token or the instance URL. The last line is `dashboard-files: written=<n> failed=<m>`.
 * The logic lives in scripts/dashboard-files-lib.ts.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { runDashboardFiles, USAGE, validateDefs } from "./dashboard-files-lib.js";

function usageError(message: string): never {
  console.error(message);
  process.exit(2);
}

let values: { org?: string; defs?: string; out?: string };
try {
  values = parseArgs({ options: { org: { type: "string" }, defs: { type: "string" }, out: { type: "string" } }, strict: true }).values;
} catch {
  usageError(USAGE);
}
if (!values.org || !values.defs || !values.out) usageError(USAGE);

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
if (!existsSync(join(root, "dist", "index.js"))) {
  usageError("dist/index.js is missing. This command builds nothing: run `npm run build` first.");
}

let raw: unknown;
try {
  raw = JSON.parse(readFileSync(values.defs, "utf8"));
} catch {
  usageError("The defs file could not be read as JSON.");
}
const checked = validateDefs(raw);
if ("error" in checked) usageError(checked.error);

const client = new Client({ name: "dashboard-files", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, "dist", "index.js"), "--org", values.org, "--read-only"],
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
process.exit(failed > 0 ? 1 : 0);
