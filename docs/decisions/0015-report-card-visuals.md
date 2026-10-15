# 0015. The report card draws its own visuals in inline CSS, with no chart library

Status: Accepted, 2026-10-15

## Context

The report view ([0013](0013-report-view-as-an-mcp-app.md)) drew a `ReportResult` as plain tables. In Claude Desktop that showed the rows but not the answer, and the README demo needs a card that reads at a glance. The view is one self-contained HTML document with no network, so anything it draws must be inline. The `ReportResult` contract is shared by three doors and must not move for a picture.

## Decision

- **Inline CSS, no chart library.** Bars and heat shading are plain elements styled with CSS (`color-mix` on the host's accent colour). Values reach the page through `textContent`, and widths and shades through CSS custom properties set with the CSSOM, so nothing new needs a CSP allowance.
- **A KPI strip across the top** shows up to three figures:
  - the grand total of the primary measure: the first measure that is not the record count, since the count has its own tile. Currency is formatted;
  - the record count, when the totals carry `RowCount`;
  - the largest top-level group's share of the total, with its label. Leaf rows are summed by the first grouping, so a summary grouped by stage and month reads "Largest Stage 38.5%, Negotiation/Review". The share uses the primary measure when it adds up (a sum or the count) and the record count otherwise, since an average or a maximum has no share. It is left out when there is only one group or the total is not positive.
- **Data bars** sit behind the primary measure in each group row of a summary, scaled to the largest row and drawn from the left edge of the cell, so bars compare across rows whatever the width of the number. They grow in on first paint and stand still under `prefers-reduced-motion`.
- **A matrix draws as a grid**: down labels as rows, across labels as columns, the primary measure in each cell, shaded by its value against the largest cell, with row and column totals. Totals are sums, so they show only for a measure that adds up; the corner is the report's own grand total. The group table stays below the grid, since the grid shows one measure.
- **Formats.** Currency draws as `$1,276,000`, with cents only when the amount has them. Percents end in `%`, and an ISO date draws as `Dec 15, 2026` in UTC so its day does not move. A blank or null value draws as a muted `-` everywhere.
- **`ReportResult` is unchanged.** Everything is derived in the view from what the result already carries.

## Consequences

- No new dependency and no network. The card stays one document.
- `ReportResult` has no currency code, so currency draws as US dollars in every org. An org in another currency sees the wrong symbol until the result carries the code; that would be an additive field, documented in design.md.
- A matrix with several down or across groupings joins their labels with ` / ` in one row or column header.
- The view looks different, so the render baselines change on both platforms. The darwin ones are updated with the change; the linux ones come from the CI render job's artifact.

## Alternatives turned down

- **A chart library (Chart.js, ECharts, Vega).** It adds tens to hundreds of kilobytes to every card for a few bars, and draws on a canvas whose text Claude's host and the render tests cannot read.
- **SVG charts beside the tables.** They repeat the numbers in a second place. Bars and shading inside the tables keep one place to read.
- **The first measure as listed, even when it is the record count.** The strip would then show the count twice.
- **The largest leaf row for the share.** In a summary grouped by stage and month, one month of one stage is not the answer a reader looks for.
