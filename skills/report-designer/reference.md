# Report designer reference

## Definition grammar

1. `list_report_types` with a search word finds the `reportType` (for example `Opportunity`).
2. `describe_report_type` with a `search` word finds the column API names (`AMOUNT`, `STAGE_NAME`, `CLOSE_DATE`). Names are upper-case and often differ from the field label.
3. Build the definition:
   - A flat list: `columns`, no groupings.
   - Totals by something: `groupingsDown` plus `aggregates`. Example: `groupingsDown: [{column: "STAGE_NAME"}]`, `aggregates: ["RowCount", {fn: "sum", column: "AMOUNT"}]`. `fn` is `sum`, `avg`, `min`, `max` or `unique`.
   - A cross-tab: add `groupingsAcross`.
   - By month or quarter: group on the date column with `dateGranularity` (`Month`, `Quarter`, `FiscalQuarter`, `Year`...).
   - Ranges: `dateFilter: {column: "CLOSE_DATE", duration: "THIS_FISCAL_QUARTER"}`. Other durations: `LAST_N_DAYS:30`, `THIS_YEAR`, `LAST_QUARTER`, or `startDate` and `endDate`.
   - Row filters: `filters: [{column, operator, value}]`. Operators come from `describe_report_type`. Combine with `filterLogic: "1 AND (2 OR 3)"`.
   - Sort and limit a flat report: `sortBy: [{column, order}]`, `topRows: {rowLimit, direction}`.
   - Whose records: `scope` (`organization`, `user` for my records, `team`).
4. Preview with `query_report` (new) or `run_report` with `overrides` (existing), and check the result before you say it is right.

The server fixes two Salesforce quirks and says so in `notes`: it adds an aggregated column to the detail columns, and drops a grouped column from them. A grouped report also needs at least one ungrouped detail column; if you give none, the server adds one from the type's defaults.

## Changing a saved report

- **A list you send replaces the saved list** (filters, columns, groupings, aggregates). Include the entries you want to keep. Fields you leave out stay as saved.
- `create_report` with `fromReportId` copies the saved report, applies your fields, and saves the copy. Adding a grouping to a flat report turns the copy into a summary report, and a grouped column leaves the detail columns. `reportType` is not needed.
- `update_report` returns one line per field that changed. Read them back to the user.

## Reading a preview

- Check `filters` in the preview result against what the user asked. Salesforce adds a default date filter and standard filters (for Opportunity, `probability: >0`, which hides Closed Lost) that the user did not set.
- Read `notes`. Rows cut at the cap mean the preview is partial.

## What the REST API can and cannot set

Checked live, 2026-10-11.

- **Can set** (pass them in `reportMetadata`, the raw escape hatch, when the definition fields do not cover them):
  - Row-level formula columns. `customDetailFormula: {"CDF1": {label, formula, formulaType: "number", decimalPlaces}}`, and put `"CDF1"` in the detail columns. Use the lowercase `formulaType` `number`; the formula refers to columns by API name, for example `AMOUNT*1`. A formula whose result type does not match its `formulaType` is rejected. `Currency`, `Number` (capitalised) and `percent` were rejected.
  - Cross filters (show deals with or without a related record). `crossFilters: [{criteria: [], includesObject: true, primaryEntityField: "OPPORTUNITY_ID", relatedEntity: "OpportunityCompetitor", relatedEntityJoinField: "OpportunityId"}]`. The entity names come from the `objectRelationships` of `describe_report_type` (not shown by the tool today; if a name is rejected, say so and point to Report Builder). `includesObject: false` is "without".
  - Bucket fields. `buckets: [{bucketType: "picklist", developerName: "BucketField_1", label, sourceColumnName: "STAGE_NAME", values: [{label: "Early", sourceDimensionValues: ["Prospecting", "Qualification"]}]}]`, then add `"BucketField_1"` to the detail columns. A numeric bucket uses `bucketType: "number"` and `values: [{label, rangeUpperBound: 1000}, {label, rangeUpperBound: null}]`; the last upper bound must be null. A picklist bucket must have at least one value. The names `devName`, `useOther` and `nullTreatment` from older docs are rejected.
  - The folder (`folderId`), charts, custom summary formulas and historical trending (untested here).
- **Cannot set:** conditional highlighting, joined-report blocks (Report Builder or the Metadata API only).
- **Cannot rename a standard column header.** There is no field for it: an unknown key is rejected. A row-level formula column can carry any label, and the original column can then be dropped from the detail columns. A summary total of the formula column works too: `{fn: "sum", column: "CDF1"}` gives "Sum of Deal value" (verified in a rehearsal). Only offer this when the user wants it; say the label is on a formula column.

## Folders

- No `folderId`: the report lands in the user's Private Reports.
- `list_report_folders` shows folders the user can see, plus the org-wide "Public Reports" folder, whose id is the org id (starts `00D`). `describe_report` shows a report's `folder` as `{id, name, developerName, isPrivate}`.
- A report in Private Reports can only be seen by its owner and cannot be moved between orgs until it is in a shared folder.
