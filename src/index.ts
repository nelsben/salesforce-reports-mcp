#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseArgs } from "node:util";
import { ReportsApi } from "./reports/api.js";
import { createClient, DEFAULT_API_VERSION } from "./salesforce/client.js";
import { resolveConnection } from "./salesforce/connection.js";
import { checkOAuthOptions, PASSCODE_ENV, type OAuthOptions } from "./http-auth.js";
import { assertLoopbackHost, startHttpServer } from "./http.js";
import { buildServer } from "./server.js";

const HELP = `salesforce-reports-mcp: an MCP server for Salesforce reports (stdio, or Streamable HTTP with --http)

Usage: salesforce-reports-mcp [--org <alias>] [options]

  --org <alias>        Authenticate through the Salesforce CLI (env SF_ORG). Default: the sf default org.
                       Or set SF_INSTANCE_URL and SF_ACCESS_TOKEN to use a token you already hold.
  --api-version <v>    REST API version (env SF_API_VERSION). Default ${DEFAULT_API_VERSION}.
  --read-only          Register no write tools (env SF_REPORTS_READ_ONLY=1).
  --allow-delete       Register delete_report (env SF_REPORTS_ALLOW_DELETE=1).
  --max-rows <n>       Default cap on detail rows per result (env SF_REPORTS_MAX_ROWS). Default 200, ceiling 2000.
  --http <port>        Serve Streamable HTTP at /mcp instead of stdio (env SF_REPORTS_HTTP_PORT). Port 0 picks a free port.
  --host <host>        Host for --http (env SF_REPORTS_HTTP_HOST). Default 127.0.0.1. Loopback only, unless --public-url is set.
  --public-url <url>   Turn on the OAuth layer for --http (env SF_REPORTS_PUBLIC_URL), for use behind a tunnel.
                       The URL clients reach this server at, https unless its host is loopback; /mcp then needs
                       a token this server issued. Needs ${PASSCODE_ENV} (env only, at least 16 characters):
                       the owner types it on the sign-in page to approve a client.
  -h, --help           Show this help.
`;

function flag(value: boolean | undefined, envName: string): boolean {
  return value ?? ["1", "true"].includes((process.env[envName] ?? "").toLowerCase());
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      org: { type: "string" },
      "api-version": { type: "string" },
      "read-only": { type: "boolean" },
      "allow-delete": { type: "boolean" },
      "max-rows": { type: "string" },
      http: { type: "string" },
      host: { type: "string" },
      "public-url": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) {
    process.stderr.write(HELP);
    return;
  }

  const maxRowsRaw = values["max-rows"] ?? process.env.SF_REPORTS_MAX_ROWS;
  const maxRows = maxRowsRaw ? Number.parseInt(maxRowsRaw, 10) : 200;
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 2000) {
    throw new Error("--max-rows must be a whole number from 1 to 2000.");
  }

  const httpRaw = values.http ?? process.env.SF_REPORTS_HTTP_PORT;
  const host = values.host ?? process.env.SF_REPORTS_HTTP_HOST ?? "127.0.0.1";
  const publicUrl = values["public-url"] ?? process.env.SF_REPORTS_PUBLIC_URL;
  let port: number | undefined;
  let oauth: OAuthOptions | undefined;
  if (httpRaw !== undefined && httpRaw !== "") {
    port = Number(httpRaw);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--http must be a port from 0 to 65535.");
    if (publicUrl) {
      // The passcode comes from the environment only, never a flag.
      oauth = { publicUrl, passcode: process.env[PASSCODE_ENV] ?? "" };
      checkOAuthOptions(oauth);
    } else {
      assertLoopbackHost(host);
    }
  } else if (values["public-url"] !== undefined) {
    throw new Error("--public-url needs --http.");
  }

  const connection = resolveConnection({ org: values.org });
  const client = createClient(connection, { apiVersion: values["api-version"] ?? process.env.SF_API_VERSION });
  const reports = new ReportsApi(client);
  const make = () =>
    buildServer(reports, {
      readOnly: flag(values["read-only"], "SF_REPORTS_READ_ONLY"),
      allowDelete: flag(values["allow-delete"], "SF_REPORTS_ALLOW_DELETE"),
      maxRows,
    });

  if (port === undefined) {
    await make().connect(new StdioServerTransport());
    return;
  }
  const handle = await startHttpServer({ port, host, createServer: make, oauth });
  const shutdown = () => {
    void handle.close().then(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  const local = `http://${host.includes(":") ? `[${host}]` : host}:${handle.port}/mcp`;
  const signIn = handle.oauth ? ` (public at ${handle.oauth.resource.href}, OAuth sign-in on)` : "";
  process.stderr.write(`salesforce-reports-mcp: listening on ${local}${signIn}\n`);
}

main().catch((error) => {
  process.stderr.write(`salesforce-reports-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
