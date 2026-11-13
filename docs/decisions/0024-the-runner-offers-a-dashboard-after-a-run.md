# 0024. The report runner offers a Claude dashboard after a run

Status: Accepted, 2026-11-12

## Context

[Decision 0022](0022-dashboard-from-attached-result-files.md) made a Claude dashboard built from attached result files the way to keep or share a view on the local door, and told the report-runner skill never to offer one unasked. The README now leads with that path: run a report, then keep the answer as a dashboard. A person who does not know the feature exists never asks for it.

In a rehearsal on Claude Desktop for Windows on 2026-11-12, one request built the dashboard in under four minutes. The same take showed a second problem: Claude's first `query_report` had no date filter, so Salesforce counted only the deals closing this fiscal quarter, and the first card showed that smaller total before Claude noticed and ran again over every date.

## Decision

- After it answers a report run, the runner offers a Claude dashboard once in a conversation, in one short line at the end, and only where Claude can make artifacts.
- It builds the dashboard only after the person's yes. A request for one is the yes.
- Every figure on the page comes from the result files that `dashboard-files` writes. Claude never types a number into the page or a file by hand.
- Every `query_report` carries the `dateFilter` the question means from the first call. A question with no period means every date.
- This replaces 0022's "never offers it unasked". The rest of 0022 stands: the page is a copy as of the run, says so, and gives the run date.

## Consequences

- One more line at the end of the first answer in a conversation.
- `skills/report-runner/dashboard-defs.example.json` is a working defs file, and a test keeps it valid.
- The first card shows the total for the range the question means, not the default quarter.

## Alternatives turned down

- **Keep it on request only.** The feature is the README's main path, and almost nobody asks for what they have not seen.
- **Offer after every run.** It turns every answer into a sales line.
- **Build the dashboard without asking.** It makes an artifact in the person's account that they did not ask for.
