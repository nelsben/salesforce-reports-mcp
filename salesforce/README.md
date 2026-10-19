# In-org REST door

Three Salesforce package directories, as [decision 0009](../docs/decisions/0009-two-shipping-units.md) and [decision 0012](../docs/decisions/0012-per-user-jwt-named-credential.md) set out:

| Directory | Holds | Depends on |
| --- | --- | --- |
| `force-app` (default) | the REST door: the Apex classes and tests, the permission sets `Salesforce_Reports` and `Salesforce_Reports_Write`, and the custom permission `Reports_Write` | nothing |
| `mcp-app` | the hosted MCP door: the API Catalog entry `ReportsApi`, the MCP server `SalesforceReports` and the External Client App `SalesforceReportsMcp`. No code. | `force-app` |
| `callout-app` (optional) | the callout identity for the hosted MCP door: the certificate, the External Client App, the external credential and the named credential `SalesforceReportsCallout`, and the permission set `Salesforce_Reports_Callout`. No code. Placeholders only: `npm run callout:setup` fills and deploys it. | nothing to deploy. Without it, the hosted door's callout tools answer `CALLOUT_SESSION` |

Install order: `force-app`, then `mcp-app` for the hosted door, then `callout-app` if hosted users need the callout tools.

The REST door is an Apex REST resource, `ReportsApi`, that answers the runner tools from inside the org. It takes the same JSON input as the local server's tool and returns the same JSON. `ReportsApi` is a thin adapter over the core class `ReportsService`, as [docs/architecture.md](../docs/architecture.md) draws it. The contract is in [docs/design.md](../docs/design.md), section "v0.2: the in-org doors". Phase 1 results are in [docs/probes/v0.2-phase1.md](../docs/probes/v0.2-phase1.md), phase 3a (the callout tools) in [docs/probes/v0.2-phase3.md](../docs/probes/v0.2-phase3.md), and phase 3b (the save tools) in [docs/probes/v0.2-phase3b.md](../docs/probes/v0.2-phase3b.md).

```
POST /services/apexrest/reports/v1/<tool>
Body: the tool's JSON input, as inputSchema in src/server.ts defines it
200:  the JSON the local tool returns
400:  bad input or a Salesforce 4xx, 500: anything else. Body: {"error": {"code", "message", "hint"?}}
403:  a write tool (a save tool or refresh_dashboard), for a user without the Reports_Write custom permission. Body: {"error": {"code": "WRITE_NOT_ALLOWED", ...}}
404:  a tool this door lacks. Body: {"error": {"code": "UNKNOWN_TOOL", ...}}
```

The class answers on two routes, and reads the tool name from the last segment of either:

| Route | Called by | Callouts |
| --- | --- | --- |
| `/services/apexrest/reports/v1/<tool>` | the REST door: scripts, the skills through `sf api request rest`, Flow, other agents | under the caller's session |
| `/services/apexrest/reports/v1/mcp/<tool>` | the hosted MCP door, through the API Catalog entry in `mcp-app` | through the named credential `SalesforceReportsCallout`, as the user, when `callout-app` is installed ([decision 0012](../docs/decisions/0012-per-user-jwt-named-credential.md)). Without it, none: a hosted sign-in gives Apex no session, so `list_report_types`, `query_report`, `combine_reports` with definitions and the three save tools answer 500 `CALLOUT_SESSION`, and `describe_report_type` reads the type through a saved report ([decision 0007](../docs/decisions/0007-callout-identity-under-hosted-mcp.md)) |

## Tools

The REST door has fifteen tools: the eight read tools `search_reports`, `list_report_folders`, `list_report_types`, `describe_report`, `describe_report_type`, `run_report`, `query_report` and `combine_reports`, the three save tools `create_report`, `update_report` and `clone_report`, the three dashboard readers `list_dashboards`, `describe_dashboard` and `run_dashboard`, and `refresh_dashboard`, a write. The hosted MCP door still lists the first eleven; its dashboard tools come later.

