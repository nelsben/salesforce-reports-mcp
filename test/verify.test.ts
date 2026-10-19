import { describe, expect, it } from "vitest";
import { parseDetail, renderTable, runVerify, stepSpecs, STEP_NAMES, type RunOutput, type StepSpec } from "../scripts/verify-lib.js";

const OK: RunOutput = { code: 0, output: "" };

function harness(outputs: Record<string, RunOutput> = {}) {
  const ran: StepSpec[] = [];
  const printed: string[] = [];
  const logs: Record<string, string> = {};
  const run = async (spec: StepSpec): Promise<RunOutput> => {
    ran.push(spec);
    return outputs[spec.name] ?? OK;
  };
  return { ran, printed, logs, run, print: (l: string) => printed.push(l), log: (n: string, t: string) => void (logs[n] = t) };
}

const base = { org: "alias-x", auth: "auth-y" };

describe("stepSpecs", () => {
  it("lists the steps in order, with argument arrays", () => {
    const specs = stepSpecs(base.org, base.auth);
    expect(specs.map((s) => s.name)).toEqual(["build", "typecheck", "test", "deploy", "parity", "live", "hosted", "leftover"]);
    expect(STEP_NAMES).toEqual(specs.map((s) => s.name));
    for (const s of specs) expect(Array.isArray(s.args)).toBe(true);
  });
  it("builds the deploy, parity, live, hosted and leftover commands", () => {
    const by = Object.fromEntries(stepSpecs("o1", "a1").map((s) => [s.name, s]));
    expect(by.deploy!.cwd).toBe("salesforce");
    expect(by.deploy!.args).toEqual([
      "project", "deploy", "start", "--ignore-conflicts", "--test-level", "RunSpecifiedTests",
      "--tests", "ReportsApiTest", "--tests", "ReportsCalloutTest", "--tests", "ReportsCombineTest", "--tests", "ReportsDashboardsTest",
      "--tests", "ReportsDefinitionTest", "--tests", "ReportsSaveTest", "--tests", "ReportsSummaryTest",
      "--source-dir", "force-app", "-o", "o1", "--wait", "30", "--json",
    ]);
    expect(by.parity!.args).toEqual(["run", "parity", "--", "--org", "o1"]);
    expect(by.live!.args).toEqual(["run", "live", "--", "--org", "o1", "--allow-delete", "--door", "apex"]);
    expect(by.hosted!.args).toEqual(["run", "mcp-check", "--", "--org", "o1", "--auth", "a1"]);
    expect(by.leftover!.args).toEqual(["data", "query", "-q", "SELECT COUNT() FROM Report WHERE CreatedDate = TODAY", "-o", "o1", "--json"]);
    expect(by.test!.args).toEqual(["vitest", "run"]);
    expect(by.build!.cwd).toBe("root");
  });
});

