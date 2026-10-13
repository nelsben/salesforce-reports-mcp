# Rehearsal: the runner over the hosted MCP door

Unlike the other rehearsals, these runs were interactive: a person in claude.ai, with the hosted server `SalesforceReports` added as a custom connector and signed in to `dev-frontend-2` through the External Client App `SalesforceReportsMcp` (`mcp_api`, `refresh_token`). The `report-runner` skill was uploaded to claude.ai. No local server ran. Every call went to `/services/apexrest/reports/v1/mcp/<tool>` through the API Catalog registration. Dated 2026-10-12.

## Run 1: no opportunity report yet

Prompt: "What reports do I have about opportunities? Run the first one."

Tool calls: `search_reports` for "opportunit", then "opp". Both empty.

Final answer: it said there were no saved opportunity reports, listed the org's six sample Flow and Orchestration reports, and ran none of them. It offered to build one, noting that `query_report` and `create_report` could not run on the hosted server (at that point the hosted route answered `CALLOUT_SESSION`).

What it showed: the hosted read tools work and the refusal is understood. The org simply held no opportunity report, since the live checks delete every report they make.

## Run 2: a saved report

A fixture, "Opportunities by Stage" (summary, grouped by stage, sum of amount), was made through the REST door's `create_report`. The same prompt then:

Tool calls: `search_reports`, `run_report`.

Final answer: a by-stage table, 8 opportunities across 6 stages, 3,091,000 in total, with Negotiation/Review holding 3 deals and about 39 percent of the value. It named the report's default filters (close date this fiscal quarter, probability above 0, whole organization) and that the Prospecting deal has no amount. The fixture was deleted afterwards.

What it showed: find and run match the local runner and the REST door on the same data.

## Run 3: the callout tools, with `callout-app` installed

After `salesforce/callout-app` was installed and `Salesforce_Reports_Callout` assigned ([decision 0012](../decisions/0012-per-user-jwt-named-credential.md)), in a new chat:

Prompt: "List the report types I can build on, then build me an opportunity report grouped by stage without saving it."

Tool calls: `list_report_types` (the first 100 of 156), `query_report` with an Opportunity summary grouped by stage.

Final answer: the report types by category, then the same 8 opportunities across 6 stages and 3,091,000, with an average amount column, the same default filters named, and "Nothing was saved". It offered to widen the close date, add columns, or save the report.

What it showed: on the hosted door, the callout tools run as the signed-in user through the per-user named credential, with no session and no click. Before the package, the same `list_report_types` answered `CALLOUT_SESSION`; before the route fix, `APEX_ERROR` ([decision 0007](../decisions/0007-callout-identity-under-hosted-mcp.md)).

## Also found

- A call with no arguments answered `INVALID_INPUT` in run 1's session, before a retry with an argument worked. The hosted server most likely posts a JSON `null` body for it. The door now reads `null` as no input.
- When the report tools could not answer, the claude.ai model offered to query opportunities "through the Salesforce connector", meaning a different connector to a different org. Keep only this server's connector on when rehearsing.
