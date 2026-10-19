# 0019. The in-org door waits for a dashboard refresh by polling back to back within a budget

Status: Accepted, 2026-10-18

## Context

`refresh_dashboard` reaches the in-org REST door ([0016](0016-dashboards-read-and-refresh-only.md)). A refresh is a `PUT /analytics/dashboards/{id}` that returns at once while the components rerun, so the tool then waits until every component shows new data. The local server pauses 3 seconds between `/status` polls, at most 20 times, so up to 60 seconds.

Apex cannot sleep. A transaction allows 100 callouts and 120 seconds of callout time, CPU time is capped at 10 seconds, and a busy loop spends that CPU time on nothing. The local wait does not port.

On the local server a refresh is a write only by annotation. On the in-org door there is no annotation, so the gate is the `Reports_Write` custom permission the save tools already use ([0005](0005-saves-behind-a-custom-permission.md), [0011](0011-name-permissions-for-the-capability.md)). A refresh spends the org's once-a-minute refresh and changes what every viewer sees.

## Decision

- **Gated like a save.** `refresh_dashboard` is in the same write set as the save tools. Without `Reports_Write` the door answers 403 `WRITE_NOT_ALLOWED` before the input is read or any callout is made. The read tools never check it.
- **Back-to-back polls inside a budget.** The door reads `/status` before the PUT, sends the PUT with the filter on the query string, then polls `/status` with no pause until every component is done. It stops after 20 polls or about 30 seconds of elapsed time, whichever comes first. Both limits are named constants in `ReportsDashboards`. A failed poll counts and is retried.
- **A different note when the budget runs out.** The note says the refresh had not finished when the door stopped waiting, and to call `run_dashboard` in a minute. It does not say how many seconds the door waited, because back-to-back polls take as long as the org takes to answer each.
- **The once-a-minute 403 is the same note as on the local server.** `ReportsCallout` is the only class that reads the status. For a 403 on the refresh PUT with code `FORBIDDEN`, or the word "minute" in the message, it throws the code `REFRESH_LIMIT`, and `ReportsDashboards` turns that into the cached-results note. Every other failure is thrown as before.

## Consequences

- A caller sees a shorter wait than on the local server, and a refresh that finishes later than about 30 seconds shows as the "had not finished" note with the cached results. The next `run_dashboard` reads the finished refresh.
- A refresh costs at most 24 callouts: one status, the PUT, up to 20 polls, a describe when filters are given, and the results GET. That leaves room under the 100-callout limit.
- The poll budget is a trade: a longer one risks the 120-second callout limit and the user's wait, a shorter one shows the note more often. If a real org shows the note on small dashboards, raise `REFRESH_BUDGET_MS` first.
- The hosted door does not list the tool yet. Called there, it passes the write check and then answers `CALLOUT_SESSION`, as the other callout tools do without the credential.
