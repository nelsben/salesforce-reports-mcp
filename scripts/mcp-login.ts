/**
 * Sign in to the hosted MCP door through the External Client App, once, and keep the refresh token.
 * Usage: npm run mcp-login -- --org <alias> [--auth <name>]
 *
 * Reads the app's consumer key and the instance URL from the org through the Salesforce CLI, opens the authorize
 * URL in the default browser (and prints it), listens on localhost:1717 for the callback, exchanges the code with
 * PKCE as a public client (no secret), and stores { instanceUrl, clientId, refreshToken } under
 * ~/.config/salesforce-reports-mcp/auth/<name>.json (folder 0700, file 0600). <name> defaults to the alias.
 * `npm run mcp-check -- --auth <name>` then exchanges the refresh token for an access token on each run.
 * To sign out, delete the file. It prints no token and nothing from any response.
 * The logic lives in scripts/mcp-auth-lib.ts.
 */
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import {
  PORT,
  authPath,
  authorizeUrl,
  exchangeCode,
  findConsumerKey,
  newState,
  nodeFileStore,
  openerCommand,
  parseCallback,
  pkcePair,
  readInstanceUrl,
  saveAuth,
  storedLine,
  type SfRunner,
} from "./mcp-auth-lib.js";

const TIMEOUT_MS = 4 * 60 * 1000;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const { values } = parseArgs({ options: { org: { type: "string" }, auth: { type: "string" } }, strict: true });
if (!values.org) {
  console.error("Pass --org <alias>. There is no default org.");
  process.exit(2);
}
const alias = values.org;
const name = values.auth ?? alias;

/** Runs `sf` through execFile, never a shell. Its output goes only to the caller. */
const runSf: SfRunner = (args) =>
  new Promise((resolve) => {
    execFile("sf", args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, stdout: String(stdout) });
    });
  });

try {
  const clientId = await findConsumerKey(runSf, alias);
  const instanceUrl = await readInstanceUrl(runSf, alias);
  const { verifier, challenge } = pkcePair();
  const state = newState();
  const url = authorizeUrl({ instanceUrl, clientId, challenge, state });

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const parsed = parseCallback(req.url ?? "/", state);
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      if (!parsed) {
        res.statusCode = 404;
        res.end("Not found.");
        return;
      }
      res.end(parsed.ok ? "Signed in. You can close this tab." : "Sign-in failed. See the terminal.");
      clearTimeout(timer);
      server.close();
      if (parsed.ok) resolve(parsed.code);
      else reject(new Error(parsed.message));
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("mcp-login: no sign-in within four minutes. Nothing was stored."));
    }, TIMEOUT_MS);
    server.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new Error(`mcp-login: cannot listen on localhost:${PORT} (${error.code ?? "error"}).`));
    });
    server.listen(PORT, "localhost", () => {
      console.log("Open this URL to sign in (it should open by itself):");
      console.log(url);
      const { file, args } = openerCommand(process.platform, url);
      execFile(file, args, () => undefined);
    });
  });

  const refreshToken = await exchangeCode({ instanceUrl, clientId, code, verifier, fetch });
  saveAuth(nodeFileStore(), homedir(), name, { instanceUrl, clientId, refreshToken });
  console.log(storedLine(name));
  process.exit(0);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