| Tool | On this door | Differences from the local server |
| --- | --- | --- |
| `search_reports` | yes | none |
| `list_report_folders` | yes | none |
| `describe_report` | yes | With `includeMetadata`, `reportMetadata` holds only the fields Apex exposes. REST-only fields such as `chart` and `presentationOptions` are absent. |
| `list_report_types` | yes, through the callout | none |
| `describe_report_type` | yes, through the callout | none. If the callout answers `CALLOUT_SESSION`, it reads the type through a saved report of that type instead, and two notes say so: `filterOperators` is then empty, and a type with no saved report answers `NO_SAVED_REPORT`. |
| `run_report` | yes | Detail rows are capped at `min(2000, floor(50000 / columns))`, and a note says when that cap cut rows. No async fallback: a run that is too large returns `RESULT_TOO_LARGE`. Raw `reportMetadata` overrides take the fields the Apex `ReportMetadata` can set. |
| `query_report` | yes, through the callout | Detail rows have the same cap as `run_report`. It asks Salesforce for detail rows only when they will be shown, so a grouped query over 2,000 rows without `detail` lacks the local note that Salesforce stopped at 2,000 rows. |
| `combine_reports` | yes | A `definition` input runs through `query_report`. |
| `create_report` | yes, through the callout, with the write permission | none. From a definition, or from `fromReportId` plus changes. With no `folderId` the report lands in Private Reports. |
| `update_report` | yes, through the callout, with the write permission | none |
| `clone_report` | yes, through the callout, with the write permission | none |
| `delete_report` | no, 404 | Use the local server. |
| `list_dashboards` | yes, with one callout per row | none. A failed `/status` call gives `lastRefreshed: null`. After a `CALLOUT_*` error, such as on the hosted route without `callout-app`, it stops calling `/status`, and a note says why. |
| `describe_dashboard` | yes, through the callout | none |
| `run_dashboard` | yes, through the callout | Detail rows per component have the same cap as `run_report`. Its notes offer `refresh_dashboard`. |
| `refresh_dashboard` | yes, through the callout, with the write permission | The wait is shorter: it polls `/status` back to back, at most 20 times or about 30 seconds, not every 3 seconds for 60. A refresh that has not finished says so in a note and points to `run_dashboard` in a minute. The once-a-minute refusal is the same note with the cached results ([decision 0019](../docs/decisions/0019-refresh-wait-on-the-in-org-door.md)). |

### Saving

The save tools and `refresh_dashboard` check the custom permission `Reports_Write` with `FeatureManagement.checkPermission` before they read the input or call out. The permission set `Salesforce_Reports_Write` grants it. A user without it gets HTTP 403, code `WRITE_NOT_ALLOWED`, and a hint naming that permission set. The read tools never check it. A user who saves also needs Create and Customize Reports, as on the local server.

- `create_report` posts to `/analytics/reports`. From `fromReportId`, it first reads the saved report's REST describe, so the copy keeps fields Apex does not expose, such as `sortBy` and `presentationOptions`.
- `update_report` patches `/analytics/reports/{id}` with only the given fields, and answers one `changes` line per field sent.
- `clone_report` posts to `/analytics/reports?cloneId={id}`, as the local server does.

### The callout

`list_report_types`, `describe_report_type`, `query_report`, the three save tools and the three dashboard readers call the org's own Reports and Dashboards REST API through one helper, `ReportsCallout`. Which identity the call carries depends on the route:

| Route | Identity | Endpoint |
| --- | --- | --- |
| REST door | `SESSION`: the running user's session | `URL.getOrgDomainUrl()` plus `/services/data/v62.0/analytics/...`, with a `Bearer` header. No Remote Site Setting needed. |
| Hosted MCP door, with `callout-app` | `NAMED_CREDENTIAL`: a token the org mints for the running user (JWT bearer, per-user principal) | `callout:SalesforceReportsCallout/services/data/v62.0/analytics/...`, with no header of its own. `UserInfo.getSessionId()` is never called. |
| Hosted MCP door, without `callout-app` | none | no request. 500 `CALLOUT_SESSION` |

`ReportsCallout` reads whether the named credential is installed with a query on `NamedCredential`, once per request, so `force-app` runs the same with or without `callout-app`.

- A missing session, a 401 or `INVALID_SESSION_ID` answers 500 with code `CALLOUT_SESSION` and a hint that the in-org door could not call the org's REST API under this sign-in.
- Through the named credential, a user without `Salesforce_Reports_Callout` answers 500 `CALLOUT_CREDENTIAL`, with a hint naming that permission set. A failed token exchange or a 401 answers the same code, with Salesforce's text and a hint to run the setup again. `describe_report_type` falls back to a saved report on either code.
- Any other Salesforce error answers with the body the local server gives for it: Salesforce's `errorCode` and `message`, the same hint, and status 400 for a 4xx.
- A call that fails outright (over 6 MB or 120 seconds) answers 500 `CALLOUT_FAILED`.

