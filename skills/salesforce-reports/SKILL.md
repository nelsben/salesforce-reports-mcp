---
name: salesforce-reports
description: Answer questions about Salesforce data by finding, running, defining, saving and combining Salesforce reports through the salesforce-reports MCP server. Use when the user asks for pipeline, bookings, forecast, win rate, activity or any other number that a Salesforce report could give, asks to run or change a named report, or asks to save a report.
---

# Working with Salesforce reports

This skill assumes the `salesforce-reports` MCP server is connected. Its tools: `search_reports`, `list_report_folders`, `list_report_types`, `describe_report_type`, `describe_report`, `run_report`, `query_report`, `combine_reports`, `create_report`, `update_report`, `clone_report`, and `delete_report` when the server was started with `--allow-delete`. If the write tools are missing, the server is in read-only mode: say so and offer the definition instead.

## Choose the path

1. **The user names a report, or one probably exists** ("run the pipeline report", "how is Q4 pipeline looking"). Call `search_reports`, then `run_report`. If several reports match, show the top few with their folder and last run date and ask which one.
2. **No report exists, or the user wants a number cut a new way.** Use `query_report`. It defines the report in the call and saves nothing. Do this before offering to save.
3. **The user wants it kept** ("save that", "make that a report"). Use `create_report` with the same definition you just queried. Say where it landed: with no `folderId` it is in the user's Private Reports folder, visible only to them.
4. **A saved report needs a small change for one answer** (another quarter, one more filter). Use `run_report` with `overrides`. Nothing is saved. Use `update_report` only when the user asks to change the report itself.

Save, update, clone and delete only when the user asks. Never save a report as a side effect of answering a question.

## Define a report correctly

1. `list_report_types` with a search word to find the `reportType` (for example `Opportunity`).
2. `describe_report_type` with a `search` word to find the column API names (`AMOUNT`, `STAGE_NAME`, `CLOSE_DATE`). Do not guess names. Names are upper-case and often differ from the field label.
3. Build the definition:
   - A flat list: `columns`, no groupings.
   - Totals by something: `groupingsDown` plus `aggregates`. Example: `groupingsDown: [{column: "STAGE_NAME"}]`, `aggregates: ["RowCount", {fn: "sum", column: "AMOUNT"}]`.
   - A cross-tab: add `groupingsAcross`.
   - By month or quarter: group on the date column with `dateGranularity` (`Month`, `Quarter`, `FiscalQuarter`, `Year`...).
   - Ranges: `dateFilter: {column: "CLOSE_DATE", duration: "THIS_FISCAL_QUARTER"}`. Other durations: `LAST_N_DAYS:30`, `THIS_YEAR`, `LAST_QUARTER`, or `startDate` and `endDate`.
   - Row filters: `filters: [{column, operator, value}]`. Operators come from `describe_report_type` (`equals`, `notEqual`, `greaterThan`, `contains` ...). Combine with `filterLogic: "1 AND (2 OR 3)"`.
4. Run it with `query_report` and check the result before you report it.

The server fixes two Salesforce quirks for you and says so in `notes`: it adds an aggregated column to the detail columns, and drops a grouped column from them.

## Read the result

- `filters` lists every filter that was applied, including ones the user did not set. Salesforce adds a default date filter (for Opportunity, `THIS_FISCAL_QUARTER`) and standard filters (such as `probability: >0`, which hides Closed Lost). **Always check `filters` against what the user asked.** If a default is wrong for the question, override it, for example with `dateFilter` or `reportMetadata: {standardFilters: []}`.
- `groups` is the table to analyse: grouping labels first, then measures. `totals` is the grand total.
- `detail` holds record-level rows. It is on by default for flat reports only. Ask for it with `detail: true`.
- **Read `notes`.** If Salesforce stopped at 2,000 rows, or rows were cut at `maxRows`, the numbers are partial: narrow the filters rather than presenting them as complete. Group totals come from Salesforce and are complete even when detail rows are cut.
- A failed call returns `isError` with a Salesforce code and a hint. Fix the input from the hint (usually a column name) and retry once. Do not retry blindly.

## Compare and combine

- **This quarter against last quarter:** `combine_reports` with `mode: "stack"` and two inputs, the same `reportId` with different `overrides.dateFilter`. Each row carries a `source` alias.
- **Two measures by the same dimension:** `mode: "join"`, for example pipeline by owner and closed-won by owner. Both inputs must be grouped by the join key. Rows missing on one side show `null`.
- Up to 5 inputs. They run one after another, so keep it small.

## Limits to keep in mind

- At most 2,000 detail rows and 100 columns per run, and 500 synchronous runs per org per hour. Prefer one grouped query over many small ones.
- Joined-format reports are not supported.
- Everything runs as the connected user: Salesforce sharing and field-level security still apply, so a number can differ from a colleague's.
- A deleted report goes to the Recycle Bin, not away for good.
