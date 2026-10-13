# Reference

The tools, what a result holds, the safety rails and the limits. The full contract is [design.md](design.md).

## Tools

| Tool | Writes | What it does |
| --- | --- | --- |
| `search_reports` | no | Find saved reports by name, folder or format. Returns ids and links. |
| `list_report_folders` | no | List the report folders you can see, including the org-wide Public Reports folder. |
| `list_report_types` | no | List the report types in the org, optionally filtered. |
| `describe_report_type` | no | List a type's fields by section, with the API names, date filters, granularities and filter operators. |
| `describe_report` | no | Summarize one saved report: columns, groupings, aggregates, filters in words, plus `developerName` and the folder as `{id, name, developerName, isPrivate}`. |
| `run_report` | no | Run a saved report. Optional `overrides` change that run only. |
| `query_report` | no | Define a report in the call and run it. Nothing is saved. |
| `combine_reports` | no | Run 2 to 5 reports and stack them (compare periods) or join them (side-by-side measures). |
| `create_report` | yes | Save a new report, from a definition or from a saved report (`fromReportId` plus the changes). It lands in Private Reports unless you give a folder. |
| `update_report` | yes | Change a saved report. Send only the fields to change. |
| `clone_report` | yes | Copy a saved report. |
| `delete_report` | yes | Delete a report (Recycle Bin). Registered only with `--allow-delete`. |

Every run returns the same shape: the filters that were applied (including Salesforce's defaults), a table of groups with their measures, grand totals, optional detail rows, and notes that say when anything was cut.

## Safety

- MCP clients ask you before a tool call, and the skills tell Claude to save, change or delete only when you ask.
- `--read-only` registers no write tools at all.
- `delete_report` does not exist unless you start the server with `--allow-delete`. A deleted report goes to the Recycle Bin.
- A new report with no folder goes to the user's **Private Reports** folder. Only that user can see it until they move it.
- The server never prints, logs or returns an access token, and calls the Salesforce CLI with an argument list and no shell. On Windows, `sf.cmd` needs a shell, so there the org alias is checked against a short list of safe characters first.

## Limits

- Salesforce returns at most **2,000 detail rows** per run. When it stops there, the result says so in `notes`.
- A report takes at most **100 columns**.
- Salesforce allows **500 synchronous report runs per org per hour**. The server runs the inputs of `combine_reports` one at a time.
- **Joined reports are not supported.** Tabular, summary and matrix are.
- Salesforce applies default filters to some report types (for Opportunity, the current fiscal quarter and probability above 0). They are listed in the result's `filters`, so check them against the question.

## Why the local server uses the REST API, and not Apex

Apex has `Reports.ReportManager`, which can describe a report and run it, even with changed filters and groupings. It cannot save a report. The Reports and Dashboards REST API can do all of it: run a report defined in the request with no saved report behind it, then create, update, clone and delete. So this server uses the REST API for everything, and it needs nothing deployed to your org. Saving a report needs no deploy. The Metadata API is only for moving a report between orgs or into source control, which is what report-deploy does.
