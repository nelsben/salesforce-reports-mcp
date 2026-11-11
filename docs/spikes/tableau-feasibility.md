# Spike: can the report loop be built against Tableau?

Desk spike, 2026-11-10, from public documentation only. No Tableau site was contacted, no account was made and no credential was used. Nothing here was run. Every fact has a link. What could not be confirmed is under [Unconfirmed](#unconfirmed).

Terms follow [design.md](../design.md): `ReportDefinition` (report type, columns, groupings, aggregates, filters, date filter, sort), `ReportResult`, and the tools `search_reports`, `describe_report_type`, `describe_report`, `run_report`, `query_report` (run without saving), `create_report`, `update_report`, `delete_report`.

## Answer in short

**Go, for a read-only loop. No-go for create, update and delete of a report-like object.**

| Part of the loop | Against Tableau |
| --- | --- |
| Find, describe, run an ad hoc query with groupings, aggregates and filters, get rows | Yes. REST API plus the VizQL Data Service (VDS). |
| Shape the answer as `ReportResult` | Yes, with two small gaps (totals and data types). |
| Save a view or workbook that a person opens in Tableau, update it, delete it | No documented way to define one without Tableau Desktop or web authoring. Nearest route: a Pulse metric (Tableau Cloud only), or publishing a file made elsewhere. |

Also note that Tableau now ships an official [Tableau MCP server](https://tableau.github.io/tableau-mcp/docs/intro) that already covers the read half. See [Risks](#risks).

## The three surfaces

### Tableau REST API

Manages site content: data sources, workbooks, views, projects, users, jobs and more. [Overview and method groups](https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api.htm).

Can do in the loop:

- List and filter data sources, workbooks and views, with `filter`, `sort`, `pageSize` (1 to 1000, default 100) and `pageNumber`. [Data Sources](https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_ref_data_sources.htm), [Workbooks and Views](https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_ref_workbooks_and_views.htm).
- Return the summary data behind a saved view as CSV, with `vf_<fieldname>=value` filters. [Query View Data](https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_ref_workbooks_and_views.htm).
- Delete a workbook, a view (from API 3.27) or a custom view. [Workbooks and Views](https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_ref_workbooks_and_views.htm).
- Publish a workbook or data source from a file. [Publishing](https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_ref_publishing.htm).
- Rename or move a workbook with Update Workbook, or rename a custom view. [Workbooks and Views](https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_ref_workbooks_and_views.htm).

Cannot:

- Run a query you define in the request. A view returns the data its author built, with only `vf_` filters changed. It cannot be regrouped or re-aggregated.
- Describe a view's fields or the data source's fields. That is VDS (below) or the Metadata API.
- Create a workbook or view from a definition. Publishing takes a finished `.twb` or `.twbx` file. The page does not say how to make one. [Publishing](https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_ref_publishing.htm).

### Metadata API (GraphQL)

One endpoint, `/api/metadata/graphql`. It indexes workbooks, sheets, dashboards, published and embedded data sources, fields, parameters, projects, users and external tables, and the links between them. [Overview](https://help.tableau.com/current/api/metadata_api/en-us/index.html), [model](https://help.tableau.com/current/api/metadata_api/en-us/docs/meta_api_model.html), [getting started](https://help.tableau.com/current/api/metadata_api/en-us/docs/meta_api_start.html).

Can do in the loop:

- Find content and show how it is built (a workbook's sheets, the fields each uses, lineage). This is richer than the REST list calls.
- Same sign-in token as the REST API.

Cannot:

- Write. The documentation describes querying only, and names no mutations. [Getting started](https://help.tableau.com/current/api/metadata_api/en-us/docs/meta_api_start.html).
- Run a query for rows. It returns metadata, not data.
- It needs setup: off by default on Tableau Server (`tsm maintenance metadata-services enable`), and on Tableau Cloud it needs Data Management from October 2026, with existing users allowed until June 2027. [Getting started](https://help.tableau.com/current/api/metadata_api/en-us/docs/meta_api_start.html).

### VizQL Data Service (VDS)

Headless query of a published data source, with no viz. Two calls: `POST /api/v1/vizql-data-service/read-metadata` and `POST /api/v1/vizql-data-service/query-datasource`. [Overview](https://help.tableau.com/current/api/vizql-data-service/en-us/index.html).

Can do in the loop:

- Describe fields: `fieldName`, `fieldCaption`, `dataType`, `fieldRole` (MEASURE or DIMENSION), `defaultAggregation`, `columnClass`, `formula`, plus the data source's parameters. [Request data source information](https://help.tableau.com/current/api/vizql-data-service/en-us/docs/vds_get_data_source_info.html).
- Run an ad hoc query: fields with a `function` (SUM, AVG, MEDIAN, COUNT, COUNTD, MIN, MAX, STDEV, VAR, COLLECT, date parts), `sortDirection` and `sortPriority`, and filters of type SET, QUANTITATIVE_NUMERICAL, QUANTITATIVE_DATE, DATE (relative), TOP and MATCH. [Query a data source](https://help.tableau.com/current/api/vizql-data-service/en-us/docs/vds_create_queries.html).
- Return `OBJECTS` or `ARRAYS`, with an optional `rowLimit`. [Query a data source](https://help.tableau.com/current/api/vizql-data-service/en-us/docs/vds_create_queries.html).

Cannot:

- Save anything. It is a read service.
- Query a cube data source, spatial, Python or R, RAWSQL, fiscal-date or `COUNT(table)` calculations; use bins or groups in filters; put two filters on one field; or aggregate date-times by hour or minute. [Limitations](https://help.tableau.com/current/api/vizql-data-service/en-us/docs/vds_limitations.html).
- Run against a workbook or view directly, except a workbook data source inside an embedded session. [Configuration](https://help.tableau.com/current/api/vizql-data-service/en-us/docs/vds_configuration.html).

## The loop, step by step

Salesforce column: the tool this repo has today. Tableau column: the call that does it, or "none".

| Step | Salesforce tool | Tableau endpoint | Notes |
| --- | --- | --- | --- |
| Find sources | `search_reports`, `list_report_types` | `GET /api/{v}/sites/{site}/datasources?filter=name:eq:...` ([REST](https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_ref_data_sources.htm)). Also `GET .../workbooks` and `GET .../views` ([REST](https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_ref_workbooks_and_views.htm)), or GraphQL at `/api/metadata/graphql` ([Metadata API](https://help.tableau.com/current/api/metadata_api/en-us/docs/meta_api_start.html)). | The nearest match to a report type is a published data source. The nearest match to a saved report is a view. |
| Describe fields | `describe_report_type` | `POST /api/v1/vizql-data-service/read-metadata` ([VDS](https://help.tableau.com/current/api/vizql-data-service/en-us/docs/vds_get_data_source_info.html)) | Gives role, type, default aggregation. It has no list of filter operators per type; the filter types are fixed (see query). |
| Describe a saved view | `describe_report` | Metadata API for sheets and their fields ([model](https://help.tableau.com/current/api/metadata_api/en-us/docs/meta_api_model.html)). `GET .../views/{id}` for name and workbook ([REST](https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_ref_workbooks_and_views.htm)). | Which fields and filters a view uses is a Metadata API question. The exact fields are Unconfirmed. |
| Ad hoc query with groupings, aggregates, filters, sort | `query_report` | `POST /api/v1/vizql-data-service/query-datasource` ([VDS](https://help.tableau.com/current/api/vizql-data-service/en-us/docs/vds_create_queries.html)) | A dimension field with no `function` is a grouping. A field with a `function` is an aggregate. |
| Run a saved view | `run_report` | `GET .../views/{id}/data` returns CSV, with `vf_` filters ([REST](https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_ref_workbooks_and_views.htm)) | Summary data only. No regrouping. For a dashboard only the first view returns. |
| Get rows back | `ReportResult` | VDS `data` array in `OBJECTS` or `ARRAYS` form ([VDS](https://help.tableau.com/current/api/vizql-data-service/en-us/docs/vds_create_queries.html)) | See shaping below. |
| Save something a person can open | `create_report` | None for a view or workbook from a definition. Pulse: `POST /api/-/pulse/definitions` and `POST /api/-/pulse/metrics` ([Pulse](https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_ref_pulse.htm)). File route: `POST .../fileUploads`, `PUT .../fileUploads/{id}`, then `POST .../workbooks?uploadSessionId=...` ([Publishing](https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_ref_publishing.htm)). | See next section. |
| Update | `update_report` | Pulse: `PATCH /api/-/pulse/definitions/{id}` and `PATCH .../metrics/{id}` ([Pulse](https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_ref_pulse.htm)). Workbook: rename or move only, `PUT .../workbooks/{id}`; or publish again with `overwrite=true` ([REST](https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_ref_workbooks_and_views.htm), [Publishing](https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_ref_publishing.htm)). | No documented call changes a view's fields or filters in place. |
| Delete | `delete_report` | `DELETE .../workbooks/{id}`, `DELETE .../views/{id}`, `DELETE .../customviews/{id}`, `DELETE .../datasources/{id}` ([REST](https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_ref_workbooks_and_views.htm)). Pulse: `DELETE .../definitions/{id}` and `.../metrics/{id}` ([Pulse](https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_ref_pulse.htm)). | Whether deletes go to a recycle bin like Salesforce is Unconfirmed; the REST reference lists a [Recycle Bin](https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api.htm) group. |

## Can a view or workbook be defined and saved through an API?

**No, not from the documentation.** The Publish Workbook call takes a finished `.twb` or `.twbx` file and the page does not say how to make one without Tableau Desktop. [Publishing](https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_ref_publishing.htm). The REST reference lists no call that creates a view, and the [Workbooks and Views page](https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_ref_workbooks_and_views.htm) offers only Update Custom View (name or owner), not a create. The official Tableau MCP server lists building workbooks as "Coming soon" and works with Tableau Desktop. [Tableau MCP](https://tableau.github.io/tableau-mcp/docs/intro).

Nearest workable routes, in order of fit:

1. **Pulse metric (Tableau Cloud only).** `POST /api/-/pulse/definitions` then `POST /api/-/pulse/metrics` create, update and delete a metric over a published data source, with no Desktop. Every Pulse method is listed as not available for Tableau Server. Most methods need no extra licence. [Pulse](https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_ref_pulse.htm). A metric is one measure over time, not a grouped report, so it saves only a narrow slice of a `ReportDefinition`.
2. **Return the query, not a saved object.** Claude returns the VDS request body and the rows, and the person saves the result in Tableau web authoring by hand. This loses "save" but keeps the loop honest.
3. **Publish a generated file.** Build a `.twb` or `.twbx` elsewhere and publish it with the Publishing calls. Tableau documents no public specification for writing that file, so this is Unconfirmed and likely brittle.

## Sign-in for a local server acting for one person

The server would hold one session, sent as the `X-Tableau-Auth` header. Sign in is `POST /api/{v}/auth/signin`. The token lasts 240 minutes by default. [Authentication](https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_concepts_auth.htm).

| Method | Fits a local MCP server? | Facts |
| --- | --- | --- |
| Personal access token | **Best fit.** Same shape as the `sf` CLI path: a name and a secret the person makes once. | Server and Cloud. Users make their own. On Cloud sites activated from June 2023 it is off until an admin enables it. Expiry is 1 to 365 days set by the admin (180 days offered), and 15 days unused also expires it. Up to 104 per user. One session per token: signing in again ends the earlier session. Works on MFA sites. [PAT page](https://help.tableau.com/current/online/en-us/security_personal_access_tokens.htm), [Authentication](https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_concepts_auth.htm). |
| Connected app, direct trust JWT | Fits only if the person is also a site admin, or an admin sets it up. | An admin creates the app. The JWT is signed with HS256, `sub` is the user's email, and it lives at most 10 minutes. The scopes limit the session: VDS needs `tableau:viz_data_service:read` and the Metadata API needs `tableau:content:read`. The page covers Tableau Cloud. [Direct trust](https://help.tableau.com/current/online/en-us/connected_apps_direct.htm). |
| OAuth 2.0 trust (external authorization server) | Does not fit a local server. | An admin registers an identity provider that issues signed JWTs; one per site. The page does not describe a local app flow. [EAS](https://help.tableau.com/current/online/en-us/connected_apps_eas.htm). |
| Username and password | Possible on Server. Not on MFA sites. | No single sign-on. [Authentication](https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_concepts_auth.htm). |

Because a PAT allows one session, two server processes sharing one PAT would knock each other out. The local server should hold the token in memory and sign in once.

## Cloud, Server, licences, sandbox, limits

| Question | Answer |
| --- | --- |
| VDS on Cloud and Server | Both. Server needs 2025.1 or later. [VDS overview](https://help.tableau.com/current/api/vizql-data-service/en-us/index.html). |
| VDS licence | "Available under all license models". [Limitations](https://help.tableau.com/current/api/vizql-data-service/en-us/docs/vds_limitations.html). The user needs the API Access capability on the data source. [Configuration](https://help.tableau.com/current/api/vizql-data-service/en-us/docs/vds_configuration.html). |
| Metadata API | Server: off by default, enabled by an admin with TSM. Cloud: needs Data Management from October 2026. [Getting started](https://help.tableau.com/current/api/metadata_api/en-us/docs/meta_api_start.html). |
| Pulse create, update, delete | Cloud only. Forecast and Pace to Goal insights need Tableau+. [Pulse](https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_ref_pulse.htm). |
| REST API on Cloud | Not every method applies to Cloud. [Fundamentals](https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_concepts_fundamentals.htm). |
| Free developer site | Yes: a free personal sandbox through the Tableau Developer Program. Tableau says content may be wiped, it is not for heavy workloads, it may be throttled or removed, and it must not hold customer or production data. Tableau lists REST API test scripts as a fit. [Enrollment page](https://www.tableau.com/products/online/developer-program-confirmation), [program](https://www.tableau.com/developer). Terms for length and inactivity are in the Developer Program Online Site Agreement, which was not read. |
| VDS rate limit | A site-wide cap of 100 queries per hour for each Creator licence on the site. Over the cap returns error 429000. [Limitations](https://help.tableau.com/current/api/vizql-data-service/en-us/docs/vds_limitations.html), [error codes](https://help.tableau.com/current/api/vizql-data-service/en-us/docs/vds_error_codes.html). Compare Salesforce: 500 synchronous runs per org per hour ([design.md](../design.md)). |
| VDS row limit | None stated. `rowLimit` is a request option and "VDS still retrieves all underlying results". Responses were capped at 1 GB before Tableau 2026.1, and are not from 2026.1. Query timeout is 30 minutes (error 408801). [Create a query](https://help.tableau.com/current/api/vizql-data-service/en-us/docs/vds_create_queries.html), [Limitations](https://help.tableau.com/current/api/vizql-data-service/en-us/docs/vds_limitations.html). Compare Salesforce: 2,000 detail rows. The server must still cut rows to `maxRows`. |
| REST rate limit | Cloud returns 429 ("Too Many Requests") when a quota is used up, and quotas refresh one or more times a day. No number is given. [Fundamentals](https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_concepts_fundamentals.htm). |
| REST list paging | `pageSize` 1 to 1000. [Data Sources](https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_ref_data_sources.htm). |
| Publish size | 64 MB in a single request, chunked upload up to 10,000 blocks. [Publishing](https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_ref_publishing.htm). |
| Cloud concurrency | Custom View data: 20 concurrent long-running requests on Cloud. [Workbooks and Views](https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_ref_workbooks_and_views.htm). |
| API versions | 2026.3 is REST 3.30, 2026.2 is 3.29, 2026.1 is 3.28. [Versions](https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_concepts_versions.htm). |

## Can a Tableau answer become a `ReportResult`?

**Yes for grouped data, reusing [skills/report-runner/dashboard-loader.js](../../skills/report-runner/dashboard-loader.js) unchanged.** The loader (`reportResultToRows`) needs `report`, and either `groups` (`dimensions`, `measures`, `rows`, optional `totals`) or `detail` (`columns`, `rows`). A VDS answer fits that.

Worked example. The request and answer below come from the [Query a data source](https://help.tableau.com/current/api/vizql-data-service/en-us/docs/vds_create_queries.html) page (sections "Set filters" and "OBJECTS return vs. ARRAYS return option"); the example there uses a Superstore-style data source.

Request, a `ReportDefinition` of one grouping, one `sum` aggregate and one filter:

```json
{
  "datasource": { "datasourceLuid": "1a2a3b4b-5c6c-7d8d-9e0e-1f2f3a4a5b6b" },
  "query": {
    "fields": [
      { "fieldCaption": "Ship Mode" },
      { "fieldCaption": "Sales", "function": "SUM" }
    ],
    "filters": [
      { "field": { "fieldCaption": "Segment" }, "filterType": "SET", "values": ["Home", "Consumer"], "exclude": false }
    ]
  }
}
```

The documentation's `OBJECTS` answer (two rows shown):

```json
{
  "data": [
    { "Ship Mode": "Second Class", "SUM(Sales)": 466671.11140000017 },
    { "Ship Mode": "Standard Class", "SUM(Sales)": 1378840.5509999855 }
  ]
}
```

The mapping, written by this spike and not copied from the documentation:

| `ReportResult` part | Source in the Tableau answer |
| --- | --- |
| `groups.dimensions` | Query fields with no `function`: `{name: "Ship Mode", label: "Ship Mode", axis: "down"}` |
| `groups.measures` | Query fields with a `function`: `{name: "SUM(Sales)", label: "Sum of Sales", dataType: ...}` |
| `groups.rows` | Each object in `data`, as a list in the order dimensions then measures (or ask for `ARRAYS`) |
| `report` | None in the answer. The server builds it: `id` is the data source LUID, `name` from the caller, `format` is `SUMMARY`, `reportType` is the data source name, `url` is the data source page. |
| `filters` | The server writes the request filters in words, as `definition.ts` does today. |
| `notes` | The server writes them, for example when it cut rows. |

Two gaps:

1. **No totals.** VDS returns none. The loader always adds a final "Total" row when `groups` exists, so with no `totals` the row would show blank values. A SUM total can be added by a second query with no dimensions (one more call against the hourly cap); an average or distinct count cannot be added up from the leaves.
2. **No data types in a query answer.** `dataType` for each measure comes from `read-metadata` (`dataType`, `defaultAggregation`), so the server must call it first and cache it. Currency versus number is not in that list; the format hint is in `defaultFormatting`. [Request data source information](https://help.tableau.com/current/api/vizql-data-service/en-us/docs/vds_get_data_source_info.html).

A saved view's CSV from `GET .../views/{id}/data` could fill `detail`. Its column names and types are Unconfirmed.

## Unconfirmed

- Whether any API creates a view, a workbook or a custom view from a definition. None was found, and the Create Custom View section of the REST reference was not visible in the fetched text.
- Whether a hand-written `.twb` is a supported way to publish. Tableau documents no public file specification in the pages read.
- The exact name of the VDS auth header. The [VDS configuration page](https://help.tableau.com/current/api/vizql-data-service/en-us/docs/vds_configuration.html) says only that a token from REST sign-in is required. `X-Tableau-Auth` is the REST header ([Authentication](https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_concepts_auth.htm)).
- Whether the VDS filter example's `field` or `column` key is right for numeric filters. The page's text and one example disagree. The `SET` filter above uses `field`.
- Whether a REST delete goes to a recycle bin that can restore it.
- A numeric REST rate limit. Only a third-party figure turned up, and it is not used.
- Developer sandbox length, renewal and inactivity rules, and whether it includes Data Management, Pulse or VDS. The agreement was not read. The Developer Program pages returned 403 to the fetch, so the sandbox facts above come from a search summary of the enrollment page.
- Which Metadata API fields give a view's filters and sort. The model page did not list them.
- How `Query View Data` names its CSV columns and types.
- Whether VDS works on a free developer site at its hourly cap (the cap depends on the Creator licence count).

## Risks

| Risk | Detail |
| --- | --- |
| The product differs | Tableau reads from a published data source and saves nothing. The loop "define, save, reopen" has no home. |
| Overlap with an official server | [Tableau MCP](https://tableau.github.io/tableau-mcp/docs/intro) lists `list-datasources`, `get-datasource-metadata`, `query-datasource`, and a hosted option at `mcp.tableau.com`. A build here would repeat it. |
| Tight query cap | 100 queries per hour per Creator licence for the whole site, shared with every other user. |
| Sign-in friction | PATs can be off by default on newer Cloud sites and allow one session. |
| Metadata API cost | Data Management on Cloud from October 2026. |
| Version drift | New endpoints arrive per release (for example view delete in API 3.27). Server sites may lag Cloud. |
| Developer site | May be wiped or throttled and is not for production data. |

## Go or no-go

**Go** for a read-only experiment: list data sources, describe fields, run a VDS query, shape it as `ReportResult`, draw it with the existing report view. **No-go** for create, update and delete of a saved report, because no documented API defines a view. Revisit if Tableau opens workbook authoring through an API, which the Tableau MCP page lists as coming.

Before any build, answer whether it is worth doing next to the official Tableau MCP server. The case for it is that this repo's `ReportResult` shape, report view and skills would work over Tableau data.

## Smallest next step (one to two days)

A read-only prototype outside `src/`, such as a script under `probes/`:

1. Sign in with a PAT on a free developer site (the person makes the site and token).
2. Call `read-metadata` and `query-datasource` for one sample data source, and a second query with no dimension for totals.
3. Map the answers to `ReportResult` and feed it to `reportResultToRows`.
4. Record the real answers, the real rate-limit behaviour, and whether the Create Custom View question has an answer, and settle the Unconfirmed list above.

Done looks like: one command prints a `ReportResult` for a Tableau question, the loader draws it, and the Unconfirmed list is shorter.
