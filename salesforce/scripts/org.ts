/**
 * The org side of the MCP setup and teardown scripts: the alias guard and Tooling API calls on the
 * Salesforce CLI's own session. No token is printed or written anywhere.
 */
import { parseArgs } from "node:util";
import { resolveConnection, type Auth } from "../../src/salesforce/connection.js";

export const API_VERSION = "68.0";

export const SERVER = "SalesforceReports";
export const REGISTRATION = "ReportsApi";
export const API_SOURCE = "API_CATALOG";
export const API_IDENTIFIER = `ar:${REGISTRATION}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

/**
 * Decides whether these scripts may change an org. When SF_REPORTS_SETUP_ORGS is set (comma-separated,
 * spaces trimmed, empty entries ignored) the alias must be on it, even with --yes. When it is unset or
 * empty, the alias is refused unless --yes is given.
 */
export function checkOrg(alias: string, opts: { env: Record<string, string | undefined>; yes: boolean }): { ok: true } | { ok: false; message: string } {
  const list = (opts.env.SF_REPORTS_SETUP_ORGS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (list.length) {
    if (list.includes(alias)) return { ok: true };
    return { ok: false, message: `Refusing org "${alias}". It is not on SF_REPORTS_SETUP_ORGS (${list.join(", ")}). Add it there to allow it.` };
  }
  if (opts.yes) return { ok: true };
  return {
    ok: false,
    message: `Refusing org "${alias}". Pass --yes to confirm this org may be changed, or set SF_REPORTS_SETUP_ORGS to the aliases these scripts may change.`,
  };
}

/** The alias from `<alias>` or `--org <alias>`, plus `--yes`. Exits 2 on a missing alias or a refused one, before any CLI call. */
export function orgFromArgs(usage: string): string {
  const { values, positionals } = parseArgs({
    options: { org: { type: "string" }, yes: { type: "boolean", default: false } },
    allowPositionals: true,
    strict: true,
  });
  const org = values.org ?? positionals[0];
  if (!org) {
    console.error(`Usage: ${usage}`);
    process.exit(2);
  }
  const verdict = checkOrg(org, { env: process.env, yes: values.yes ?? false });
  if (!verdict.ok) {
    console.error(verdict.message);
    process.exit(2);
  }
  return org;
}

/** Prints the alias and instance URL about to be changed. Never the token. */
export async function announce(org: Org): Promise<void> {
  const auth = await org.connection.getAuth();
  console.log(`About to change org ${org.alias} (${auth.instanceUrl})\n`);
}

export class Org {
  private auth?: Auth;
  readonly connection;

  constructor(readonly alias: string) {
    // env: {} so SF_ACCESS_TOKEN in the shell can never point the script at another org.
    this.connection = resolveConnection({ org: alias, env: {} });
  }

  async request(method: string, path: string, body?: unknown): Promise<Json> {
    const send = (auth: Auth) =>
      fetch(`${auth.instanceUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${auth.accessToken}`, Accept: "application/json", "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    this.auth ??= await this.connection.getAuth();
    let response = await send(this.auth);
    if (response.status === 401) response = await send((this.auth = await this.connection.refresh()));
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : undefined;
    if (!response.ok) {
      const message = Array.isArray(parsed) ? parsed.map((e: Json) => `${e.errorCode}: ${e.message}`).join("; ") : text;
      throw new Error(`${method} ${path.split("?")[0]} answered ${response.status}: ${message}`);
    }
    return parsed;
  }

  tooling(soql: string): Promise<Json[]> {
    return this.request("GET", `/services/data/v${API_VERSION}/tooling/query?q=${encodeURIComponent(soql)}`).then((r) => r.records);
  }

  create(type: string, fields: Record<string, unknown>): Promise<string> {
    return this.request("POST", `/services/data/v${API_VERSION}/tooling/sobjects/${type}`, fields).then((r) => r.id);
  }

  update(type: string, id: string, fields: Record<string, unknown>): Promise<void> {
    return this.request("PATCH", `/services/data/v${API_VERSION}/tooling/sobjects/${type}/${id}`, fields);
  }

  remove(type: string, id: string): Promise<void> {
    return this.request("DELETE", `/services/data/v${API_VERSION}/tooling/sobjects/${type}/${id}`);
  }

  async server(): Promise<{ Id: string; DeveloperName: string } | undefined> {
    return (await this.tooling(`SELECT Id, DeveloperName FROM McpServerDefinition WHERE DeveloperName = '${SERVER}'`))[0];
  }

  /** The server's API Catalog entry: its hosted endpoint and whether it is active. */
  async catalogServer(serverId: string): Promise<{ serverUrl?: string; isActive?: boolean } | undefined> {
    const { apis } = await this.request("GET", `/services/data/v${API_VERSION}/api-catalog/apis`);
    const entry = (apis as Json[]).find((a) => a.providerType === "PLATFORM_CUSTOM_MCP_SERVER" && String(a.id).slice(0, 15) === serverId.slice(0, 15));
    return entry?.properties;
  }

  /** The API Catalog entry for the registration, with each operation's active flag. */
  async catalogOperations(): Promise<{ id: string; name: string; isActive: boolean }[]> {
    const base = `/services/data/v${API_VERSION}/api-catalog/sources/APEX_REST/apis`;
    const registration = (await this.tooling(`SELECT Id FROM ExternalServiceRegistration WHERE DeveloperName = '${REGISTRATION}'`))[0];
    if (!registration) return [];
    const apiId = String(registration.Id).slice(0, 15);
    const versions = await this.request("GET", `${base}/${apiId}/versions`);
    const version = versions.apiVersions?.[0]?.id ?? apiId;
    const ops = await this.request("GET", `${base}/${apiId}/versions/${version}/operations`);
    return ops.apiVersionOperations ?? [];
  }
}
