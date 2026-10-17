# Design: salesforce-reports-mcp v0.1

An MCP server that lets Claude find, define, run, save and combine Salesforce reports, and hands the results back in a shape Claude can analyse. This document is the build contract for v0.1, and the plan for v0.2's in-org doors (last section).

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
  server.ts             buildServer(api, options): registers the tools and the report view resource
  widget/
    report.html         the report view: inline CSS and script, with the ext-apps client inlined when served
    view.ts             serves the view as one self-contained HTML document
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

Runtime: Node 20 or later, TypeScript in strict mode, ESM, `@modelcontextprotocol/sdk` 1.x, `zod` 3.25 or later. Tests run in vitest. The only runtime dependencies are the SDK, zod and `@modelcontextprotocol/ext-apps` 1.x (the report view only). Requests use the global `fetch`.

## Configuration

| Flag | Env | Default | Meaning |
| --- | --- | --- | --- |
| `--org <alias>` | `SF_ORG` | the `sf` default org | Authenticate through the Salesforce CLI. |
| | `SF_INSTANCE_URL` and `SF_ACCESS_TOKEN` | | Authenticate with a token you already hold. Wins over `--org` when both are set. |
| `--api-version <v>` | `SF_API_VERSION` | `62.0` | REST API version. |
| `--read-only` | `SF_REPORTS_READ_ONLY=1` | off | Register no write tools. |
| `--allow-delete` | `SF_REPORTS_ALLOW_DELETE=1` | off | Register `delete_report`. |
| `--max-rows <n>` | `SF_REPORTS_MAX_ROWS` | `200` | Default cap on detail rows in a result. The hard ceiling is 2,000. |

The CLI is called with `execFile` and an argument array, with no shell. The exception is Windows, where `sf.cmd` needs a shell (Node refuses to spawn a `.cmd` file without one): there the call is one command string built from fixed literals and the org alias, and the alias is checked against `^[A-Za-z0-9._@+-]+$` first. A bad alias is refused and nothing is spawned. A token is never written to stdout, stderr or a log, and never appears in an error message.

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
| `columns` | `detailColumns` | Column API names from `describe_report_type`, for example `AMOUNT`. A column that is also a grouping is dropped from the list, and the source column of every aggregate is added to it (see "Live findings"). |
| `groupingsDown` | `groupingsDown` | Up to 3 of `{column, sortOrder?, dateGranularity?}`. `sortOrder` defaults to `Asc`, `dateGranularity` to `None`. |
| `groupingsAcross` | `groupingsAcross` | Up to 2. `MATRIX` only. |
| `aggregates` | `aggregates` | `RowCount`, or `{fn, column}` where `fn` is `sum`, `avg`, `min`, `max` or `unique`, mapped to the prefixes `s!`, `a!`, `m!`, `mx!` and `u!`. A raw string such as `s!AMOUNT` is passed through. Defaults to `["RowCount"]`. |
| `filters` | `reportFilters` | `{column, operator, value}`. Operators come from `describe_report_type`. Relative date values such as `THIS_QUARTER` and `LAST_N_DAYS:30` pass through. |
| `filterLogic` | `reportBooleanFilter` | For example `1 AND (2 OR 3)`. |
| `dateFilter` | `standardDateFilter` | `{column, duration?, startDate?, endDate?}`. `duration` maps to `durationValue`. A start or end date with no duration sends `CUSTOM`. |
| `sortBy` | `sortBy` | `{column, order}`. |
| `topRows` | `topRows` | `{rowLimit, direction}`. |
| `scope` | `scope` | For example `user` or `organization`. |

### Live findings (checked 2026-10-11, API v62.0, `scripts/live-check.ts`)

