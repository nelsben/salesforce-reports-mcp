import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fail, InputError, ok, type ToolResult } from "./format.js";
import { ReportsApi, soqlLike, soqlString } from "./reports/api.js";
import { combineResults, type CombineInput } from "./reports/combine.js";
import { aggregateColumns, definitionShape, ReportDefinitionSchema, toReportMetadata, type ReportDefinition } from "./reports/definition.js";
import { HARD_ROW_CEILING, shapeResult, type ReportResult } from "./reports/shape.js";
import { reportUrl, summarizeReport, summarizeReportType, summarizeReportTypes } from "./reports/summarize.js";

export interface ServerOptions {
  readOnly: boolean;
  allowDelete: boolean;
  /** Default cap on detail rows per result. */
  maxRows: number;
  version?: string;
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };

const reportId = z.string().regex(/^00O[A-Za-z0-9]{12,15}$/, "A report id starts with 00O.").describe("Report id, 15 or 18 characters starting with 00O. Find one with search_reports.");

const resultControls = {
  detail: z
    .boolean()
    .optional()
    .describe("Return the detail rows. Default: yes for a tabular report, no for summary and matrix (the group table is usually what you want)."),
  maxRows: z
    .number()
    .int()
    .min(1)
    .max(HARD_ROW_CEILING)
    .optional()
    .describe(`Cap on detail rows returned. Default is the server's setting (200); Salesforce itself never returns more than ${HARD_ROW_CEILING}.`),
};

