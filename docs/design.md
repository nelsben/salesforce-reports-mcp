# Design: salesforce-reports-mcp v0.1

An MCP server that lets Claude find, define, run, save and combine Salesforce reports, and hands the results back in a shape Claude can analyse. This document is the build contract for v0.1.

## Facts this design rests on

Checked on 2026-10-11 against a Developer Edition scratch org, API v66.0.

| Fact | Consequence |
| --- | --- |
| Apex `Reports.ReportManager` can describe a report and run it, including with changed filters, groupings and columns. It cannot save a report. | Create, update, clone and delete go through the Reports and Dashboards REST API. v0.1 uses that API for everything. |
| `POST /analytics/reports/query` runs a report defined in the request body, with no saved report behind it. | Claude can define and preview a report before anyone saves it. |
| `POST /analytics/reports` with no `folderId` saves the report to the running user's **Private Reports** folder. | A report Claude creates stays private until someone moves it. |
| `PATCH /analytics/reports/{id}` with only `{"reportMetadata":{"name":…}}` changes the name and keeps every other field. | Updates can be partial. A list field that is sent, such as filters, replaces the saved list. |
| `POST /analytics/reports?cloneId={id}` clones. `DELETE /analytics/reports/{id}` returns 204 and sends the report to the Recycle Bin. | |
| Newer `sf` CLI versions redact `accessToken` in `sf org display --json`. `sf org auth show-access-token --json --target-org <alias>` returns the real token. | The `sf` auth path reads the instance URL from `org display` and the token from `show-access-token`. |
| The API returns at most 2,000 detail rows (`allData: false` past that), takes at most 100 columns, and allows 500 synchronous runs per org per hour. | Every result says when it was cut, and why. |
| Salesforce hosted MCP can expose an Apex `@RestResource` class as MCP tools through `McpServerDefinition` metadata and an API Catalog entry. | This is the v0.2 "in-org door" (below). It is out of scope for v0.1. |

## Shape

```
src/
  index.ts              CLI entry: read flags and env, build the connection, start the stdio server
  server.ts             buildServer(api, options): registers the tools
  salesforce/
    connection.ts       resolve instance URL and token (sf CLI or env); refetch once on 401
    client.ts           request(method, path, body): JSON in and out, error mapping, API version
  reports/
    api.ts              thin calls: reportTypes, describeReportType, describeReport, run, query, create, patch, clone, remove, soql
    definition.ts       the friendly ReportDefinition schema, and its mapping to reportMetadata
    shape.ts            reportMetadata + factMap  ->  ReportResult
    summarize.ts        describe responses  ->  compact summaries
    combine.ts          stack and join of ReportResults
skills/salesforce-reports/SKILL.md   teaches Claude the workflow
scripts/live-check.ts                end-to-end run against a real org
test/                                unit and server tests, with fixtures
```

Runtime: Node 20 or later, TypeScript in strict mode, ESM, `@modelcontextprotocol/sdk` 1.x, `zod` 3.25 or later. Tests run in vitest. The only runtime dependencies are the SDK and zod. Requests use the global `fetch`.

## Configuration

| Flag | Env | Default | Meaning |
| --- | --- | --- | --- |
| `--org <alias>` | `SF_ORG` | the `sf` default org | Authenticate through the Salesforce CLI. |
| | `SF_INSTANCE_URL` and `SF_ACCESS_TOKEN` | | Authenticate with a token you already hold. Wins over `--org` when both are set. |
| `--api-version <v>` | `SF_API_VERSION` | `62.0` | REST API version. |
| `--read-only` | `SF_REPORTS_READ_ONLY=1` | off | Register no write tools. |
| `--allow-delete` | `SF_REPORTS_ALLOW_DELETE=1` | off | Register `delete_report`. |
| `--max-rows <n>` | `SF_REPORTS_MAX_ROWS` | `200` | Default cap on detail rows in a result. The hard ceiling is 2,000. |

The CLI is called with `execFile` and an argument array, never a shell string. A token is never written to stdout, stderr or a log, and never appears in an error message.

## Tools

Every tool returns one compact JSON object as text content. A failure returns `isError: true` with the Salesforce error code and message, and a hint when one helps. For example, an unknown column suggests `describe_report_type`. Read tools carry `readOnlyHint: true`. `delete_report` carries `destructiveHint: true`. Every tool carries `openWorldHint: true`.

