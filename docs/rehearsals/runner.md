# Rehearsal: report-runner

Prompt: "I'm a seller. How is our pipeline looking this fiscal year? Is there anything I should worry about, and can you show it to me by owner too?"

Three runs. Run 1 is with no saved pipeline report in the org; runs 2 and 3 are with one.

## Run 1: no saved report

Tool calls: `Skill(report-runner)`, `search_reports("pipeline")` (0), `search_reports("opportunit")` (0), `list_report_types`, `describe_report_type`, then three `query_report` calls (by stage, owner by stage as a matrix, and overdue open deals as a flat list).

Final answer: a headline ("$3.09M across 8 open opportunities"), a by-stage table, a by-owner table, four worries (one owner holds 91 percent of the dollars, one deal is 29 percent of the pipeline, no closed-won rows this fiscal year, one deal has no amount), the default `probability > 0` caveat in words, and four next cuts, one of them "save this as a report, I won't do that unless you say yes". Nothing was saved.

What the skill got right: it searched first, fell back to `query_report` as the skill says, named the hidden Closed Lost default, offered but did not save. What it got wrong: nothing material. It did not call `describe_report`, correctly, since there was no report.

## Run 2: a saved report exists

Tool calls: `Skill(report-runner)`, `search_reports("pipeline")` (1 match), `describe_report`, `run_report`, `run_report` with `overrides.groupingsDown` on column `OWNER` (failed: "The column OWNER is not a valid column for groupings"), `describe_report_type(search: "owner")`, `run_report` with `FULL_NAME` and `STAGE_NAME`.

Final answer: said which report it used and what it counts ("opportunities with a close date this fiscal year, across the whole org, and hides Closed Lost because of its probability filter"), stage and owner tables, six worries, the report link, and three next cuts. Nothing saved.

What the skill got right: the find, describe, run order, the plain-words scope, the link. What it got wrong: it guessed the owner column (`OWNER`) instead of looking it up, and the failure cost a call. The tip about looking columns up lived only in `reference.md`, which the model did not read.

Change made: `skills/report-runner/SKILL.md` step 4 now says to take the column for a new slice from `describe_report_type` with a `search` word, and that "owner" finds `FULL_NAME` on Opportunity.

## Run 3: after the change

Tool calls: `Skill`, `search_reports`, `describe_report`, `run_report`, `describe_report_type(search: "owner")`, `run_report` with `FULL_NAME`. No failed call, one call fewer. Same shape of answer: report named, scope said, by-stage and by-owner tables, worries (owner concentration, one account holding about 90 percent, close dates all in December while several deals are early stage, no closed-won rows, one deal with no amount), the link, "Nothing was saved."
