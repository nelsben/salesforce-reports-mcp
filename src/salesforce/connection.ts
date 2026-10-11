import { execFile as nodeExecFile } from "node:child_process";

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

export interface ConnectionOptions {
  org?: string;
  env?: Record<string, string | undefined>;
  execFile?: ExecFile;
}

export class ConnectionError extends Error {}

const defaultExecFile: ExecFile = (file, args, options) =>
  new Promise((resolve, reject) => {
    nodeExecFile(file, args, options, (error, stdout) => {
      if (error) reject(error);
      else resolve({ stdout: String(stdout) });
    });
  });

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
  const sfBin = process.platform === "win32" ? "sf.cmd" : "sf";
  let cached: Auth | undefined;
  let instanceUrl: string | undefined;

  async function runSf(args: string[]): Promise<Record<string, unknown>> {
    const full = [...args, "--json", ...(org ? ["--target-org", org] : [])];
    let stdout: string;
    try {
      ({ stdout } = await exec(sfBin, full, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }));
    } catch (error) {
      stdout = (error as { stdout?: string }).stdout ?? "";
      const message = cliMessage(stdout);
      if (message) throw new ConnectionError(`Salesforce CLI: ${message}`);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ConnectionError(
          "Salesforce CLI (sf) not found on PATH. Install it, or set SF_INSTANCE_URL and SF_ACCESS_TOKEN.",
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
