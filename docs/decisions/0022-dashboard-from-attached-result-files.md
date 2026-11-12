# 0022. On the local door, a view to keep is a Claude Dashboard built from attached result files

Status: Accepted, 2026-11-11

## Context

[Decision 0021](0021-claude-dashboards-as-the-shareable-view.md) made a connector-bound live dashboard the default for a view to keep or share, and turned a fixed copy down because it "goes stale at once and looks live". That path needs door 4 ([decision 0020](0020-door-four-the-local-server-over-http.md)): an HTTPS tunnel, a custom connector and a passcode, for one view.

On 2026-11-10 and 2026-11-11 a shorter path was seen to work on the local stdio door. A report was run with `query_report` and nothing was saved. The `ReportResult` files were attached to a Claude Dashboard as JSON file datasets, one dataset per report. The dashboard drew four datasets through the tested loader in `skills/report-runner/dashboard-loader.js`. No tunnel and no connector were involved. These are observations from those days, not documented behaviour. The details are in [design.md](../design.md#claude-dashboard-findings-observed-2026-11-11).

A connector-bound live dashboard and a claude.ai connector through a tunnel were not run. Door 4 has passed only on loopback through `npm run door4-check`.

## Decision

- On the local door, the default way to keep or share a view is a Claude Dashboard built from attached result files of report runs. It is a copy as of the run.
- The report card stays the live view in chat ([decision 0013](0013-report-view-as-an-mcp-app.md)).
- A connector-bound live dashboard ([decision 0021](0021-claude-dashboards-as-the-shareable-view.md)) stays possible where `run_report` comes from a connector. It is untested from claude.ai.
- This answers 0021's objection to a fixed copy in two ways. Every such dashboard must say on the page that it is a copy and give the date of the runs. It is brought up to date by running the reports again.
- The report-runner skill offers it only when the person wants a view to keep, share or open again, builds it only after their yes, and never offers it unasked.

## Consequences

- Nothing in `src/` changes. The contract stays one `ReportResult` ([decision 0001](0001-one-contract-three-doors.md)).
- `npm run dashboard-files` makes one result file per report definition. A single result already in the chat can be attached the same way.
- A page-side filter acts only on rows already in the files, so it redraws at once and runs nothing. It is never offered over a dataset whose `cut` is true, because its totals would be wrong.
- A change to a report's own filters is a new run, then new files.
- The dashboard holds a copy of the data. Share it with care: everyone who can open it sees the figures, whatever their Salesforce access.
- Design changes are asked for through the dashboard's comments to Claude. A dashboard page cannot reach the local server, so it cannot re-run a report itself.
- If the Dashboard type changes how it reads datasets, only the wrapper in the skill's `reference.md` moves.

## Alternatives turned down

- **A tunnel plus a connector as the default.** It is an install, a public address and a passcode for one view. It stays as the way to a live dashboard.
- **A custom request queue on the dashboard page.** A page script has no way to reach Claude or the local server. Comments already do that.
- **A new tool that publishes dashboards.** Publishing is the host's job, and a tool would add a write the server does not otherwise have.
- **Saving a Salesforce dashboard.** [Decision 0016](0016-dashboards-read-and-refresh-only.md) keeps dashboards read and refreshed only.
