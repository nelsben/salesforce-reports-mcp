import { CombineError } from "./reports/combine.js";
import { ConnectionError } from "./salesforce/connection.js";
import { SalesforceError } from "./salesforce/client.js";

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export function ok(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

export function fail(error: unknown): ToolResult {
  const body = describeError(error);
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: body }) }] };
}

function describeError(error: unknown): { code: string; message: string; hint?: string } {
  if (error instanceof SalesforceError) {
    return { code: error.code, message: error.message, hint: hintFor(error) };
  }
  if (error instanceof ConnectionError) {
    return { code: "CONNECTION", message: error.message, hint: "Check the --org alias, or log in with `sf org login web`." };
  }
  if (error instanceof CombineError || error instanceof InputError) {
    return { code: "INVALID_INPUT", message: error.message };
  }
  return { code: "UNEXPECTED", message: error instanceof Error ? error.message : "Unexpected error." };
}



function hintFor(error: SalesforceError): string | undefined {
  const text = `${error.code} ${error.message}`;
  if (error.status === 401) return "Log in again with `sf org login web`, or pass a fresh token.";
  if (error.status === 404 || /NOT_FOUND|INVALID_ID/i.test(error.code)) {
    return "Check the id with search_reports (reports) or list_report_types (report types).";
  }
  if (/column|field|grouping|aggregate|filter|operator/i.test(text)) {
    return "Check column API names, filter operators and aggregates with describe_report_type, or the report's own columns with describe_report.";
  }
  if (/REQUEST_LIMIT_EXCEEDED|limit/i.test(text)) {
    return "Salesforce allows 500 synchronous report runs per org per hour. Wait, or reduce the number of runs.";
  }
  if (/INSUFFICIENT_ACCESS|FORBIDDEN|permission/i.test(text)) {
    return "The authenticated user lacks access. They need the Run Reports permission, and for saving, Create and Customize Reports.";
  }
  return undefined;
}

export class InputError extends Error {}