`ReportsApi` and `ReportsService` are `with sharing`, and the service runs its queries in user mode, so sharing, folder access and field-level security stay Salesforce's own.

## Classes

| Class | Layer | What it does |
| --- | --- | --- |
| `ReportsApi` | REST adapter | The `@RestResource`. Reads the tool name from the URL and the body text, calls `ReportsService`, and answers 200, or maps an error's category to 400, 403, 404 or 500 with the error body. |
| `ReportsService` | core | The tool list, the `Reports_Write` check for the save tools and `refresh_dashboard` (before the input is read or any callout), dispatch by tool name, and the eleven report tools, the SOQL ones included. Ported from `src/server.ts`. |
| `ReportsDashboards` | core | `src/reports/dashboards.ts` and the dashboard card fields from `src/server.ts`: `list_dashboards` (SOQL on `Dashboard`, then `/status` per row), `describe_dashboard` and `run_dashboard` through `ReportsCallout`, filters resolved to `filter1` option ids, each component's report result shaped by `ReportsShape`, and `refresh_dashboard` (a status read, the PUT, then a bounded run of `/status` polls). |
| `ReportsInput` | core | Parses the body and reads typed fields, refusing bad input with the local server's messages. |
| `ReportsException` | core | The one error type: code, message, hint and a category (invalid input, forbidden, unknown tool, failed), never an HTTP status. Turns any other exception into one, as `src/format.ts` does. |
| `ReportsDefinition` | core | `src/reports/definition.ts`: the friendly definition to `reportMetadata` to `Reports.ReportMetadata`. |
| `ReportsShape` | core | `src/reports/shape.ts`: `Reports.ReportResults` (run_report) and the REST JSON (query_report) to `ReportResult`, through one shared frame. |
| `ReportsSummary` | core | `src/reports/summarize.ts`: `describe_report`, `list_report_types`, `describe_report_type`, filter lines. |
| `ReportsCombine` | core | `src/reports/combine.ts`: stack and join. |
| `ReportsCallout` | outbound HTTP adapter | `src/salesforce/client.ts`: the one call to the org's REST API, with the session or, on the hosted route, the named credential. It reads the upstream status, and throws `ReportsException`. |

The dependency rule: no class but `ReportsApi` and its tests names `ReportsApi`, so the core does not know which door called it. `scripts/measure.apex` and `scripts/measure-query.apex` call the core directly, with the row cap and base URL from `ReportsService`, and call `ReportsApi.handle` only where they measure the door itself.

`ReportsApiTest` covers the adapter: status codes, error bodies, unknown tools and `delete_report`. The other test classes call the door through `ReportsApi.handle` or the core classes directly. The tests that run reports use `@IsTest(SeeAllData='true')` and the org's own saved reports. They create no reports. `ReportsCalloutTest` and `ReportsSaveTest` answer every callout with an `HttpCalloutMock`, and cover the hosted route in its three cases: without the named credential, through it, and for a user who cannot use it. They set whether the credential is installed, so they pass the same in an org with or without `callout-app`. `ReportsDashboardsTest` answers every dashboard callout with an `HttpCalloutMock` and trimmed inline JSON. Its list tests build `Dashboard` rows in memory, and one `SeeAllData='true'` test runs the SOQL on the org's own dashboards with every `/status` call mocked. `ReportsSaveTest` creates, in its test setup, a Chatter Free user without the write permission (so it takes no Salesforce license), and assigns the write permission set to the running user if it lacks it. Both roll back with the test.

## Commands

Run these from this folder (`salesforce/`). Replace `<alias>` with a Salesforce CLI alias.

Deploy the REST door, then, for the MCP door, `mcp-app` on top of it:

```bash
sf project deploy start -d force-app -o <alias>
sf project deploy start -d mcp-app -o <alias>
```

For the callout tools on the hosted door, set up `callout-app` from the repo root, then assign its permission set to each hosted user. The script refuses an alias that is not on `SF_REPORTS_SETUP_ORGS` (or, with that unset, one given without `--yes`). Add `--ignore-conflicts` in a scratch org whose source tracking remembers an earlier removal:

```bash
SF_REPORTS_SETUP_ORGS=<alias> npm run callout:setup -- --org <alias>
sf org assign permset -n Salesforce_Reports_Callout -o <alias>
```