- **Aggregate prefixes are right.** `s!`, `a!`, `m!`, `mx!` and `u!` all work. `m!` is "Smallest" (min) and `mx!` is "Largest" (max). A `u!` measure is a unique count and is an `int`.
- **`dateGranularity` accepts exactly these values:** `None`, `Day`, `Week`, `Month`, `Quarter`, `Year`, `FiscalPeriod`, `FiscalQuarter`, `FiscalWeek`, `FiscalYear`, `MonthInYear`, `DayInMonth`. Any other value is **silently turned into `None`** with no error, so the input schema is an enum. A report type's own `dateGranularityInfos` lists the first nine; `FiscalPeriod` and `FiscalWeek` are accepted too.
- **A grouped column cannot be a detail column.** Salesforce answers `You can't include groupings in the selected columns list`. The server drops it from `columns`.
- **Every aggregated column must be a detail column.** `s!AMOUNT` fails with `not a valid aggregate because it was not selected in the detail columns` unless `AMOUNT` is in `detailColumns`. The server adds it.
- **A grouped report needs at least one detail column, and an empty list is read as "all columns"** (which then fails the 100-column limit). When the caller gives none, the server takes the first of the report type's default columns that is not a grouping.
- **The API applies defaults a caller did not ask for.** An Opportunity report with no date filter gets `THIS_FISCAL_QUARTER`, and the standard filters `open: all` and `probability: >0`. Despite its value, `probability: >0` is Salesforce's "All" and hides nothing (checked below). `ReportResult.filters` lists them so the caller sees what was applied. `reportMetadata` can override the date filter, and can change a standard filter's value but not remove it (next finding).
- **A run cannot remove a standard filter, only change its value.** A run with `{"reportMetadata":{"standardFilters":[]}}`, or `null`, comes back with the saved `open: all` and `probability: >0` and the same totals, with no error. The same holds for `/analytics/reports/query` and for Apex `Reports.ReportManager.runReport` with an empty `setStandardFilters`. A listed filter is applied by name, and one left out keeps its saved value: `[{"name":"open","value":"closed"}]` ran with `open: closed` and the saved `probability: >0`. Values must come from the report type's `standardFilterInfos`. For `probability` they are `>0` (which Salesforce labels "All"), `gt10` to `gt90` and `lt10` to `lt90`; `>50`, `0`, `>=0` and `all` fail with `value "…" is not one of the picklist choices`, and an unknown name fails with `… is not a valid standard filter for this report`. None is needed: `>0` keeps opportunities at 0 percent. On 2026-10-14 `dev-frontend-2` held 37 opportunities closing from 2020 to 2030, 7 of them Closed Lost at 0 percent. An unsaved Opportunity summary by stage over those dates, with the default `probability: >0`, returned all 37 with Closed Lost as its own group, on the local server and on the in-org door alike, and a row filter `Probability (%) equals 0` returned exactly the 7. Earlier skill text said the filter hides Closed Lost; that was wrong and is corrected. `run_report` and `query_report` now say in `notes`, on every door, when an empty list was ignored and which standard filters still apply, and which ones a partial list left at their saved values. Requests and answers are in [the runner REST rehearsal](rehearsals/runner-rest.md#the-standardfilters-override-checked) (found 2026-10-12, API v62.0 and the in-org door).
- **Lookup cells carry the record id in `value` and the readable name in `label`**; percent cells are numbers (`90` for `90%`); currency cells are `{amount, currency}`; booleans are booleans.
- **`GET /analytics/reportTypes/{type}` and `GET /analytics/report-types/{type}` both work.** The server uses the first, as designed.
- **`DELETE` returns 204; `POST /analytics/reports?cloneId=` with `{"reportMetadata":{"name":…}}` clones into Private Reports.**
- **Saved metadata comes back with its keys in alphabetical order.** Apex's `JSON.deserializeUntyped` loses key order, so the in-org door writes `update_report`'s change lines with sorted keys to match what `JSON.stringify` writes locally (found in phase 3b).
- **An External Client App can be deleted by metadata.** After `npm run mcp:teardown`, one destructive deploy removed the whole MCP door: the app's two OAuth settings and the MCP server in the pre step, the app and the API Catalog entry in the post step (`salesforce/manifest/mcp-app/`). No manual step and no Setup click was needed (found in the package split).
- **Deploying the `McpServerDefinition` writes its tool rows.** On a fresh install, `mcp:setup` found all eleven `McpServerToolDefinition` rows already there and only created the `McpServerAccess` row. Redeploying the registration and the server over an active server also succeeds, and updates each tool row's `DescriptionOverride` in place, so a description change needs no teardown. The API Catalog operations stay inactive either way (found in the package split).
- **`UserInfo.getSessionId()` throws under a hosted MCP sign-in.** Through the hosted server in claude.ai, signed in through the External Client App with `mcp_api` and `refresh_token`, `list_report_types` failed at `ReportsCallout.session` with `System.UnexpectedException: Script-thrown exception`. The REST API never saw a call. So the hosted door has its own route, `/reports/v1/mcp/<tool>`, and on it `ReportsCallout` answers `CALLOUT_SESSION` before it asks for a session ([decision 0007](decisions/0007-callout-identity-under-hosted-mcp.md); found 2026-10-12).
- **A per-user JWT named credential calls the org's own REST API without a session.** With the optional `callout-app` package, the hosted route calls `callout:SalesforceReportsCallout` and the org mints a token for the running user. The app needs the scopes `Api` and `RefreshToken`, even though no refresh token is used. In the external credential, `iss` and `sub` must be unquoted (a quoted `sub` is not evaluated as a formula) and `aud` must be quoted (the deploy refuses an unquoted URL). A user without the permission set gets `We couldn't access the credential(s)`, which the door answers as `CALLOUT_CREDENTIAL` ([decision 0012](decisions/0012-per-user-jwt-named-credential.md), [phase 3c](probes/v0.2-phase3c.md); found 2026-10-12).
- **That exception escapes `catch (Exception e)`.** `ReportsApi.handle` catches every `Exception`, yet the client got Salesforce's own `APEX_ERROR`, not the door's `UNEXPECTED`, with class names and line numbers in the message. Code that may hit it must avoid the call, not catch it (found 2026-10-12).
- **A call without arguments through the hosted server answered `INVALID_INPUT`.** The hosted server most likely posts the JSON `null` for it (inferred from the reproduction, not observed on the wire), and `ReportsInput.parse` refused it as not a JSON object. The door now reads `null`, like a blank body, as no input, as the local server reads missing arguments. `[]` and `"x"` are still refused (found 2026-10-12).

### Dashboard findings (checked 2026-10-16, API v62.0, [v0.3 dashboards probe](probes/v0.3-dashboards.md))

- **`GET /analytics/dashboards` lists only recently viewed dashboards** and returned `[]` for a dashboard never opened in the UI. Find dashboards with SOQL on `Dashboard` (`Id, Title, DeveloperName, FolderName, Type, RunningUserId`), which returns the ones the signed-in user can see.
- **A dashboard that was never refreshed answers 200 with `componentDataStatus: NO_DATA`** on every component, `refreshDate: null` and `reportResult: null`. There is no error.
- **`PUT /analytics/dashboards/{id}` refreshes** (201 with a `statusUrl`). Data was ready at the first poll of `/status`, 3 to 9 seconds later. A second refresh inside a minute answers 403 `FORBIDDEN`.
- **Each `componentData[].reportResult` is an ordinary report run** (`factMap`, `groupingsDown`, `reportMetadata`), so `shape.ts` can read it. Join it to `describe.components` by `componentId`, and note that `reportMetadata` does not show the dashboard filter.
- **Filtered data needs the filter on the PUT's query string**: `PUT /analytics/dashboards/{id}?filter1=<optionId>`, then `GET …?filter1=<optionId>`. A body such as `{"filters":["<optionId>"]}` answers 201 and does nothing. The option text, and `filter2` or `filter3` on a one-filter dashboard, answer 400 `BAD_REQUEST`.
- **The cache is per filter value.** A value never refreshed answers `NO_DATA`. After a refresh for another value, the older caches keep their data and show `refreshStatus: STALE`.

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

### Report view

`run_report` and `query_report` carry an MCP App on the local door ([decision 0013](decisions/0013-report-view-as-an-mcp-app.md)). Their `_meta.ui.resourceUri` is `ui://salesforce-reports/report`, and they return the `ReportResult` twice: as the text content, byte for byte what they returned before, and as `structuredContent`. No `outputSchema` is declared. Every other tool returns text only.

