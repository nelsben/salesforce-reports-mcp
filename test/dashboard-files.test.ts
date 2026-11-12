import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dashboardFilesCommand, runDashboardFiles, summaryLine, validateDefs, type FileWriter, type ToolClient } from "../src/dashboard-files.js";

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
