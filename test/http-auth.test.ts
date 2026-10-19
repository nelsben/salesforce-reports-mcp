import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ReportsApi } from "../src/reports/api.js";
import type { SalesforceApi } from "../src/salesforce/client.js";
import { startHttpServer, type HttpHandle } from "../src/http.js";
import { resolvePublicUrl } from "../src/http-auth.js";
import { buildServer } from "../src/server.js";

const PUBLIC = "https://reports.example.test";
const RESOURCE = `${PUBLIC}/mcp`;
const PRM = `${PUBLIC}/.well-known/oauth-protected-resource/mcp`;
const PASSCODE = "correct-horse-battery-staple-42";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const ROOT = fileURLToPath(new URL("..", import.meta.url));

const api: SalesforceApi = {
  apiVersion: "62.0",
  instanceUrl: async () => "https://example.my.salesforce.com",
  request: async (method: string, path: string) => {
    throw new Error(`unexpected request ${method} ${path}`);
  },
};
const reports = new ReportsApi(api, async () => undefined);
const factory = () => buildServer(reports, { readOnly: false, allowDelete: true, maxRows: 200 });

let handle: HttpHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

const b64url = (buf: Buffer) => buf.toString("base64url");
function pkce() {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
};

function flow(base: string) {
  const form = (path: string, body: Record<string, string>) =>
    fetch(`${base}${path}`, { method: "POST", body: new URLSearchParams(body), redirect: "manual" });
  const register = (redirect_uris: string[], client_name = "Claude") =>
    fetch(`${base}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris, client_name, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
    });
  const authParams = (clientId: string, challenge: string, extra: Record<string, string> = {}) => ({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "state-123",
    resource: RESOURCE,
    ...extra,
  });
  const approve = (clientId: string, challenge: string, passcode: string, extra: Record<string, string> = {}) =>
    form("/authorize", { ...authParams(clientId, challenge, extra), passcode });
  const code = async (clientId: string, challenge: string) => {
    const res = await approve(clientId, challenge, PASSCODE);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(`${location.origin}${location.pathname}`).toBe(CALLBACK);
    expect(location.searchParams.get("state")).toBe("state-123");
    return location.searchParams.get("code")!;
  };
  const exchange = (clientId: string, c: string, verifier: string) =>
    form("/token", { grant_type: "authorization_code", client_id: clientId, code: c, code_verifier: verifier, redirect_uri: CALLBACK, resource: RESOURCE });
  const refresh = (clientId: string, token: string) => form("/token", { grant_type: "refresh_token", client_id: clientId, refresh_token: token, resource: RESOURCE });
  const mcp = (token?: string) =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(INIT),
    });
  const listTools = async (token: string) => {
    const client = new Client({ name: "test", version: "0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    await transport.terminateSession();
    await client.close();
    return tools;
  };
  return { form, register, authParams, approve, code, exchange, refresh, mcp, listTools };
}

async function startOwner(now: () => number) {
  handle = await startHttpServer({ port: 0, host: "127.0.0.1", createServer: factory, oauth: { publicUrl: PUBLIC, passcode: PASSCODE, now } });
  return `http://127.0.0.1:${handle.port}`;
}

describe("http door OAuth layer", () => {
  it("signs one owner's client in end to end and guards /mcp", async () => {
    let now = Date.now();
    const base = await startOwner(() => now);
    const f = flow(base);
    const captured: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
      captured.push(String(chunk));
      return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write;
    const secrets: string[] = [PASSCODE];
    try {
      // Metadata documents
      const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
      expect(as.issuer).toBe(`${PUBLIC}/`);
      expect(as.authorization_endpoint).toBe(`${PUBLIC}/authorize`);
      expect(as.token_endpoint).toBe(`${PUBLIC}/token`);
      expect(as.registration_endpoint).toBe(`${PUBLIC}/register`);
      expect(as.revocation_endpoint).toBe(`${PUBLIC}/revoke`);
      expect(as.code_challenge_methods_supported).toEqual(["S256"]);
      const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
      expect(prm.resource).toBe(RESOURCE);
      expect(prm.authorization_servers).toEqual([`${PUBLIC}/`]);

      // Registration: https and loopback http accepted, public http refused
      const reg = await f.register([CALLBACK]);
      expect(reg.status).toBe(201);
      const clientId = (await reg.json()).client_id as string;
      expect((await f.register(["http://127.0.0.1:33418/callback"], "Desktop")).status).toBe(201);
      expect((await f.register(["http://localhost/callback"], "Desktop")).status).toBe(201);
      const bad = await f.register(["http://evil.example.com/callback"]);
      expect(bad.status).toBe(400);
      expect((await bad.json()).error).toBe("invalid_client_metadata");
      expect((await f.register([CALLBACK, "http://evil.example.com/callback"])).status).toBe(400);

      // The passcode page
      const { verifier, challenge } = pkce();
      const page = await fetch(`${base}/authorize?${new URLSearchParams(f.authParams(clientId, challenge))}`);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toMatch(/text\/html/);
      const html = await page.text();
      expect(html).toContain("Claude");
      expect(html).toMatch(/Salesforce user/);
      expect(html).toMatch(/name="passcode"/);
      expect(html).not.toMatch(/<script|<link|src=|https?:\/\/(?!claude\.ai\/api\/mcp\/auth_callback|reports\.example\.test)/i);

      // Wrong passcode: the page again, no redirect, no echo
      const wrong = await f.approve(clientId, challenge, "not-the-passcode-at-all");
      expect(wrong.status).toBe(403);
      expect(wrong.headers.get("location")).toBeNull();
      const wrongHtml = await wrong.text();
      expect(wrongHtml).toMatch(/passcode/i);
      expect(wrongHtml).not.toContain("not-the-passcode-at-all");

      // Right passcode: a code; a wrong verifier burns it
      const code1 = await f.code(clientId, challenge);
      const badVerifier = await f.exchange(clientId, code1, pkce().verifier);
      expect(badVerifier.status).toBe(400);
      expect((await badVerifier.json()).error).toBe("invalid_grant");
      expect((await f.exchange(clientId, code1, verifier)).status).toBe(400);

      // A fresh code is exchanged once, then refused
      const code2 = await f.code(clientId, challenge);
      const tokenRes = await f.exchange(clientId, code2, verifier);
      expect(tokenRes.status).toBe(200);
      const tokens = await tokenRes.json();
      secrets.push(tokens.access_token, tokens.refresh_token, code1, code2);
      expect(tokens.token_type.toLowerCase()).toBe("bearer");
      expect(tokens.expires_in).toBe(3600);
      expect(tokens.access_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(tokens.refresh_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect((await f.exchange(clientId, code2, verifier)).status).toBe(400);

      // A code expires after 5 minutes
      const code3 = await f.code(clientId, challenge);
      secrets.push(code3);
      now += 5 * 60_000 + 1000;
      expect((await f.exchange(clientId, code3, verifier)).status).toBe(400);
      now -= 5 * 60_000 + 1000;

      // /mcp: 401 with the header, then 16 tools with the bearer
      const anon = await f.mcp();
      expect(anon.status).toBe(401);
      expect(anon.headers.get("www-authenticate")).toContain(`resource_metadata="${PRM}"`);
      const junk = await f.mcp("not-a-real-token");
      expect(junk.status).toBe(401);
      expect(junk.headers.get("www-authenticate")).toContain(`resource_metadata="${PRM}"`);
      expect(await f.listTools(tokens.access_token)).toHaveLength(16);

      // Refresh rotates; the old refresh token stops working
      const rotated = await f.refresh(clientId, tokens.refresh_token);
      expect(rotated.status).toBe(200);
      const next = await rotated.json();
      secrets.push(next.access_token, next.refresh_token);
      expect(next.refresh_token).not.toBe(tokens.refresh_token);
      expect((await f.refresh(clientId, tokens.refresh_token)).status).toBe(400);
      expect(await f.listTools(next.access_token)).toHaveLength(16);

      // Revocation ends a refresh token
      const spare = await (await f.refresh(clientId, next.refresh_token)).json();
      secrets.push(spare.access_token, spare.refresh_token);
      expect((await f.form("/revoke", { client_id: clientId, token: spare.refresh_token })).status).toBe(200);
      expect((await f.refresh(clientId, spare.refresh_token)).status).toBe(400);

      // An access token expires after an hour
      now += 3600_000 + 1000;
      expect((await f.mcp(next.access_token)).status).toBe(401);
      now -= 3600_000 + 1000;

      // A token for another resource fails, and another resource cannot be asked for
      const foreign = handle!.oauth!.issueTokens(clientId, new URL("https://other.example.test/mcp"), []);
      secrets.push(foreign.access_token, foreign.refresh_token!);
      expect((await f.mcp(foreign.access_token)).status).toBe(401);
      const otherResource = await f.approve(clientId, challenge, PASSCODE, { resource: "https://other.example.test/mcp" });
      expect(otherResource.status).toBe(302);
      const otherLocation = new URL(otherResource.headers.get("location")!);
      expect(otherLocation.searchParams.get("error")).toBe("invalid_target");
      expect(otherLocation.searchParams.get("code")).toBeNull();
    } finally {
      process.stderr.write = write;
    }
    for (const line of captured) for (const secret of secrets) expect(line).not.toContain(secret);
  });

  it("rate limits wrong passcodes", async () => {
    let now = Date.now();
    const base = await startOwner(() => now);
    const f = flow(base);
    const clientId = (await (await f.register([CALLBACK])).json()).client_id as string;
    const { challenge } = pkce();
    for (let i = 0; i < 10; i++) expect((await f.approve(clientId, challenge, `wrong-passcode-${i}`)).status).toBe(403);
    const locked = await f.approve(clientId, challenge, PASSCODE);
    expect(locked.status).toBe(429);
    expect(locked.headers.get("location")).toBeNull();
    now += 15 * 60_000 + 1000;
    expect((await f.approve(clientId, challenge, PASSCODE)).status).toBe(302);
  });

  it("refuses to start without a long enough passcode or with a public http URL", async () => {
    const start = (publicUrl: string, passcode: string) =>
      startHttpServer({ port: 0, host: "127.0.0.1", createServer: factory, oauth: { publicUrl, passcode } });
    await expect(start(PUBLIC, "")).rejects.toThrow(/SF_REPORTS_HTTP_PASSCODE/);
    const short = start(PUBLIC, "short-pass-15ch");
    await expect(short).rejects.toThrow(/at least 16/);
    await short.catch((error: Error) => expect(error.message).not.toContain("short-pass-15ch"));
    await expect(start("http://reports.example.test", PASSCODE)).rejects.toThrow(/https/);
    expect(resolvePublicUrl("http://127.0.0.1:8080").href).toBe("http://127.0.0.1:8080/");
    expect(resolvePublicUrl("https://reports.example.test/").href).toBe(`${PUBLIC}/`);
    expect(() => resolvePublicUrl("https://reports.example.test/base")).toThrow();
    expect(() => resolvePublicUrl("not a url")).toThrow();
  });
});

// The real CLI, so stderr is what a person would see. No sf: a fake token in env, and no tool touches Salesforce.
function cli(args: string[], env: Record<string, string>) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("SF_"))) as Record<string, string>;
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", ...args], {
    cwd: ROOT,
    env: { ...clean, SF_INSTANCE_URL: "https://example.my.salesforce.com", SF_ACCESS_TOKEN: "fake-access-token-not-real", ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += String(d)));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  const listening = new Promise<string>((resolve, reject) => {
    child.stderr.on("data", () => {
      const m = /listening on (http:\/\/\S+)\/mcp/.exec(stderr);
      if (m) resolve(m[1]!);
    });
    void exited.then(() => reject(new Error(`exited: ${stderr}`)));
  });
  listening.catch(() => undefined);
  return { child, exited, listening, stderr: () => stderr };
}

