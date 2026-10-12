---
name: report-designer
description: Change a Salesforce report or build a new one, preview it on real data, and save it. Use when the user says "add a column", "group it by owner", "start from my pipeline report and...", "build me a report of...", "make this a report", "save that", "rename the report", or wants a report kept or shared in a folder. Covers saving as a new report or over the original. For just reading a report's numbers, use report-runner. For moving a saved report to another org or into git, use report-deploy.
---

# Designing and saving Salesforce reports

You are helping someone get a report they can keep, without learning what a report type or an API name is. Work in their words, show a preview on real data, change it until they like it, and save in one step. If the write tools (`create_report`, `update_report`) are missing, the server is read-only: say so and give the definition instead.

The tools named below may come from any door: the local MCP server, the hosted MCP server in the org, or the in-org REST door through the `sf` CLI. They take the same input and return the same result on each. If no tool named `search_reports` is connected, read [transport.md](transport.md) before the first call: it says how to pick the door, which org to use, and how to call each tool.

## The steps

1. **Start point.**
   - An existing report: `search_reports`, then `describe_report`.
   - Nothing close: `list_report_types` and `describe_report_type`, searching on the user's words. Pick fields by their labels and take the API names from the result. Never guess names.
2. **Draft in words before any call.** Write a short spec in the user's labels: what each row is, the columns, the groupings, the filters, the date range, the sort. Ask only about what is ambiguous.
3. **Preview on real data.** For an existing report, `run_report` with `overrides`. For a new one, `query_report`. Show 5 to 10 rows or groups. Change the spec and preview again until the user is happy. Nothing is saved yet.
4. **Ask which kind of save, then save in one step.**
   - **New report:** `create_report`. Starting from an existing report, pass `fromReportId` with only the fields to change; the saved report is copied and the changes applied in one call. With no `folderId` it lands in Private Reports, visible only to the user. Offer `list_report_folders` when they want it shared.
   - **Over the original:** `update_report`. Only when the user asks for it by name and can edit it. Restate what will change first.
   - Never save as a side effect of a question.
5. **After saving,** give the link from the result. Name anything the API could not set and point to Report Builder for it (see `reference.md`).

## Things people ask for that need a straight answer

- **Rename a column header.** As far as we know Salesforce has no way to rename a standard column header, in the API or elsewhere. Say so once, then offer the one thing that works: a row-level formula column that carries the label they want, with the original column left out of the detail columns. Pass it in `reportMetadata` and use the lowercase type `number`:
  `reportMetadata: {customDetailFormula: {"CDF1": {label: "Deal value", formulaType: "number", decimalPlaces: 2, formula: "AMOUNT"}}}`, then put `"CDF1"` in `columns`. The formula uses column API names, and `Currency` or `Number` (capitalised) are rejected. To total it, aggregate the formula column: `{fn: "sum", column: "CDF1"}` gives "Sum of Deal value". Do not send them to Report Builder for this.
- **Conditional highlighting, joined-report blocks.** The API cannot set these. Say so and link to Report Builder.
- **Share it with the team.** Move it to a shared folder: `list_report_folders`, then `create_report` or `update_report` with `folderId`.

## When something fails

A failed call returns an error with a code and a hint (`isError` on MCP, an `error` body on the REST door). Fix the input from the hint (usually a column name) and try once more. Do not retry blindly.

## When the org refuses

A refusal is not a bad input. Never retry it.

- **`WRITE_NOT_ALLOWED` on a save.** Nothing was saved, and nothing else will be. Say the user needs the permission set `Salesforce_Reports_MCP_Write`, which a Salesforce admin assigns. Then give them the finished definition (the JSON you sent, name included), so the admin or the user can save it once the permission is in. Do not try `update_report` or `clone_report` instead.
- **`CALLOUT_SESSION`.** The door cannot call the org's own REST API under this sign-in. Previews of unsaved reports (`query_report`) and every save need an admin fix first: the two options are in `docs/probes/v0.2-phase3.md` in the repository, section "Two fixes to try". Previews of a saved report with `run_report` and `overrides` still work, so keep designing that way, and give the finished definition at the end instead of saving.

## Details

[transport.md](transport.md) has the doors and the REST call form. `reference.md` has the definition grammar, what the REST API can and cannot set (formula columns, bucket fields, cross filters, the folder), and how to read a preview.
