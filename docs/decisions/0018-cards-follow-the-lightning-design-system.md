# 0018. The report card and the dashboard card follow the Lightning Design System, as token values only

Status: Accepted, 2026-10-16

## Context

Both cards draw Salesforce data, so they should look like Salesforce. Until now the report card ([0015](0015-report-card-visuals.md)) and the dashboard card ([0017](0017-dashboard-card.md)) used ad hoc sizes, greys and series colours. Each card must stay one self-contained HTML document that loads nothing from the network ([0013](0013-report-view-as-an-mcp-app.md)), so the Salesforce Lightning Design System (SLDS) stylesheet and the Salesforce Sans font files cannot come in. The host still owns the surface: Claude Desktop passes `--color-background-primary`, `--color-text-primary` and `--color-border-primary`, and the cards already honour them.

## Decision

- **Tokens only.** `src/widget/tokens.css` holds the SLDS values the cards use, as `--slds-*` custom properties on `:root`. No SLDS class names, no SLDS bundle, no font file, no `url()`, `@font-face` or `@import`. The values are vendored by hand, not installed, so no dependency is added.
- **One file, inlined at build.** Each template starts its `<style>` with a `/*@slds-tokens*/` marker. `scripts/build-widget.ts` replaces it with `tokens.css` when it writes `dist/widget/`, and `src/widget/view.ts` does the same when it serves a template from source, so the tests and the built server draw the same card.
- **Where the values come from.** The package is `@salesforce-ux/design-system` 2.264.1 (npm, BSD-3-Clause). The header of `tokens.css` names it and carries its copyright notice.

  | Token file (`design-tokens/dist/`) | Values | Card parts |
  | --- | --- | --- |
  | `font.raw.json` | the font stack after "Salesforce Sans" | all text: "Salesforce Sans" where the host has it, then the system fallbacks |
  | `theme-one-salesforce.json` | font sizes 2 to 9, regular and bold weights, text and heading line heights, spacing xxx-small to medium, small and card radius, card border, card shadow, brand accessible blue and its active shade | the title, tile headers, body, captions and the big numbers; padding and gaps; chips, tiles and buttons; the Save button and the dashboard's Open button |
  | `slds-hooks.raw.json` | link colour and link hover | links, the neutral Open button's text, and the focus ring (shadow-outset-focus-1, drawn as 2px of the surface then 2px of the link colour) |
  | `palettes.json` | neutrals 10 to 100, blue 70 and 80, red 60, orange 65, green 60 | light and dark fallbacks for the surface, text and rules; dark-mode links; gauge bands when a dashboard sets none |

- **The chart palette.** The data-visualization colours are not in the package's token files. They come from the SLDS guidelines, Data Visualization, Charts, "Chart Color": http://v1.lightningdesignsystem.com/guidelines/data-visualization/charts/ (read 2026-10-16). The cards use the Default Palette in order: `#52B7D8`, `#E16032`, `#FFB03B`, `#54A77B`, `#4FD2D2`, `#E287B2`. Following the guideline, a chart of one measure takes one colour, categories take the palette in order, and a continuous value takes shades of one colour. So the report card's bars, column chart and heat grid, and the dashboard's bar, column and line, are in palette colour 1. The donut's slices and the funnel's stages take colours 1 to 6 in order, and Other is a neutral grey.
- **Named dashboard palettes.** Salesforce Help, "Color Palettes for Dashboards" (https://help.salesforce.com/s/articleView?id=analytics.dashboards_color_theme.htm&language=en_US&type=5, read 2026-10-16), says a dashboard chooses one of fourteen palettes, with Wildflowers the default and Mineral the accessible one. It publishes no colour values. The SLDS guideline above publishes four of those names with values, each in its order, and `tokens.css` carries them: Bluegrass, Sunrise, Water and Watermelon. The dashboard card reads `colorPalette` on the result, the dashboard or a component, lower-cased. When it names one of those four, the card sets `data-palette` on the root or the tile and the series colours switch to that palette. Any other name draws the Default Palette, including "unity", which the probe dashboard reports and no source defines.
- **The palette name does not reach the card yet.** `DashboardResult` does not carry `colorPalette`, and `dashboardView` in `src/server.ts` does not add it. Until it passes `dashboardMetadata.colorPalette` through, every dashboard draws the Default Palette. The card's side is in place and render-tested with an injected name.
- **Gauge bands keep the dashboard's colours.** When a dashboard sets none, the bands are SLDS red 60, orange 65 and green 60. These, and the palette colours, are only ever fills. Text uses the text colours only.
- **The host sets the surface first.** Background, secondary background, text, secondary text and border read the host's `--color-*` variables, with the SLDS neutrals as the fallbacks: neutral 100, 95, 10 and 30 in light, and neutral 15, 20, 95 and 70 in dark. Everything else (type, spacing, chrome, brand blue, the palette) is SLDS in every host.
- **Contrast.** Every text node, heat cell and chart label keeps WCAG AA in light and dark, checked by the render tests. Palette colour 1 is light, so a hot heat cell keeps the normal dark text in light mode, and takes neutral 10 as its text in dark mode, where the hot shade starts at 80%. White text sits only on brand blue (4.6:1).

## Consequences

- The cards read as Salesforce, in a host that does not have Salesforce Sans too.
- Every render baseline changes. The darwin baselines are updated with this change. The linux ones come from the CI render job's artifact, as for 0015 and 0017.
- A token value that SLDS changes later does not move here until `tokens.css` is updated by hand.
- The dashboard's Open in Salesforce button is a brand button, since it is the card's one action. On the report card, Save this report is the brand button and Open in Salesforce is neutral.

## Alternatives turned down

- **Inlining the SLDS stylesheet.** It is several hundred kilobytes, references font and icon URLs, and styles by class names the cards do not use.
- **Bundling Salesforce Sans.** A font file breaks the one-document rule or adds a large data URI, and the host's own font is a fine fallback.
- **Inventing values for the other ten named palettes.** No published source gives them, so the card draws the Default Palette instead.
