import { SalesforceError, type SalesforceApi } from "../salesforce/client.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface RunOutput {
  raw: Json;
  /** True when the synchronous call timed out and the run went through the async instances API. */
  async: boolean;
}

const enc = encodeURIComponent;

export function soqlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/** For a `LIKE` clause: escape the quote and backslash, and the two wildcards. */
export function soqlLike(value: string): string {
  return soqlString(value).replace(/([%_])/g, "\\$1");
}

export class ReportsApi {
  constructor(
    private readonly api: SalesforceApi,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  instanceUrl(): Promise<string> {
    return this.api.instanceUrl();
  }

  reportTypes(): Promise<Json[]> {
    return this.api.request("GET", "/analytics/reportTypes");
  }

  describeReportType(type: string): Promise<Json> {
    return this.api.request("GET", `/analytics/reportTypes/${enc(type)}`);
  }

  describeReport(id: string): Promise<Json> {
    return this.api.request("GET", `/analytics/reports/${enc(id)}/describe`);
  }

  async run(id: string, options: { overrides?: Json; includeDetails: boolean }): Promise<RunOutput> {
    const path = `/analytics/reports/${enc(id)}?includeDetails=${options.includeDetails}`;
    try {
      const raw = options.overrides
        ? await this.api.request<Json>("POST", path, { reportMetadata: options.overrides })
        : await this.api.request<Json>("GET", path);
      return { raw, async: false };
    } catch (error) {
      if (!isTimeout(error)) throw error;
      return { raw: await this.runAsync(id, options.overrides), async: true };
    }
  }

  query(metadata: Json, includeDetails: boolean): Promise<Json> {
    return this.api.request("POST", `/analytics/reports/query?includeDetails=${includeDetails}`, { reportMetadata: metadata });
  }

  create(metadata: Json): Promise<Json> {
    return this.api.request("POST", "/analytics/reports", { reportMetadata: metadata });
  }

  patch(id: string, metadata: Json): Promise<Json> {
    return this.api.request("PATCH", `/analytics/reports/${enc(id)}`, { reportMetadata: metadata });
  }

  clone(id: string, metadata: Json): Promise<Json> {
    return this.api.request("POST", `/analytics/reports?cloneId=${enc(id)}`, { reportMetadata: metadata });
  }

  async remove(id: string): Promise<void> {
    await this.api.request("DELETE", `/analytics/reports/${enc(id)}`);
  }

  async soql(query: string): Promise<Json[]> {
    const out = await this.api.request<{ records: Json[] }>("GET", `/query?q=${enc(query)}`);
    return out.records;
  }

  // ---- dashboards. `filters` is a query string from resolveFilters, such as "?filter1=0IC…", or "". ----

  describeDashboard(id: string): Promise<Json> {
    return this.api.request("GET", `/analytics/dashboards/${enc(id)}/describe`);
  }

  /** The cached results. Never refreshes. */
  dashboardResults(id: string, filters = ""): Promise<Json> {
    return this.api.request("GET", `/analytics/dashboards/${enc(id)}${filters}`);
  }

  dashboardStatus(id: string, filters = ""): Promise<Json> {
    return this.api.request("GET", `/analytics/dashboards/${enc(id)}/status${filters}`);
  }

  /** Starts a refresh. The filter goes on the query string: a body is accepted and ignored. */
  async refreshDashboard(id: string, filters = ""): Promise<void> {
    await this.api.request("PUT", `/analytics/dashboards/${enc(id)}${filters}`);
  }

  /** Waits between polls. Tests pass a sleep that returns at once. */
  pause(ms: number): Promise<void> {
    return this.sleep(ms);
  }

  private async runAsync(id: string, overrides?: Json): Promise<Json> {
    const started = await this.api.request<Json>(
      "POST",
      `/analytics/reports/${enc(id)}/instances?includeDetails=true`,
      overrides ? { reportMetadata: overrides } : undefined,
    );
    const instanceId: string = started.id ?? started.attributes?.id;
    if (!instanceId) throw new SalesforceError(500, "NO_INSTANCE", "Salesforce did not return an async report instance.");
    for (let attempt = 0; attempt < 30; attempt++) {
      await this.sleep(Math.min(1000 + attempt * 500, 4000));
      const instance = await this.api.request<Json>("GET", `/analytics/reports/${enc(id)}/instances/${enc(instanceId)}`);
      const status = instance.attributes?.status ?? instance.status;
      if (status === "Success") return instance;
      if (status === "Error") throw new SalesforceError(500, "REPORT_RUN_FAILED", "The async report run failed in Salesforce.");
    }
    throw new SalesforceError(504, "REPORT_RUN_PENDING", `The async report run (${instanceId}) did not finish in time. Try again, or narrow the filters.`);
  }
}

function isTimeout(error: unknown): boolean {
  if (!(error instanceof SalesforceError)) return false;
  return (
    error.status === 408 ||
    error.status === 504 ||
    /TIMEOUT|TOO_LONG|ASYNC/i.test(error.code) ||
    /timed out|time out|asynchronous/i.test(error.message)
  );
}