| Tool | Writes | API | Returns |
| --- | --- | --- | --- |
| `search_reports` | no | SOQL on `Report`: Id, Name, DeveloperName, FolderName, Format, Description, LastRunDate, LastModifiedDate | Matches by name or developer name, optionally by folder and format. Default limit 25. Each match carries its Lightning URL. User input in a `LIKE` clause is escaped. |
| `list_report_folders` | no | SOQL on `Folder WHERE Type = 'Report'` | Folders the user can see, plus a line saying that a report saved with no folder goes to Private Reports. |
| `list_report_types` | no | `GET /analytics/reportTypes` | Report types as `{type, label, category, description}`, filtered by an optional search on label, type and category. Default limit 50. |
| `describe_report_type` | no | `GET /analytics/reportTypes/{type}` | Fields by section as `{name, label, dataType}`, filtered by an optional field search, plus the date-filter columns and durations, and the filter operators for each data type. |
| `describe_report` | no | `GET /analytics/reports/{id}/describe` | A summary: name, folder, format, report type, columns with labels, groupings, aggregates with labels, filters and filter logic, date filter, URL. With `includeMetadata: true`, the raw `reportMetadata` as well. |
| `run_report` | no | `GET` or `POST /analytics/reports/{id}`, async instances on a timeout | A `ReportResult`. Optional `overrides` (a partial `ReportDefinition`) change this run only and are never saved. |
| `query_report` | no | `POST /analytics/reports/query` | A `ReportResult` for a report defined in the call and not saved. |
| `create_report` | yes | `POST /analytics/reports` | The new report's id, name, folder and URL, and its summary. Takes a `ReportDefinition` plus `name`, optional `folderId` and `description`. |
| `update_report` | yes | `PATCH /analytics/reports/{id}` | The saved summary, and a line per field that changed. Takes a partial `ReportDefinition` plus optional `name`, `description` and `folderId`. |
| `clone_report` | yes | `POST /analytics/reports?cloneId={id}` | The clone's id, name, folder and URL. |
| `delete_report` | yes, destructive | `DELETE /analytics/reports/{id}` | Confirmation that the report is in the Recycle Bin. Registered only with `--allow-delete`. |
| `combine_reports` | no | runs each input as `run_report` or `query_report` would | One `ReportResult` built from 2 to 5 inputs (below). |

### ReportDefinition (input)

The friendly shape that `query_report`, `create_report`, `update_report`, `run_report`'s `overrides` and `combine_reports` all take. `definition.ts` maps it to `reportMetadata`. A caller may also pass raw `reportMetadata` fields, which are sent unchanged.

| Field | Maps to | Notes |
| --- | --- | --- |
| `reportType` | `reportType.type` | For example `Opportunity`. Required for `query_report` and `create_report`. |
| `format` | `reportFormat` | `TABULAR`, `SUMMARY` or `MATRIX`. Joined reports are out of scope. |
| `columns` | `detailColumns` | Column API names from `describe_report_type`, for example `AMOUNT`. |
| `groupingsDown` | `groupingsDown` | Up to 3 of `{column, sortOrder?, dateGranularity?}`. `sortOrder` defaults to `Asc`, `dateGranularity` to `None`. |
| `groupingsAcross` | `groupingsAcross` | Up to 2. `MATRIX` only. |
| `aggregates` | `aggregates` | `RowCount`, or `{fn, column}` where `fn` is `sum`, `avg`, `min`, `max` or `unique`, mapped to the prefixes `s!`, `a!`, `m!`, `mx!` and `u!`. A raw string such as `s!AMOUNT` is passed through. Defaults to `["RowCount"]`. |
| `filters` | `reportFilters` | `{column, operator, value}`. Operators come from `describe_report_type`. Relative date values such as `THIS_QUARTER` and `LAST_N_DAYS:30` pass through. |
| `filterLogic` | `reportBooleanFilter` | For example `1 AND (2 OR 3)`. |
| `dateFilter` | `standardDateFilter` | `{column, duration?, startDate?, endDate?}`. `duration` maps to `durationValue`. A start or end date with no duration sends `CUSTOM`. |
| `sortBy` | `sortBy` | `{column, order}`. |
| `topRows` | `topRows` | `{rowLimit, direction}`. |
| `scope` | `scope` | For example `user` or `organization`. |

Check the aggregate prefixes and the date-granularity values against a live org in `scripts/live-check.ts`. Correct this table if they differ.

### ReportResult (output)

One shape for every report Claude runs.

```json
{
  "report": { "id": "00O…", "name": "Pipeline by stage", "format": "SUMMARY", "reportType": "Opportunity", "url": "https://…/lightning/r/Report/00O…/view" },
  "filters": ["Close Date: THIS_FISCAL_QUARTER", "Stage not equal to Closed Lost"],
  "groups": {
    "dimensions": [{ "name": "STAGE_NAME", "label": "Stage", "axis": "down" }],
    "measures": [{ "name": "s!AMOUNT", "label": "Sum of Amount", "dataType": "currency" }, { "name": "RowCount", "label": "Record Count", "dataType": "int" }],
    "rows": [["Prospecting", 120000, 4], ["Proposal/Price Quote", 480000, 1]]
  },
  "totals": { "measures": ["s!AMOUNT", "RowCount"], "values": [600000, 5] },
  "detail": {
    "columns": [{ "name": "STAGE_NAME", "label": "Stage", "dataType": "picklist" }, { "name": "OPPORTUNITY_NAME", "label": "Opportunity Name", "dataType": "string" }],
    "rows": [["Prospecting", "Acme renewal"]],
    "rowCount": 5,
    "truncated": false
  },
  "notes": []
}
```

