# 0006. No delete in the org

Status: Accepted, 2026-10-11

## Context

Deleting a report is the one action here that a user may not be able to undo themselves: the report leaves its folder, subscriptions and dashboards that used it break, and the Recycle Bin empties on its own schedule.

## Decision

The in-org doors have no `delete_report`. A call to it answers 404 `UNKNOWN_TOOL` with a message that it is on the local server only. The local server offers it only with `--allow-delete`, and marks it destructive so MCP clients ask first.

## Consequences

- An AI client signed in to the org cannot delete a report through these doors, whatever it is told.
- Cleaning up a report Claude made is a click in Salesforce, or the local server.
- The live and parity checks delete their reports through the local server.

## Alternatives

- **Delete behind a second custom permission.** Possible later. Not built until someone needs it, because the safe default is absence.
