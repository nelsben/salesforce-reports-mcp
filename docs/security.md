# Security and identity

**Every call runs as the person asking. Claude sees what they can see in Salesforce and nothing more.**

Each door signs in differently, and each is least privilege by default.

| Door | Identity | What it can do |
| --- | --- | --- |
| Local | The user's `sf` CLI session, refetched on expiry; never written anywhere | Whatever the user can do. `--read-only` removes every write tool; `delete_report` exists only with `--allow-delete`. |
| REST | The caller's own Salesforce session | Reads with `Salesforce_Reports`. Saves only with `Salesforce_Reports_Write`, checked in the service, not by hiding tools ([decision 0005](decisions/0005-saves-behind-a-custom-permission.md)). |
| Hosted MCP | OAuth with PKCE through the External Client App `SalesforceReportsMcp`, scopes `mcp_api` and `refresh_token` only | The same permission sets. For the calls that need the org's REST API, a per-user JWT named credential mints a token for the signed-in user. |

Sharing, folder access and field-level security apply on every door, because every call runs as the user.

**The hard part, and how it was solved.** Under a hosted MCP sign-in, Apex has no session, and asking for one throws an exception no `catch` block can stop. The first version leaked a raw platform error to claude.ai. The fix came in two steps, each with a decision record:

1. The hosted door got its own route, so the code knows which door called before it asks for a session, and answers a clear `CALLOUT_SESSION` instead ([decision 0007](decisions/0007-callout-identity-under-hosted-mcp.md)).
2. A probe showed that a [per-user JWT named credential](probes/v0.2-phase3c.md) lets the org mint a token for the running user from a certificate it made itself. No secret is stored, no user clicks anything, and the connector's own app keeps its narrow scopes ([decision 0012](decisions/0012-per-user-jwt-named-credential.md)). `npm run callout:renew` renews the certificate.

No token, consumer key, org address or certificate reaches the repo, logs or error messages. The tracked metadata holds placeholders that setup scripts fill at deploy time, and a test enforces it.
