import { exec as nodeExec, execFile as nodeExecFile } from "node:child_process";

export interface Auth {
  instanceUrl: string;
  accessToken: string;
}

export interface Connection {
  /** Current credentials. Fetched lazily, then cached. */
  getAuth(): Promise<Auth>;
  /** Fetch credentials again after a 401. Throws when the source cannot refresh. */
  refresh(): Promise<Auth>;
}

export type ExecFile = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number },
) => Promise<{ stdout: string }>;

/** Runs one command string through a shell. Used only on Windows, where sf.cmd needs one. */
export type ExecShell = (
  command: string,
  options: { timeout: number; maxBuffer: number },
) => Promise<{ stdout: string }>;

export interface ConnectionOptions {
  org?: string;
  env?: Record<string, string | undefined>;
  execFile?: ExecFile;
  execShell?: ExecShell;
  /** Defaults to process.platform. Tests set it to cover win32 on any OS. */
  platform?: NodeJS.Platform;
}

export class ConnectionError extends Error {}

const defaultExecFile: ExecFile = (file, args, options) =>
  new Promise((resolve, reject) => {
    nodeExecFile(file, args, options, (error, stdout) => {
      if (error) reject(error);
      else resolve({ stdout: String(stdout) });
    });
  });

const defaultExecShell: ExecShell = (command, options) =>
  new Promise((resolve, reject) => {
    nodeExec(command, options, (error, stdout) => {
      if (error) reject(Object.assign(error, { stdout: String(stdout) }));
      else resolve({ stdout: String(stdout) });
    });
  });

const SAFE_ORG = /^[A-Za-z0-9._@+-]+$/;

/** A real Salesforce session id looks like `00D...!...`. The CLI's redacted form does not. */
function isRealToken(value: unknown): value is string {
  return typeof value === "string" && /^00D\w+!\S+$/.test(value);
}

export function resolveConnection(options: ConnectionOptions = {}): Connection {
  const env = options.env ?? process.env;
  const exec = options.execFile ?? defaultExecFile;
  const envUrl = env.SF_INSTANCE_URL;
  const envToken = env.SF_ACCESS_TOKEN;

  if (envUrl && envToken) {
    const auth = { instanceUrl: trimUrl(envUrl), accessToken: envToken };
    return {
      getAuth: async () => auth,
      refresh: async () => {
        throw new ConnectionError(
          "Salesforce rejected the access token from SF_ACCESS_TOKEN (401). It has probably expired. Set a fresh token, or use --org to authenticate through the Salesforce CLI.",
        );
      },
    };
  }

  const org = options.org ?? env.SF_ORG;
  const isWindows = (options.platform ?? process.platform) === "win32";
  const execShell = options.execShell ?? defaultExecShell;
  let cached: Auth | undefined;
  let instanceUrl: string | undefined;

  async function runSf(args: string[]): Promise<Record<string, unknown>> {
    const full = [...args, "--json", ...(org ? ["--target-org", org] : [])];
    const limits = { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 };
    if (isWindows && org !== undefined && !SAFE_ORG.test(org)) {
      throw new ConnectionError(
        "The org alias or username may only contain letters, digits and . _ @ + - on Windows (A-Z, a-z, 0-9, ., _, @, +, -).",
      );
    }
    let stdout: string;
    try {
      // On Windows, sf.cmd needs a shell. The command is fixed literals plus the checked alias.
      ({ stdout } = isWindows
        ? await execShell(["sf.cmd", ...full].join(" "), limits)
        : await exec("sf", full, limits));
    } catch (error) {
      stdout = (error as { stdout?: string }).stdout ?? "";
      const message = cliMessage(stdout);
      if (message) throw new ConnectionError(`Salesforce CLI: ${message}`);
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EINVAL") {
        throw new ConnectionError(
          "The Salesforce CLI (sf) could not be started. Install it and make sure it is on PATH, or set SF_INSTANCE_URL and SF_ACCESS_TOKEN.",
        );
      }
      throw new ConnectionError(
        `The Salesforce CLI call failed${org ? ` for org "${org}"` : ""}. Run "sf org list" to check you are logged in.`,
      );
    }
    try {
      const parsed = JSON.parse(stdout) as { result?: Record<string, unknown> };
      return parsed.result ?? {};
    } catch {
      throw new ConnectionError("The Salesforce CLI returned output that is not JSON.");
    }
  }

  async function load(): Promise<Auth> {
    const display = await runSf(["org", "display"]);
    instanceUrl = typeof display.instanceUrl === "string" ? trimUrl(display.instanceUrl) : instanceUrl;
    let token = display.accessToken;
    if (!isRealToken(token)) {
      // Newer CLI versions redact the token in `org display`.
      const shown = await runSf(["org", "auth", "show-access-token"]);
      token = shown.accessToken;
    }
    if (!instanceUrl || !isRealToken(token)) {
      throw new ConnectionError(
        `Could not read an instance URL and access token from the Salesforce CLI${org ? ` for org "${org}"` : ""}.`,
      );
    }
    cached = { instanceUrl, accessToken: token };
    return cached;
  }

  async function reload(): Promise<Auth> {
    // `show-access-token` makes the CLI refresh an expired session.
    const shown = await runSf(["org", "auth", "show-access-token"]);
    if (!instanceUrl || !isRealToken(shown.accessToken)) return load();
    cached = { instanceUrl, accessToken: shown.accessToken };
    return cached;
  }

  return {
    getAuth: async () => cached ?? load(),
    refresh: reload,
  };
}

function trimUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function cliMessage(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as { message?: unknown };
    if (typeof parsed.message === "string") return parsed.message.split("\n")[0]?.trim();
  } catch {
    // not JSON
  }
  return undefined;
}