The script copies `callout-app` to a temp folder, fills it there and deletes the copy. It never writes a filled value to the repo, and prints none.

| Step | What |
| --- | --- |
| 1 | Deploy the certificate `SalesforceReportsCallout`, unless the org has it. The org makes the key pair, and the private key never leaves it. |
| 2 | Retrieve the certificate's public part, fill `__CERTIFICATE__`, and deploy the External Client App with its scopes (`Api, RefreshToken`), global OAuth settings and app policy. |
| 3 | Read the app's consumer key from `apps/oauth/credentials/<app id>`, a listing with no secret. Fill `__CONSUMER_KEY__`, `__MY_DOMAIN__` and `__AUDIENCE__` (`https://<My Domain>`), and deploy the external credential, the named credential and the permission set. |
| 4 | Deploy the app's OAuth policy, which pre-authorizes users with the permission set. It needs the set, so it goes last. |

Running it again is safe: it keeps the certificate and redeploys the rest. It ends by printing the certificate's expiry.

**Renewing the certificate.** The certificate expires a year after it is made, at midnight UTC on that day. When it has expired, the org can no longer mint a token, and the hosted door's callout tools answer `CALLOUT_CREDENTIAL`. Renew it in the month before it expires, from the repo root:

```bash
SF_REPORTS_SETUP_ORGS=<alias> npm run callout:renew -- --org <alias>
```

Read the expiry date with a Tooling query, or in Setup under Certificate and Key Management:

```bash
sf data query -t -q "SELECT DeveloperName, ExpirationDate FROM Certificate WHERE DeveloperName LIKE 'SalesforceReportsCallout%'" -o <alias>
```

`npm run callout:renew` is `npm run callout:setup` with `--renew-certificate`. It needs `callout-app` already set up, and it refuses aliases as the setup does. It switches the certificate twice, so a new one ends under the name `SalesforceReportsCallout`, which the external credential and the removal manifest use:

| Switch | What |
| --- | --- |
| 1 | Deploy a new certificate `SalesforceReportsCallout2`. In one deploy, point the app's global OAuth settings (its `certificate`) and the external credential's signing certificate at it. Then remove `SalesforceReportsCallout`. |
| 2 | The same, back to a new `SalesforceReportsCallout`. Then remove `SalesforceReportsCallout2`. |

The org makes each key pair. The script reads back only public certificates and the app's consumer key, and prints no filled value. Permission set assignments are untouched, and no user clicks anything. Tokens already minted keep working until they expire. Each deploy passes `--ignore-conflicts`, since the renewal overwrites what the setup deployed.

If a renewal stops part way, `SalesforceReportsCallout2` is left in the org. Run `npm run callout:renew` again: it keeps the newer certificate, removes the older and finishes the switches, without making a third. Until then `npm run callout:setup` stops and says so. Finish a renewal before a removal too, since the removal manifest names only `SalesforceReportsCallout`.

Test, with coverage:

```bash
sf apex run test -o <alias> --class-names ReportsApiTest --class-names ReportsDefinitionTest --class-names ReportsSummaryTest --class-names ReportsCombineTest --class-names ReportsCalloutTest --class-names ReportsSaveTest --class-names ReportsDashboardsTest --code-coverage --result-format human --wait 20
```

Call it:

```bash
sf api request rest "/services/apexrest/reports/v1/search_reports" --method POST --body '{"query":"pipeline"}' -o <alias>
```

Check parity with the local server, from the repo root. It creates and deletes its own zz-parity-* reports:

```bash
npm run parity -- --org <alias>
```

Run the live check's read and save steps through this door, from the repo root. The deletes still run on the local server, and the user needs the write permission set:

```bash
npm run live -- --org <alias> --door apex --allow-delete
```

### Removal

Remove the units in the opposite order: `callout-app` and `mcp-app` first, then `force-app`. Salesforce will not delete a class an API Catalog entry names, and the MCP door is useless without the REST door. Each unit has its own manifest folder, `manifest/callout-app/`, `manifest/mcp-app/` and `manifest/force-app/`, with an empty `package.xml`, a pre step and a post step. Check a removal first with `--dry-run`.

To remove `callout-app`, unassign `Salesforce_Reports_Callout` from every user first, since an assigned permission set cannot be deleted. The hosted door's callout tools then answer `CALLOUT_SESSION` again.

