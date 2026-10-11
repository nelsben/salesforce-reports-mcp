#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseArgs } from "node:util";
import { ReportsApi } from "./reports/api.js";
import { createClient, DEFAULT_API_VERSION } from "./salesforce/client.js";
import { resolveConnection } from "./salesforce/connection.js";
import { buildServer } from "./server.js";

const HELP = `salesforce-reports-mcp: an MCP server for Salesforce reports (stdio)

Usage: salesforce-reports-mcp [--org <alias>] [options]

  --org <alias>        Authenticate through the Salesforce CLI (env SF_ORG). Default: the sf default org.
                       Or set SF_INSTANCE_URL and SF_ACCESS_TOKEN to use a token you already hold.
  --api-version <v>    REST API version (env SF_API_VERSION). Default ${DEFAULT_API_VERSION}.
  --read-only          Register no write tools (env SF_REPORTS_READ_ONLY=1).
  --allow-delete       Register delete_report (env SF_REPORTS_ALLOW_DELETE=1).
  --max-rows <n>       Default cap on detail rows per result (env SF_REPORTS_MAX_ROWS). Default 200, ceiling 2000.
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

  const connection = resolveConnection({ org: values.org });
  const client = createClient(connection, { apiVersion: values["api-version"] ?? process.env.SF_API_VERSION });
  const server = buildServer(new ReportsApi(client), {
    readOnly: flag(values["read-only"], "SF_REPORTS_READ_ONLY"),
    allowDelete: flag(values["allow-delete"], "SF_REPORTS_ALLOW_DELETE"),
    maxRows,
  });
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  process.stderr.write(`salesforce-reports-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
