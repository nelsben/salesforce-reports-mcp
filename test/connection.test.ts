import { describe, expect, it, vi } from "vitest";
import { createClient, SalesforceError } from "../src/salesforce/client.js";
import { ConnectionError, resolveConnection, type ExecFile, type ExecShell } from "../src/salesforce/connection.js";

// Built from parts so no secret-shaped literal sits in the repo.
const REAL_TOKEN = ["00D000000000001", "AQEAQFakeTokenValueForTestsOnly.12345"].join("!");
const URL = "https://example.my.salesforce.com";

function fakeSf(handlers: Record<string, () => unknown>): { exec: ExecFile; calls: string[][] } {
  const calls: string[][] = [];
  const exec: ExecFile = async (_file, args) => {
    calls.push(args);
    const key = args.slice(0, args.indexOf("--json")).join(" ");
    const handler = handlers[key];
    if (!handler) throw new Error(`unexpected sf call: ${key}`);
    return { stdout: JSON.stringify({ status: 0, result: handler() }) };
  };
  return { exec, calls };
}

describe("resolveConnection", () => {
  it("reads the token from `org display` when it is real", async () => {
    const { exec, calls } = fakeSf({ "org display": () => ({ instanceUrl: `${URL}/`, accessToken: REAL_TOKEN }) });
    const auth = await resolveConnection({ org: "dev", env: {}, execFile: exec }).getAuth();
    expect(auth).toEqual({ instanceUrl: URL, accessToken: REAL_TOKEN });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--target-org");
    expect(calls[0]).toContain("dev");
  });

  it("falls back to `show-access-token` when `org display` redacts the token", async () => {
    const { exec, calls } = fakeSf({
      "org display": () => ({ instanceUrl: URL, accessToken: "[REDACTED - use sf org auth show-access-token]" }),
      "org auth show-access-token": () => ({ accessToken: REAL_TOKEN }),
    });
    const auth = await resolveConnection({ org: "dev", env: {}, execFile: exec }).getAuth();
    expect(auth).toEqual({ instanceUrl: URL, accessToken: REAL_TOKEN });
    expect(calls).toHaveLength(2);
  });

  it("uses the sf default org when none is named", async () => {
    const { exec, calls } = fakeSf({ "org display": () => ({ instanceUrl: URL, accessToken: REAL_TOKEN }) });
    await resolveConnection({ env: {}, execFile: exec }).getAuth();
    expect(calls[0]).not.toContain("--target-org");
  });

  it("prefers SF_INSTANCE_URL and SF_ACCESS_TOKEN over --org and never calls the CLI", async () => {
    const exec = vi.fn();
    const connection = resolveConnection({
      org: "dev",
      env: { SF_INSTANCE_URL: URL, SF_ACCESS_TOKEN: REAL_TOKEN },
      execFile: exec as unknown as ExecFile,
    });
    expect(await connection.getAuth()).toEqual({ instanceUrl: URL, accessToken: REAL_TOKEN });
    expect(exec).not.toHaveBeenCalled();
  });

  it("reports a CLI failure without leaking raw output", async () => {
    const exec: ExecFile = async () => {
      throw Object.assign(new Error("exit 2"), { stdout: JSON.stringify({ message: "No authorization information found for nope.\nSee help" }) });
    };
    await expect(resolveConnection({ org: "nope", env: {}, execFile: exec }).getAuth()).rejects.toThrow(/No authorization information found for nope\./);
  });

  it("says when the sf CLI is missing", async () => {
    const exec: ExecFile = async () => {
      throw Object.assign(new Error("spawn sf ENOENT"), { code: "ENOENT" });
    };
    await expect(resolveConnection({ env: {}, execFile: exec }).getAuth()).rejects.toThrow(/could not be started/);
  });

  it("explains EINVAL when the CLI cannot be started", async () => {
    const exec: ExecFile = async () => {
      throw Object.assign(new Error("spawn EINVAL"), { code: "EINVAL" });
    };
    await expect(resolveConnection({ env: {}, execFile: exec }).getAuth()).rejects.toThrow(/could not be started.*SF_INSTANCE_URL and SF_ACCESS_TOKEN/);
  });
});

