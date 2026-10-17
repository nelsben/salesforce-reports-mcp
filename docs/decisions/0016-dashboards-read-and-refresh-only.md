# 0016. Dashboards are read and refreshed, never saved, and listed through SOQL

Status: Accepted, 2026-10-16

## Context

v0.3 brings dashboards to the local server. A dashboard is a set of components, each a chart or table over a saved report, with up to three filters and a running user. The [v0.3 dashboards probe](../probes/v0.3-dashboards.md) pinned the REST API down on `dev-frontend-2`:

- `GET /analytics/dashboards` lists only recently viewed dashboards, and returned nothing for a dashboard no one had opened in the UI.
- `GET /analytics/dashboards/{id}` reads cached results. A dashboard never refreshed for a filter value answers 200 with `NO_DATA` on every component.
- `PUT /analytics/dashboards/{id}` refreshes: every component reruns its source report, and the cache everyone sees changes. A second refresh inside a minute answers 403.
- Each component's data is an ordinary report run, so the existing `shapeResult` reads it.

The REST API can also create, change and delete dashboards. People ask about the numbers a dashboard gathers far more often than they ask to rebuild one, and a dashboard's layout is easier to get right in the Lightning builder than in JSON.

## Decision

- **Read and refresh only.** Four tools: `list_dashboards`, `describe_dashboard`, `run_dashboard` and `refresh_dashboard`. No tool creates, saves, clones or deletes a dashboard.
- **Refresh counts as a write.** It saves nothing, but it reruns every source report against the org's limits and changes what every other viewer sees. So `refresh_dashboard` carries the write annotations, is registered after the `--read-only` cutoff, and the report runner skill refreshes only with the user's yes. `run_dashboard` never refreshes on its own; it says when data is missing or more than a day old and points to `refresh_dashboard`.
- **SOQL for listing.** `list_dashboards` queries `Dashboard` by title, developer name and folder, as `search_reports` queries `Report`. SOQL returns the dashboards the signed-in user can see, viewed or not. The last refresh comes from `/status`, because the SOQL field `DashboardResultRefreshedDate` stayed null after REST refreshes.
- **One result shape.** `run_dashboard` and `refresh_dashboard` return a `DashboardResult` whose components each carry a `ReportResult` from `shapeResult`, so a component reads like a `run_report` result ([design.md](../design.md#dashboardresult-output)).
- **Filters by name and label.** Callers name a filter and an option label; the server maps them to option ids from describe and sends `?filter<n>=<optionId>` on the query string, the only form the probe found to work. An unknown name or label is refused with the valid ones, before any data call.
- **The once-a-minute 403 is a note, not a failure.** `refresh_dashboard` returns the cached results and says when to try again.
- **Local door only, for now.** The in-org doors do not carry the dashboard tools, and the skills' transport lists leave them out.

## Consequences

- Claude can answer "how does the pipeline dashboard look" with the dashboard's own components and filters, and say how fresh the numbers are.
- A user who wants a dashboard changed does it in Salesforce. A component's source report can still be run, cut and saved with the report tools.
- `list_dashboards` makes one `/status` call per match (five at a time) to give the last refresh, so its limit is capped at 50.
- Only `filter1` is proven. The numbering for a second and third filter follows describe's order and is inferred, not tested.
- A refresh may take longer than 60 seconds on a large dashboard. The tool then returns what is cached with a note, and `run_dashboard` reads the rest later.

## Alternatives turned down

- **`GET /analytics/dashboards` for listing.** It misses every dashboard the user has not opened recently.
- **Dashboard saves (create, update, clone, delete).** A large JSON surface for a rare need, with layout that is easier to get right in the builder. Can be added later behind its own decision.
- **Refresh inside `run_dashboard` when data is missing.** It would make a read tool write, and spend the once-a-minute refresh without the user asking.
- **Refresh as a read tool.** It changes what others see, so `--read-only` must be able to remove it.
