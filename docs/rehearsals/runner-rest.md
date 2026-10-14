# Rehearsal: report-runner over the REST door

Prompt: "I'm a seller. How is our pipeline looking this fiscal year? Is there anything I should worry about, and can you show it to me by owner too? My Salesforce org is the CLI alias dev-frontend-2."

This is the prompt of [runner.md](runner.md) plus the last sentence, so that a headless run need not ask for the alias. No MCP server ran. Every tool call went through `sf api request rest` to `/services/apexrest/reports/v1/<tool>`, as `skills/report-runner/transport.md` says. The fixture was "zz-rehearsal Pipeline by Stage" (summary, grouped by stage, close date this fiscal year, whole org).

Four runs. Run 1 was a setup mistake. Runs 2 and 3 each showed a gap in `transport.md`, which was fixed before the next run.

## Run 1: the skill could not read its own files

Tool calls: `Skill(report-runner)`, a `cat` of `transport.md` and `reference.md` (refused), `ToolSearch("search_reports")` (no match, which is how it decided no MCP tool was there), two `Read` calls (refused), `sf org display` (refused).

Final answer: it said no report tools were connected, that reading `transport.md` was refused, and asked for permission. Nothing was run.

What went wrong: the rehearsal allowed no reads outside the working directory, and the plugin folder is outside it. This was the rehearsal's limit, not the skill's. Change made: the rehearsal allows `Read` on the plugin's `skills/` folder from run 2 on.

## Run 2: first real run

Tool calls: `Skill`, `Read(transport.md)`, `Read(reference.md)`, then `search_reports` through a heredoc (refused by Claude Code: "Contains brace with quote character"), then each call as a body file and one `sf api request rest`: `search_reports` (1 match), `describe_report`, `run_report`, `describe_report_type` with `reportType` (failed: `INVALID_INPUT`, "type is required."), `describe_report_type` with `type` and `search: "owner"`, `run_report` with `groupingsDown` on `FULL_NAME` then `STAGE_NAME`, and `run_report` with `reportMetadata.standardFilters: []` to see what the probability filter hides.

