# Report runner reference

## Reading a result

- `filters` lists every filter that was applied, including ones the user did not set. Salesforce adds a default date filter (for Opportunity, `THIS_FISCAL_QUARTER`) and standard filters (such as `probability: >0`, which hides Closed Lost). **Always check `filters` against what the user asked**, and say the ones that change the meaning. If a default is wrong for the question, override it for this run, for example with `dateFilter`. A standard filter cannot be removed, only given another value by name, for example `reportMetadata: {standardFilters: [{name: "open", value: "closed"}]}`; one left out keeps its saved value, and an empty list is ignored (`notes` say so). `probability` has no value wider than `>0`.
- `groups` is the table to analyse: grouping labels first, then measures. `totals` is the grand total.
- `detail` holds record-level rows. It is on by default for flat reports only. Ask for it with `detail: true`.
- **Read `notes`.** If Salesforce stopped at 2,000 rows, or rows were cut at `maxRows`, the numbers are partial: narrow the filters rather than presenting them as complete. Group totals come from Salesforce and are complete even when detail rows are cut.
- A report's link is in the result (`url`). Give it every time.

## Slicing a saved report

`run_report` takes `overrides`: any of the definition fields below. They apply to that run only and are never saved. A list you send (filters, columns, groupings, aggregates) replaces the saved list, so include the entries you want to keep.

Examples of slices, in the user's words:

- "by owner": `overrides: {groupingsDown: [{column: "FULL_NAME"}]}` (find the real column name with `describe_report_type`).
- "last quarter instead": `overrides: {dateFilter: {column: "CLOSE_DATE", duration: "LAST_FISCAL_QUARTER"}}`.
- "without closed deals": a filter on the stage column, or `reportMetadata: {standardFilters: [{name: "open", value: "open"}]}`.

## Compare and combine

- **This quarter against last quarter:** `combine_reports` with `mode: "stack"` and two inputs, the same `reportId` with different `overrides.dateFilter`. Each row carries a `source` alias.
- **Two measures by the same dimension:** `mode: "join"`, for example pipeline by owner and closed-won by owner. Both inputs must be grouped by the join key. Rows missing on one side show `null`.
- Up to 5 inputs. They run one after another, so keep it small.

## Definition grammar (for `query_report` and `overrides`)

1. `list_report_types` with a search word finds the `reportType` (for example `Opportunity`).
2. `describe_report_type` with a `search` word finds the column API names (`AMOUNT`, `STAGE_NAME`, `CLOSE_DATE`). Names are upper-case and often differ from the field label.
3. Build the definition:
   - A flat list: `columns`, no groupings.
   - Totals by something: `groupingsDown` plus `aggregates`. Example: `groupingsDown: [{column: "STAGE_NAME"}]`, `aggregates: ["RowCount", {fn: "sum", column: "AMOUNT"}]`.
   - A cross-tab: add `groupingsAcross`.
   - By month or quarter: group on the date column with `dateGranularity` (`Month`, `Quarter`, `FiscalQuarter`, `Year`...).
   - Ranges: `dateFilter: {column: "CLOSE_DATE", duration: "THIS_FISCAL_QUARTER"}`. Other durations: `LAST_N_DAYS:30`, `THIS_YEAR`, `LAST_QUARTER`, or `startDate` and `endDate`.
   - Row filters: `filters: [{column, operator, value}]`. Operators come from `describe_report_type` (`equals`, `notEqual`, `greaterThan`, `contains` ...). Combine with `filterLogic: "1 AND (2 OR 3)"`.
   - Whose records: `scope` (`organization`, `user` for my records, `team`).
4. Run it and check the result before you report it.

The server fixes two Salesforce quirks and says so in `notes`: it adds an aggregated column to the detail columns, and drops a grouped column from them.

## Limits

- At most 2,000 detail rows and 100 columns per run, and 500 synchronous runs per org per hour. Prefer one grouped query over many small ones.
- Joined-format reports are not supported.
- Everything runs as the connected user: Salesforce sharing and field-level security still apply, so a number can differ from a colleague's.
