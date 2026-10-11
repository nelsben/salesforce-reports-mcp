import type { Connection } from "./connection.js";

export const DEFAULT_API_VERSION = "62.0";

export class SalesforceError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface SalesforceApi {
  readonly apiVersion: string;
  /** Lightning base URL, for building links to reports. */
  instanceUrl(): Promise<string>;
  /** `path` starts after `/services/data/vXX.X`, for example `/analytics/reports`. */
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
}

export function createClient(
  connection: Connection,
  options: { apiVersion?: string; fetch?: typeof fetch } = {},
): SalesforceApi {
  const apiVersion = options.apiVersion ?? DEFAULT_API_VERSION;
  const doFetch = options.fetch ?? fetch;

  async function send(method: string, path: string, body: unknown, auth: { instanceUrl: string; accessToken: string }) {
    return doFetch(`${auth.instanceUrl}/services/data/v${apiVersion}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  return {
    apiVersion,
    async instanceUrl() {
      return (await connection.getAuth()).instanceUrl;
    },
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      let auth = await connection.getAuth();
      let response = await send(method, path, body, auth);
      if (response.status === 401) {
        auth = await connection.refresh();
        response = await send(method, path, body, auth);
        if (response.status === 401) {
          throw new SalesforceError(
            401,
            "INVALID_SESSION_ID",
            "Salesforce rejected the session twice (401). Log in again with `sf org login web`, or pass a fresh token.",
          );
        }
      }
      const text = await response.text();
      if (!response.ok) throw toError(response.status, text);
      if (!text) return undefined as T;
      return JSON.parse(text) as T;
    },
  };
}

function toError(status: number, text: string): SalesforceError {
  try {
    const parsed = JSON.parse(text) as unknown;
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    if (first && typeof first === "object") {
      const { errorCode, message, error, error_description } = first as Record<string, unknown>;
      const code = String(errorCode ?? error ?? `HTTP_${status}`);
      const msg = String(message ?? error_description ?? `HTTP ${status}`);
      return new SalesforceError(status, code, msg);
    }
  } catch {
    // fall through
  }
  return new SalesforceError(status, `HTTP_${status}`, `Salesforce returned HTTP ${status}.`);
}
