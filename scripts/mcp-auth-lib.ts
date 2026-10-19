/**
 * The logic behind scripts/mcp-login.ts and the token step of scripts/mcp-check.ts, with no side effects at import:
 * the PKCE values, the authorize URL, the callback parsing, the token requests, the store and the reads through `sf`.
 * `fetch`, the runner for `sf`, the file store and the random source are injected, so tests need no network, no real
 * `sf` and no browser. Nothing here prints a token or puts one in an error message.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Runs `sf` with the given arguments and answers its exit code and stdout. It never throws. */
export type SfRunner = (args: string[]) => Promise<{ code: number; stdout: string }>;

/** The sign-in as stored. No access token is ever stored. */
export interface StoredAuth {
  instanceUrl: string;
  clientId: string;
  refreshToken: string;
}

/** The file system, as far as the store needs it. */
export interface FileStore {
  mkdir(path: string, mode: number): void;
  writeFile(path: string, text: string, mode: number): void;
  readFile(path: string): string | undefined;
}

export const PORT = 1717;
export const CALLBACK_PATH = "/OauthRedirect";
export const REDIRECT_URI = `http://localhost:${PORT}${CALLBACK_PATH}`;
export const SCOPE = "mcp_api refresh_token";
export const APP_NAME = "SalesforceReportsMcp";
const API_VERSION = "68.0";

/** The real file system. Modes are applied after the write too, since the umask can narrow them but not widen. */
export function nodeFileStore(): FileStore {
  return {
    mkdir: (path, mode) => {
      mkdirSync(path, { recursive: true, mode });
      chmodSync(path, mode);
    },
    writeFile: (path, text, mode) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text, { mode });
      chmodSync(path, mode);
    },
    readFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },
  };
}

/** A PKCE verifier and its S256 challenge. `random` gives 32 bytes by default. */
export function pkcePair(random: () => Buffer = () => randomBytes(32)): { verifier: string; challenge: string } {
  const verifier = random().toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function newState(random: () => Buffer = () => randomBytes(16)): string {
  return random().toString("base64url");
}

const base = (instanceUrl: string) => instanceUrl.replace(/\/+$/, "");

export function authorizeUrl(o: { instanceUrl: string; clientId: string; challenge: string; state: string }): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: o.clientId,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    code_challenge: o.challenge,
    code_challenge_method: "S256",
    state: o.state,
  });
  return `${base(o.instanceUrl)}/services/oauth2/authorize?${params}`;
}

/** The command that opens a URL in the default browser. Run it through execFile, never a shell string. */
export function openerCommand(platform: string, url: string): { file: string; args: string[] } {
  if (platform === "darwin") return { file: "open", args: [url] };
  if (platform === "win32") return { file: "cmd", args: ["/c", "start", "", url] };
  return { file: "xdg-open", args: [url] };
}

/**
 * Reads the request target of the callback. Undefined for any other path. A state mismatch or an `error` is a failure
 * with a one-line message; only the error code is echoed, never its description.
 */
export function parseCallback(target: string, expectedState: string): { ok: true; code: string } | { ok: false; message: string } | undefined {
  const url = new URL(target, `http://localhost:${PORT}`);
  if (url.pathname !== CALLBACK_PATH) return undefined;
  if (url.searchParams.get("state") !== expectedState) return { ok: false, message: "mcp-login: the state did not match. Nothing was stored." };
  const error = url.searchParams.get("error");
  if (error) return { ok: false, message: `mcp-login: the sign-in failed: ${error.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 60) || "unknown"}.` };
  const code = url.searchParams.get("code");
  if (!code) return { ok: false, message: "mcp-login: the callback carried no code. Nothing was stored." };
  return { ok: true, code };
}