describe("runVerify", () => {
  it("runs every step in order and passes", async () => {
    const h = harness({
      deploy: { code: 0, output: JSON.stringify({ result: { status: "Succeeded", numberTestsCompleted: 40, numberTestErrors: 0 } }) },
      leftover: { code: 0, output: JSON.stringify({ result: { totalSize: 0 } }) },
    });
    const r = await runVerify({ ...base, skip: [], run: h.run, print: h.print, log: h.log });
    expect(h.ran.map((s) => s.name)).toEqual(STEP_NAMES);
    expect(r.ok).toBe(true);
    expect(h.printed.filter((l) => l.startsWith("verify: build "))[0]).toMatch(/^verify: build PASS seconds=\d+/);
  });

  it("stops at the first failure and skips the rest", async () => {
    const h = harness({ test: { code: 1, output: "Tests  2 failed | 8 passed (10)" } });
    const r = await runVerify({ ...base, skip: [], run: h.run, print: h.print, log: h.log });
    expect(h.ran.map((s) => s.name)).toEqual(["build", "typecheck", "test"]);
    expect(r.ok).toBe(false);
    expect(r.results.map((x) => x.result)).toEqual(["PASS", "PASS", "FAIL", "SKIP", "SKIP", "SKIP", "SKIP", "SKIP"]);
  });

  it("honours --skip", async () => {
    const h = harness({ leftover: { code: 0, output: '{"result":{"totalSize":0}}' } });
    const r = await runVerify({ ...base, skip: ["build", "deploy", "parity", "live", "hosted"], run: h.run, print: h.print, log: h.log });
    expect(h.ran.map((s) => s.name)).toEqual(["typecheck", "test", "leftover"]);
    expect(r.results.find((x) => x.step === "build")!.result).toBe("SKIP");
    expect(r.ok).toBe(true);
  });

  it("skips hosted without --auth", async () => {
    const h = harness({
      deploy: { code: 0, output: "{}" },
      leftover: { code: 0, output: '{"result":{"totalSize":0}}' },
    });
    const r = await runVerify({ org: "o", auth: undefined, skip: [], run: h.run, print: h.print, log: h.log });
    expect(h.ran.map((s) => s.name)).not.toContain("hosted");
    const hosted = r.results.find((x) => x.step === "hosted")!;
    expect(hosted.result).toBe("SKIP");
    expect(hosted.detail).toMatch(/--auth/);
    expect(r.ok).toBe(true);
  });

  it("fails leftover when a report remains, and writes each step output to the log", async () => {
    const h = harness({ leftover: { code: 0, output: '{"result":{"totalSize":2}}' } });
    const r = await runVerify({ ...base, skip: [], run: h.run, print: h.print, log: h.log });
    const left = r.results.find((x) => x.step === "leftover")!;
    expect(left.result).toBe("FAIL");
    expect(left.detail).toBe("reports=2");
    expect(Object.keys(h.logs)).toContain("build");
  });

  it("fails deploy on test errors or a failed status", async () => {
    const h = harness({ deploy: { code: 0, output: JSON.stringify({ result: { status: "Failed", numberTestsCompleted: 10, numberTestErrors: 3 } }) } });
    const r = await runVerify({ ...base, skip: [], run: h.run, print: h.print, log: h.log });
    const d = r.results.find((x) => x.step === "deploy")!;
    expect(d.result).toBe("FAIL");
    expect(d.detail).toBe("apex tests=10 failed=3");
  });
});

describe("parseDetail", () => {
  it("reads vitest counts", () => {
    expect(parseDetail("test", "\u001b[32m Tests \u001b[39m 412 passed (412)")).toBe("passed=412 failed=0");
    expect(parseDetail("test", "Tests  2 failed | 8 passed (10)")).toBe("passed=8 failed=2");
  });
  it("reads deploy JSON leniently", () => {
    expect(parseDetail("deploy", '{"result":{"numberTestsCompleted":7,"numberTestErrors":0}}')).toBe("apex tests=7 failed=0");
    expect(parseDetail("deploy", '{"result":{}}')).toBe("apex tests=0 failed=0");
    expect(parseDetail("deploy", "not json")).toBe("no result");
  });
  it("reads leftover JSON", () => {
    expect(parseDetail("leftover", '{"result":{"totalSize":0}}')).toBe("reports=0");
    expect(parseDetail("leftover", "oops")).toBe("no count");
  });
  it("counts parity cases from its own lines", () => {
    const out = ["Created 3 zz-parity reports.", "PASS  case one: same", "PASS  case two", "FAIL  case three: Account 9 differs", "", "Parity: 1 case(s) failed."].join("\n");
    expect(parseDetail("parity", out)).toBe("matched=2 differing=1");
  });
  it("counts live steps from its own lines", () => {
    const out = ["PASS  a", "SKIP  b: skipped on the apex door", "PASS  c", "FAIL  d: boom", "      refreshed at 2026", "", "1 step(s) failed."].join("\n");
    expect(parseDetail("live", out)).toBe("passed=2/3");
  });
  it("reads the hosted last line", () => {
    expect(parseDetail("hosted", "PASS  x\nmcp-check: tools=15 steps=5/6")).toBe("tools=15 steps=5/6");
    expect(parseDetail("hosted", "nothing")).toBe("no summary");
  });
});

describe("renderTable", () => {
  it("is a markdown table with counts only", () => {
    const table = renderTable([
      { step: "parity", result: "FAIL", detail: parseDetail("parity", "PASS  Account 1 Big Deal\nFAIL  https://x.my.salesforce.com/00O123456789abc: bad") },
      { step: "live", result: "SKIP", detail: "after a failure" },
    ]);
    const lines = table.split("\n");
    expect(lines[0]).toBe("| Step | Result | Detail |");
    expect(lines[1]).toBe("| --- | --- | --- |");
    expect(lines[2]).toBe("| parity | FAIL | matched=1 differing=1 |");
    expect(table).not.toMatch(/Account|salesforce\.com|00O/);
  });
});
