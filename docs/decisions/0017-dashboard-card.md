# 0017. The dashboard card is a second MCP App that draws every component as its chart

Status: Accepted, 2026-10-16

The card's type, chrome and chart colours now come from the Lightning Design System; the SLDS data-visualization palette replaces the dataviz skill's palette ([0018](0018-cards-follow-the-lightning-design-system.md)).

## Context

`run_dashboard` and `refresh_dashboard` ([0016](0016-dashboards-read-and-refresh-only.md)) return a `DashboardResult`: one `ReportResult` per component, in layout order. A dashboard is a picture, and in Claude Desktop a list of tables does not read as one. The report card ([0013](0013-report-view-as-an-mcp-app.md), [0015](0015-report-card-visuals.md)) already proves an MCP App works on the local door, with inline SVG, no chart library and no network. The probe dashboard has one component of each type the card must draw: Metric, Gauge, Donut, Bar, Line, Table, Funnel and Column.

Two things a tile needs are not in the `DashboardResult` that BE-25 shipped: the source report of a component with no data (only a component with data has a `result.report.url`), and a gauge's range and breakpoints. A metric or gauge result has no groups either, so it carries no measure label or type.

## Decision

- **A second view, not a mode of the first.** `src/widget/dashboard.html` is served at `ui://salesforce-reports/dashboard`, built beside the report view by `scripts/build-widget.ts` and inlined the same way by `src/widget/view.ts`. `run_dashboard` and `refresh_dashboard` carry it in `_meta.ui.resourceUri` and return the result as text and, unchanged, as `structuredContent`. The resource is served in `--read-only` mode too, since `run_dashboard` stays.
- **Additive fields on each component.** The server adds, from the raw dashboard it already read: `sourceReport` (`{id, url}`), `measure` (the first aggregate with its label and type), `metricLabel` for a metric, and `gauge` (`{min, max, breakpoints, colors}`) for a gauge whose bands have bounds. Nothing in `DashboardResult` moves, so Claude reads the same shape plus these, and the source report id is useful to `run_report` too. `src/reports/dashboards.ts` is unchanged; the join is `dashboardView` in `src/server.ts`, by component id.
- **One drawing per type.** Metric is a big number with its label. Gauge is a semicircle in bands split at the breakpoints, in the dashboard's own band colours, with a needle, the value, the range and the breakpoints. Donut shows the five largest groups and Other, with a legend that names each and gives its share. Bar draws horizontal bars and Funnel centred bands, each with its label and a compact value, at most ten rows (then Other). Column draws up to 24 columns (then Other), labelled under the first and last, with a value on the tallest; at six or fewer every column is labelled. Line draws up to 60 points with an area under it, and labels its peak and its last point. Table is a compact table of the groups, ten rows, then how many more. Any other type, or a chart the numbers cannot make (a measure that does not add up over several groupings, no positive value), falls back to that table.
- **Leaf rows are summed by the first grouping,** as on the report card, so a chart needs a measure that adds up or a single grouping.
- **Layout.** Tiles keep the layout order the result already has, on a grid three across at 700 px and wider, two from 520 px, and one below that. A chart is drawn in pixels to its tile's width, so its text never scales; it is redrawn without motion when the card changes width.
- **Each tile** shows its header (and title when both are set), its footer, a muted dashed state that says to refresh the dashboard when it has no data, or Salesforce's message when it failed. Its header links to the source report and opens through `app.openLink`. The card's header shows the dashboard name (linked the same way), the refresh time and the filters as chips; the notes and an Open in Salesforce button close the card. The card never refreshes or calls a tool.
- **The rules of 0015 hold.** Inline CSS and SVG built with `createElementNS`, every value through `textContent`, no chart library, no network. Each chart is `role="img"` with a `title` and a `desc` that gives every value in words, and each mark has its own `title`. Text uses the text tokens only, never a series colour. The donut uses the reference categorical palette from the dataviz skill, stepped for each theme. Charts grow in on first paint and stand still under `prefers-reduced-motion`.
- **A hint in both descriptions.** `run_dashboard` and `refresh_dashboard` end with `DASHBOARD_VIEW_HINT`: where the card is drawn, lead with the one finding it cannot show (what moved, what is missing or stale, a risk, the next question), keep the reply short, and never repeat its numbers. The dashboard tools are not on the hosted door, so nothing strips it there.

## Consequences

- Claude Desktop shows a dashboard at a glance, and Claude's reply can carry the insight rather than the figures.
- The `DashboardResult` grows four optional fields per component; design.md documents them.
- The render tests gain four screenshots (light, dark, 360 px, no data). The darwin baselines come with the change; the linux ones come from the CI render job's artifact, as for 0015.
- Currency is still drawn as US dollars ([0015](0015-report-card-visuals.md)).
- Salesforce's own options (sort, show values, legend position, grouped or stacked bars, dynamic gauge segments) are not followed. A stacked or grouped chart draws its first grouping, summed.

## Alternatives turned down

- **One view for reports and dashboards.** A single template would carry both renderers into every card, and the report card's tests and baselines would move for a dashboard change.
- **A chart library.** The same reasons as in 0015.
- **Reading the gauge range and source report in the view from another call.** The view never calls a tool; the server has the raw dashboard already.
- **Placing tiles by the dashboard's own 12-column grid.** Spans of 3 and 6 columns do not survive a 360 px card, and the layout order already keeps the reading order.
