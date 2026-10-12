# In-org REST door

Two Salesforce package directories, as [decision 0009](../docs/decisions/0009-two-shipping-units.md) sets out:

| Directory | Holds | Depends on |
| --- | --- | --- |
| `force-app` (default) | the REST door: the Apex classes and tests, the permission sets `Salesforce_Reports_MCP` and `Salesforce_Reports_MCP_Write`, and the custom permission `Reports_MCP_Write` | nothing |
| `mcp-app` | the hosted MCP door: the API Catalog entry `ReportsApi`, the MCP server `SalesforceReports` and the External Client App `SalesforceReportsMcp`. No code. | `force-app` |

The REST door is an Apex REST resource, `ReportsApi`, that answers the runner tools from inside the org. It takes the same JSON input as the local server's tool and returns the same JSON. `ReportsApi` is a thin adapter over the core class `ReportsService`, as [docs/architecture.md](../docs/architecture.md) draws it. The contract is in [docs/design.md](../docs/design.md), section "v0.2: the in-org doors". Phase 1 results are in [docs/probes/v0.2-phase1.md](../docs/probes/v0.2-phase1.md), phase 3a (the callout tools) in [docs/probes/v0.2-phase3.md](../docs/probes/v0.2-phase3.md), and phase 3b (the save tools) in [docs/probes/v0.2-phase3b.md](../docs/probes/v0.2-phase3b.md).

```
POST /services/apexrest/reports/v1/<tool>
Body: the tool's JSON input, as inputSchema in src/server.ts defines it
200:  the JSON the local tool returns
400:  bad input or a Salesforce 4xx, 500: anything else. Body: {"error": {"code", "message", "hint"?}}
403:  a save tool, for a user without the Reports_MCP_Write custom permission. Body: {"error": {"code": "WRITE_NOT_ALLOWED", ...}}
404:  a tool this door lacks. Body: {"error": {"code": "UNKNOWN_TOOL", ...}}
```

## Tools

The door has eleven tools: the eight read tools `search_reports`, `list_report_folders`, `list_report_types`, `describe_report`, `describe_report_type`, `run_report`, `query_report` and `combine_reports`, and the three save tools `create_report`, `update_report` and `clone_report`.

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

### Saving

The save tools check the custom permission `Reports_MCP_Write` with `FeatureManagement.checkPermission` before they read the input or call out. The permission set `Salesforce_Reports_MCP_Write` grants it. A user without it gets HTTP 403, code `WRITE_NOT_ALLOWED`, and a hint naming that permission set. The read tools never check it. A user who saves also needs Create and Customize Reports, as on the local server.

- `create_report` posts to `/analytics/reports`. From `fromReportId`, it first reads the saved report's REST describe, so the copy keeps fields Apex does not expose, such as `sortBy` and `presentationOptions`.
- `update_report` patches `/analytics/reports/{id}` with only the given fields, and answers one `changes` line per field sent.
- `clone_report` posts to `/analytics/reports?cloneId={id}`, as the local server does.

### The callout

`list_report_types`, `describe_report_type`, `query_report` and the three save tools call the org's own Reports REST API through one helper, `ReportsCallout`: `URL.getOrgDomainUrl()` plus `/services/data/v62.0/analytics/...`, with the running user's session. It needs no Remote Site Setting. A Named Credential could replace the session in that one class.

- A missing session, a 401 or `INVALID_SESSION_ID` answers 500 with code `CALLOUT_SESSION` and a hint that the in-org door could not call the org's REST API under this sign-in.
- Any other Salesforce error answers with the body the local server gives for it: Salesforce's `errorCode` and `message`, the same hint, and status 400 for a 4xx.
- A call that fails outright (over 6 MB or 120 seconds) answers 500 `CALLOUT_FAILED`.

`ReportsApi` and `ReportsService` are `with sharing`, and the service runs its queries in user mode, so sharing, folder access and field-level security stay Salesforce's own.

## Classes

| Class | Layer | What it does |
| --- | --- | --- |
| `ReportsApi` | REST adapter | The `@RestResource`. Reads the tool name from the URL and the body text, calls `ReportsService`, and answers 200, or maps an error's category to 400, 403, 404 or 500 with the error body. |
| `ReportsService` | core | The tool list, the `Reports_MCP_Write` check for the save tools (before the input is read or any callout), dispatch by tool name, and the eleven tools, the SOQL ones included. Ported from `src/server.ts`. |
| `ReportsInput` | core | Parses the body and reads typed fields, refusing bad input with the local server's messages. |
| `ReportsException` | core | The one error type: code, message, hint and a category (invalid input, forbidden, unknown tool, failed), never an HTTP status. Turns any other exception into one, as `src/format.ts` does. |
| `ReportsDefinition` | core | `src/reports/definition.ts`: the friendly definition to `reportMetadata` to `Reports.ReportMetadata`. |
| `ReportsShape` | core | `src/reports/shape.ts`: `Reports.ReportResults` (run_report) and the REST JSON (query_report) to `ReportResult`, through one shared frame. |
| `ReportsSummary` | core | `src/reports/summarize.ts`: `describe_report`, `list_report_types`, `describe_report_type`, filter lines. |
| `ReportsCombine` | core | `src/reports/combine.ts`: stack and join. |
| `ReportsCallout` | outbound HTTP adapter | `src/salesforce/client.ts`: the one call to the org's REST API. It reads the upstream status, and throws `ReportsException`. |

