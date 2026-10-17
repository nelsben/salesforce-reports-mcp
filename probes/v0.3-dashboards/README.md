# v0.3 dashboard probe

A self-contained SFDX project that puts one dashboard in an org, so the dashboard tools have something real to read, refresh and capture. Findings are in `docs/probes/v0.3-dashboards.md`.

It deploys:

| Component | What it is |
| --- | --- |
| Report folder `Dashboard_Probe` | Three Opportunity summary reports, all close dates 2020 to 2030 |
| `Pipeline_by_Stage` | Sum of Amount by Stage |
| `Amount_by_Close_Month` | Sum of Amount by close month |
| `Won_by_Stage` | Sum of Amount for won deals |
| Dashboard folder `Dashboard_Probe_Dashboards` | |
| Dashboard `Pipeline_Overview` | Eight components: Metric, Gauge, Donut, Bar, Line, Table, Funnel, Column. One filter, Stage, with three options, applied to every component. Runs as a specified user. |

## Deploy

Run from this folder, with an org alias you may write to:

```
scripts/setup.sh dev-frontend-2
```

The tracked dashboard names its running user `__RUNNING_USER__`. The script fills in the CLI user's username in a temp copy and deploys from there, so no username reaches the repo.

## Remove

```
sf project deploy start --manifest destructive/package.xml --post-destructive-changes destructive/destructiveChanges.xml -o dev-frontend-2
```

## Two things the metadata API insists on

- A chart, metric or gauge component that names a `chartSummary` or `groupingColumn` must set `autoselectColumnsFromReport` to false. With true, the deploy fails: "The values of chartSummary and/or groupingColumn are not compatible with the autoselectColumnsFromReport mode".
- A dashboard filter needs a `dashboardFilterColumns` entry on every component.