describe("resolveConnection on Windows", () => {
  function fakeShell(): { shell: ExecShell; commands: string[] } {
    const commands: string[] = [];
    const shell: ExecShell = async (command) => {
      commands.push(command);
      return { stdout: JSON.stringify({ status: 0, result: { instanceUrl: URL, accessToken: REAL_TOKEN } }) };
    };
    return { shell, commands };
  }

  it("runs sf.cmd through a shell as one command string", async () => {
    const { shell, commands } = fakeShell();
    const exec = vi.fn();
    await resolveConnection({ org: "dev-1@x.com", env: {}, platform: "win32", execFile: exec as unknown as ExecFile, execShell: shell }).getAuth();
    expect(commands).toEqual(["sf.cmd org display --json --target-org dev-1@x.com"]);
    expect(exec).not.toHaveBeenCalled();
  });

  it("refuses an unsafe alias and spawns nothing", async () => {
    const { shell, commands } = fakeShell();
    const exec = vi.fn();
    const conn = resolveConnection({ org: "dev & calc", env: {}, platform: "win32", execFile: exec as unknown as ExecFile, execShell: shell });
    await expect(conn.getAuth()).rejects.toThrow(ConnectionError);
    await expect(conn.getAuth()).rejects.toThrow(/A-Z/);
    expect(commands).toEqual([]);
    expect(exec).not.toHaveBeenCalled();
  });

  it.each(["linux", "darwin"] as const)("keeps execFile with an argument array on %s", async (platform) => {
    const { exec, calls } = fakeSf({ "org display": () => ({ instanceUrl: URL, accessToken: REAL_TOKEN }) });
    const shell = vi.fn();
    await resolveConnection({ org: "dev & calc", env: {}, platform, execFile: exec, execShell: shell as unknown as ExecShell }).getAuth();
    expect(calls).toEqual([["org", "display", "--json", "--target-org", "dev & calc"]]);
    expect(shell).not.toHaveBeenCalled();
  });
});

describe("createClient", () => {
  function response(status: number, body: unknown): Response {
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  }

  it("sends the bearer token to the versioned path and parses JSON", async () => {
    const { exec } = fakeSf({ "org display": () => ({ instanceUrl: URL, accessToken: REAL_TOKEN }) });
    const fetchMock = vi.fn(async () => response(200, { ok: true }));
    const client = createClient(resolveConnection({ env: {}, execFile: exec }), { apiVersion: "62.0", fetch: fetchMock as unknown as typeof fetch });
    expect(await client.request("POST", "/analytics/reports/query", { a: 1 })).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${URL}/services/data/v62.0/analytics/reports/query`);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${REAL_TOKEN}`);
    expect(init.body).toBe('{"a":1}');
  });

  it("refetches the token once on a 401 and retries", async () => {
    let shown = 0;
    const { exec } = fakeSf({
      "org display": () => ({ instanceUrl: URL, accessToken: "[REDACTED]" }),
      "org auth show-access-token": () => ({ accessToken: shown++ === 0 ? REAL_TOKEN : `${REAL_TOKEN}2` }),
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(401, [{ errorCode: "INVALID_SESSION_ID", message: "Session expired" }]))
      .mockResolvedValueOnce(response(200, { ok: 1 }));
    const client = createClient(resolveConnection({ env: {}, execFile: exec }), { fetch: fetchMock as unknown as typeof fetch });
    expect(await client.request("GET", "/x")).toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryHeaders = (fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(retryHeaders.Authorization).toBe(`Bearer ${REAL_TOKEN}2`);
  });

  it("fails with a clear message after a second 401, without the token in it", async () => {
    const { exec } = fakeSf({
      "org display": () => ({ instanceUrl: URL, accessToken: REAL_TOKEN }),
      "org auth show-access-token": () => ({ accessToken: REAL_TOKEN }),
    });
    const fetchMock = vi.fn(async () => response(401, [{ errorCode: "INVALID_SESSION_ID", message: "Session expired" }]));
    const client = createClient(resolveConnection({ env: {}, execFile: exec }), { fetch: fetchMock as unknown as typeof fetch });
    const error = await client.request("GET", "/x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SalesforceError);
    expect((error as Error).message).toMatch(/rejected the session twice/);
    expect((error as Error).message).not.toContain(REAL_TOKEN);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("explains an expired env token", async () => {
    const connection = resolveConnection({ env: { SF_INSTANCE_URL: URL, SF_ACCESS_TOKEN: REAL_TOKEN } });
    const fetchMock = vi.fn(async () => response(401, [{ errorCode: "INVALID_SESSION_ID", message: "x" }]));
    const client = createClient(connection, { fetch: fetchMock as unknown as typeof fetch });
    const error = await client.request("GET", "/x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectionError);
    expect((error as Error).message).toMatch(/SF_ACCESS_TOKEN/);
    expect((error as Error).message).not.toContain(REAL_TOKEN);
  });

  it("maps a Salesforce error body to code and message", async () => {
    const { exec } = fakeSf({ "org display": () => ({ instanceUrl: URL, accessToken: REAL_TOKEN }) });
    const fetchMock = vi.fn(async () => response(400, [{ errorCode: "BAD_REQUEST", message: "The column NOPE is not a valid column." }]));
    const client = createClient(resolveConnection({ env: {}, execFile: exec }), { fetch: fetchMock as unknown as typeof fetch });
    await expect(client.request("POST", "/x", {})).rejects.toMatchObject({ status: 400, code: "BAD_REQUEST", message: "The column NOPE is not a valid column." });
  });

  it("returns undefined for a 204", async () => {
    const { exec } = fakeSf({ "org display": () => ({ instanceUrl: URL, accessToken: REAL_TOKEN }) });
    const client = createClient(resolveConnection({ env: {}, execFile: exec }), { fetch: (async () => response(204, undefined)) as unknown as typeof fetch });
    expect(await client.request("DELETE", "/x")).toBeUndefined();
  });
});
