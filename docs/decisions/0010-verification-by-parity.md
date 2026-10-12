# 0010. Verification by parity between doors, against a real org

Status: Accepted, 2026-10-11

## Context

Two implementations of one contract ([0001](0001-one-contract-three-doors.md)) drift unless something compares them. Mocked tests cannot catch Salesforce's own surprises, such as silent default filters on Opportunity reports or a date granularity quietly turned into `None`.

## Decision

Four layers of checks:

| Check | What it proves | Runs |
| --- | --- | --- |
| Unit and server tests, against anonymised fixtures captured from a real org | the TypeScript mapping and shaping | every push, in CI |
| Apex tests with `HttpCalloutMock` | the Apex paths, including a user without the save permission | on deploy, package classes only |
| `npm run parity` | the local server and the REST door give the same JSON for the same input, case by case, after normalising fields that must differ (ids, URLs, timestamps) | by hand, against a dev org |
| `npm run live` | every tool works end to end on either door and leaves no report behind | by hand, against a dev org |

A refactor in the org is accepted only when parity and the live check pass unchanged.

## Consequences

- Behaviour that moves shows up as a named parity case, not a user report.
- The org checks need a real org and run by hand; CI stays fast and needs no secrets.
- Salesforce quirks found by the live check go into design.md's live findings, so the next person does not rediscover them.