The resource is one self-contained HTML document of type `text/html;profile=mcp-app`: inline CSS, the view script, and the ext-apps browser client inlined from the installed package when the view is first served. It loads nothing from the network, so it needs no csp block. If a file is missing, the resource answers a short page that says so and the server runs on. The view draws the report name (linked to the report when it is saved), a strip of key figures (the grand total of the first measure that is not the record count, the record count, and the largest top-level group's share), the filters as chips, a matrix as a heat-shaded grid with row and column totals and its group table closed below it, a column chart of the top-level groups on a summary (at most 12 columns, then one Other), the group table with a totals row and data bars on a summary, the detail rows with a line when they were cut, and the notes. A tabular card draws no chart, and a matrix keeps its grid with no chart. At phone width (480 px or less) every table folds so nothing scrolls sideways: a group row keeps its grouping labels on the left and the primary measure with its bar on the right, and every other column stacks under the row with its header as a label. Currency, percents and dates are formatted, and a blank value draws as `-`. It all comes from the `ReportResult` as it is, with inline CSS and SVG and no chart library ([decision 0015](decisions/0015-report-card-visuals.md)). It offers "Open in Salesforce" when the result has a URL, and "Save this report" for an unsaved `query_report` result, which asks Claude in the chat to save it with `create_report`. The view never calls a tool by itself.

Claude Desktop, claude.ai and Cowork draw the card. Claude Code and other hosts without MCP Apps show the text result, unchanged. The in-org doors carry no ui resource: the REST door answers JSON, and the hosted door is built from an API Catalog registration that cannot carry `ui://`. The two tools' descriptions end with a short hint for a host that draws the card: lead with the one finding the card cannot show (concentration, change, risk, the next question), keep the reply short, and never repeat the card's rows, totals or a table. `doorDescription` strips the hint on the hosted door, which draws no card. The report runner skill carries the same rule for both kinds of host. `npm run test:render` draws the real view in Chromium through a test host page that speaks the host side of the protocol with the ext-apps AppBridge, checks the DOM, and compares screenshots kept per platform ([decision 0014](decisions/0014-render-tests-through-a-test-host.md)).

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

## Planned after v0.1

- **v0.2, the in-org doors.** A REST endpoint and a hosted MCP server inside the org, so people choose how they connect. See the next section.
- Dashboards (`/analytics/dashboards`): list, describe, refresh, read component data.
- Joined reports, report charts, and subscriptions.
- Publishing to npm.

## v0.2: the in-org doors (planned)

v0.1 runs on the user's machine and needs nothing in the org. v0.2 adds two ways in that live in the org itself. All three doors offer the same tool names, the same inputs and the same `ReportResult`, so the three skills work unchanged on any of them.

| Door | What runs | For | Setup |
| --- | --- | --- | --- |
| Local MCP (v0.1) | This Node server, over the Reports and Dashboards REST API | Claude Code, Claude Desktop, any MCP client that can start a process | `npx`, plus the `sf` CLI or a token. Nothing in the org. |
| In-org REST | An Apex `@RestResource` class, `ReportsApi`, at `/services/apexrest/reports/v1/<tool>` | Scripts, Flow, Agentforce actions, other agents | Deploy the package and assign its permission set. |
| In-org MCP | Salesforce hosted MCP, exposing the same Apex class as tools through an `McpServerDefinition`, on its own route `/services/apexrest/reports/v1/mcp/<tool>` | claude.ai and other remote MCP clients, with nothing to host | The package, an admin enabling the server, and an External Client App for sign-in. Hosted MCP is for Enterprise Edition and above; whether a scratch org can run it is probe 1. |

One Apex class backs both in-org doors: a hosted MCP custom server wraps an Apex REST resource, so the MCP door is the REST door with one more layer. The local server never calls the Apex door, and the Apex door never needs the local server. "Nothing to host" is not "nothing to set up": the README says what an admin does.

### One contract, two implementations

- Tool names, input schemas and `ReportResult` are defined once, in this document. The TypeScript and Apex tests both cite it.
- `scripts/parity-check.ts` runs each fixture report through the local server and through the REST door, and diffs the JSON. The live check gains `--door apex` and runs its steps through the REST door.
- A door that lacks a tool leaves it out of its tool list. The skills look at the tool list, never at the transport. When `query_report` is missing, the runner says so and offers the nearest saved report instead.
- The skills name tools by their bare names (`run_report`), which still match when a client puts a server prefix in front.

### What Apex can do without a callout

`Reports.ReportManager` can describe a report and run it with changed filters, groupings and columns, but cannot save one. Everything else needs a call from Apex back into the org's own REST API.

| Tool | Apex alone | With a callout to the org's REST API |
| --- | --- | --- |
| `search_reports` | SOQL on `Report` | |
| `list_report_folders` | SOQL on `Folder` | |
| `describe_report` | `ReportManager.describeReport` | |
| `run_report` | `ReportManager.runReport` with `ReportMetadata` overrides, `runAsyncReport` on a timeout | |
| `combine_reports` | Built on `run_report`, a port of `combine.ts` | Also over `query_report` |
| `describe_report_type` | Only through a saved report of that type, from `ReportDescribeResult.getReportTypeMetadata()` (probe 5) | `GET /analytics/reportTypes/{type}` |
| `list_report_types` | No | `GET /analytics/reportTypes` |
| `query_report` | No: it needs a saved report behind it | `POST /analytics/reports/query` |
| `create_report`, `update_report`, `clone_report` | No: Apex cannot save a report | `POST` and `PATCH /analytics/reports` |
| `delete_report` | Not offered in the org | |

### Phase 0: probes

Answered on 2026-10-11 in `docs/probes/v0.2-phase0.md`; the results are under "Phase 0 results" below. Probe source lives in `probes/v0.2-hosted-mcp/`, a separate SFDX project, and everything deployed for a probe is removed afterwards. Probes run against a scratch org.

1. **Hosted MCP on a scratch org.** Do the hosted MCP metadata types exist in the org, and does a hello-world custom server over a one-method Apex REST class deploy and show up? If a scratch org cannot run hosted MCP, the MCP door cannot be tested in a dev org, and the REST door goes ahead alone.
2. **From Apex class to tools.** What turns the class into tools (the OpenAPI document Salesforce generates for Apex REST, an API Catalog entry, an `ExternalServiceRegistration`), and which tool names and input schemas come out. Can the names match the local server's?
3. **A callout to the org's own REST API.** From Apex, with the running user's session, under a token from the `sf` CLI: `GET /analytics/reportTypes`, `POST /analytics/reports/query`, and a report created and then deleted. Which is needed: a Remote Site Setting, or a Named Credential. Then the same under a hosted MCP sign-in, or a plain note that this needs an interactive sign-in and is still open.
4. **Heap and CPU.** Shape a run into a `ReportResult` in Apex, measure heap and CPU per row, and estimate a 2,000-row, 100-column run against the synchronous limits. The in-org `maxRows` default stays at 200, and the in-org ceiling comes from this.
5. **Report type columns without a callout.** Does `describeReport` on a saved report return its report type's columns, by section, with enough to answer `describe_report_type`?

### Phase 0 results

| # | Answer | What changes |
| --- | --- | --- |
| 1 | Yes for the metadata, open for a live call | `McpServerDefinition` deploys on a Developer Edition scratch org (API 68.0). A CLI token gets 401 at the hosted endpoint, so a live call needs an External Client App and an interactive sign-in. |
| 2 | Open, leaning yes | An `ExternalServiceRegistration` (provider type `ApexRest`, inline OpenAPI, `systemVersion` 3, base path `/services/apexrest`) names operations from our `operationId`, so `run_report` is ours to set. Tools are `McpServerToolDefinition` rows, which are data, not metadata: an admin adds them in Setup, or a setup script writes them. |
| 3 | Yes under a user session | Apex reached `/analytics/reportTypes`, `/analytics/reports/query`, and created and deleted a report, with no Remote Site Setting or Named Credential. Under a hosted MCP sign-in it is open. |
| 4 | Estimated | A 2,000 by 100 run needs about 20 MB of heap against 6 MB. The in-org row cap is `min(2000, floor(50000 / columns))`; the default stays 200. Re-measure on a seeded org in phase 1. |
| 5 | Yes, through a saved report | `describeReport(...).getReportTypeMetadata()` gives the same columns as REST, by section, with name, label and data type (`STRING_DATA` becomes `string`). It has no filter operators, and a type with no saved report needs the callout. |

### Phase 1 result

Done 2026-10-11 (`docs/probes/v0.2-phase1.md`, `salesforce/README.md`). `ReportsApi` matches the local server on all 27 parity cases on a seeded scratch org, and the live check's read steps pass with `--door apex`. Differences: `describe_report_type` reads the type through a saved report of it and has no filter operators; `describe_report` with `includeMetadata` returns only the fields Apex exposes; a run too large for Apex returns `RESULT_TOO_LARGE` instead of going async. The cell cap held, and CPU, not heap, is what stops a larger run. A 200-row measurement still needs an org with more data.

### Phase 2 result

Built 2026-10-11 (`docs/probes/v0.2-phase2.md`). The server `SalesforceReports` is deployed and active in a scratch org with the six read tools, named exactly like the local ones. Tool rows use `ApiSource` `API_CATALOG`, `ApiIdentifier` `ar:ReportsApi` and `Operation` equal to the tool name, and at API 68.0 the `McpServerDefinition` metadata carries its tools. Open: activating the API Catalog operations is a Setup click, and a live call needs one interactive sign-in through the External Client App. A client credentials token was not issued, because the org does not return an app's secret over REST.

### Phase 3a result

Built 2026-10-11 (`docs/probes/v0.2-phase3.md`). `list_report_types`, `query_report` and a full `describe_report_type` reach the in-org door through one helper, `ReportsCallout`, which calls the org's own REST API under the user's session. `combine_reports` takes definition inputs. The hosted server carries eight tools. Parity holds on 44 cases with no ignore list, the live check passes with `--door apex`, and 38 Apex tests pass. `query_report` asks for detail rows only when the result shows them. A grouped query over 2,000 rows can therefore lack the local "stopped at 2,000 rows" note. A refused session answers `CALLOUT_SESSION`, and `describe_report_type` then falls back to the phase 1 path. Open: whether the callout works under a hosted MCP sign-in, whose External Client App has only the `mcp_api` and `refresh_token` scopes. If it does not, the fixes are the `Api` scope (which widens the token to the whole API as that user) or a per-user Named Credential.

### Phase 3b result

Built 2026-10-11 (`docs/probes/v0.2-phase3b.md`). `create_report` (from a definition, or from `fromReportId` plus changes), `update_report` and `clone_report` reach the in-org door through `ReportsCallout`. Each checks the custom permission `Reports_Write`, held by the permission set `Salesforce_Reports_Write`, before it reads its input or calls out, and answers 403 `WRITE_NOT_ALLOWED` without it. The hosted server carries eleven tools. No MCP Tooling object has a user or permission field, so one hosted server cannot hide tools per user: the save tools stay listed for everyone and the door refuses users without the permission. Parity holds on 49 cases, the live check runs every save step through the door (delete stays local), and 50 Apex tests pass, including a user without the permission whose call makes no callout. Open, as in 3a: whether the callout works under a hosted MCP sign-in.

### Callout through a named credential

Built 2026-10-12 ([decision 0012](decisions/0012-per-user-jwt-named-credential.md)). On the hosted route `ReportsCallout` uses the identity `NAMED_CREDENTIAL`. With the optional package `salesforce/callout-app` installed and its permission set `Salesforce_Reports_Callout` assigned, `list_report_types`, `query_report`, `combine_reports` with definitions, the full `describe_report_type` and the three saves run on the hosted door as the signed-in user, through `callout:SalesforceReportsCallout`. Without the package, the hosted route answers `CALLOUT_SESSION` as before. With it, a user without the permission set gets 500 `CALLOUT_CREDENTIAL` and a hint naming the set, and `describe_report_type` still falls back to a saved report. The REST route keeps the caller's session. In a dev org, anonymous Apex calling the hosted route answered 200 for `list_report_types`, `query_report` and `combine_reports` with definitions. From a real hosted sign-in in claude.ai the same day, `list_report_types` listed 156 types and `query_report` ran an unsaved stage summary, 8 opportunities and 3,091,000, matching the saved report ([rehearsal](rehearsals/runner-hosted.md)).

### Phases

| Phase | Work | Done when |
| --- | --- | --- |
| 0. Probes | The five above | All five answered in `docs/probes/v0.2-phase0.md` |
| 1. REST door, runner tools | `ReportsApi` with `search_reports`, `list_report_folders`, `describe_report`, `run_report`, `combine_reports`, and `describe_report_type` through a saved report of the type; the shaper ported from `shape.ts`, with the cell cap from probe 4; Apex tests; `scripts/parity-check.ts` | Parity on every fixture, and the live check's read steps pass with `--door apex` |
| 2. MCP door | The `McpServerDefinition`, the `ExternalServiceRegistration`, the permission set, and the admin steps in the README (External Client App, tool rows, sign-in); the runner skill rehearsed against hosted MCP, with Ben signing in once | The in-org runner rehearsal matches the local one |
| 3a. Callout reads | `list_report_types`, `query_report` and `describe_report_type` through one callout helper; `combine_reports` over definitions | Parity on the new cases (done, see Phase 3a result) |
| 3b. Saves | `create_report`, `update_report` and `clone_report` through the same helper, behind a custom permission. If the hosted sign-in cannot call out, a Named Credential the admin sets up, or saving stays local-only. | Built, parity on 49 cases (see Phase 3b result). Open: the designer rehearsal in the org |
| 4. Docs and skills | The README's three doors, the changelog, the runner's fallback when `query_report` is missing | The skills read the same on every door |

`report-deploy` stays local-only: it needs the `sf` CLI, and its description already says so.

### Safety in the org

- `ReportsApi` is `with sharing` and runs as the signed-in user, so sharing, folder access and field-level security stay Salesforce's own.
- The permission set grants the Apex class and nothing else.
- The save tools check a custom permission, `Reports_Write`, held by a second permission set, before any input is read or callout made. Without it they answer 403 `WRITE_NOT_ALLOWED`. They stay listed on the hosted server, because a tool list is not a security boundary: the REST door can be called directly, and one hosted server cannot vary its tools per user.
- No `delete_report` in the org.