- The pre step, `manifest/callout-app/destructiveChangesPre.xml`, removes the app's policies and OAuth settings, the named credential and the permission set.
- The post step, `manifest/callout-app/destructiveChanges.xml`, then removes the certificate, the External Client App and the external credential.

```bash
sf project deploy start --manifest manifest/callout-app/package.xml --pre-destructive-changes manifest/callout-app/destructiveChangesPre.xml --post-destructive-changes manifest/callout-app/destructiveChanges.xml -o <alias>
```

To remove the MCP door, first remove the tool rows and server access (from the repo root), then the metadata. A server that is still active cannot be deleted ("Server must be inactive before making changes"), which is why the teardown runs first.

- The pre step, `manifest/mcp-app/destructiveChangesPre.xml`, removes the External Client App's two OAuth settings and the MCP server, which names the API Catalog entry.
- The post step, `manifest/mcp-app/destructiveChanges.xml`, then removes the External Client App and the API Catalog entry.

```bash
npm run mcp:teardown -- --org <alias> --yes
sf project deploy start --manifest manifest/mcp-app/package.xml --pre-destructive-changes manifest/mcp-app/destructiveChangesPre.xml --post-destructive-changes manifest/mcp-app/destructiveChanges.xml -o <alias>
```

Removing the External Client App ends every Claude connector that signs in through it. Deploying `mcp-app` again creates the app anew, so read its consumer key again and reconnect.

To remove the REST door after that, unassign both permission sets from every user first, since an assigned permission set cannot be deleted.

- The pre step, `manifest/force-app/destructiveChangesPre.xml`, removes the two permission sets (`Salesforce_Reports` grants every non-test class, `ReportsService`, `ReportsInput` and `ReportsException` among them).
- The post step, `manifest/force-app/destructiveChanges.xml`, then removes the custom permission and all seventeen classes: the adapter, the core, the callout and their tests.

```bash
sf project deploy start --manifest manifest/force-app/package.xml --pre-destructive-changes manifest/force-app/destructiveChangesPre.xml --post-destructive-changes manifest/force-app/destructiveChanges.xml -o <alias>
```

## Hosted MCP door

The same class is also a Salesforce hosted MCP server. Everything it adds is in `mcp-app`, deployed on top of `force-app`, and none of it is code. The admin steps are in the repo's [README](../README.md), section "In the org", and the platform findings are in [docs/probes/v0.2-phase2.md](../docs/probes/v0.2-phase2.md).

| Piece | Source | Made by |
| --- | --- | --- |
| API Catalog entry `ReportsApi` (ExternalServiceRegistration, ApexRest, inline OpenAPI 3) | `mcp-app/main/default/externalServiceRegistrations/` | `npm run mcp:generate`, from the local tool list |
| MCP server `SalesforceReports`, with eleven tools on `ar:ReportsApi`. The save tools are not marked read-only, and their descriptions name the write permission set. | `mcp-app/main/default/mcpServerDefinitions/` | `npm run mcp:generate` |
| External Client App `SalesforceReportsMcp` (PKCE, `mcp_api`, `refresh_token`, callback for claude.ai) | `mcp-app/main/default/externalClientApps/`, `extlClntAppGlobalOauthSets/`, `extlClntAppOauthSettings/` | by hand |
| Tool rows and server access | not metadata | `npm run mcp:setup -- --org <alias> --yes`, removed by `npm run mcp:teardown -- --org <alias> --yes` |

The permission sets and the custom permission it relies on are in `force-app`, since the REST door needs them too.

For the three save tools, the generator adds two sentences after the local description, in the OpenAPI operation, the server's `descriptionOverride` and the tool row: "In the org, this tool needs the permission set Salesforce_Reports_Write. Without it, the call answers WRITE_NOT_ALLOWED." `src/server.ts` stays as it is.

The setup script writes each tool row's ReadOnly, Destructive, Idempotent and OpenWorld flags from the local server's annotations. A hosted server lists its tools to every user who can reach it: there is no per-user or per-permission field on the tool, server or access rows. So the save tools are listed for everyone, and the door refuses a user without the write permission.

`npm run mcp:generate -- --check` fails when the committed registration or server no longer matches `src/server.ts`.

`scripts/measure.apex` measures heap and CPU of real runs through the door's code. The phase 1 doc says how to run it. `scripts/measure-query.apex` measures the callout time and heap of a `query_report` with detail rows (`sf apex run -f scripts/measure-query.apex -o <alias>`).
