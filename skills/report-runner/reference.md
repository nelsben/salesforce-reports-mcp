# Report runner reference

## Reading a result

- `filters` lists every filter that was applied, including ones the user did not set. Salesforce adds a default date filter (for Opportunity, `THIS_FISCAL_QUARTER`) and standard filters (such as `open: all` and `probability: >0`; despite its value, `probability: >0` is Salesforce's "All" and keeps Closed Lost and other 0 percent deals). **Always check `filters` against what the user asked**, and say the ones that change the meaning. If a default is wrong for the question, override it for this run, for example with `dateFilter`. A standard filter cannot be removed, only given another value by name, for example `reportMetadata: {standardFilters: [{name: "open", value: "closed"}]}`; one left out keeps its saved value, and an empty list is ignored (`notes` say so). `probability` has no value wider than `>0`, and none is needed.
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

## Loader for a Claude Dashboard

On the local door a dashboard to keep is built from attached result files. It is a copy as of the run (decision [0022](../../docs/decisions/0022-dashboard-from-attached-result-files.md)). Seen to work on 2026-11-11, not documented behaviour: JSON file datasets, one per report, each read by the loader below.

**Make the files.** `npx -y salesforce-reports-mcp dashboard-files --org <alias> --defs <file.json> --out <dir>` runs report definitions read-only and writes one `ReportResult` file per definition. It is the subcommand of the installed server, so it needs no clone. Inside a clone of the repo, use `npm run dashboard-files -- --org <alias> --defs <file.json> --out <dir>` after `npm run build`. The defs file is a JSON object that maps a short id (letters, digits, dash and underscore) to `query_report` arguments, the definition fields at the top level. Give each definition its `dateFilter`, as for any `query_report`. [dashboard-defs.example.json](dashboard-defs.example.json) is a working example: open pipeline by stage and by owner over every close date. It prints `<id>: rows=<n> truncated=<bool>` for each file, or `<id>: failed`, and ends with `dashboard-files: written=<n> failed=<m>`. Exit codes: 0 when every report was written, 1 when any failed or the server could not be reached, 2 for a usage error. A single result already in the chat can be attached the same way, as a file.

**Reshape each file.** The loader turns a `ReportResult` into plain rows:

1. `groups.dimensions` and `groups.measures` are lists of objects. Their `name` values, dimensions first and then measures, name the cells of each row in `groups.rows`, in order. Zip each row with those names into one object per row, and use each `label` as the column heading.
2. `totals.measures` and `totals.values` are two lists of the same length. Zip them into one more row, labelled "Total".
3. A flat report has no `groups`: zip each row of `detail.rows` with the `name` of each entry in `detail.columns` instead, and say when `detail.truncated` is true.
4. `filters` stay words. The report's own filters are shown as a caption or filter note, never as controls that would change the run. A page-side control may filter only rows already in the files, and never over a dataset whose `cut` is true, because its totals would be wrong.
5. Carry `notes` and `report.url` through: show any note about cut rows, and keep the link to the report.

The tested source is [dashboard-loader.js](dashboard-loader.js) in this folder. It is one function, `reportResultToRows({ answer })`, that runs alone. It returns `{columns, rows, cut, meta}` and throws the server's own words when the answer is an error. Do not rewrite it by hand. Paste it whole inside a wrapper and register the wrapper as each dataset's loader. The dashboard reads rows from `data`, so the wrapper returns them there:

```
function loadReport({ answer }) {
  /* dashboard-loader.js pasted whole here */
  var r = reportResultToRows({ answer: answer });
  return { data: r.rows, columns: r.columns, cut: r.cut, meta: r.meta };
}
```

Beyond the wrapper, follow the Dashboard type's own instructions.

**Say it is a copy.** The page states that it is a copy and gives the date of the runs. To bring it up to date, run the reports again and attach the new files. A dashboard page cannot reach the local server, so it cannot re-run a report. Ask for design changes through the dashboard's comments to Claude.

**Where `run_report` comes from a connector**, a live dataset is possible. Its source is a live call with nothing saved, and its `args` are the `query_report` input itself, the definition fields at the top level. This was not run from claude.ai and is untested.

```
{kind: 'call', connector, tool: 'query_report', args: {reportType, columns, groupingsDown, aggregates, filters, ...}}
```

Keep the run's input in the dashboard (the `reportId` and any `overrides`) so each refresh asks the same question. Check the shape of a real result before writing the loader.

## Limits

- At most 2,000 detail rows and 100 columns per run, and 500 synchronous runs per org per hour. Prefer one grouped query over many small ones.
- Joined-format reports are not supported.
- Everything runs as the connected user: Salesforce sharing and field-level security still apply, so a number can differ from a colleague's.
