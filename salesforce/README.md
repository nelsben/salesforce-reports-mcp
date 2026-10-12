# In-org REST door

An Apex REST resource, `ReportsApi`, that answers the runner tools from inside the org. It takes the same JSON input as the local server's tool and returns the same JSON. The contract is in [docs/design.md](../docs/design.md), section "v0.2: the in-org doors". Phase 1 results are in [docs/probes/v0.2-phase1.md](../docs/probes/v0.2-phase1.md).

```
POST /services/apexrest/reports/v1/<tool>
Body: the tool's JSON input, as inputSchema in src/server.ts defines it
200:  the JSON the local tool returns
400:  bad input, 500: anything else. Body: {"error": {"code", "message", "hint"?}}
404:  a tool this door lacks. Body: {"error": {"code": "UNKNOWN_TOOL", ...}}
```

## Tools

| Tool | On this door | Differences from the local server |
| --- | --- | --- |
| `search_reports` | yes | none |
| `list_report_folders` | yes | none |
| `describe_report` | yes | With `includeMetadata`, `reportMetadata` holds only the fields Apex exposes. REST-only fields such as `chart` and `presentationOptions` are absent. |
| `describe_report_type` | yes | Needs a saved report of that type the user can see. `filterOperators` is empty and a note says so, because Apex has no operator map. |
| `run_report` | yes | Detail rows are capped at `min(2000, floor(50000 / columns))`, and a note says when that cap cut rows. No async fallback: a run that is too large returns `RESULT_TOO_LARGE`. Raw `reportMetadata` overrides take the fields the Apex `ReportMetadata` can set. |
| `combine_reports` | yes | Inputs must be saved reports (`reportId`). A `definition` input needs `query_report`. |
| `list_report_types`, `query_report`, `create_report`, `update_report`, `clone_report`, `delete_report` | no, 404 | Use the local server. |

`ReportsApi` is `with sharing` and runs its queries in user mode, so sharing, folder access and field-level security stay Salesforce's own.

## Classes

| Class | Ported from |
| --- | --- |
| `ReportsApi` | `src/server.ts`, `src/format.ts`: dispatch, inputs, errors, the SOQL tools |
| `ReportsDefinition` | `src/reports/definition.ts`: `overrides` to `reportMetadata` to `Reports.ReportMetadata` |
| `ReportsShape` | `src/reports/shape.ts`: `Reports.ReportResults` to `ReportResult` |
| `ReportsSummary` | `src/reports/summarize.ts`: `describe_report`, `describe_report_type`, filter lines |
| `ReportsCombine` | `src/reports/combine.ts`: stack and join |

Each has a test class. The tests that run reports use `@IsTest(SeeAllData='true')` and the org's own saved reports. They create no records.

## Commands

Run these from this folder (`salesforce/`). Replace `<alias>` with a Salesforce CLI alias.

Deploy:

```bash
sf project deploy start -d force-app -o <alias>
```

Test, with coverage:

```bash
sf apex run test -o <alias> --class-names ReportsApiTest --class-names ReportsDefinitionTest --class-names ReportsSummaryTest --class-names ReportsCombineTest --code-coverage --result-format human --wait 10
```

Call it:

```bash
sf api request rest "/services/apexrest/reports/v1/search_reports" --method POST --body '{"query":"pipeline"}' -o <alias>
```

Check parity with the local server, from the repo root. It creates and deletes its own zz-parity-* reports:

```bash
npm run parity -- --org <alias>
```

Run the live check's read steps through this door, from the repo root:

```bash
npm run live -- --org <alias> --door apex --allow-delete
```

Remove everything: first the MCP rows and server access (from the repo root), then the server, the API Catalog entry, the permission set and the classes. Check the second command first with `--dry-run`. A server that is still active cannot be deleted ("Server must be inactive before making changes"), and a class an API Catalog entry names cannot be deleted before the entry, which is why the manifest has a pre and a post step.

```bash
npm run mcp:teardown -- --org <alias> --yes
sf project deploy start --manifest manifest/package.xml --pre-destructive-changes manifest/destructiveChangesPre.xml --post-destructive-changes manifest/destructiveChanges.xml -o <alias>
```

## Hosted MCP door

The same class is also a Salesforce hosted MCP server. The admin steps are in the repo's [README](../README.md), section "In the org", and the platform findings are in [docs/probes/v0.2-phase2.md](../docs/probes/v0.2-phase2.md).

| Piece | Source | Made by |
| --- | --- | --- |
| API Catalog entry `ReportsApi` (ExternalServiceRegistration, ApexRest, inline OpenAPI 3) | `force-app/main/default/externalServiceRegistrations/` | `npm run mcp:generate`, from the local tool list |
| MCP server `SalesforceReports`, with six tools on `ar:ReportsApi` | `force-app/main/default/mcpServerDefinitions/` | `npm run mcp:generate` |
| Permission set `Salesforce_Reports_MCP` (the five non-test classes) | `force-app/main/default/permissionsets/` | by hand |
| External Client App `SalesforceReportsMcp` (PKCE, `mcp_api`, `refresh_token`, callback for claude.ai) | `eca/` | by hand; deploy it with `-d eca` |
| Tool rows and server access | not metadata | `npm run mcp:setup -- --org <alias> --yes`, removed by `npm run mcp:teardown -- --org <alias> --yes` |

`npm run mcp:generate -- --check` fails when the committed registration or server no longer matches `src/server.ts`.

`scripts/measure.apex` measures heap and CPU of real runs through the door's code. The phase 1 doc says how to run it.
