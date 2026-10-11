# Changelog

## 0.1.0

First release.

- Twelve tools over the Salesforce Reports and Dashboards REST API: `search_reports`, `list_report_folders`, `list_report_types`, `describe_report_type`, `describe_report`, `run_report`, `query_report`, `combine_reports`, `create_report`, `update_report`, `clone_report` and `delete_report`.
- One result shape for every run (`ReportResult`): filters in words, a tidy group table, grand totals, optional detail rows, and notes that say when rows were cut.
- `combine_reports` stacks or joins 2 to 5 runs, for period comparisons and side-by-side measures.
- Authentication through the Salesforce CLI (`--org`) or an access token you already hold (`SF_INSTANCE_URL`, `SF_ACCESS_TOKEN`).
- Safety flags: `--read-only` registers no write tools; `delete_report` exists only with `--allow-delete`; new reports are saved to Private Reports.
- A Claude skill, `skills/salesforce-reports`, that teaches the workflow.
- Live-verified against a Developer Edition org (API v62.0): aggregate prefixes, date-granularity values, and three Salesforce rules about detail columns are recorded in `docs/design.md`.
