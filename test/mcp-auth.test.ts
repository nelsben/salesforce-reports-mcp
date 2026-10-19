import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  REDIRECT_URI,
  authorizeUrl,
  authPath,
  exchangeCode,
  findConsumerKey,
  openerCommand,
  parseCallback,
  pkcePair,
  readInstanceUrl,
  refreshAccessToken,
  saveAuth,
  storedLine,
  loadAuth,
  type FileStore,
  type SfRunner,
} from "../scripts/mcp-auth-lib.js";

const REFRESH = "fake-refresh-token-not-real";
const ACCESS = "fake-access-token-not-real";

function memoryStore() {
  const files = new Map<string, { text: string; mode: number }>();
  const dirs = new Map<string, number>();
  const store: FileStore = {
    mkdir: (path, mode) => void dirs.set(path, mode),
    writeFile: (path, text, mode) => void files.set(path, { text, mode }),
    readFile: (path) => files.get(path)?.text,
  };
  return { store, files, dirs };
}

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("pkcePair", () => {
  it("makes the challenge the S256 of the verifier, base64url without padding", () => {
    const { verifier, challenge } = pkcePair(() => Buffer.alloc(32, 7));
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(challenge).not.toMatch(/[=+/]/);
  });
});

describe("authorizeUrl", () => {
  it("carries the PKCE parameters, the scope, the callback and the state", () => {
    const url = new URL(authorizeUrl({ instanceUrl: "https://example.my.salesforce.com", clientId: "KEY", challenge: "CH", state: "ST" }));
    expect(url.origin + url.pathname).toBe("https://example.my.salesforce.com/services/oauth2/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "KEY",
      redirect_uri: "http://localhost:1717/OauthRedirect",
      scope: "mcp_api refresh_token",
      code_challenge: "CH",
      code_challenge_method: "S256",
      state: "ST",
    });
    expect(REDIRECT_URI).toBe("http://localhost:1717/OauthRedirect");
  });
});

describe("parseCallback", () => {
  it("returns the code when the state matches", () => {
    expect(parseCallback("/OauthRedirect?code=abc&state=ST", "ST")).toEqual({ ok: true, code: "abc" });
  });
  it("refuses a wrong state", () => {
    expect(parseCallback("/OauthRedirect?code=abc&state=other", "ST")).toEqual({ ok: false, message: "mcp-login: the state did not match. Nothing was stored." });
  });
  it("refuses a missing state", () => {
    expect(parseCallback("/OauthRedirect?code=abc", "ST")?.ok).toBe(false);
  });
  it("reports an error on the callback with the error field only", () => {
    const result = parseCallback("/OauthRedirect?error=access_denied&error_description=secret+words&state=ST", "ST");
    expect(result).toEqual({ ok: false, message: "mcp-login: the sign-in failed: access_denied." });
  });
  it("ignores other paths", () => {
    expect(parseCallback("/favicon.ico", "ST")).toBeUndefined();
  });
});

describe("exchangeCode", () => {
  it("posts the authorization_code grant with the verifier and no secret", async () => {
    const { fn, calls } = fakeFetch(200, { access_token: ACCESS, refresh_token: REFRESH });
    const out = await exchangeCode({ instanceUrl: "https://example.my.salesforce.com", clientId: "KEY", code: "CODE", verifier: "VER", fetch: fn });
    expect(out).toBe(REFRESH);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://example.my.salesforce.com/services/oauth2/token");
    expect(calls[0]!.init.method).toBe("POST");
    const body = new URLSearchParams(String(calls[0]!.init.body));
    expect(Object.fromEntries(body)).toEqual({
      grant_type: "authorization_code",
      client_id: "KEY",
      redirect_uri: "http://localhost:1717/OauthRedirect",
      code: "CODE",
      code_verifier: "VER",
    });
    expect(body.has("client_secret")).toBe(false);
  });
  it("reports status and error field only on failure", async () => {
    const { fn } = fakeFetch(400, { error: "invalid_grant", error_description: `bad ${REFRESH}` });
    const error = (await exchangeCode({ instanceUrl: "https://x", clientId: "K", code: "C", verifier: "V", fetch: fn }).catch((e: Error) => e)) as Error;
    expect(error.message).toBe("The code exchange failed: HTTP 400 invalid_grant.");
    expect(error.message).not.toContain(REFRESH);
  });
  it("fails when no refresh token comes back", async () => {
    const { fn } = fakeFetch(200, { access_token: ACCESS });
    const error = (await exchangeCode({ instanceUrl: "https://x", clientId: "K", code: "C", verifier: "V", fetch: fn }).catch((e: Error) => e)) as Error;
    expect(error.message).toContain("no refresh token");
    expect(error.message).not.toContain(ACCESS);
  });
});

