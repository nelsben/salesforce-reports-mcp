/**
 * The logic behind scripts/door4-check.ts, with no side effects at import: it starts door 4 (the server over HTTP
 * with its own OAuth sign-in) on loopback and does what a connector does, step by step. `spawn` and `fetch` are
 * injected, so tests need no network, no org and no real server. Output is fixed words and counts. The passcode,
 * the tokens and the row values never reach `print`, even through an error.
 */
import { createHash, randomBytes } from "node:crypto";
import { body, type Json } from "./mcp-check-lib.js";

/** The part of a child process this check uses. Node's ChildProcess fits. */
export interface ServerProcess {
  stdout?: { on(event: "data", listener: (chunk: unknown) => void): unknown } | null;
  stderr?: { on(event: "data", listener: (chunk: unknown) => void): unknown } | null;
  on(event: "exit" | "error", listener: (...args: unknown[]) => void): unknown;
  kill(signal?: "SIGTERM" | "SIGKILL"): unknown;
}
export type Spawn = (cmd: string, args: string[], env: Record<string, string>) => ServerProcess;

export interface StepResult {
  ok: boolean;
  label: string;
  detail: string;
}

export const STEP_LABELS = [
  "the server prints its listening line",
  "the protected-resource metadata names the sign-in server",
  "the authorization-server metadata offers PKCE S256",
  "a client registers with a loopback redirect",
  "the passcode signs in and returns a code",
  "the code exchanges for an access token",
  "tools/list answers over /mcp with the bearer",
  "query_report returns a summary with group rows",
] as const;

/** A summary of Opportunity amounts by stage on the standard Opportunity report type. Nothing is saved. */
export const QUERY_INPUT = {
  reportType: "Opportunity",
  format: "SUMMARY",
  groupingsDown: [{ column: "STAGE_NAME" }],
  aggregates: ["RowCount", { fn: "sum", column: "AMOUNT" }],
} as const;

export const MIN_PASSCODE_LENGTH = 24;

/** A random passcode of 32 characters. */
export const newPasscode = (): string => randomBytes(24).toString("base64url");

/** The last line of the check. */
export function summaryLine(tools: number, steps: readonly StepResult[], total: number = STEP_LABELS.length): string {
  return `door4-check: tools=${tools} steps=${steps.filter((s) => s.ok).length}/${total}`;
}

export interface CheckOptions {
  org: string;
  port: number;
  passcode: string;
  spawn: Spawn;
  fetch: typeof fetch;
  /** Prints one terminal line. Secrets are scrubbed from it. */
  print: (line: string) => void;
  /** How long to wait for the listening line, in milliseconds. */
  startTimeoutMs?: number;
  /** How long to wait for the child to exit after SIGTERM before SIGKILL, in milliseconds. */
  stopTimeoutMs?: number;
}

const b64url = (buf: Buffer): string => buf.toString("base64url");

