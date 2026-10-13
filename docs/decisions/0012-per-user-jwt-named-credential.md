# 0012. The hosted door calls out through a per-user JWT named credential, in an optional package

Status: Accepted, 2026-10-12. Proposed the same day and settled by a call through the hosted server in claude.ai; see "Result". Follows [0007](0007-callout-identity-under-hosted-mcp.md).

## Context

Under a hosted MCP sign-in, `UserInfo.getSessionId()` throws an exception no `catch` stops ([0007](0007-callout-identity-under-hosted-mcp.md)). So on the hosted route the callout tools answer `CALLOUT_SESSION`: `list_report_types`, `query_report`, `combine_reports` with definitions and the three saves. `describe_report_type` falls back to a saved report of the type.

Probe 3c ([docs/probes/v0.2-phase3c.md](../probes/v0.2-phase3c.md)) showed that a named credential with an OAuth JWT bearer external credential and a per-user principal lets Apex call the org's own REST API as the running user. The org mints the token from its own token endpoint, from the user's username and a certificate it made itself. No session is asked for, no secret is read, and no user clicks anything.

## Decision

`ReportsCallout` gets a third identity, `NAMED_CREDENTIAL`, and the hosted route sets it.

| Case on the hosted route | Answer |
| --- | --- |
| The named credential `SalesforceReportsCallout` is installed and the user has `Salesforce_Reports_Callout` | The call goes to `callout:SalesforceReportsCallout` plus the path, with no `Authorization` header of its own. `UserInfo.getSessionId()` is never called. |
| It is not installed | `CALLOUT_SESSION`, exactly as before. No request is built. |
| It is installed, but the user cannot use it | `CALLOUT_CREDENTIAL`, with a hint naming the permission set `Salesforce_Reports_Callout` to assign. A failed token exchange or a refused token also answers `CALLOUT_CREDENTIAL`, with Salesforce's text and a hint to run the setup again. |

The REST route is unchanged: it keeps the caller's session.

The credential ships as a third, optional package directory, `salesforce/callout-app`, beside `mcp-app`. It holds no Apex: the certificate, the External Client App `SalesforceReportsCallout` with its OAuth settings and policies, the external credential, the named credential and the permission set. `force-app` never depends on it. `ReportsCallout` names the credential only in strings and reads whether it exists with a query on `NamedCredential`, so `force-app` deploys and runs the same with or without it.

The tracked files hold placeholders only. `salesforce/scripts/callout-setup.ts` deploys the certificate (the org makes the key pair), reads back its public part, deploys the app, reads the app's consumer key, fills My Domain and the key into a temp copy, and deploys the rest. It refuses an org that is not on `SF_REPORTS_SETUP_ORGS`, as the other setup scripts do.

The probe's quirks are kept: the app's scopes are `Api` and `RefreshToken`, `iss` and `sub` are written without quotes, and `aud` is quoted.

## Consequences

- The hosted door can run every tool but `delete_report`, as the signed-in user, with that user's sharing and field security.
- An admin runs one script per org and assigns one more permission set per user. No user clicks anything.
- The certificate expires a year after it is made. Renewing it means a new certificate and the app's `certificate` updated with it. Not yet scripted: the setup keeps a certificate that is already in the org.
- The External Client App `SalesforceReportsCallout` carries the `Api` scope. Its tokens are minted only by the org itself, for users the permission set pre-authorizes, and they never leave the org. The connector's own app, `SalesforceReportsMcp`, keeps `mcp_api` and `refresh_token` only.
- Each callout may mint a token. A tool makes at most a few calls, so this is inferred to be cheap (phase 3c).
- The credential mints its token from the running user's username, so it does not depend on how the user signed in. The result below bears this out.

## Result

Settled 2026-10-12 in claude.ai, through the hosted server, signed in to `dev-frontend-2` through the connector's External Client App (`mcp_api`, `refresh_token`), with `callout-app` installed and `Salesforce_Reports_Callout` assigned. In a new chat:

- `list_report_types` answered with the org's 156 report types, where it had answered `CALLOUT_SESSION` before.
- `query_report` ran an unsaved Opportunity summary grouped by stage: 8 opportunities across 6 stages, 3,091,000 in total. That is the same figure the saved report gave through `run_report` on the hosted door, and through the REST door. Nothing was saved.

[Rehearsal: the runner over the hosted door](../rehearsals/runner-hosted.md) has both runs.

## Alternatives

- **The `api` scope on the connector's External Client App.** It widens the token claude.ai holds to the whole REST API as the user. And it is not known to stop `UserInfo.getSessionId()` from throwing, since the throw is about the hosted sign-in, not the scope.
- **A per-user principal with the browser flow (authorization code).** Each user must authorise once in My Settings, and the app needs a consumer secret pasted into the credential. The JWT flow needs neither.
- **A named principal.** Every call would run as one integration user, so users would see that user's data. Ruled out in [0007](0007-callout-identity-under-hosted-mcp.md).
- **Folding the principal access into `Salesforce_Reports`.** One assignment fewer, but `force-app` would then name a component in `callout-app` and could not deploy without it.
- **Always answering the credential error on the hosted route.** An org without the package would then see a setup error instead of the plain `CALLOUT_SESSION` and its list of tools that still work.
