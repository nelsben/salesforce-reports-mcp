/**
 * Proves door 4 (the server over HTTP with its own OAuth sign-in) end to end on loopback, the way a connector does:
 * metadata, register, sign in with the passcode, exchange the code, list tools, run one query_report.
 * Usage: npm run door4-check -- --org <alias>
 *
 * It builds nothing: run `npm run build` first. It picks a free loopback port, makes a random passcode that is
 * given to the child server through its environment only, and always stops the child, on success, failure and
 * Ctrl-C. The query is a summary of Opportunity amounts by stage; nothing is saved. It prints counts only, and
 * never a token, the passcode or a row value. The last line is `door4-check: tools=<n> steps=<passed>/<total>`.
 * The logic lives in scripts/door4-check-lib.ts.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { newPasscode, runDoor4Check, STEP_LABELS, summaryLine, type ServerProcess, type Spawn } from "./door4-check-lib.js";

const { values } = parseArgs({ options: { org: { type: "string" } }, strict: true });
if (!values.org) {
  console.error("Pass --org <alias>. The check never uses a default org.");
  process.exit(2);
}

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
if (!existsSync(join(root, "dist", "index.js"))) {
  console.error("dist/index.js is missing. This check builds nothing: run `npm run build` first.");
  process.exit(2);
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => done(port));
    });
  });
}

const children: ServerProcess[] = [];
const spawn: Spawn = (cmd, args, env) => {
  const child = nodeSpawn(cmd, args, { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  return child;
};

// Ctrl-C and SIGTERM: stop the child at once, then leave with the usual signal code.
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  process.once(signal, () => {
    for (const child of children) child.kill("SIGKILL");
    console.log(summaryLine(0, [], STEP_LABELS.length));
    process.exit(code);
  });
}

const result = await runDoor4Check({
  org: values.org,
  port: await freePort(),
  passcode: newPasscode(),
  spawn,
  fetch,
  print: (line) => console.log(line),
});
process.exit(result.ok ? 0 : 1);