/** Starts the server, runs the connector flow and always stops the server. Never throws for a failed step. */
export async function runDoor4Check(options: CheckOptions): Promise<{ ok: boolean; tools: number; steps: StepResult[] }> {
  const { org, port, passcode, spawn } = options;
  const doFetch = options.fetch;
  const base = `http://127.0.0.1:${port}`;
  const secrets = new Set<string>([passcode]);
  const scrub = (text: string): string => [...secrets].reduce((t, s) => (s ? t.split(s).join("[redacted]") : t), text);
  const print = (line: string): void => options.print(scrub(line));

  const steps: StepResult[] = [];
  let tools = 0;
  /** Records a step. `detail` says why it failed; `okDetail` is a count shown when it passed. */
  const add = (ok: boolean, detail = "", okDetail = ""): boolean => {
    const label = STEP_LABELS[steps.length]!;
    const shown = ok ? okDetail : detail;
    steps.push({ ok, label, detail: shown });
    print(`${ok ? "PASS" : "FAIL"}  ${label}${shown ? `: ${shown}` : ""}`);
    return ok;
  };

  let exited = false;
  const child = spawn(
    process.execPath,
    ["dist/index.js", "--org", org, "--http", String(port), "--public-url", base, "--read-only"],
    { SF_REPORTS_HTTP_PASSCODE: passcode },
  );
  let onExit: () => void = () => {};
  const exitedPromise = new Promise<void>((resolve) => {
    onExit = resolve;
  });
  child.on("exit", () => {
    exited = true;
    onExit();
  });
  child.on("error", () => {
    exited = true;
    onExit();
  });
  child.stdout?.on("data", () => {});

  /** Stops the child: SIGTERM, then SIGKILL if it has not exited in time. */
  const stop = async (): Promise<void> => {
    if (exited) return;
    child.kill("SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), options.stopTimeoutMs ?? 3000);
    });
    const result = await Promise.race([exitedPromise.then(() => "exit" as const), timedOut]);
    clearTimeout(timer);
    if (result === "timeout" && !exited) child.kill("SIGKILL");
  };

  try {
    // Step 1: the listening line, from the child's stderr. Its text is never printed.
    const listening = new Promise<string>((resolve) => {
      let seen = "";
      child.stderr?.on("data", (chunk) => {
        seen += String(chunk);
        if (/listening on /.test(seen)) resolve("listening");
      });
      void exitedPromise.then(() => resolve("exited"));
      setTimeout(() => resolve("timeout"), options.startTimeoutMs ?? 30_000).unref?.();
    });
    const started = await listening;
    if (!add(started === "listening", started === "listening" ? "" : started === "exited" ? "the server exited before it listened" : "no listening line in time")) {
      return finish();
    }

    const json = async (res: Response): Promise<Json> => {
      try {
        return await res.json();
      } catch {
        return undefined;
      }
    };
    const wrong = (what: string, res: Response): string => `${what} answered ${res.status}`;

    // Step 2 and 3: the two metadata documents.
    const prm = await doFetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    const prmBody = prm.status === 200 ? await json(prm) : undefined;
    const names = Array.isArray(prmBody?.authorization_servers) && prmBody.authorization_servers.length > 0;
    if (!add(prm.status === 200 && names, prm.status === 200 ? "no authorization server named" : wrong("the metadata", prm))) return finish();

    const asm = await doFetch(`${base}/.well-known/oauth-authorization-server`);
    const asBody: Json = asm.status === 200 ? await json(asm) : undefined;
    const s256 = Array.isArray(asBody?.code_challenge_methods_supported) && asBody.code_challenge_methods_supported.includes("S256");
    const endpoints = ["authorization_endpoint", "token_endpoint", "registration_endpoint"].every((k) => typeof asBody?.[k] === "string");
    if (!add(asm.status === 200 && s256 && endpoints, asm.status === 200 ? "S256 or an endpoint is missing" : wrong("the metadata", asm))) return finish();

    // Step 4: register a public client with a loopback redirect.
    const redirect = `${base}/callback`;
    const reg = await doFetch(asBody.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [redirect],
        client_name: "door4-check",
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    const regBody: Json = reg.status === 201 ? await json(reg) : undefined;
    const clientId: string | undefined = typeof regBody?.client_id === "string" ? regBody.client_id : undefined;
    if (!add(reg.status === 201 && Boolean(clientId), reg.status === 201 ? "no client id" : wrong("registration", reg))) return finish();

    // Step 5: /authorize with PKCE S256, signed in with the passcode as the form post the sign-in page makes.
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const state = b64url(randomBytes(8));
    const resource = `${base}/mcp`;
    const auth = await doFetch(asBody.authorization_endpoint, {
      method: "POST",
      redirect: "manual",
      body: new URLSearchParams({
        response_type: "code",
        client_id: clientId!,
        redirect_uri: redirect,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
        resource,
        passcode,
      }),
    });
    let code: string | undefined;
    if (auth.status === 302) {
      try {
        const target = new URL(auth.headers.get("location") ?? "");
        if (target.searchParams.get("state") === state) code = target.searchParams.get("code") ?? undefined;
      } catch {
        // a location that is not a URL leaves code unset
      }
    }
    if (code) secrets.add(code);
    if (!add(Boolean(code), auth.status === 302 ? "no code or a different state" : wrong("authorize", auth))) return finish();

    // Step 6: the code for tokens.
    const tok = await doFetch(asBody.token_endpoint, {
      method: "POST",
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId!, code: code!, code_verifier: verifier, redirect_uri: redirect, resource }),
    });
    const tokBody: Json = tok.status === 200 ? await json(tok) : undefined;
    const token: string | undefined = typeof tokBody?.access_token === "string" ? tokBody.access_token : undefined;
    if (typeof tokBody?.refresh_token === "string") secrets.add(tokBody.refresh_token);
    if (token) secrets.add(token);
    if (!add(Boolean(token), tok.status === 200 ? "no access token" : wrong("the token endpoint", tok))) return finish();

    // Step 7 and 8: Streamable HTTP at /mcp with the bearer.
    let sessionId: string | undefined;
    let nextId = 1;
    const rpc = async (method: string, params?: Json, notify = false): Promise<Json> => {
      const message: Json = { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) };
      if (!notify) message.id = nextId++;
      const res = await doFetch(resource, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        },
        body: JSON.stringify(message),
      });
      sessionId = res.headers.get("mcp-session-id") ?? sessionId;
      const text = await res.text();
      if (!res.ok) throw new Error(`${method} answered ${res.status}`);
      if (notify) return undefined;
      const payloads = (res.headers.get("content-type") ?? "").includes("text/event-stream")
        ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)))
        : [JSON.parse(text)];
      const reply = payloads.find((p) => p.id === message.id);
      if (!reply) throw new Error(`${method} had no reply`);
      if (reply.error) throw new Error(`${method} answered an error`);
      return reply.result;
    };

    let listed: Json[] | undefined;
    let listFailure = "";
    try {
      await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "door4-check", version: "0.0.0" } });
      await rpc("notifications/initialized", undefined, true);
      listed = (await rpc("tools/list", {}))?.tools;
    } catch (error) {
      listFailure = error instanceof Error ? error.message : "failed";
    }
    tools = Array.isArray(listed) ? listed.length : 0;
    if (!add(tools > 0, listFailure || `${tools} tools`, `${tools} tools`)) return finish();

    let queryOk = false;
    let queryDetail = "";
    try {
      const result = await rpc("tools/call", { name: "query_report", arguments: QUERY_INPUT });
      const data = body(result);
      const rows = Array.isArray(data?.groups?.rows) ? data.groups.rows.length : 0;
      queryOk = !result?.isError && rows >= 1;
      queryDetail = result?.isError ? "the tool answered an error" : `groups rows=${rows}`;
    } catch (error) {
      queryDetail = error instanceof Error ? error.message : "failed";
    }
    add(queryOk, queryDetail, queryDetail);

    // Best effort: end the session. A failure here changes nothing.
    if (sessionId) {
      try {
        await doFetch(resource, { method: "DELETE", headers: { authorization: `Bearer ${token}`, "mcp-session-id": sessionId } });
      } catch {
        // ignored
      }
    }
    return finish();
  } catch (error) {
    // A step threw (a refused connection, say). Name the step, never the message.
    if (steps.length < STEP_LABELS.length) add(false, error instanceof Error && error.name ? "the request failed" : "failed");
    return finish();
  } finally {
    await stop();
  }

  function finish(): { ok: boolean; tools: number; steps: StepResult[] } {
    const ok = steps.length === STEP_LABELS.length && steps.every((s) => s.ok);
    print(summaryLine(tools, steps));
    return { ok, tools, steps };
  }
}
