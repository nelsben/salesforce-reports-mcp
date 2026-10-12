# 0008. Result limits: a row cap from the heap, and notes that say so

Status: Accepted, 2026-10-11

## Context

Salesforce returns at most 2,000 detail rows from a report run. Synchronous Apex has a 6 MB heap and 10 seconds of CPU. A 2,000-row, 100-column result was estimated at about 20 MB in Apex (phase 0). A model reading a result also does worse with thousands of rows than with a clean group table.

## Decision

- Results are compact: groups, totals, and detail rows only when asked for, never the raw `factMap`.
- The default is 200 detail rows. The ceiling is 2,000 locally and `min(2000, floor(50000 / columns))` in the org, which keeps a result near 50,000 cells.
- `ReportsCallout` checks the response size against the remaining heap before it parses. A result too large answers `RESULT_TOO_LARGE` instead of failing the transaction.
- Every cut is said in the result's `notes`, with the reason.

## Consequences

- A user is never handed partial numbers without being told.
- Very wide detail reports return fewer rows in the org than locally. The note says so, and the local server remains the path for bulk detail.
- CPU, not heap, turned out to be the binding limit on large runs (phase 1), so the cap is conservative.

## Alternatives

- **Asynchronous runs in the org.** Possible later through `runAsyncReport`; not needed for interactive use.
