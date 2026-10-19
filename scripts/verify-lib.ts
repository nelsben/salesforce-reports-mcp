/**
 * The logic behind scripts/verify.ts, with no side effects at import: the step list, each step's command and
 * working folder, how a step's output becomes a count for the table, and the table. The runner is injected, so tests
 * need no network, no real `sf` and no real `npm`.
 */

export interface StepSpec {
  name: string;
  cmd: string;
  args: string[];
  /** "root" is the repo root; "salesforce" is the salesforce/ folder. */
  cwd: "root" | "salesforce";
}
export interface RunOutput {
  code: number;
  output: string;
}
export type Runner = (spec: StepSpec) => Promise<RunOutput>;
export type Result = "PASS" | "FAIL" | "SKIP";
export interface StepOutcome {
  step: string;
  result: Result;
  detail: string;
}

export const STEP_NAMES = ["build", "typecheck", "test", "deploy", "parity", "live", "hosted", "leftover"] as const;

const APEX_TESTS = ["ReportsApiTest", "ReportsCalloutTest", "ReportsCombineTest", "ReportsDashboardsTest", "ReportsDefinitionTest", "ReportsSaveTest", "ReportsSummaryTest"];

/** Every step with its command, in the order they run. `hosted` is listed only to be skipped when there is no --auth. */
export function stepSpecs(org: string, auth?: string): StepSpec[] {
  return [
    { name: "build", cmd: "npm", args: ["run", "build"], cwd: "root" },
    { name: "typecheck", cmd: "npm", args: ["run", "typecheck"], cwd: "root" },
    { name: "test", cmd: "npx", args: ["vitest", "run"], cwd: "root" },
    {
      name: "deploy",
      cmd: "sf",
      args: [
        "project", "deploy", "start", "--ignore-conflicts", "--test-level", "RunSpecifiedTests",
        ...APEX_TESTS.flatMap((t) => ["--tests", t]),
        "--source-dir", "force-app", "-o", org, "--wait", "30", "--json",
      ],
      cwd: "salesforce",
    },
    { name: "parity", cmd: "npm", args: ["run", "parity", "--", "--org", org], cwd: "root" },
    { name: "live", cmd: "npm", args: ["run", "live", "--", "--org", org, "--allow-delete", "--door", "apex"], cwd: "root" },
    { name: "hosted", cmd: "npm", args: ["run", "mcp-check", "--", "--org", org, ...(auth ? ["--auth", auth] : [])], cwd: "root" },
    { name: "leftover", cmd: "sf", args: ["data", "query", "-q", "SELECT COUNT() FROM Report WHERE CreatedDate = TODAY", "-o", org, "--json"], cwd: "root" },
  ];
}

// eslint-disable-next-line no-control-regex
const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");

/**
 * The JSON object in the output, which may follow some lines of text and be followed by more (the Salesforce CLI
 * prints its update warning on stderr, after the JSON). Undefined when there is none.
 */
function jsonIn(output: string): Record<string, any> | undefined {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end < start) return undefined;
  try {
    return JSON.parse(output.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

const lineCount = (output: string, word: string) => output.split("\n").filter((l) => l.startsWith(`${word} `)).length;

function deployNumbers(output: string): { run: number; failed: number; status: string | undefined } | undefined {
  const json = jsonIn(output);
  if (!json) return undefined;
  const result = json.result ?? {};
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  return { run: num(result.numberTestsCompleted), failed: num(result.numberTestErrors), status: typeof result.status === "string" ? result.status : undefined };
}

/** A count-only detail for a step, parsed from its output. It never echoes a line of the output. */
export function parseDetail(step: string, rawOutput: string): string {
  const output = stripAnsi(rawOutput);
  switch (step) {
    case "test": {
      const passed = /(\d+) passed/.exec(output.split("\n").find((l) => /^\s*Tests\s/.test(l)) ?? "")?.[1];
      const failed = /(\d+) failed/.exec(output.split("\n").find((l) => /^\s*Tests\s/.test(l)) ?? "")?.[1];
      return passed === undefined && failed === undefined ? "no count" : `passed=${passed ?? 0} failed=${failed ?? 0}`;
    }
    case "deploy": {
      const n = deployNumbers(output);
      return n ? `apex tests=${n.run} failed=${n.failed}` : "no result";
    }
    case "leftover": {
      const size = jsonIn(output)?.result?.totalSize;
      return typeof size === "number" ? `reports=${size}` : "no count";
    }
    case "parity":
      return `matched=${lineCount(output, "PASS")} differing=${lineCount(output, "FAIL")}`;
    case "live": {
      const passed = lineCount(output, "PASS");
      return `passed=${passed}/${passed + lineCount(output, "FAIL")}`;
    }
    case "hosted": {
      const m = /mcp-check: tools=(\d+) steps=(\d+)\/(\d+)/.exec(output);
      return m ? `tools=${m[1]} steps=${m[2]}/${m[3]}` : "no summary";
    }
    default:
      return "";
  }
}

/** Whether a step passed, from its exit code and, for deploy and leftover, its JSON. */
function passed(step: string, run: RunOutput): boolean {
  if (run.code !== 0) return false;
  if (step === "deploy") {
    const n = deployNumbers(run.output);
    if (!n) return true;
    return n.failed === 0 && (n.status === undefined || /^succeeded/i.test(n.status));
  }
  if (step === "leftover") return jsonIn(run.output)?.result?.totalSize === 0;
  return true;
}

export interface VerifyOptions {
  org: string;
  auth: string | undefined;
  skip: readonly string[];
  run: Runner;
  /** Prints one terminal line. */
  print: (line: string) => void;
  /** Keeps a step's full output, in the log folder. */
  log: (step: string, output: string) => void;
  now?: () => number;
}

/** Runs the steps in order. The first failure stops the run; the steps after it read SKIP. */
export async function runVerify(options: VerifyOptions): Promise<{ ok: boolean; results: StepOutcome[] }> {
  const now = options.now ?? Date.now;
  const results: StepOutcome[] = [];
  let failed = false;
  for (const spec of stepSpecs(options.org, options.auth)) {
    let outcome: StepOutcome;
    let seconds = 0;
    if (options.skip.includes(spec.name)) outcome = { step: spec.name, result: "SKIP", detail: "skipped" };
    else if (spec.name === "hosted" && !options.auth) outcome = { step: spec.name, result: "SKIP", detail: "needs --auth" };
    else if (failed) outcome = { step: spec.name, result: "SKIP", detail: "after a failure" };
    else {
      const started = now();
      const run = await options.run(spec);
      seconds = Math.round((now() - started) / 1000);
      options.log(spec.name, run.output);
      const ok = passed(spec.name, run);
      let detail = parseDetail(spec.name, run.output);
      if (!detail || (!ok && /^no /.test(detail))) detail = ok ? "ok" : `exit code ${run.code}`;
      outcome = { step: spec.name, result: ok ? "PASS" : "FAIL", detail };
      if (!ok) failed = true;
    }
    results.push(outcome);
    options.print(`verify: ${spec.name} ${outcome.result} seconds=${seconds}`);
  }
  return { ok: !failed, results };
}

/** The closing table. Its details are counts and fixed words only. */
export function renderTable(results: readonly StepOutcome[]): string {
  return ["| Step | Result | Detail |", "| --- | --- | --- |", ...results.map((r) => `| ${r.step} | ${r.result} | ${r.detail} |`)].join("\n");
}
