# Rehearsal: report-designer when the save is refused

Prompt: "Build me an opportunity report that shows the amount by stage, and save it as 'zz-rehearsal Refusal'. I am happy for you to go ahead and save. My Salesforce org is the CLI alias dev-frontend-2."

No MCP server ran, as in [designer-rest.md](designer-rest.md). The setup is the same: `claude -p --model sonnet`, `--plugin-dir`, `--strict-mcp-config` with an empty servers config, `--disallowedTools "mcp__claude_ai_*"`, and `--allowedTools` limited to `Skill`, `Bash(sf api request rest:*)` and `Read` on the plugin's `skills/` folder. The difference is the user: the CLI user held the permission sets `Salesforce_Reports` and `Salesforce_Reports_Callout` but not `Salesforce_Reports_Write`.

## The refusal, seen before the rehearsal

With the write permission set absent, `create_report` was called on both in-org doors with a small Opportunity definition (name, `reportType`, `format: "tabular"`, three columns). Both answered the same refusal, and a query for reports modified that day found none.

| Door | Call | Status | Code |
| --- | --- | --- | --- |
| REST | `sf api request rest` POST to `/services/apexrest/reports/v1/create_report` | 403 | `WRITE_NOT_ALLOWED` |
| Hosted | anonymous Apex `ReportsApi.handle('create_report', body, true)` | 403 | `WRITE_NOT_ALLOWED` |

Message: "Saving reports on the in-org door needs the Reports_Write custom permission, and this user does not have it."
Hint: "Ask an admin to assign the permission set Salesforce_Reports_Write to users who may save reports, or use the local server."

## The run

Tool calls: `Skill(report-designer)`, a read of `transport.md` and `reference.md`, body file and `sf api request rest` for `query_report` (grouped by stage, count and sum of amount, the preview), then body file and `sf` for `create_report`. The save answered 403 `WRITE_NOT_ALLOWED`. One call each, no retry, no `update_report`, no `clone_report`. Cost $0.18.

Final answer: "The report was not saved", with the code and the missing permission named, the fix ("ask a Salesforce admin to assign you the permission set `Salesforce_Reports_Write`"), the preview table (8 deals, $3,091,000 over six stages), the exact `create_report` input so the admin or user can save it later, and a note on the filters Salesforce adds by default (close date this fiscal quarter, probability above 0) with an offer to change them.

## What went right / what went wrong

What went right: the refusal was read as a refusal and not as a bad input. The model did not retry and did not try another save tool, as `SKILL.md` says. It named `Salesforce_Reports_Write` and said who assigns it. It handed over the finished definition, with the preview, so the work was not lost. It also surfaced the silent default filters.

What went wrong: nothing that needed a text change. The skill's refusal text did not mislead the model, so no skill file changed. One small thing: it wrote "your user lacks the `Reports_Write` custom permission" in one place and the permission set name in another. Both come from the server's message, and the answer made the difference clear by naming the permission set as the thing to ask for.

Clean-up: no report was created, so there was nothing to delete. A query for reports modified that day returned none.
