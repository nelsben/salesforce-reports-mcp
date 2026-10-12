# 0007. The callout's identity under a hosted MCP sign-in

Status: Proposed, 2026-10-11. Settled by one signed-in call; see "How it is settled".

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