Rules:

- **`groups`** is a tidy long table: one row per leaf combination of the down and across groupings, the grouping labels first, then one value per measure. Subtotals are left out because Claude can sum the leaves. `totals` holds the grand total. A tabular report has no `groups`.
- **`detail`** is present when detail rows were requested and returned. In a grouped report each detail row starts with its group labels. Detail rows are cut at `maxRows`, which defaults to the configured cap and can go up to 2,000.
- **Cell values.** Numbers, currency and percent cells give a number (`value`, or `value.amount` for currency). Booleans give a boolean. Dates and datetimes give the ISO string. Everything else gives the display label. An empty cell (`-`) gives `null`.
- **`notes`** say in plain words when anything was cut. Salesforce stopped at 2,000 rows (`allData: false`): narrow the filters. This tool cut rows at `maxRows`: raise `maxRows` or add filters. The run went async because the synchronous call timed out.

### combine_reports

Takes 2 to 5 inputs. Each input is `{alias, reportId?, overrides?, definition?}`, with exactly one of `reportId` and `definition`. The inputs run one after another, never in parallel, to stay inside the concurrency limit.

- **`mode: "stack"`** puts the inputs' rows into one table with a leading `source` column holding the alias. Columns are matched by name, and a column one input lacks is `null`. This answers "this quarter against last quarter" from one report run twice with different overrides.
- **`mode: "join"`** joins the inputs' `groups` tables on their grouping labels as a full outer join. `joinOn` names the dimensions to match, and defaults to each input's first down grouping. Keys match on the trimmed, case-insensitive label. Each measure column is labelled `"<alias>: <measure label>"`. This answers "pipeline by owner next to closed-won by owner".

The result is a `ReportResult` with `report.name` set to `combined: <aliases>`, and each input's notes kept with the alias in front.

## Safety

- Write tools are registered unless `--read-only` is set. MCP clients ask the user before a tool call, and the skill tells Claude to save only when asked.
- `delete_report` exists only with `--allow-delete`.
- Nothing this server does runs as anyone but the authenticated user. Sharing, folder access and field-level security are Salesforce's own.

## Tests

- **Unit.**
  - `definition.ts`: every mapping row above, including raw passthrough and the defaults.
  - `shape.ts`: fixtures for a tabular report, a summary report with detail rows and two grouping levels, and a matrix report, each checked against an expected `ReportResult`. Also an `allData: false` fixture, and a `maxRows` cut.
  - `combine.ts`: a stack and a join, including keys that appear on only one side.
  - `connection.ts`: a redacted token falls back to `show-access-token`; a 401 refetches once and then fails with a clear message; the env token wins over `--org`. `execFile` is mocked.
- **Server.** An in-memory MCP client lists the tools in default, read-only and allow-delete modes, and calls `run_report` and `query_report` against a fake API, getting a `ReportResult` back.
- **Fixtures** are captured from a real scratch org with `scripts/capture-fixtures.ts`. Account, opportunity, contact and user names are replaced with neutral ones such as `Account 1`, and the instance URL with `https://example.my.salesforce.com`. Structure, types and numbers are kept.
- **Live check.** `npm run live -- --org <alias> --allow-delete` runs every tool in order against a real org:
  1. list report types;
  2. describe `Opportunity`;
  3. query a summary report and a matrix report;
  4. create a report in Private Reports, describe it, update its name and filters, and run it;
  5. clone it;
  6. combine the two with `stack` and with `join`;
  7. delete both.

  It prints a pass or fail line per step and exits non-zero on any failure. It must leave no report behind, and it checks that with `search_reports` at the end.

## Out of scope for v0.1, planned

- **v0.2, the in-org door.** An Apex `@RestResource` class over `Reports.ReportManager` for describe and run, an `ExternalServiceRegistration`, and an `McpServerDefinition`. claude.ai would then reach reports through Salesforce's hosted MCP, signing in with an External Client App, with nothing to host. It keeps the same tool names and the same `ReportResult` shape, and passes the same fixtures. Saving from Apex needs a call back into the org's own REST API, so it waits on a probe that this works under a hosted-MCP token.
- Dashboards (`/analytics/dashboards`): list, describe, refresh, read component data.
- Joined reports, report charts, and subscriptions.
- Publishing to npm.
