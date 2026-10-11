# v0.2 phase 0 probes

A self-contained SFDX project. It holds everything the five phase 0 probes deployed to `dev-backend`, and the destructive manifests that remove it. Findings are in `docs/probes/v0.2-phase0.md`.

Run every command from this folder. Use a scratch or dev org alias you are allowed to write to. The examples use `dev-backend`.

| Component | Probe |
| --- | --- |
| `ReportsProbeApi` (+ `Test`) | 1 and 2: a one-method `@RestResource` class at `/reportsprobe/v1/*` |
| `ReportsProbeLab` (+ `Test`) | 3, 4 and 5: callouts, heap and CPU, `describeReport` at `/reportsprobelab/v1/*` |
| `mcpServerDefinitions/ReportsProbe` | 1: the smallest `McpServerDefinition` |
| `externalServiceRegistrations/ReportsProbeApi` | 2: an OpenAPI 3 document for the class, with our own `operationId` |

## Probe 1: types and deploy

1. List the types: `sf org list metadata-types -o dev-backend --json` and look for `McpServerDefinition`.
2. Deploy the classes: `sf project deploy start -d force-app/main/default/classes -o dev-backend`
3. Call it: `sf api request rest "/services/apexrest/reportsprobe/v1/ping" -o dev-backend`
4. Deploy the server: `sf project deploy start -d force-app/main/default/mcpServerDefinitions -o dev-backend`
5. See it: `sf data query -t -q "SELECT Id, DeveloperName FROM McpServerDefinition" -o dev-backend`

## Probe 2: from class to tools

1. Deploy the registration (after the classes): `sf project deploy start -d force-app/main/default/externalServiceRegistrations -o dev-backend`
2. Read it back: `sf project retrieve start -m ExternalServiceRegistration:ReportsProbeApi -o dev-backend` and look at `<operations>`.

## Probe 3: callouts to the org's own REST API

No Remote Site Setting or Named Credential is deployed. The org domain URL works without one.

1. `sf api request rest "/services/apexrest/reportsprobelab/v1/types" -o dev-backend`
2. `sf api request rest "/services/apexrest/reportsprobelab/v1/query" -o dev-backend -X POST -b '{"reportMetadata":{"reportType":{"type":"Opportunity"},"reportFormat":"SUMMARY","groupingsDown":[{"name":"STAGE_NAME","sortOrder":"Asc","dateGranularity":"None"}],"aggregates":["s!AMOUNT","RowCount"],"detailColumns":["OPPORTUNITY_NAME","AMOUNT"],"scope":"organization","standardDateFilter":{"column":"CLOSE_DATE","durationValue":"CUSTOM","startDate":"2000-01-01","endDate":"2100-01-01"}}}'`
3. Create then delete a report in one call: `sf api request rest "/services/apexrest/reportsprobelab/v1/createdelete" -o dev-backend -X POST -b '{"reportMetadata":{"name":"zz probe tmp","developerName":"zz_probe_tmp","reportType":{"type":"Opportunity"},"reportFormat":"TABULAR","detailColumns":["OPPORTUNITY_NAME","AMOUNT"],"scope":"organization","folderId":"<a report folder id>"}}'`

## Probes 4 and 5: heap, CPU and describeReport

Create a saved report to run, with the REST API (`POST /services/data/v62.0/analytics/reports`, a TABULAR `User` report with 30 `detailColumns` and no `scope`). Then:

1. Real run: `sf api request rest "/services/apexrest/reportsprobelab/v1/run?id=<report id>" -o dev-backend`
2. Synthetic run (the org holds almost no records): `curl --compressed -H "Authorization: Bearer $TOKEN" "<instance url>/services/apexrest/reportsprobelab/v1/synthetic?rows=2000&cols=100"`. Use curl for the query string form, and set `TOKEN` from `sf org auth show-access-token`. Never print it.
3. describeReport: `sf api request rest "/services/apexrest/reportsprobelab/v1/describe?id=<report id>" -o dev-backend`
4. REST side of probe 5: `sf api request rest "/services/data/v62.0/analytics/reportTypes/Opportunity" -o dev-backend`

## Clean up

1. Delete the reports you made: `DELETE /services/data/v62.0/analytics/reports/<id>` (use curl, `sf api request rest` cannot delete).
2. Remove the components. The registration and server go first, because the registration references the class:

```
sf project deploy start --manifest destructive/package.xml --pre-destructive-changes destructive/pre.xml --post-destructive-changes destructive/post.xml -o dev-backend
```

3. Check: `sf org list metadata -m ApexClass -o dev-backend --json` shows no `ReportsProbe*`, and `SELECT Id, Name FROM Report WHERE LastModifiedDate = TODAY` shows none of your reports.