export function buildServer(reports: ReportsApi, options: ServerOptions): McpServer {
  const server = new McpServer(
    { name: "salesforce-reports", version: options.version ?? "0.1.0" },
    {
      instructions:
        "Find, define, run, save and combine Salesforce reports. To answer a data question without saving anything, use query_report. To re-run an existing report, use search_reports then run_report. Save a report (create_report) only when the user asks for one.",
    },
  );

  async function baseUrl(): Promise<string | undefined> {
    try {
      return await reports.instanceUrl();
    } catch {
      return undefined;
    }
  }

  function limitFor(requested: number | undefined): number {
    return Math.min(requested ?? options.maxRows, HARD_ROW_CEILING);
  }

  /**
   * Salesforce rejects a grouped report with no detail column, and reads an empty list as "all columns"
   * (which then trips the 100-column limit). Give such a report one ungrouped column from the type's defaults.
   */
  async function ensureDetailColumn(mapped: { metadata: Record<string, any>; notes: string[] }): Promise<void> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const meta = mapped.metadata;
    const grouped = [...(meta.groupingsDown ?? []), ...(meta.groupingsAcross ?? [])].map((g: { name: string }) => g.name);
    if (!grouped.length || (meta.detailColumns && meta.detailColumns.length)) return;
    const type = meta.reportType?.type;
    if (!type) return;
    const describe = await reports.describeReportType(type);
    const defaults: string[] = describe.reportMetadata?.detailColumns ?? [];
    const column = defaults.find((c) => !grouped.includes(c));
    if (!column) throw new InputError("Give at least one detail column that is not a grouping.");
    meta.detailColumns = [column];
    mapped.notes.push(`No detail column was given, so ${column} was added; Salesforce needs one on a grouped report.`);
  }

  async function runToResult(
    input: { reportId?: string; overrides?: ReportDefinition; definition?: ReportDefinition; detail?: boolean; maxRows?: number },
  ): Promise<ReportResult> {
    const notes: string[] = [];
    let raw: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const wantsDetail = input.detail !== false;
    if (input.reportId) {
      let overrides: Record<string, unknown> | undefined;
      if (input.overrides) {
        const mapped = toReportMetadata(input.overrides, { partial: true });
        overrides = mapped.metadata;
        notes.push(...mapped.notes);
      }
      const out = await reports.run(input.reportId, { overrides, includeDetails: wantsDetail });
      raw = out.raw;
      if (out.async) notes.push("The synchronous run timed out, so it ran as an async instance. It may be slow; narrow the filters if you can.");
    } else if (input.definition) {
      if (!input.definition.reportType) throw new InputError("A report defined in the call needs reportType. Find one with list_report_types.");
      const mapped = toReportMetadata(input.definition);
      await ensureDetailColumn(mapped);
      notes.push(...mapped.notes);
      raw = await reports.query(mapped.metadata, wantsDetail);
    } else {
      throw new InputError("Give a reportId or a definition.");
    }
    const format = raw.reportMetadata?.reportFormat;
    return shapeResult(raw, {
      maxRows: limitFor(input.maxRows),
      includeDetail: input.detail ?? format === "TABULAR",
      baseUrl: await baseUrl(),
      notes,
    });
  }

  // ---- read tools ----

  server.registerTool(
    "search_reports",
    {
      title: "Search reports",
      description:
        "Find saved Salesforce reports by name or developer name, optionally within a folder or of one format. Returns up to `limit` matches (default 25), most recently modified first, each with its id, folder, format, last run date and a Lightning URL. Use this first when the user mentions a report by name. To see reports they could be saved to, use list_report_folders. To learn what a report contains, follow with describe_report; to get its numbers, run_report.",
      inputSchema: {
        query: z.string().optional().describe("Text to find in the report name or developer name. Omit to list the most recently modified reports."),
        folder: z.string().optional().describe('Part of a folder name, for example "Sales" or "Private Reports".'),
        format: z.enum(["TABULAR", "SUMMARY", "MATRIX", "JOINED"]).optional().describe("Only reports of this format."),
        limit: z.number().int().min(1).max(200).optional().describe("Maximum matches. Default 25."),
      },
      annotations: READ,
    },
    async ({ query, folder, format, limit }) => {
      try {
        const where: string[] = [];
        if (query) where.push(`(Name LIKE '%${soqlLike(query)}%' OR DeveloperName LIKE '%${soqlLike(query)}%')`);
        if (folder) where.push(`FolderName LIKE '%${soqlLike(folder)}%'`);
        if (format) where.push(`Format = '${{ TABULAR: "Tabular", SUMMARY: "Summary", MATRIX: "Matrix", JOINED: "MultiBlock" }[format]}'`);
        const soql = `SELECT Id, Name, DeveloperName, FolderName, Format, Description, LastRunDate, LastModifiedDate FROM Report${
          where.length ? ` WHERE ${where.join(" AND ")}` : ""
        } ORDER BY LastModifiedDate DESC LIMIT ${limit ?? 25}`;
        const rows = await reports.soql(soql);
        const base = await baseUrl();
        return ok({
          count: rows.length,
          reports: rows.map((r) => ({
            id: r.Id,
            name: r.Name,
            developerName: r.DeveloperName,
            folder: r.FolderName,
            format: r.Format,
            description: r.Description,
            lastRunDate: r.LastRunDate,
            lastModifiedDate: r.LastModifiedDate,
            url: reportUrl(base, r.Id),
          })),
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "list_report_folders",
    {
      title: "List report folders",
      description:
        "List the report folders the user can see, with id, name and access type. Use it to choose a `folderId` for create_report, update_report or clone_report. A report saved with no folder goes to the user's Private Reports folder, which is not listed here.",
      inputSchema: {
        search: z.string().optional().describe("Part of a folder name."),
        limit: z.number().int().min(1).max(200).optional().describe("Maximum folders. Default 100."),
      },
      annotations: READ,
    },
    async ({ search, limit }) => {
      try {
        const where = ["Type = 'Report'", "AccessType != 'Hidden'", ...(search ? [`Name LIKE '%${soqlLike(search)}%'`] : [])];
        const rows = await reports.soql(
          `SELECT Id, Name, DeveloperName, AccessType FROM Folder WHERE ${where.join(" AND ")} ORDER BY Name LIMIT ${limit ?? 100}`,
        );
        return ok({
          count: rows.length,
          folders: rows.map((f) => ({ id: f.Id, name: f.Name, developerName: f.DeveloperName, accessType: f.AccessType })),
          note: "A report saved with no folderId goes to the user's Private Reports folder.",
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "list_report_types",
    {
      title: "List report types",
      description:
        "List the report types this org offers (what a report is built on, such as Opportunity, Accounts, or a custom type), as {type, label, category, description}. Use it before query_report or create_report to find the `reportType` value. Next step: describe_report_type to see its columns.",
      inputSchema: {
        search: z.string().optional().describe('Text to find in the type name, label or category, for example "opportunit" or "case".'),
        limit: z.number().int().min(1).max(500).optional().describe("Maximum types. Default 50."),
      },
      annotations: READ,
    },
    async ({ search, limit }) => {
      try {
        return ok(summarizeReportTypes(await reports.reportTypes(), { search, limit }));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "describe_report_type",
    {
      title: "Describe a report type",
      description:
        "Show what can go in a report of one type: the available fields by section as {name, label, dataType} (the names are the API names to use in columns, groupings, aggregates and filters), the date-filter columns and durations, the date-grouping granularities, the scopes, and the filter operators valid for each data type. Use it before query_report or create_report so column names are right. Different from describe_report, which describes one saved report.",
      inputSchema: {
        type: z.string().describe("Report type API name from list_report_types, for example Opportunity."),
        search: z.string().optional().describe('Only fields whose name, label or section contains this text, for example "amount" or "owner".'),
        limit: z.number().int().min(1).max(1000).optional().describe("Maximum fields to return. Default 150."),
      },
      annotations: READ,
    },
    async ({ type, search, limit }) => {
      try {
        return ok(summarizeReportType(await reports.describeReportType(type), type, { search, limit }));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "describe_report",
    {
      title: "Describe a saved report",
      description:
        "Summarize one saved report without running it: name, folder, format, report type, columns with labels, groupings, aggregates, filters in words, date filter and URL. Use it to understand a report before running or changing it. Set includeMetadata to also get the raw reportMetadata. Different from describe_report_type, which lists what is available to build with.",
      inputSchema: {
        reportId,
        includeMetadata: z.boolean().optional().describe("Also return the raw reportMetadata. Default false."),
      },
      annotations: READ,
    },
    async ({ reportId: id, includeMetadata }) => {
      try {
        const describe = await reports.describeReport(id);
        return ok(summarizeReport(describe, { baseUrl: await baseUrl(), includeMetadata }));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "run_report",
    {
      title: "Run a saved report",
      description:
        "Run a saved report and return its numbers as one tidy result: filters in words, a group table (one row per group, grouping labels then measures), grand totals, and detail rows when asked. Use it for a report that already exists. `overrides` change this run only and are never saved (for example a different date range or extra filter), which makes it the way to compare periods. Different from query_report, which runs a report you define in the call without saving anything. Notes in the result say when rows were cut.",
      inputSchema: {
        reportId,
        overrides: ReportDefinitionSchema.optional().describe(
          "Optional changes for this run only: any of the report definition fields (filters, dateFilter, groupings, columns, aggregates ...). Sent filters replace the saved ones.",
        ),
        ...resultControls,
      },
      annotations: READ,
    },
    async (args) => {
      try {
        return ok(await runToResult(args));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "query_report",
    {
      title: "Run an ad hoc report",
      description:
        "Define a report in the call and run it at once. Nothing is saved. Use it to answer a data question: pick a report type (list_report_types), check column names (describe_report_type), then give columns, groupings, aggregates and filters. Returns the same tidy result as run_report. Different from run_report, which runs a saved report by id. If the user likes the result, offer create_report with the same definition.",
      inputSchema: { ...definitionShape, ...resultControls },
      annotations: READ,
    },
    async ({ detail, maxRows, ...definition }) => {
      try {
        return ok(await runToResult({ definition, detail, maxRows }));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "combine_reports",
    {
      title: "Combine reports",
      description:
        "Run 2 to 5 reports one after another and merge them into one table. Each input is a saved report (reportId, optionally with overrides) or a definition. mode `stack` puts rows one under another with a leading `source` column holding the alias: use it to compare periods (the same report run twice with different date filters), or to append similar reports. mode `join` lines up grouped results side by side on a shared grouping such as owner or account, as a full outer join: use it for questions like pipeline by owner next to closed-won by owner. Nothing is saved.",
      inputSchema: {
        mode: z.enum(["stack", "join"]).describe("stack: rows under each other with a `source` column. join: grouped results side by side on matching groupings."),
        inputs: z
          .array(
            z.object({
              alias: z.string().min(1).describe('Short name for this input, for example "this_quarter". Shown in the source column and in measure labels.'),
              reportId: reportId.optional().describe("A saved report to run. Give this or `definition`, not both."),
              overrides: ReportDefinitionSchema.optional().describe("With reportId: changes for this run only."),
              definition: ReportDefinitionSchema.optional().describe("An ad hoc report definition (needs reportType). Give this or `reportId`."),
            }),
          )
          .min(2)
          .max(5)
          .describe("The reports to combine, 2 to 5."),
        joinOn: z
          .array(z.string())
          .optional()
          .describe("join only: the grouping column API names to match on. Default: each input's first down grouping. Every input must be grouped by exactly these."),
        ...resultControls,
      },
      annotations: READ,
    },
    async ({ mode, inputs, joinOn, detail, maxRows }) => {
      try {
        const prepared: CombineInput[] = [];
        for (const input of inputs) {
          if (Boolean(input.reportId) === Boolean(input.definition)) {
            throw new InputError(`Input "${input.alias}" needs exactly one of reportId and definition.`);
          }
          const result = await runToResult({
            reportId: input.reportId,
            overrides: input.overrides,
            definition: input.definition,
            detail: detail ?? undefined,
            maxRows,
          });
          prepared.push({ alias: input.alias, result });
        }
        return ok(combineResults(mode, prepared, { joinOn }));
      } catch (error) {
        return fail(error);
      }
    },
  );

  if (options.readOnly) return server;

  // ---- write tools ----

  server.registerTool(
    "create_report",
    {
      title: "Create a report",
      description:
        "Save a new report in Salesforce from a definition. With no folderId it lands in the user's Private Reports folder, visible only to them; the user can move or share it in Salesforce. Use it only when the user asks to save or create a report. Try the definition first with query_report. Returns the new report's id, name, folder, URL and summary.",
      inputSchema: {
        name: z.string().min(1).max(40).describe("Report name shown in Salesforce."),
        description: z.string().optional().describe("Optional description."),
        folderId: z.string().optional().describe("Folder id from list_report_folders. Omit to save to Private Reports."),
        ...definitionShape,
      },
      annotations: WRITE,
    },
    async ({ name, description, folderId, ...definition }) => {
      try {
        if (!definition.reportType) throw new InputError("create_report needs reportType. Find one with list_report_types.");
        const mapped = toReportMetadata(definition);
        await ensureDetailColumn(mapped);
        const created = await reports.create({
          ...mapped.metadata,
          name,
          ...(description ? { description } : {}),
          ...(folderId ? { folderId } : {}),
        });
        const summary = summarizeReport(created, { baseUrl: await baseUrl() });
        return ok({
          id: summary.id,
          name: summary.name,
          folder: await folderName(summary.id),
          folderId: summary.folderId,
          url: summary.url,
          summary,
          notes: mapped.notes,
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "update_report",
    {
      title: "Update a report",
      description:
        "Change a saved report. Send only the fields to change; the rest stay as saved. A list you send (filters, columns, groupings, aggregates) replaces the saved list in full, so include the entries you want to keep. Use it only when the user asks to change the report itself. To try a change without saving it, use run_report with overrides. Returns the saved summary and one line per field that changed.",
      inputSchema: {
        reportId,
        name: z.string().min(1).max(40).optional().describe("New report name."),
        description: z.string().optional().describe("New description."),
        folderId: z.string().optional().describe("Move the report to this folder (id from list_report_folders)."),
        ...definitionShape,
      },
      annotations: WRITE,
    },
    async ({ reportId: id, name, description, folderId, ...definition }) => {
      try {
        const mapped = toReportMetadata(definition, { partial: true });
        const patch: Record<string, unknown> = {
          ...mapped.metadata,
          ...(name ? { name } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(folderId ? { folderId } : {}),
        };
        if (!Object.keys(patch).length) throw new InputError("Nothing to update. Give at least one field to change.");
        const before = (await reports.describeReport(id)).reportMetadata ?? {};
        if (definition.aggregates && !definition.columns) {
          // A new aggregate needs its column among the detail columns; keep the saved ones.
          const needed = aggregateColumns(definition.aggregates).filter((c) => !(before.detailColumns ?? []).includes(c));
          if (needed.length) patch.detailColumns = [...(before.detailColumns ?? []), ...needed];
        }
        const after = await reports.patch(id, patch);
        const changes = Object.keys(patch).map((key) => {
          const was = JSON.stringify(before[key]);
          const now = JSON.stringify(after.reportMetadata?.[key]);
          return was === now ? `${key}: unchanged` : `${key}: ${clip(was)} -> ${clip(now)}`;
        });
        return ok({ summary: summarizeReport(after, { baseUrl: await baseUrl() }), changes, notes: mapped.notes });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "clone_report",
    {
      title: "Clone a report",
      description:
        "Copy a saved report to a new report. The clone lands in the user's Private Reports folder unless folderId is given. Use it when the user wants a variant to edit without touching the original, then change the copy with update_report. Returns the clone's id, name, folder and URL.",
      inputSchema: {
        reportId,
        name: z.string().min(1).max(40).optional().describe("Name for the copy. Default: Salesforce's own."),
        folderId: z.string().optional().describe("Folder id for the copy. Omit for Private Reports."),
      },
      annotations: WRITE,
    },
    async ({ reportId: id, name, folderId }) => {
      try {
        const cloned = await reports.clone(id, { ...(name ? { name } : {}), ...(folderId ? { folderId } : {}) });
        const summary = summarizeReport(cloned, { baseUrl: await baseUrl() });
        return ok({ id: summary.id, name: summary.name, folder: await folderName(summary.id), folderId: summary.folderId, url: summary.url });
      } catch (error) {
        return fail(error);
      }
    },
  );

  if (options.allowDelete) {
    server.registerTool(
      "delete_report",
      {
        title: "Delete a report",
        description:
          "Delete a saved report. It goes to the Recycle Bin, where an admin can restore it. Use it only when the user explicitly asks to delete that report. Returns a confirmation.",
        inputSchema: { reportId },
        annotations: DESTRUCTIVE,
      },
      async ({ reportId: id }) => {
        try {
          await reports.remove(id);
          return ok({ deleted: true, id, note: "The report is in the Recycle Bin." });
        } catch (error) {
          return fail(error);
        }
      },
    );
  }

  async function folderName(id: string | null): Promise<string | undefined> {
    if (!id) return undefined;
    try {
      const rows = await reports.soql(`SELECT FolderName FROM Report WHERE Id = '${soqlString(id)}'`);
      return rows[0]?.FolderName;
    } catch {
      return undefined;
    }
  }

  return server;
}

function clip(text: string | undefined): string {
  if (text === undefined) return "(none)";
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

export type { ToolResult };
