# 0015. The report card draws its own visuals in inline CSS, with no chart library

Status: Accepted, 2026-10-15

The card's type, chrome and colours now come from the Lightning Design System tokens, and its bars, columns and heat grid use the SLDS data-visualization palette ([0018](0018-cards-follow-the-lightning-design-system.md)).

## Context

The report view ([0013](0013-report-view-as-an-mcp-app.md)) drew a `ReportResult` as plain tables. In Claude Desktop that showed the rows but not the answer, and the README demo needs a card that reads at a glance. The view is one self-contained HTML document with no network, so anything it draws must be inline. The `ReportResult` contract is shared by three doors and must not move for a picture.

## Decision

- **Inline CSS, no chart library.** Bars and heat shading are plain elements styled with CSS (`color-mix` on the host's accent colour). Values reach the page through `textContent`, and widths and shades through CSS custom properties set with the CSSOM, so nothing new needs a CSP allowance.
- **A KPI strip across the top** shows up to three figures:
  - the grand total of the primary measure: the first measure that is not the record count, since the count has its own tile. Currency is formatted;
  - the record count, when the totals carry `RowCount`;
  - the largest top-level group's share of the total, with its label. Leaf rows are summed by the first grouping, so a summary grouped by stage and month reads "Largest Stage 38.5%, Negotiation/Review". The share uses the primary measure when it adds up (a sum or the count) and the record count otherwise, since an average or a maximum has no share. It is left out when there is only one group or the total is not positive.
- **Data bars** sit beside the primary measure in each group row of a summary: a track on the left and the number on the right, in one width for the whole column, so a bar never sits under text and every track has the same length. Bars are scaled to the largest row. They grow in on first paint and stand still under `prefers-reduced-motion`.
- **A matrix draws as a grid**: down labels as rows, across labels as columns, the primary measure in each cell, shaded by its value against the largest cell, with row and column totals. Totals are sums, so they show only for a measure that adds up; the corner is the report's own grand total. The grid is the card: the full group table, which has every measure, waits below it in a closed "All groups (N)" disclosure.
- **Heat shading in two bands.** A cell below 60% of the largest is shaded lightly under the normal text. A cell at 60% or more is hot: a deep shade with the text in the background colour, so the top cells read at a glance in both themes. No single shade range keeps one text colour at WCAG AA from pale to saturated, so the shade jumps between the bands. The render tests check AA contrast on every cell in light and dark.
- **Formats.** Currency draws as `$1,276,000`, with cents only when the amount has them. Percents end in `%`, and an ISO date draws as `Dec 15, 2026` in UTC so its day does not move. A blank or null value draws as a muted `-` everywhere.
- **`ReportResult` is unchanged.** Everything is derived in the view from what the result already carries.

## Consequences

- No new dependency and no network. The card stays one document.
- `ReportResult` has no currency code, so currency draws as US dollars in every org. An org in another currency sees the wrong symbol until the result carries the code; that would be an additive field, documented in design.md.
- A matrix with several down or across groupings joins their labels with ` / ` in one row or column header.
- The view looks different, so the render baselines change on both platforms. The darwin ones are updated with the change; the linux ones come from the CI render job's artifact.

## Update, 2026-10-16: a column chart and a narrow layout

At 360 px the group and detail tables scrolled sideways inside the card, so the amounts and bars were cut off. A summary also showed its answer only as rows. Both changes keep the rules above: inline CSS and SVG in the one view, no chart library, values through `textContent`, and `ReportResult` unchanged.

- **A column chart above a summary's groups.** One column per top-level group for the primary measure, in report order, scaled to the largest. Leaf rows are summed by the first grouping, as for the share in the KPI strip, so the chart needs a measure that adds up, or a single grouping where the rows are the groups. After 12 groups the rest are summed into one Other column; a measure that does not add up has no Other, so it draws no chart past 12. The chart needs at least two groups and a positive largest value, and a negative group draws as an empty column.
- **How it is drawn.** Inline SVG built with `createElementNS`, with every label and value set through `textContent`. Columns sit in percent slots (at least six, centred), so the chart fills any width without scaling its text. Labels are in the card font and are shortened with an ellipsis to fit their slot, refitted when the card changes width. A compact value sits on each column and is hidden when it does not fit. The SVG has `role="img"`, a `title` that names the chart and a `desc` that lists every group with its full value; each column also carries a `title`. Columns grow in on first paint and stand still under `prefers-reduced-motion`.
- **Where it is drawn.** Summaries only. A tabular card has no groups and draws no chart. A matrix keeps its heat grid and draws no chart, since the grid already is the picture.
- **The narrow layout.** At 480 px or less every table folds. Each row becomes a small grid of its own: the grouping labels stack on the left, the primary measure and its bar sit on the right, and every other column stacks under the row as its header and its value. A detail row keeps its first column on top and stacks the rest the same way. The header label comes from a `data-label` attribute read by CSS, so the DOM keeps one cell per column and the text stays the same at every width. The render tests check that no table or scroll box is wider than its own box at 360 px.

This supersedes "SVG charts beside the tables" below for summaries: the table still holds every number, and the chart shows the shape of the top-level groups at a glance.

Consequences: the folded rows lose the table's column alignment for the stacked cells, and Chromium may drop table semantics for a table whose display changes, so a screen reader can hear the narrow table as plain text. The chart repeats the top-level figures that the KPI strip and the table already hold.

## Alternatives turned down

- **A chart library (Chart.js, ECharts, Vega).** It adds tens to hundreds of kilobytes to every card for a few bars, and draws on a canvas whose text Claude's host and the render tests cannot read.
- **SVG charts beside the tables.** They repeat the numbers in a second place. Bars and shading inside the tables keep one place to read.
- **The first measure as listed, even when it is the record count.** The strip would then show the count twice.
- **The largest leaf row for the share.** In a summary grouped by stage and month, one month of one stage is not the answer a reader looks for.
