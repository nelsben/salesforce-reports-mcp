# 0021. Claude Dashboards are the shareable view, built on run_report from a connector

Status: Accepted, 2026-10-19

## Context

The report card and the dashboard card are live views inside one chat, in hosts that draw MCP Apps ([decision 0013](0013-report-view-as-an-mcp-app.md), [decision 0017](0017-dashboard-card.md)). They are not something to keep, share or open tomorrow.

Claude's Dashboard artifact type is. It binds live data only to a tool of a claude.ai connector, and it draws a `ReportResult` well once a small loader reshapes it into rows. This was tested on 2026-10-19 with a fixed copy of a result. Door four ([decision 0020](0020-door-four-the-local-server-over-http.md)) gives the local server a connector.

## Decision

- Lasting and shareable views go to Claude's Dashboard artifact type, with `run_report` on a connector as the live query. This repo adds no new card, no new tool and no publishing code for it.
- The report-runner skill offers it, only where the host offers Claude's Dashboard artifacts and `run_report` comes from a connector. It offers when the person wants a view to keep or share, never unasked. The loader recipe is in the skill's `reference.md`.
- On the local door (stdio) the artifact cannot bind to a tool. The most it can hold is a fixed copy of one result, and the skill says so rather than implying it is live.
- The SLDS cards stay the live view in Claude Desktop ([decision 0018](0018-cards-follow-the-lightning-design-system.md)).

## Consequences

- Nothing in `src/` changes. The contract stays one `ReportResult` ([decision 0001](0001-one-contract-three-doors.md)), and the loader lives in a skill file.
- A live dashboard needs a connector: door four, or the in-org hosted door. A person with neither gets a fixed copy or the card.
- The artifact runs as whoever the connector signs in as. On door four that is the owner's Salesforce user for every viewer who can use the connector, so share the artifact with care.
- If the artifact type changes how it binds data, only the skill's recipe moves.

## Alternatives turned down

- **A third card for the shareable case.** Cards live inside a chat turn and cannot be opened later or shared.
- **A new tool that publishes a dashboard artifact.** Publishing is the host's job, and a tool would add a write the server does not otherwise have.
- **Saving a Salesforce dashboard.** Decision 0016 keeps dashboards read and refreshed only.
- **A fixed copy as the default.** It goes stale at once and looks live.