The dependency rule: no class but `ReportsApi` and its tests names `ReportsApi`, so the core does not know which door called it. `scripts/measure.apex` and `scripts/measure-query.apex` call the core directly, with the row cap and base URL from `ReportsService`, and call `ReportsApi.handle` only where they measure the door itself.

`ReportsApiTest` covers the adapter: status codes, error bodies, unknown tools and `delete_report`. The other test classes call the door through `ReportsApi.handle` or the core classes directly. The tests that run reports use `@IsTest(SeeAllData='true')` and the org's own saved reports. They create no reports. `ReportsCalloutTest` and `ReportsSaveTest` answer every callout with an `HttpCalloutMock`. `ReportsSaveTest` creates, in its test setup, a Chatter Free user without the write permission (so it takes no Salesforce license), and assigns the write permission set to the running user if it lacks it. Both roll back with the test.

## Commands

Run these from this folder (`salesforce/`). Replace `<alias>` with a Salesforce CLI alias.

Deploy the REST door, then, for the MCP door, `mcp-app` on top of it:

```bash
sf project deploy start -d force-app -o <alias>
sf project deploy start -d mcp-app -o <alias>
```

Test, with coverage:

```bash
sf apex run test -o <alias> --class-names ReportsApiTest --class-names ReportsDefinitionTest --class-names ReportsSummaryTest --class-names ReportsCombineTest --class-names ReportsCalloutTest --class-names ReportsSaveTest --code-coverage --result-format human --wait 20
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

Remove the units in the opposite order: `mcp-app` first, then `force-app`. Salesforce will not delete a class an API Catalog entry names, and the MCP door is useless without the REST door. Each unit has its own manifest folder, `manifest/mcp-app/` and `manifest/force-app/`, with an empty `package.xml`, a pre step and a post step. Check a removal first with `--dry-run`.

To remove the MCP door, first remove the tool rows and server access (from the repo root), then the metadata. A server that is still active cannot be deleted ("Server must be inactive before making changes"), which is why the teardown runs first.

- The pre step, `manifest/mcp-app/destructiveChangesPre.xml`, removes the External Client App's two OAuth settings and the MCP server, which names the API Catalog entry.
- The post step, `manifest/mcp-app/destructiveChanges.xml`, then removes the External Client App and the API Catalog entry.

```bash
npm run mcp:teardown -- --org <alias> --yes
sf project deploy start --manifest manifest/mcp-app/package.xml --pre-destructive-changes manifest/mcp-app/destructiveChangesPre.xml --post-destructive-changes manifest/mcp-app/destructiveChanges.xml -o <alias>
```

Removing the External Client App ends every Claude connector that signs in through it. Deploying `mcp-app` again creates the app anew, so read its consumer key again and reconnect.

To remove the REST door after that, unassign both permission sets from every user first, since an assigned permission set cannot be deleted.

- The pre step, `manifest/force-app/destructiveChangesPre.xml`, removes the two permission sets (`Salesforce_Reports_MCP` grants every non-test class, `ReportsService`, `ReportsInput` and `ReportsException` among them).
- The post step, `manifest/force-app/destructiveChanges.xml`, then removes the custom permission and all fifteen classes: the adapter, the core, the callout and their tests.

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

For the three save tools, the generator adds two sentences after the local description, in the OpenAPI operation, the server's `descriptionOverride` and the tool row: "In the org, this tool needs the permission set Salesforce_Reports_MCP_Write. Without it, the call answers WRITE_NOT_ALLOWED." `src/server.ts` stays as it is.

The setup script writes each tool row's ReadOnly, Destructive, Idempotent and OpenWorld flags from the local server's annotations. A hosted server lists its tools to every user who can reach it: there is no per-user or per-permission field on the tool, server or access rows. So the save tools are listed for everyone, and the door refuses a user without the write permission.

`npm run mcp:generate -- --check` fails when the committed registration or server no longer matches `src/server.ts`.

`scripts/measure.apex` measures heap and CPU of real runs through the door's code. The phase 1 doc says how to run it. `scripts/measure-query.apex` measures the callout time and heap of a `query_report` with detail rows (`sf apex run -f scripts/measure-query.apex -o <alias>`).
