/**
 * Runs the whole check loop against one org and ends with one table of counts.
 * Usage: npm run verify -- --org <alias> [--auth <cli alias>] [--skip <step,...>] [--log <dir>]
 *
 * Steps, in order: build, typecheck, test, deploy, parity, live, hosted, leftover. The first FAIL stops the run and
 * the steps after it read SKIP. `hosted` needs --auth (see docs/install.md). Each step's output goes to a file under
 * the log folder, so the terminal stays short. The logic lives in scripts/verify-lib.ts.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { renderTable, runVerify, STEP_NAMES, type Runner } from "./verify-lib.js";

const { values } = parseArgs({ options: { org: { type: "string" }, auth: { type: "string" }, skip: { type: "string" }, log: { type: "string" } }, strict: true });
if (!values.org) {
  console.error("Pass --org <alias>. The verify loop never uses a default org.");
  process.exit(2);
}
const skip = (values.skip ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const unknown = skip.filter((s) => !(STEP_NAMES as readonly string[]).includes(s));
if (unknown.length) {
  console.error(`Unknown step in --skip. The steps are ${STEP_NAMES.join(", ")}.`);
  process.exit(2);
}

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const logDir = values.log ? resolve(values.log) : mkdtempSync(join(tmpdir(), "verify-"));
mkdirSync(logDir, { recursive: true });
console.log(`verify: logs in ${logDir}`);

/** Runs a step through execFile, never a shell. Its output goes only to the caller. */
const run: Runner = (spec) =>
  new Promise((done) => {
    execFile(spec.cmd, spec.args, { cwd: spec.cwd === "salesforce" ? join(root, "salesforce") : root, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      done({ code, output: `${stdout}${stderr}` });
    });
  });

const { ok, results } = await runVerify({
  org: values.org,
  auth: values.auth,
  skip,
  run,
  print: (line) => console.log(line),
  log: (step, output) => writeFileSync(join(logDir, `${step}.log`), output),
});
console.log(`\n${renderTable(results)}`);
process.exit(ok ? 0 : 1);
