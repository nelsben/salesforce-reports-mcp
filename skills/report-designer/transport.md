# Transport: where the tools come from

The skill steps name tools such as `search_reports` and `run_report`. The same tools, with the same inputs and the same results, can reach you through three doors. This file says how to tell which one you have and how to call the REST door. It is the same file in report-runner and report-designer.

## Which door

1. **MCP tools connected.** If you have tools named after the steps (`search_reports`, `run_report` and so on, often with a prefix such as `mcp__salesforce-reports__`, or a Salesforce hosted connector called SalesforceReports), call them. That is the local MCP server or the hosted MCP door. Skip the rest of this file.
2. **No such tools, but a shell and the Salesforce CLI (`sf`).** Use the in-org REST door below. It needs only the `sf` CLI, signed in to the org, and the package from `salesforce/` deployed in that org. No MCP server runs.
3. **Neither.** Say the skill needs either the salesforce-reports MCP server or the `sf` CLI with the package in the org, and stop.

## Which org

Ask the user once for the Salesforce CLI alias (or username) of the org, unless they already named it. Pass it as `-o <alias>` on every call. Never leave out `-o`, and never fall back to the CLI's default org without saying so: it may be a different org from the one the user means.

## The call

Every tool is one POST to `/services/apexrest/reports/v1/<tool>`, with the tool's input JSON as the body. The input is exactly what the step would pass to the MCP tool.

Pass the JSON in a body file. It avoids every shell quoting problem (apostrophes in report names, quotes and braces in filters):

1. Write the input JSON to a new file with your file-writing tool, in your scratchpad directory if the session has one, otherwise a temp folder (for example `/tmp/sf-reports/run_report-1.json`). Use a fresh file name for each call, so you never overwrite a file you have not read. Do not make the file in the shell (`echo`, `printf`, `mkdir`, `>`): the file tool needs no folder made first, and a shell command that does more than the one `sf` call can be refused by Claude Code's permission checks.
2. Run the call as a command of its own, with `@` before the path:

```bash
sf api request rest "/services/apexrest/reports/v1/run_report" --method POST --body @/tmp/sf-reports/run_report-1.json -o <alias>
```

Do not put JSON inline in `--body '...'`, where one apostrophe in a value breaks the command, and do not pipe it through a heredoc, which Claude Code refuses as a quoted brace.

The `sf` CLI signs the request with the org's stored session. Never fetch, print or paste an access token, never put one in a command, and never ask the user for one.

## Tools on the REST door

The door has fifteen tools.

Over MCP the tool schema tells you the input fields. Here it does not, so use these names exactly. The definition fields are `reportType`, `format`, `columns`, `groupingsDown`, `groupingsAcross`, `aggregates`, `filters`, `filterLogic`, `dateFilter`, `sortBy`, `topRows`, `scope` and `reportMetadata`, with the shapes in `reference.md`. The result controls are `detail` and `maxRows`.

| Tool | Kind | Input fields (required in bold) |
| --- | --- | --- |
| `search_reports` | read | `query`, `folder`, `format`, `limit` |
| `list_report_folders` | read | `search`, `limit` |
| `list_report_types` | read, calls the org's REST API from inside the org | `search`, `limit` |
| `describe_report` | read | **`reportId`**, `includeMetadata` |
| `describe_report_type` | read, calls the org's REST API from inside the org | **`type`** (not `reportType`), `search`, `limit` |
| `run_report` | read | **`reportId`**, `overrides` (any definition fields, for this run only), `detail`, `maxRows` |
| `query_report` | read, calls the org's REST API from inside the org | **`reportType`**, the definition fields, `detail`, `maxRows` |
| `combine_reports` | read | **`mode`** (`stack` or `join`), **`inputs`** (2 to 5 of `{alias, reportId, overrides}` or `{alias, definition}`), `joinOn`, `detail`, `maxRows` |
| `list_dashboards` | read | `query`, `folder`, `limit` |
| `describe_dashboard` | read, calls the org's REST API from inside the org | **`dashboardId`** |
| `run_dashboard` | read, calls the org's REST API from inside the org | **`dashboardId`**, `filters` (`[{name, option}]`, from `describe_dashboard`), `maxRows` |
| `create_report` | save, needs the write permission | **`name`**, `description`, `folderId`, `fromReportId`, the definition fields (`reportType` when there is no `fromReportId`) |
| `update_report` | save, needs the write permission | **`reportId`**, `name`, `description`, `folderId`, the definition fields to change |
| `clone_report` | save, needs the write permission | **`reportId`**, `name`, `folderId` |
| `refresh_dashboard` | write, needs the write permission; waits up to about 30 seconds | **`dashboardId`**, `filters`, `maxRows` |

Deleting a report is not on this door. It answers 404 `UNKNOWN_TOOL`. Deleting needs the local MCP server started with `--allow-delete`, or Salesforce itself.

## Reading a result

A success prints the same JSON the MCP tool returns, and the command exits 0. Read it exactly as the skill and `reference.md` say: `summary`, `filters`, `notes`, `groups`, `rows`, `url`.

## Reading an error

A refusal or failure exits non-zero and prints a body of this shape:

```json
{"error": {"code": "INVALID_INPUT", "message": "reportId is required.", "hint": "optional"}}
```

Act on `code`:

| Code | Means | Do |
| --- | --- | --- |
| `INVALID_INPUT`, or a Salesforce error code | The input is wrong, often a column name | Fix the input from `message` and `hint` and try once more, as the skill says. |
| `WRITE_NOT_ALLOWED` (HTTP 403) | The user lacks the write permission for saves and dashboard refreshes | A refusal. Do not retry. Follow the skill's refusal steps. |
| `CALLOUT_SESSION` | The door could not call the org's own REST API under this sign-in. On the hosted MCP server, the org lacks the optional callout package | A refusal. Do not retry. Follow the skill's refusal steps. |
| `CALLOUT_CREDENTIAL` | On the hosted MCP server, the org has the callout package, but this user lacks its permission set (the `hint` names it) or its token failed | A refusal. Do not retry. Follow the skill's refusal steps for `CALLOUT_SESSION`, and pass on the `hint`. |
| `CALLOUT_FAILED`, `RESULT_TOO_LARGE` | The run was too big or too slow inside the org | Narrow it (fewer columns, a tighter date range, no detail rows) and try once. |
| `NO_SAVED_REPORT` | `describe_report_type` could not read a type that has no saved report | Pick a type that has a saved report, or say the type cannot be read here. |
| `UNKNOWN_TOOL` (HTTP 404) | The package is installed, but this tool is not on the door | Do not retry. Use another tool, or say it needs the local server. |

## The package is not installed

If the call answers a platform 404 that is not ours, the package is not deployed in that org. It looks like this, a list with `NOT_FOUND`, not an object with `error`:

```json
[{"errorCode": "NOT_FOUND", "message": "Could not find a match for URL"}]
```

Say so, and point an admin to `salesforce/README.md` in the repository (https://github.com/nelsben/salesforce-reports-mcp/blob/main/salesforce/README.md), which deploys it. Check the alias first: the wrong org gives the same 404.

Other CLI errors: `No authorization information found` or an expired session means the alias is not signed in. Ask the user to run `sf org login web -a <alias>` themselves. `ENOENT` means the body file path is wrong.