Final answer: "$3.09M across 8 opportunities", a by-stage table, a by-owner table (Owner 1 $2.80M across 6 deals, Owner 2 $291K across 2), five worries (one owner holds 91 percent, one $900K deal is 29 percent of the total, $1.19M in Negotiation/Review, a thin early funnel, a $0 deal), the report link and three next cuts. It said the attempt to drop the probability filter did not change the result, so Closed Lost stays hidden. The first half was right, and the tool said nothing about it; the second half was wrong, because `probability: >0` hides nothing (checked 2026-10-14, [live finding](../design.md#live-findings-checked-2026-10-11-api-v620-scriptslive-checkts)): Salesforce ignores an empty `standardFilters` list ([live finding](../design.md#live-findings-checked-2026-10-11-api-v620-scriptslive-checkts), [checked below](#the-standardfilters-override-checked)). `run_report` now says so in `notes`.

What went right: the same find, describe, run, slice order as the local runner, the owner column taken from `describe_report_type`, the hidden default named. What went wrong, both from `transport.md`:

- It offered a heredoc as the fallback, and the model tried it first. Claude Code refuses a heredoc that carries JSON.
- It gave no input field names. Over MCP the tool schema carries them; over REST the model guessed `reportType` for `describe_report_type`, whose field is `type`.

Change made: `transport.md` dropped the heredoc and says to use a body file only, and its tool table gained the input fields of every tool, with required ones in bold and "`type` (not `reportType`)" called out. `test/skills.test.ts` checks the bold names against the server's schemas.

## Run 3: after the first change

Tool calls: `Skill`, `Read` of both files, one Bash command that made the body file with `mkdir` and `printf` before the `sf` call (refused: more than one operation), then body file and `sf` for `search_reports`, `describe_report`, `run_report`, `describe_report_type` (`type` right first time), `run_report` by owner, `run_report` with detail columns that included the grouping `STAGE_NAME` (failed: `INVALID_REPORT_METADATA`, "You can't include groupings in the selected columns list"), and the same without it.

Final answer: the same headline and tables, with worries drawn from the deal rows: one account (Account 1) holds 5 deals and 91 percent, all of them closing in December, one deal with no amount, two of Owner 2's deals closing within a month while still in negotiation, no closed-won rows. Report link, three next cuts, "I haven't saved anything."

What went wrong: the model made the body file in the shell first, which Claude Code refuses. The grouping-in-columns failure is a Salesforce rule the local runner meets too; the hint fixed it in one call. Change made: `transport.md` now says not to make the file in the shell (`echo`, `printf`, `mkdir`, `>`), and to run the `sf` call as a command of its own.

## Run 4: after the second change

Tool calls: `Skill`, one `cat` of `transport.md` and `reference.md`, then body file and `sf` for `search_reports` (1 match), `describe_report`, `run_report`, `describe_report_type` (`type`, `search: "owner"`), `run_report` by owner, `run_report` by owner and stage with deal rows. No refused call and no failed call.

Final answer: "$3.09M across 8 deals", what the report counts (close date this fiscal year, whole org, Closed Lost hidden by the probability filter), the by-stage and by-owner tables, five worries (Account 1 concentration, everything closing in December, Owner 2's two near-term deals, a thin top of funnel with a $0 deal, early-stage deals with far to go), caveats (unweighted totals, no win rate while Closed Lost is hidden), three next cuts and the link. One slip: it said "5 of 6 deals" and later "all six" for Account 1.

## Against the local runner

| | Local, run 3 ([runner.md](runner.md)) | REST door, run 4 |
| --- | --- | --- |
| Door | local MCP server | `sf api request rest`, no MCP server |
| Tool order | search, describe, run, describe type, run by owner | the same, plus one run with deal rows |
| Failed or refused calls | 0 | 0 |
| Headline and tables | $3.09M, 8 deals, by stage and by owner | the same numbers |
| Hidden default named | yes | yes |
| Saved anything | no | no |
| Cost | not recorded | $0.25 |

Each REST call is two steps, a file write and one `sf` command, so the transcript is about twice as long. The answer is the same. Run 2's `run_report` override of `reportMetadata.standardFilters` did not remove the probability filter on the door, and nothing said so. That is closed below.

## The standardFilters override, checked

Checked on 2026-10-12 in `dev-frontend-2`, on a private Opportunity summary report grouped by stage, close date 2020-01-01 to 2030-12-31, whole org, saved with `open: all` and `probability: >0`. Each run posted `{"reportMetadata": <override>}` to `/analytics/reports/<id>?includeDetails=false` on the REST API, and the same override went to the in-org door's `run_report` (Apex `Reports.ReportManager.runReport`). The report was deleted afterwards.

| `reportMetadata` sent | `standardFilters` returned | Rows | Amount |
| --- | --- | --- | --- |
| nothing (GET, as saved) | `open: all`, `probability: >0` | 9 | 3,128,000 |
| `{"standardFilters":[]}` | `open: all`, `probability: >0` | 9 | 3,128,000 |
| `{"standardFilters":null}` | `open: all`, `probability: >0` | 9 | 3,128,000 |
| `{"standardFilters":[{"name":"open","value":"closed"}]}` | `open: closed`, `probability: >0` | 1 | 37,000 |
| `{"standardFilters":[{"name":"probability","value":"gt50"}]}` | `open: all`, `probability: gt50` | 6 | 2,348,000 |
| `{"standardFilters":[{"name":"open","value":"all"},{"name":"probability","value":"lt10"}]}` | `open: all`, `probability: lt10` | 0 | 0 |
| `probability` `>50`, `all`, `0` or `>=0` | error: `value "…" is not one of the picklist choices.` | | |
| `{"standardFilters":[{"name":"nosuch","value":"x"}]}` | error: `nosuch is not a valid standard filter for this report.` | | |

`/analytics/reports/query` with `standardFilters: []` also came back with both defaults. The in-org door gave the same filters and totals for `[]`, `open: closed` and `open: all` with `probability: gt50`, and `INVALID_FILTER` for `>50`. The report type's `standardFilterInfos` lists `probability` as `>0` ("All"), `gt10` to `gt90` and `lt10` to `lt90`, and `open` as `all` ("Any"), `open`, `closed` and `closedwon`.

Before the change, the local server's `run_report` with `{"standardFilters":[]}` listed `Standard filter probability: >0` in `filters` and returned `notes: []`. After it, both doors add: "Salesforce ignored reportMetadata.standardFilters: an empty list does not clear a report's standard filters, so these still apply: open: all, probability: >0. To change one, list it by name with another of its values." A partial list adds "Standard filters left out of reportMetadata.standardFilters keep their saved values: probability: >0." `scripts/parity-check.ts` checks both, and `query_report` with `[]`, on the two doors.