async function tokenRequest(instanceUrl: string, params: Record<string, string>, fetchFn: typeof fetch, what: string, hint = ""): Promise<Record<string, unknown>> {
  const response = await fetchFn(`${base(instanceUrl)}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(params).toString(),
  });
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(await response.text());
  } catch {
    json = {};
  }
  if (!response.ok) {
    const field = typeof json.error === "string" ? json.error.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 60) : "";
    throw new Error(`The ${what} failed: HTTP ${response.status}${field ? ` ${field}` : ""}.${hint}`);
  }
  return json;
}

/** Exchanges the authorization code for tokens as a public client: no secret. Answers the refresh token. */
export async function exchangeCode(o: { instanceUrl: string; clientId: string; code: string; verifier: string; fetch: typeof fetch }): Promise<string> {
  const json = await tokenRequest(
    o.instanceUrl,
    { grant_type: "authorization_code", client_id: o.clientId, redirect_uri: REDIRECT_URI, code: o.code, code_verifier: o.verifier },
    o.fetch,
    "code exchange",
  );
  if (typeof json.refresh_token !== "string" || !json.refresh_token) throw new Error("The code exchange returned no refresh token.");
  return json.refresh_token;
}

/** A fresh access token from the stored refresh token. The access token is not stored. */
export async function refreshAccessToken(o: { auth: StoredAuth; fetch: typeof fetch }): Promise<string> {
  const json = await tokenRequest(
    o.auth.instanceUrl,
    { grant_type: "refresh_token", client_id: o.auth.clientId, refresh_token: o.auth.refreshToken },
    o.fetch,
    "refresh exchange",
    " Run npm run mcp-login again.",
  );
  if (typeof json.access_token !== "string" || !json.access_token) throw new Error("The refresh exchange returned no access token.");
  return json.access_token;
}

const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

export function authPath(home: string, name: string): string {
  return join(home, ".config", "salesforce-reports-mcp", "auth", `${name}.json`);
}

export function saveAuth(store: FileStore, home: string, name: string, auth: StoredAuth): void {
  if (!NAME.test(name)) throw new Error("The auth name may hold only letters, digits, underscore, dot and hyphen, and may not start with a dot or hyphen.");
  const file = authPath(home, name);
  store.mkdir(dirname(file), 0o700);
  const { instanceUrl, clientId, refreshToken } = auth;
  store.writeFile(file, `${JSON.stringify({ instanceUrl, clientId, refreshToken }, null, 2)}\n`, 0o600);
}

/** The stored sign-in, or undefined when the file is missing, malformed or lacks a field. */
export function loadAuth(store: FileStore, home: string, name: string): StoredAuth | undefined {
  if (!NAME.test(name)) return undefined;
  const text = store.readFile(authPath(home, name));
  if (text === undefined) return undefined;
  try {
    const j = JSON.parse(text);
    if ([j?.instanceUrl, j?.clientId, j?.refreshToken].every((v) => typeof v === "string" && v)) {
      return { instanceUrl: j.instanceUrl, clientId: j.clientId, refreshToken: j.refreshToken };
    }
  } catch {
    // fall through
  }
  return undefined;
}

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The app's consumer key (a client id, not a secret), read the way the install steps do. Output is never put in a message. */
export async function findConsumerKey(run: SfRunner, alias: string): Promise<string> {
  const query = await run(["data", "query", "-t", "-q", `SELECT Id FROM ExternalClientApplication WHERE DeveloperName = '${APP_NAME}'`, "--json", "-o", alias]);
  if (query.code !== 0) throw new Error(`sf data query failed (exit code ${query.code}).`);
  const id = parseJson(query.stdout)?.result?.records?.[0]?.Id;
  if (typeof id !== "string" || !/^[A-Za-z0-9]+$/.test(id)) throw new Error(`The org has no External Client App named ${APP_NAME}. Deploy salesforce/mcp-app first.`);
  const creds = await run(["api", "request", "rest", `/services/data/v${API_VERSION}/apps/oauth/credentials/${id}`, "-o", alias]);
  if (creds.code !== 0) throw new Error(`sf api request failed (exit code ${creds.code}).`);
  const json = parseJson(creds.stdout);
  const key = json?.consumers?.[0]?.key ?? json?.key;
  if (typeof key !== "string" || !key) throw new Error("The app's credentials listing held no consumer key.");
  return key;
}

export async function readInstanceUrl(run: SfRunner, alias: string): Promise<string> {
  const out = await run(["org", "display", "--json", "--target-org", alias]);
  if (out.code !== 0) throw new Error(`sf org display failed (exit code ${out.code}).`);
  const url = parseJson(out.stdout)?.result?.instanceUrl;
  if (typeof url !== "string" || !url) throw new Error("sf org display returned no instance URL.");
  return base(url);
}

/** The one line login prints on success. */
export const storedLine = (name: string): string => `mcp-login: auth=${name} stored`;
