# Rehearsal: report-designer over the REST door

Prompt: "Start from my 'zz-rehearsal Pipeline by Stage' report and group it by owner as well, owner first and then stage. Show me a preview first, and then save it as a new report called 'zz-rehearsal Pipeline by Owner' (a new one, leave the original alone). I am happy for you to go ahead and save once the preview looks right. My Salesforce org is the CLI alias dev-frontend-2."

No MCP server ran. Every tool call went through `sf api request rest` to `/services/apexrest/reports/v1/<tool>`, as `skills/report-designer/transport.md` says. The CLI user holds the permission set `Salesforce_Reports_MCP_Write`, so the save went through the door. The fixture was the one of [runner-rest.md](runner-rest.md). The runs came after runner runs 1 to 3, so `transport.md` already listed the input fields and had no heredoc.

Two runs.

## Run 1

Tool calls: `Skill(report-designer)`, one `cat` of `transport.md` and `reference.md`, one Bash command that made the body file with `mkdir` and `echo` before the `sf` call (refused: "Quoted text in this command can't be checked before it runs"), then each call as a body file and one `sf api request rest`: `search_reports`, `describe_report`, `describe_report_type` (`type: "Opportunity"`, `search: "owner"`), `run_report` with `overrides.groupingsDown` on `FULL_NAME` then `STAGE_NAME` (the preview), and `create_report` with `fromReportId` and the same groupings.

Final answer: the new report's name and link, "The original was not touched", the preview table by owner then stage (Owner 2 $291K in Negotiation/Review, Owner 1 across six stages, total $3,091,000 over 8 deals), that columns, filters and totals match the original with the probability default still hiding Closed Lost, that it sits in Private Reports with an offer to move it, and that it used the `sf` CLI because no MCP tools were connected.

What went right: the whole flow of the local designer, with the owner column looked up and not guessed, a preview before the save, `fromReportId` with only the groupings in one call, the original left alone, the Private Reports note. What went wrong: the same shell-made body file that runner run 3 hit. Change made: `transport.md` says not to make the file in the shell and to run the `sf` call as a command of its own (the same change as runner run 3). One wording slip: it called the preview "all open and won deals".

## Run 2: after the change

Tool calls: `Skill`, one `cat` of both files, then body file and `sf` for `search_reports`, `describe_report`, `describe_report_type`, `run_report` (preview), `create_report` with `fromReportId`. No refused call and no failed call.

Final answer: the link, "The original is unchanged", the same preview table and total, the inherited probability filter in words, and "visible only to you until you move it to a shared folder."

Clean-up: both saved reports and the fixture were deleted with curl against `/services/data/v62.0/analytics/reports/<id>`, the token held in a shell variable and never printed. A query for reports modified today returned none.

## Against the local designer

| | Local, run 3 ([designer.md](designer.md)) | REST door, run 2 |
| --- | --- | --- |
| Door | local MCP server | `sf api request rest`, no MCP server |
| Ask | owner and stage, Next Step, a formula column for Amount | owner and stage only |
| Tool order | search, describe, describe type twice, run (preview), create from the report | search, describe, describe type, run (preview), create from the report |
| Failed or refused calls | 0 | 0 |
| Saved | a new report, original untouched, Private Reports | the same |
| Cost | not recorded | $0.22 |

The REST ask was smaller, as the card set it, so this does not test formula columns over the door. The save path, `create_report` with `fromReportId`, behaved the same on both doors. The refusals `WRITE_NOT_ALLOWED` and `CALLOUT_SESSION` were not rehearsed: the CLI user holds the write permission, and the CLI session can call out.
