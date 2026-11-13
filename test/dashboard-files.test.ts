import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dashboardFilesCommand, resolveOrg, runDashboardFiles, summaryLine, validateDefs, type FileWriter, type ToolClient } from "../src/dashboard-files.js";

function fakeWriter() {
  const files = new Map<string, string>();
  const dirs: string[] = [];
  const writer: FileWriter = { mkdir: async (d) => void dirs.push(d), writeFile: async (p, t) => void files.set(p, t) };
  return { writer, files, dirs };
}

function fakeClient(answers: Record<string, unknown>) {
  const calls: unknown[] = [];
  let closed = 0;
  const client: ToolClient = {
    callTool: async (req) => {
      calls.push(req);
      const key = String(req.arguments.reportType);
      const a = answers[key];
      if (a instanceof Error) throw a;
      return a;
    },
    close: async () => void closed++,
  };
  return { client, calls, closed: () => closed };
}

describe("validateDefs", () => {
  it("keeps file order", () => {
    const r = validateDefs({ b: { reportType: "A" }, a_1: { reportType: "B" } });
    expect("entries" in r && r.entries.map((e) => e[0])).toEqual(["b", "a_1"]);
  });
  it("refuses a bad id and names it", () => {
    expect(validateDefs({ "bad id": {} })).toEqual({ error: expect.stringContaining("bad id") });
  });
  it("refuses a non-object value and names the id", () => {
    expect(validateDefs({ one: "x" })).toEqual({ error: expect.stringContaining('"one"') });
    expect(validateDefs({ one: [] })).toHaveProperty("error");
  });
  it("refuses a non-object file", () => {
    expect(validateDefs([])).toHaveProperty("error");
    expect(validateDefs(null)).toHaveProperty("error");
  });
});

describe("runDashboardFiles", () => {
  const defs: [string, Record<string, unknown>][] = [
    ["ok", { reportType: "Ok" }],
    ["bad", { reportType: "Bad" }],
    ["none", { reportType: "None" }],
  ];

  it("writes one file per success, counts failures and prints the summary", async () => {
    const result = { detail: { rowCount: 3, truncated: true, rows: [], columns: [] } };
    const { client, closed } = fakeClient({
      Ok: { structuredContent: result },
      Bad: { isError: true, structuredContent: { x: 1 } },
      None: { content: [] },
    });
    const { writer, files, dirs } = fakeWriter();
    const lines: string[] = [];
    const out = await runDashboardFiles({ client, defs, outDir: "/out", writer, print: (l) => lines.push(l) });
    expect(out).toEqual({ written: 1, failed: 2 });
    expect(dirs).toEqual(["/out"]);
    expect([...files.keys()]).toEqual(["/out/ok.json"]);
    expect(JSON.parse(files.get("/out/ok.json")!)).toEqual(result);
    expect(lines[0]).toBe("ok: rows=3 truncated=true");
    expect(lines.at(-1)).toBe(summaryLine(1, 2));
    expect(lines.at(-1)).toBe("dashboard-files: written=1 failed=2");
    expect(closed()).toBe(1);
  });

  it("counts group rows when there is no detail", async () => {
    const { client } = fakeClient({ Ok: { structuredContent: { groups: { rows: [[1], [2]] } } } });
    const lines: string[] = [];
    await runDashboardFiles({ client, defs: [defs[0]], outDir: "/o", writer: fakeWriter().writer, print: (l) => lines.push(l) });
    expect(lines[0]).toBe("ok: rows=2 truncated=false");
  });

  it("closes the client when a call throws and counts it failed", async () => {
    const { client, closed } = fakeClient({ Ok: new Error("boom secret-row") });
    const lines: string[] = [];
    const out = await runDashboardFiles({ client, defs: [defs[0]], outDir: "/o", writer: fakeWriter().writer, print: (l) => lines.push(l) });
    expect(out).toEqual({ written: 0, failed: 1 });
    expect(closed()).toBe(1);
    expect(lines.join("\n")).not.toContain("secret-row");
  });

  it("closes the client when writing throws", async () => {
    const { client, closed } = fakeClient({ Ok: { structuredContent: {} } });
    const writer: FileWriter = { mkdir: async () => undefined, writeFile: async () => { throw new Error("disk"); } };
    await expect(runDashboardFiles({ client, defs: [defs[0]], outDir: "/o", writer, print: () => undefined })).rejects.toThrow("disk");
    expect(closed()).toBe(1);
  });
});

describe("dashboardFilesCommand", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function spies() {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const logOut = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const logErr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    return {
      stdout: () => [...out.mock.calls, ...logOut.mock.calls].map((c) => String(c[0])).join(""),
      stderr: () => [...err.mock.calls, ...logErr.mock.calls].map((c) => String(c[0])).join(""),
    };
  }

  it("returns 2 and prints usage when a flag is missing", async () => {
    const s = spies();
    expect(await dashboardFilesCommand(["--org", "<alias>", "--defs", "defs.json"])).toBe(2);
    expect(s.stderr()).toContain("Usage: salesforce-reports-mcp dashboard-files");
    expect(s.stdout()).toBe("");
  });

  it("returns 2 on an unknown flag", async () => {
    const s = spies();
    expect(await dashboardFilesCommand(["--org", "<alias>", "--defs", "d.json", "--out", "/o", "--bogus", "x"])).toBe(2);
    expect(s.stderr()).toContain("Usage: salesforce-reports-mcp dashboard-files");
    expect(s.stdout()).toBe("");
  });

  it("returns 2 when the defs file cannot be read", async () => {
    const s = spies();
    expect(await dashboardFilesCommand(["--org", "<alias>", "--defs", "/no/such/defs-file.json", "--out", "/o"])).toBe(2);
    expect(s.stderr()).toContain("could not be read as JSON");
    expect(s.stdout()).toBe("");
  });

  it("returns 2 when the defs file is invalid", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dashboard-files-test-"));
    const defs = join(dir, "defs.json");
    writeFileSync(defs, JSON.stringify({ "bad id": { reportType: "A" } }));
    const s = spies();
    expect(await dashboardFilesCommand(["--org", "<alias>", "--defs", defs, "--out", dir])).toBe(2);
    expect(s.stderr()).toContain("bad id");
    expect(s.stdout()).toBe("");
  });
});

