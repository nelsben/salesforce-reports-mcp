# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

An MCP server, plus Claude skills, that lets Claude find, define, run, save and combine Salesforce reports through the Salesforce Reports and Dashboards REST API. Nothing is installed in the Salesforce org.

- [docs/design.md](docs/design.md) is the contract for the tools: the `ReportDefinition` input, the `ReportResult` output, safety, and live findings that corrected the first draft.
- `docs/experiences.md` describes how people use the tools: the report runner, the report designer and report deploy, each a skill.
- [docs/architecture.md](docs/architecture.md) maps the three doors and the Apex layers; [docs/decisions/](docs/decisions/README.md) records why. A change that moves a decision gets a new record.

Read the relevant one before changing behaviour, and update it in the same change when behaviour moves.

## Commands

```bash
npm install
npm run build                       # tsc, strict
npm test                            # vitest: unit, fixtures, MCP server tests
npm run test:render                 # Playwright: draws the report view through a test host (after npm run build)
npm run demo:gif                    # remakes docs/assets/report-view.gif from the test host (needs ffmpeg)
npm run live -- --org <alias> --allow-delete   # every tool against a real org; leaves no report behind
npm run capture -- --org <alias>    # recapture test fixtures (then anonymise; see below)
node dist/index.js --org <alias>    # run the server over stdio
node dist/index.js --org <alias> --http 8787   # the same server over HTTP on loopback (door 4; add --public-url and SF_REPORTS_HTTP_PASSCODE behind a tunnel)
```

CI runs build and test on Node 20 and 22. The live check needs a real org and runs by hand only.

## Layout

| Path | Holds |
| --- | --- |
| `src/salesforce/` | connection (sf CLI or token, refetch on 401) and the REST client |
| `src/reports/api.ts` | thin calls to the Reports REST API and SOQL |
| `src/reports/definition.ts` | the friendly `ReportDefinition` and its mapping to `reportMetadata` |
| `src/reports/shape.ts` | factMap to `ReportResult` |
| `src/reports/summarize.ts`, `combine.ts` | describe summaries, stack and join |
| `src/server.ts` | tool registration; tool descriptions are prompts Claude reads |
| `src/http.ts`, `src/http-auth.ts` | door 4: Streamable HTTP at `/mcp`, and its own OAuth 2.1 server for one owner (passcode page, tokens held as hashes in memory) |
| `src/widget/` | the report view: one self-contained HTML MCP App that `run_report` and `query_report` carry on the local door |
| `skills/` | the Claude skills |
| `test/fixtures/` | captured, anonymised API responses and expected results |

## Conventions

- **Tool descriptions are prompts.** Each says when to use the tool, what it returns, and how it differs from its neighbours. Every input has a description.
- **Results stay compact.** Return a `ReportResult`, never the raw factMap. Say in `notes` whenever rows were cut or the input was adjusted.
- **Writes are explicit.** No tool saves as a side effect. `delete_report` exists only with `--allow-delete`, and `--read-only` removes every write tool.
- **No secrets anywhere.** A token never reaches stdout, stderr, logs, error messages, fixtures or commits. Newer `sf` CLI versions redact the token in `sf org display`, so the server reads it from `sf org auth show-access-token`.
- **Fixtures are anonymised.** Account, opportunity, contact and user names become neutral ones (`Account 1`). The instance URL becomes `https://example.my.salesforce.com`. Structure, types and numbers are kept.
- **Salesforce quirks are handled in code and noted**, for example aggregated columns must also be detail columns, and Opportunity reports carry silent default filters. Add new ones to design.md's live findings.
- Runtime dependencies are the MCP SDK, zod and `@modelcontextprotocol/ext-apps` (the report view only). Requests use the global `fetch`.
- Work on a branch and open a PR. `main` takes merge commits, so stacked branches stay clean.