describe("the store", () => {
  it("writes only instanceUrl, clientId and refreshToken, with modes 0700 and 0600", () => {
    const { store, files, dirs } = memoryStore();
    saveAuth(store, "/home/u", "mine", { instanceUrl: "https://example.my.salesforce.com", clientId: "KEY", refreshToken: REFRESH });
    const path = "/home/u/.config/salesforce-reports-mcp/auth/mine.json";
    expect(authPath("/home/u", "mine")).toBe(path);
    expect(dirs.get("/home/u/.config/salesforce-reports-mcp/auth")).toBe(0o700);
    expect(files.get(path)?.mode).toBe(0o600);
    expect(JSON.parse(files.get(path)?.text ?? "")).toEqual({ instanceUrl: "https://example.my.salesforce.com", clientId: "KEY", refreshToken: REFRESH });
    expect(loadAuth(store, "/home/u", "mine")).toEqual({ instanceUrl: "https://example.my.salesforce.com", clientId: "KEY", refreshToken: REFRESH });
  });
  it("answers undefined for a missing or malformed file", () => {
    const { store, files } = memoryStore();
    expect(loadAuth(store, "/h", "none")).toBeUndefined();
    files.set(authPath("/h", "bad"), { text: "{not json", mode: 0o600 });
    expect(loadAuth(store, "/h", "bad")).toBeUndefined();
    files.set(authPath("/h", "thin"), { text: JSON.stringify({ clientId: "K" }), mode: 0o600 });
    expect(loadAuth(store, "/h", "thin")).toBeUndefined();
  });
  it("refuses a name that could leave the folder", () => {
    const { store } = memoryStore();
    for (const name of ["../x", "a/b", ".hidden", "", "a b"]) {
      expect(() => saveAuth(store, "/h", name, { instanceUrl: "u", clientId: "c", refreshToken: "r" })).toThrow(/name/);
    }
  });
});

describe("refreshAccessToken", () => {
  it("posts the refresh_token grant with the client id and no secret", async () => {
    const { fn, calls } = fakeFetch(200, { access_token: ACCESS });
    const token = await refreshAccessToken({ auth: { instanceUrl: "https://example.my.salesforce.com", clientId: "KEY", refreshToken: REFRESH }, fetch: fn });
    expect(token).toBe(ACCESS);
    expect(calls[0]!.url).toBe("https://example.my.salesforce.com/services/oauth2/token");
    const body = new URLSearchParams(String(calls[0]!.init.body));
    expect(Object.fromEntries(body)).toEqual({ grant_type: "refresh_token", client_id: "KEY", refresh_token: REFRESH });
  });
  it("reports status and error field only on failure", async () => {
    const { fn } = fakeFetch(400, { error: "invalid_grant", error_description: `expired ${REFRESH}` });
    const error = (await refreshAccessToken({ auth: { instanceUrl: "https://x", clientId: "K", refreshToken: REFRESH }, fetch: fn }).catch((e: Error) => e)) as Error;
    expect(error.message).toBe("The refresh exchange failed: HTTP 400 invalid_grant. Run npm run mcp-login again.");
    expect(error.message).not.toContain(REFRESH);
  });
});

describe("reading the org through sf", () => {
  function runner(answers: { code: number; stdout: string }[]) {
    const calls: string[][] = [];
    const run: SfRunner = async (args) => {
      calls.push(args);
      return answers.shift() ?? { code: 1, stdout: "" };
    };
    return { run, calls };
  }
  it("finds the consumer key with the query and the credentials call", async () => {
    const { run, calls } = runner([
      { code: 0, stdout: JSON.stringify({ result: { records: [{ Id: "0xyAPPID" }] } }) },
      { code: 0, stdout: JSON.stringify({ consumers: [{ key: "THEKEY" }] }) },
    ]);
    expect(await findConsumerKey(run, "alias")).toBe("THEKEY");
    expect(calls[0]).toEqual(["data", "query", "-t", "-q", "SELECT Id FROM ExternalClientApplication WHERE DeveloperName = 'SalesforceReportsMcp'", "--json", "-o", "alias"]);
    expect(calls[1]).toEqual(["api", "request", "rest", "/services/data/v68.0/apps/oauth/credentials/0xyAPPID", "-o", "alias"]);
  });
  it("says so when the app is missing, without printing output", async () => {
    const { run } = runner([{ code: 0, stdout: JSON.stringify({ result: { records: [] } }) }]);
    const error = (await findConsumerKey(run, "alias").catch((e: Error) => e)) as Error;
    expect(error.message).toContain("External Client App");
  });
  it("reports only the exit code when sf fails", async () => {
    const { run } = runner([{ code: 3, stdout: `oops ${REFRESH}` }]);
    const error = (await findConsumerKey(run, "alias").catch((e: Error) => e)) as Error;
    expect(error.message).toContain("exit code 3");
    expect(error.message).not.toContain(REFRESH);
  });
  it("reads the instance URL from org display", async () => {
    const { run, calls } = runner([{ code: 0, stdout: JSON.stringify({ result: { instanceUrl: "https://example.my.salesforce.com/" } }) }]);
    expect(await readInstanceUrl(run, "alias")).toBe("https://example.my.salesforce.com");
    expect(calls[0]).toEqual(["org", "display", "--json", "--target-org", "alias"]);
  });
});

describe("openerCommand", () => {
  it("picks the platform opener", () => {
    expect(openerCommand("darwin", "U")).toEqual({ file: "open", args: ["U"] });
    expect(openerCommand("linux", "U")).toEqual({ file: "xdg-open", args: ["U"] });
    expect(openerCommand("win32", "U")).toEqual({ file: "cmd", args: ["/c", "start", "", "U"] });
  });
});

describe("printed lines", () => {
  it("holds no token in the success line or in any failure message", async () => {
    expect(storedLine("mine")).toBe("mcp-login: auth=mine stored");
    const lines = [storedLine("mine"), parseCallback("/OauthRedirect?error=x&state=ST", "ST"), parseCallback(`/OauthRedirect?code=${REFRESH}&state=bad`, "ST")];
    for (const line of lines) expect(JSON.stringify(line)).not.toContain(REFRESH);
  });
});