describe("http door CLI", () => {
  it("lists --public-url and the passcode variable in --help", async () => {
    const run = cli(["--help"], {});
    expect(await run.exited).toBe(0);
    expect(run.stderr()).toContain("--public-url");
    expect(run.stderr()).toContain("SF_REPORTS_HTTP_PASSCODE");
  }, 30_000);

  it("refuses to start without the passcode, with a short one, or with it as a flag", async () => {
    const base = ["--http", "0", "--public-url", PUBLIC];
    const none = cli(base, {});
    expect(await none.exited).toBe(1);
    expect(none.stderr()).toContain("SF_REPORTS_HTTP_PASSCODE");
    const short = cli(base, { SF_REPORTS_HTTP_PASSCODE: "short-pass-15ch" });
    expect(await short.exited).toBe(1);
    expect(short.stderr()).toMatch(/at least 16/);
    expect(short.stderr()).not.toContain("short-pass-15ch");
    const flagged = cli([...base, "--passcode", PASSCODE], { SF_REPORTS_HTTP_PASSCODE: PASSCODE });
    expect(await flagged.exited).toBe(1);
    expect(flagged.stderr()).not.toContain(PASSCODE);
    const exposed = cli(["--http", "0", "--host", "0.0.0.0"], { SF_REPORTS_HTTP_PASSCODE: PASSCODE });
    expect(await exposed.exited).toBe(1);
    expect(exposed.stderr()).toMatch(/--public-url/);
  }, 60_000);

  it("signs in through the real process and never writes the passcode or a token to stderr", async () => {
    const run = cli(["--http", "0", "--public-url", PUBLIC, "--allow-delete"], { SF_REPORTS_HTTP_PASSCODE: PASSCODE, SF_REPORTS_PUBLIC_URL: "" });
    try {
      const base = await run.listening;
      expect(run.stderr()).toContain(RESOURCE);
      const f = flow(base);
      expect((await f.mcp()).status).toBe(401);
      const clientId = (await (await f.register([CALLBACK])).json()).client_id as string;
      const { verifier, challenge } = pkce();
      expect((await f.approve(clientId, challenge, "wrong-passcode-here")).status).toBe(403);
      const tokens = await (await f.exchange(clientId, await f.code(clientId, challenge), verifier)).json();
      expect(await f.listTools(tokens.access_token)).toHaveLength(16);
      const next = await (await f.refresh(clientId, tokens.refresh_token)).json();
      expect((await f.refresh(clientId, tokens.refresh_token)).status).toBe(400);
      for (const secret of [PASSCODE, tokens.access_token, tokens.refresh_token, next.access_token, next.refresh_token]) {
        expect(run.stderr()).not.toContain(secret);
      }
    } finally {
      run.child.kill("SIGTERM");
      await run.exited;
    }
  }, 60_000);
});
