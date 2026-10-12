# 0004. `Reports.ReportManager` first, a callout to the org's own REST API for the rest

Status: Accepted, 2026-10-11

## Context

Apex has `Reports.ReportManager`, which describes and runs saved reports, with changed filters, groupings and columns. It cannot run a report that is not saved, list report types, describe a type with no saved report, or save anything. The Reports and Dashboards REST API can do all of that.

## Decision

- Search, folders, describe and run use Apex alone: SOQL on `Report` and `Folder`, and `ReportManager`.
- Unsaved runs (`query_report`), report types and saves go through `ReportsCallout`, one helper that calls the org's own REST API at `URL.getOrgDomainUrl()` with the running user's session.
- A refused session answers `CALLOUT_SESSION`. Where a callout-free path exists, the tool uses it: `describe_report_type` falls back to reading the type through a saved report of it.

## Consequences

- No Remote Site Setting and no Named Credential are needed under a normal user session (phase 0, probe 3).
- Every call still runs as the user, so sharing and field security hold.
- The read tools that matter most to a seller (find and run a saved report) keep working even when callouts are refused.
- Whether the session works under a hosted MCP sign-in is open: [0007](0007-callout-identity-under-hosted-mcp.md).
- Each callout costs time inside the transaction limit (120 seconds, 100 callouts). A tool makes at most a few.

## Alternatives

- **Callouts for everything.** Rejected: more limits spent, and saved-report runs would fail whenever the session is refused.
- **Metadata API for saves.** Rejected: it cannot even retrieve a report in Private Reports, where new reports land, and it is built for deployments, not interactive edits.