describe("reportId entries", () => {
  function recorder(answer: unknown) {
    const calls: { name: string; arguments: Record<string, unknown> }[] = [];
    const client: ToolClient = {
      callTool: async (req) => {
        calls.push(req);
        if (answer instanceof Error) throw answer;
        return answer;
      },
      close: async () => undefined,
    };
    return { client, calls };
  }
  const run = async (defs: [string, Record<string, unknown>][], answer: unknown) => {
    const { client, calls } = recorder(answer);
    const lines: string[] = [];
    await runDashboardFiles({ client, defs, outDir: "/o", writer: fakeWriter().writer, print: (l) => lines.push(l) });
    return { calls, lines };
  };
  const errorAnswer = (text: string) => ({ isError: true, content: [{ type: "text", text }] });

  it("calls run_report with reportId and overrides", async () => {
    const { calls } = await run([["s", { reportId: "00OAAA", overrides: { limit: 5 } }]], { structuredContent: {} });
    expect(calls).toEqual([{ name: "run_report", arguments: { reportId: "00OAAA", overrides: { limit: 5 } } }]);
  });

  it("sends no overrides key when the entry has none", async () => {
    const { calls } = await run([["s", { reportId: "00OAAA" }]], { structuredContent: {} });
    expect(calls[0].name).toBe("run_report");
    expect(calls[0].arguments).toEqual({ reportId: "00OAAA" });
    expect("overrides" in calls[0].arguments).toBe(false);
  });

  it("uses query_report when reportId is not a string", async () => {
    const { calls } = await run([["s", { reportId: 5, reportType: "X" }]], { structuredContent: {} });
    expect(calls[0].name).toBe("query_report");
  });

  it("refuses an extra key beside reportId and overrides, naming the id", () => {
    const r = validateDefs({ mine: { reportId: "00OAAA", limit: 3 } });
    expect(r).toEqual({ error: expect.stringContaining('"mine"') });
    expect("error" in r && r.error).toContain("limit");
    expect(validateDefs({ ok: { reportId: "00OAAA", overrides: {} } })).toHaveProperty("entries");
  });

  it("refuses overrides that is not an object, naming the id", () => {
    expect(validateDefs({ mine: { reportId: "00OAAA", overrides: [] } })).toEqual({ error: expect.stringContaining('"mine"') });
  });

  it("prints code, message and hint for an isError answer", async () => {
    const body = JSON.stringify({ error: { code: "INVALID_FIELD", message: "No such column", hint: "Check describe_report" } });
    const { lines } = await run([["s", { reportId: "x" }]], errorAnswer(body));
    expect(lines[0]).toBe("s: failed INVALID_FIELD: No such column (Check describe_report)");
  });

  it("prints code and message when there is no hint", async () => {
    const body = JSON.stringify({ error: { code: "UNEXPECTED", message: "Nope" } });
    const { lines } = await run([["s", { reportId: "x" }]], errorAnswer(body));
    expect(lines[0]).toBe("s: failed UNEXPECTED: Nope");
  });

  it("prints only the id for text that is not the error JSON", async () => {
    const { lines } = await run([["s", { reportId: "x" }]], errorAnswer("plain failure\nsecond line"));
    expect(lines[0]).toBe("s: failed");
    const noCode = await run([["s", { reportId: "x" }]], errorAnswer(JSON.stringify({ error: { message: "m" } })));
    expect(noCode.lines[0]).toBe("s: failed");
    const bare = await run([["s", { reportId: "x" }]], { isError: true });
    expect(bare.lines[0]).toBe("s: failed");
  });

  it("prints only the id when the call throws", async () => {
    const { lines } = await run([["s", { reportId: "x" }]], new Error("boom\nsecond"));
    expect(lines[0]).toBe("s: failed");
  });

  it("cuts a line to 300 characters", async () => {
    const body = JSON.stringify({ error: { code: "E", message: "m".repeat(500) } });
    const { lines } = await run([["s", { reportId: "x" }]], errorAnswer(body));
    expect(lines[0]).toHaveLength(300);
  });
});

describe("resolveOrg", () => {
  it("uses SF_ORG when --org is absent", () => {
    expect(resolveOrg({}, { SF_ORG: "from-env" })).toBe("from-env");
  });
  it("lets --org win over SF_ORG", () => {
    expect(resolveOrg({ org: "flag" }, { SF_ORG: "from-env" })).toBe("flag");
  });
  it("is undefined with neither", () => {
    expect(resolveOrg({}, {})).toBeUndefined();
    expect(resolveOrg({}, { SF_ORG: "" })).toBeUndefined();
  });
  it("makes the command exit 2 with neither", async () => {
    const saved = process.env.SF_ORG;
    delete process.env.SF_ORG;
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await dashboardFilesCommand(["--defs", "d.json", "--out", "/o"])).toBe(2);
      expect(String(err.mock.calls[0][0])).toContain("Usage:");
    } finally {
      err.mockRestore();
      if (saved !== undefined) process.env.SF_ORG = saved;
    }
  });
});
