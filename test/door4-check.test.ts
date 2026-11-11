import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { MIN_PASSCODE_LENGTH, newPasscode, QUERY_INPUT, runDoor4Check, STEP_LABELS, summaryLine, type Spawn } from "../scripts/door4-check-lib.js";

const PASSCODE = "p".repeat(30) + "-secret-passcode";
const CODE = "authcode-value-xyz";
const TOKEN = "access-token-value-abc";
const REFRESH = "refresh-token-value-def";
const ROW_VALUE = "Closed Won Row Value 77";
const PORT = 4321;
const BASE = `http://127.0.0.1:${PORT}`;

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  signals: string[] = [];
  kill(signal: string = "SIGTERM"): void {
    this.signals.push(signal);
    queueMicrotask(() => this.emit("exit", 0, signal));
  }
}

const json = (status: number, data: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

interface Seen {
  url: string;
  method: string;
  body: string;
  auth: string | null;
}

/** A fake door 4: each handler may be replaced to make one step answer the wrong status. */
function fakeServer(overrides: Record<string, (seen: Seen) => Response> = {}) {
  const seen: Seen[] = [];
  const handlers: Record<string, (s: Seen) => Response> = {
    "GET /.well-known/oauth-protected-resource/mcp": () => json(200, { resource: `${BASE}/mcp`, authorization_servers: [`${BASE}/`] }),
    "GET /.well-known/oauth-authorization-server": () =>
      json(200, {
        issuer: `${BASE}/`,
        authorization_endpoint: `${BASE}/authorize`,
        token_endpoint: `${BASE}/token`,
        registration_endpoint: `${BASE}/register`,
        code_challenge_methods_supported: ["S256"],
      }),
    "POST /register": () => json(201, { client_id: "client-1" }),
    "POST /authorize": (s) => {
      const form = new URLSearchParams(s.body);
      const target = new URL(form.get("redirect_uri")!);
      target.searchParams.set("code", CODE);
      target.searchParams.set("state", form.get("state")!);
      return new Response(null, { status: 302, headers: { location: target.href } });
    },
    "POST /token": () => json(200, { access_token: TOKEN, refresh_token: REFRESH, token_type: "Bearer" }),
    "POST /mcp": (s) => {
      const msg = JSON.parse(s.body);
      const headers = { "mcp-session-id": "session-1" };
      if (msg.method === "initialize") return json(200, { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18" } }, headers);
      if (msg.method === "notifications/initialized") return new Response(null, { status: 202, headers });
      if (msg.method === "tools/list") {
        return json(200, { jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "query_report" }, { name: "run_report" }] } }, headers);
      }
      const data = { groups: { dimensions: [], measures: [], rows: [[{ value: ROW_VALUE }], [{ value: "Another" }]] } };
      const text = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(data) }] } })}\n\n`;
      return new Response(text, { status: 200, headers: { "content-type": "text/event-stream", ...headers } });
    },
    "DELETE /mcp": () => new Response(null, { status: 200 }),
    ...overrides,
  };
  const fetchFake = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const entry: Seen = {
      url,
      method,
      body: init?.body === undefined ? "" : String(init.body),
      auth: new Headers(init?.headers).get("authorization"),
    };
    seen.push(entry);
    const handler = handlers[`${method} ${new URL(url).pathname}`];
    return handler ? handler(entry) : json(404, {});
  }) as typeof fetch;
  return { seen, fetch: fetchFake };
}

function harness(options: { listens?: boolean; overrides?: Record<string, (s: Seen) => Response> } = {}) {
  const child = new FakeChild();
  const spawned: { cmd: string; args: string[]; env: Record<string, string> }[] = [];
  const spawn: Spawn = (cmd, args, env) => {
    spawned.push({ cmd, args, env });
    if (options.listens !== false) {
      queueMicrotask(() => child.stderr.emit("data", Buffer.from(`salesforce-reports-mcp: listening on ${BASE}/mcp (OAuth sign-in on)\n`)));
    }
    return child;
  };
  const server = fakeServer(options.overrides);
  const lines: string[] = [];
  const run = () =>
    runDoor4Check({ org: "alias-x", port: PORT, passcode: PASSCODE, spawn, fetch: server.fetch, print: (l) => lines.push(l), startTimeoutMs: 200, stopTimeoutMs: 200 });
  return { child, spawned, server, lines, run };
}

describe("runDoor4Check", () => {
  it("runs the connector flow and passes", async () => {
    const h = harness();
    const r = await h.run();
    expect(r.ok).toBe(true);
    expect(r.tools).toBe(2);
    expect(r.steps).toHaveLength(STEP_LABELS.length);
    expect(h.lines.at(-1)).toBe(`door4-check: tools=2 steps=${STEP_LABELS.length}/${STEP_LABELS.length}`);
    expect(h.lines.filter((l) => l.startsWith("PASS ")).length).toBe(STEP_LABELS.length);
  });

  it("starts the server read-only with the passcode in the environment only", async () => {
    const h = harness();
    await h.run();
    const [spawned] = h.spawned;
    expect(spawned!.args).toEqual(["dist/index.js", "--org", "alias-x", "--http", String(PORT), "--public-url", BASE, "--read-only"]);
    expect(spawned!.env).toEqual({ SF_REPORTS_HTTP_PASSCODE: PASSCODE });
    expect(spawned!.args.join(" ")).not.toContain(PASSCODE);
  });

  it("sends PKCE S256, the passcode, the bearer and the summary query", async () => {
    const h = harness();
    await h.run();
    const authorize = h.server.seen.find((s) => s.method === "POST" && s.url.endsWith("/authorize"))!;
    const form = new URLSearchParams(authorize.body);
    expect(form.get("code_challenge_method")).toBe("S256");
    expect(form.get("passcode")).toBe(PASSCODE);
    expect(form.get("redirect_uri")).toBe(`${BASE}/callback`);
    expect(form.get("resource")).toBe(`${BASE}/mcp`);
    const exchange = new URLSearchParams(h.server.seen.find((s) => s.url.endsWith("/token"))!.body);
    expect(exchange.get("code")).toBe(CODE);
    expect(exchange.get("code_verifier")).toBeTruthy();
    const mcp = h.server.seen.filter((s) => s.url.endsWith("/mcp") && s.method === "POST");
    expect(mcp.length).toBe(4);
    for (const s of mcp) expect(s.auth).toBe(`Bearer ${TOKEN}`);
    const call = JSON.parse(mcp.at(-1)!.body);
    expect(call.params.name).toBe("query_report");
    expect(call.params.arguments).toEqual(JSON.parse(JSON.stringify(QUERY_INPUT)));
  });

  it("stops the child after a pass", async () => {
    const h = harness();
    await h.run();
    expect(h.child.signals).toEqual(["SIGTERM"]);
  });

  it("fails on a wrong-status step, stops the flow and still stops the child", async () => {
    const h = harness({ overrides: { "POST /register": () => json(500, {}) } });
    const r = await h.run();
    expect(r.ok).toBe(false);
    expect(r.steps.map((s) => s.ok)).toEqual([true, true, true, false]);
    expect(h.lines.some((l) => l.startsWith("FAIL ") && l.includes("registration answered 500"))).toBe(true);
    expect(h.lines.at(-1)).toBe(`door4-check: tools=0 steps=3/${STEP_LABELS.length}`);
    expect(h.server.seen.some((s) => s.url.endsWith("/authorize"))).toBe(false);
    expect(h.child.signals).toEqual(["SIGTERM"]);
  });

  it("fails when query_report has no group rows", async () => {
    const empty = (s: { body: string }) => {
      const msg = JSON.parse(s.body);
      const headers = { "mcp-session-id": "session-1" };
      if (msg.method === "initialize") return json(200, { jsonrpc: "2.0", id: msg.id, result: {} }, headers);
      if (msg.method === "notifications/initialized") return new Response(null, { status: 202, headers });
      if (msg.method === "tools/list") return json(200, { jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "query_report" }] } }, headers);
      return json(200, { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify({ groups: { rows: [] } }) }] } }, headers);
    };
    const h = harness({ overrides: { "POST /mcp": empty } });
    const r = await h.run();
    expect(r.ok).toBe(false);
    expect(h.lines.at(-1)).toBe(`door4-check: tools=1 steps=${STEP_LABELS.length - 1}/${STEP_LABELS.length}`);
  });

  it("fails and stops the child when the server never prints its listening line", async () => {
    const h = harness({ listens: false });
    const r = await h.run();
    expect(r.ok).toBe(false);
    expect(h.server.seen).toHaveLength(0);
    expect(h.child.signals).toEqual(["SIGTERM"]);
  });

  it("fails when the child exits before it listens", async () => {
    const h = harness({ listens: false });
    const original = h.child.emit.bind(h.child);
    queueMicrotask(() => original("exit", 1, null));
    const r = await h.run();
    expect(r.ok).toBe(false);
    expect(h.lines.at(-1)).toBe(`door4-check: tools=0 steps=0/${STEP_LABELS.length}`);
  });

  it("names a thrown request without its message", async () => {
    const h = harness();
    const server = fakeServer();
    const throwing = (async (input: RequestInfo | URL) => {
      if (String(input).includes("oauth-protected-resource")) throw new Error(`connect refused with ${PASSCODE}`);
      return json(404, {});
    }) as typeof fetch;
    const lines: string[] = [];
    const r = await runDoor4Check({
      org: "a",
      port: PORT,
      passcode: PASSCODE,
      spawn: (() => {
        queueMicrotask(() => h.child.stderr.emit("data", "listening on x"));
        return h.child;
      }) as Spawn,
      fetch: throwing,
      print: (l) => lines.push(l),
      stopTimeoutMs: 100,
    });
    void server;
    expect(r.ok).toBe(false);
    expect(lines.join("\n")).not.toContain(PASSCODE);
  });

  it("never prints the passcode, a token, a code or a row value", async () => {
    for (const overrides of [undefined, { "POST /token": () => json(500, { error: `bad ${PASSCODE} ${TOKEN}` }) }]) {
      const h = harness({ overrides });
      await h.run();
      const text = h.lines.join("\n");
      for (const secret of [PASSCODE, TOKEN, REFRESH, CODE, ROW_VALUE, "Another"]) expect(text).not.toContain(secret);
    }
  });

  it("scrubs a secret that reaches a failure detail", async () => {
    const h = harness({ overrides: { "POST /register": () => json(500, {}) } });
    const lines: string[] = [];
    await runDoor4Check({
      org: "a", port: PORT, passcode: PASSCODE, fetch: h.server.fetch, print: (l) => lines.push(l), startTimeoutMs: 100, stopTimeoutMs: 100,
      spawn: (() => {
        queueMicrotask(() => h.child.stderr.emit("data", "listening on x"));
        return h.child;
      }) as Spawn,
    });
    expect(lines.join("\n")).not.toContain(PASSCODE);
  });
});

describe("summaryLine and passcode", () => {
  it("counts passed steps against the planned total", () => {
    const steps = [{ ok: true, label: "a", detail: "" }, { ok: false, label: "b", detail: "" }];
    expect(summaryLine(15, steps)).toBe(`door4-check: tools=15 steps=1/${STEP_LABELS.length}`);
  });
  it("makes a long random passcode", () => {
    const a = newPasscode();
    expect(a.length).toBeGreaterThanOrEqual(MIN_PASSCODE_LENGTH);
    expect(a).not.toBe(newPasscode());
  });
});
