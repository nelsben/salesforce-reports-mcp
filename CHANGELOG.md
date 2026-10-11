# Changelog

## Unreleased

- v0.2 phase 2, the in-org MCP door: `salesforce/` adds the API Catalog entry `ReportsApi` (one operation per tool, schemas generated from the local server by `npm run mcp:generate`), the hosted MCP server `SalesforceReports` with the six read tools, a permission set, `npm run mcp:setup` and `mcp:teardown`, an External Client App for sign-in, and `npm run mcp-check`. The README's "In the org" section has the admin steps.
- v0.2 phase 1, the in-org REST door: `salesforce/` holds `ReportsApi`, an Apex REST class at `/services/apexrest/reports/v1/<tool>` for search_reports, list_report_folders, describe_report, describe_report_type, run_report and combine_reports, with the local server's inputs and results. `npm run parity` checks both doors give the same JSON, and `npm run live -- --door apex` runs the read steps through it.
- The Salesforce CLI now starts on Windows: `sf.cmd` runs through a shell with the org alias checked first, and a failure to start the CLI says how to fix it.
- Three skills replace `skills/salesforce-reports`: `report-runner` (explore and answer, never saves), `report-designer` (change or make a report, preview, save) and `report-deploy` (move a saved report between orgs or into git with the Salesforce CLI).
- A Claude Code plugin: `.claude-plugin/plugin.json` and `marketplace.json`, bundling the skills and the server through `npx -y github:nelsben/salesforce-reports-mcp`, with no org baked in.
- `create_report` takes `fromReportId`: copy a saved report, apply the changes given, and save as new.
- `describe_report` returns `developerName` and the folder as `{id, name, developerName, isPrivate}`.
- `list_report_folders` includes the org-wide Public Reports folder (`unfiled$public`; its id is the org id).
- `docs/experiences.md` records three live probes: standard column headers cannot be renamed through the REST API but a row-level formula column can carry a label; the Metadata API cannot retrieve a report in Private Reports; bucket fields and cross filters are accepted with the shapes listed there.
- `docs/rehearsals/` holds headless runs of each skill.

## 0.1.0

First release.

- Twelve tools over the Salesforce Reports and Dashboards REST API: `search_reports`, `list_report_folders`, `list_report_types`, `describe_report_type`, `describe_report`, `run_report`, `query_report`, `combine_reports`, `create_report`, `update_report`, `clone_report` and `delete_report`.
- One result shape for every run (`ReportResult`): filters in words, a tidy group table, grand totals, optional detail rows, and notes that say when rows were cut.
- `combine_reports` stacks or joins 2 to 5 runs, for period comparisons and side-by-side measures.
- Authentication through the Salesforce CLI (`--org`) or an access token you already hold (`SF_INSTANCE_URL`, `SF_ACCESS_TOKEN`).
- Safety flags: `--read-only` registers no write tools; `delete_report` exists only with `--allow-delete`; new reports are saved to Private Reports.
- A Claude skill, `skills/salesforce-reports`, that teaches the workflow.
- Live-verified against a Developer Edition org (API v62.0): aggregate prefixes, date-granularity values, and three Salesforce rules about detail columns are recorded in `docs/design.md`.
