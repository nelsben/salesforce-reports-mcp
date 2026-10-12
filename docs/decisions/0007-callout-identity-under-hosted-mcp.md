# 0007. The callout's identity under a hosted MCP sign-in

Status: Accepted, 2026-10-12. Proposed 2026-10-11 and settled by one signed-in call; see "Result".

## Context

Under the hosted MCP door, the user signs in through an External Client App with the scopes `mcp_api` and `refresh_token`. `ReportsCallout` reuses the running user's session to call the org's own REST API ([0004](0004-reportmanager-first-callout-for-the-rest.md)). A session minted for `mcp_api` alone may be refused by the REST API. If it is, `query_report`, `list_report_types`, the full `describe_report_type` and the three saves answer `CALLOUT_SESSION` on that door.

## Options

| Option | Token stays narrow | Runs as the user | Setup | Verdict |
| --- | --- | --- | --- | --- |
| Keep `mcp_api` only | Yes | Yes | none | Default. The callout tools refuse with a remedy; the rest work |
| Add the `api` scope to the External Client App | No: the connector's token can call any REST API as the user | Yes | one setting | Documented opt-in |
| Named Credential with a per-user principal | Yes | Yes | each user authorises once | Documented alternative for orgs that will not widen the token |
| Named Credential with a named principal | Yes | No: everything runs as one integration user | one credential | Rejected |

## Decision (proposed)

Ship with `mcp_api` only. When a callout is refused, the tools answer `CALLOUT_SESSION` and name both remedies. The skills fall back to saved reports and say what the admin can change. The admin chooses between the `api` scope and a per-user Named Credential knowingly, with this page as the trade-off. The scope is set in the `mcp-app` package, in `salesforce/mcp-app/main/default/extlClntAppOauthSettings/SalesforceReportsMcp.ecaOauth-meta.xml`, and reaches the org with a deploy of `mcp-app`.

The named-principal credential is ruled out for good: a reporting tool that runs as an integration user shows every user the integration user's data, which defeats the org's sharing model.

## How it is settled

Connect the hosted server in claude.ai, signed in to a dev org, and call `list_report_types`. A list means the session works and this record becomes "not needed". `CALLOUT_SESSION` means it is refused, and this record becomes Accepted as written.

## Result

Settled 2026-10-12 by a call to `list_report_types` through the hosted server in claude.ai, signed in through the External Client App with `mcp_api` and `refresh_token`. The answer was stronger than the REST API refusing the session. `UserInfo.getSessionId()` itself threw `System.UnexpectedException` ("Script-thrown exception"), and no `catch (Exception e)` stopped it. The client got Salesforce's own `APEX_ERROR`, with class names and line numbers, instead of `CALLOUT_SESSION`, so the skills' fallback never ran.

So the code must know which door called before it asks for a session. The hosted door has its own route, `/services/apexrest/reports/v1/mcp/<tool>`, written into the API Catalog registration by `npm run mcp:generate`. On that route `ReportsApi` tells `ReportsCallout` the call has no session to use, and `ReportsCallout` answers `CALLOUT_SESSION` before it asks for one and before any request. Its hint names the tools that still work on the hosted server: `search_reports`, `list_report_folders`, `describe_report`, `describe_report_type` through a saved report, `run_report` with overrides, and `combine_reports` over saved reports. The REST door keeps `/reports/v1/<tool>` and the caller's session. The core does not know the route.

Whether the `api` scope would change the throw is untested. The per-user Named Credential is the chosen remedy, and it will be recorded in its own decision when it is built.
