---
name: report-runner
description: Explore data and answer questions from Salesforce reports and dashboards that already exist. Use when the user asks what is in a report or a dashboard, asks for a number a report could give (pipeline, bookings, forecast, win rate, activity), asks why a number moved, or wants a saved report cut another way (by owner, last quarter instead, without closed deals) to look at. This skill reads and never saves; it refreshes a dashboard only when the user says yes. For changing a report or making a new one, use report-designer. For moving a report between orgs or into git, use report-deploy.
---

# Answering from Salesforce reports

You are helping a seller or manager understand their data. They do not need to know what a report type or an API name is. Lead with the answer, say in words what the report counts, and offer the next question. Nothing here saves anything.

The tools named below may come from any door: the local MCP server, the hosted MCP server in the org, or the in-org REST door through the `sf` CLI. They take the same input and return the same result on each. If no tool named `search_reports` is connected, read [transport.md](transport.md) before the first call: it says how to pick the door, which org to use, and how to call each tool.

## The steps

1. **Find the report.** Call `search_reports` with the user's own words.
   - Several matches: show up to three, each with its folder and last run date, and ask which one.
   - One clear match: use it and say which one.
   - No match: say so, then use `query_report` to answer the question without a saved report (see "No saved report" below), and offer to save it afterwards.
2. **Say what it counts before you run it.** Call `describe_report`. Then give one or two plain sentences: what each row or group is, grouped by what, over which dates, and for whom. Scope matters ("only your opportunities"). Name silent defaults ("it only counts deals closing this fiscal quarter, because that is the default date range"). Read `filters` in the result for this; see `reference.md`.
3. **Run it and lead with the answer.** Call `run_report`. Say the headline first: the total and the biggest movers. Then the group table, at most about 10 rows inline, ranked. Then anything odd: an empty group, one deal carrying a stage, rows that were cut.
   - **Card or no card.** Where the host draws the result as a report card above your reply (Claude Desktop and other hosts that draw MCP Apps), lead with the one finding the card cannot show (concentration, change, risk, the next question), keep the reply short, and never repeat the card's rows, totals or a table. Without a card, give the headline and the group table as above.
4. **Offer the next slice.** Give two or three concrete follow-ups in the user's words, such as "by owner", "last quarter instead" or "without closed deals". Each becomes a `run_report` with `overrides`, which changes that run only. Take the column for a new slice from `describe_report_type` with a `search` word ("owner" finds `FULL_NAME` on Opportunity); a guessed name such as `OWNER` fails. Comparisons go through `combine_reports`: `stack` for this period against last, `join` for two measures by the same dimension.
5. **Always give the report link** from the result, and say when numbers are partial.

## No saved report

When no report fits, or the user wants a number cut a way no saved report does, use `query_report`. It defines the report in the call and saves nothing. Find the `reportType` with `list_report_types`, then the column names with `describe_report_type` (give it a `search` word). Never guess column names. The definition grammar is in `reference.md`. If the user likes the result and wants it kept, say you can save it as a report. Do not save it yourself; that is a different job and needs their yes. If `query_report` is not offered or answers `CALLOUT_SESSION`, follow "When the org refuses" below.

## Dashboards

Reach for a dashboard tool instead of a report run when the user names a dashboard ("the pipeline dashboard"), or asks for the set of figures a dashboard already gathers ("how does the board look this week"). For one number, or a cut no dashboard has, stay with reports: a report run is live and takes `overrides`; a dashboard shows what Salesforce cached at its last refresh. The dashboard tools are on the local server only.

1. **Find it** with `list_dashboards` and the user's words. Pick or ask as for reports.
2. **Learn its filters** with `describe_dashboard` when the user wants a slice ("only Prospecting"). Filters are chosen by name and option label, and only from the options the dashboard offers. For any other cut, run the source report a component names with `run_report` and `overrides`.
3. **Read it** with `run_dashboard`. Lead with the two or three components that answer the question, each by its header, and say when the data was refreshed and whose data it shows (`runningUser`). Read `notes`.
4. **No data or old data.** When a note says a component has no data, or the numbers are more than a day old, say so and offer `refresh_dashboard` with the same filters. Do not refresh without the user's yes: a refresh reruns every source report and changes what other viewers see. If it answers that the dashboard was refreshed less than a minute ago, give the cached numbers and the time to try again; do not retry at once.

## Never save

Do not call `create_report`, `update_report`, `clone_report` or `delete_report` from this skill. If the user wants a slice kept, or a report changed, say so plainly ("Want me to save this as a report?") and carry on only after they say yes.

## When something fails

A failed call returns an error with a code and a hint (`isError` on MCP, an `error` body on the REST door). Fix the input from the hint (usually a column name) and try once more. Do not retry blindly. If the write tools are missing, the server is read-only; that does not affect this skill.

## When the org refuses

A refusal is not a bad input. Never retry it.

- **`CALLOUT_SESSION`, `CALLOUT_CREDENTIAL`, or `query_report` is not offered.** The door cannot run unsaved definitions under this sign-in, so `query_report` and `list_report_types` will not work. For `CALLOUT_CREDENTIAL`, also pass on the `hint`: it names the permission set an admin assigns to fix it. These still work: `search_reports`, `list_report_folders`, `describe_report`, `run_report`, `combine_reports` over saved reports, and `describe_report_type` for a type that has a saved report (it reads the columns through that report). Say that in one sentence. Then answer through the closest saved report: find it with `search_reports`, and cut it the user's way with `run_report` and `overrides` (other groupings, columns, filters or dates). Say which report you started from and what you changed. If no saved report is close, say so and that an admin can fix the sign-in (on the hosted MCP server, by installing the optional callout package and assigning its permission set).

## Details

[transport.md](transport.md) has the doors and the REST call form. `reference.md` has how to read a result (filters, notes, cut rows), how to compare and combine, the definition grammar for `query_report`, and the limits.
