# Rehearsal: report-designer

Prompt (final form): "Start from my 'Pipeline by Stage' report. I want Next Step shown on each deal, and the report grouped by owner first and then stage. I'd also like the Amount to say 'Deal value' instead; if Salesforce can't rename the header, a formula column called Deal value is fine. Show me a preview first, and then save it as a new report called 'Pipeline by Owner' (a new one, leave the original alone). I am happy for you to go ahead and save once the preview looks right."

Three runs. The first prompt left out the clause about the formula column and the permission to save.

## Run 1: first prompt

Tool calls: `Skill(report-designer)`, `search_reports`, `describe_report`, `describe_report_type` (Next Step), `describe_report_type` (owner), one attempt to read `reference.md` with Bash (blocked by the rehearsal's tool limits), `run_report` with `overrides` (columns and groupings).

Final answer: a preview table grouped by owner then stage with Next Step, then a straight answer on the header: Salesforce does not let the API rename the standard Amount header, with two options, a formula column called "Deal value" or save without the rename. It asked which, and recommended saving without. It said "Report Builder, column menu, Edit Column Name" for the rename, which is not something we have verified. It saved nothing, because the prompt did not say to.

What the skill got right: preview before save, no save without a yes, an honest answer on the header. What it got wrong: it sent the user to Report Builder for a rename we cannot confirm exists. Change made: `SKILL.md` now says Salesforce has no known way to rename a standard header, offers the formula column as the one thing that works, and says not to send the user to Report Builder for it.

## Run 2: second prompt, the formula column is allowed

Tool calls: `Skill`, `search_reports`, a `Read` of `reference.md` (refused by the rehearsal's permissions), `describe_report`, `describe_report_type` twice, `run_report` with a formula column in `reportMetadata` (failed: `formulaType: "currency"` is "invalid for row-level formulas"), the same with `number` (worked), `run_report` again summing the formula column, then `create_report` with `fromReportId` and the same changes.

Final answer: the new report's link, "Pipeline by Stage is untouched", what changed (grouping, columns, a formula column called Deal value standing in for Amount, subtotals reading "Sum of Deal value"), a preview table matching the saved report, and a note that Deal value is a plain number because Salesforce rejected the currency type. It said the report is in Private Reports and offered to move it.

What the skill got right: the whole flow, including `fromReportId` in one call and the Private Reports note. What it got wrong: it could not read `reference.md` here, so it guessed the formula type and lost one call. Changes made: the formula shape (lowercase `number`, `CDF1`, aggregate on `CDF1`) moved into `SKILL.md` itself, and a note in `reference.md` that summing the formula column works.

## Run 3: after the changes

Tool calls: `Skill`, `search_reports`, `describe_report`, `describe_report_type` twice, `run_report` (preview, with the formula column on the first try), `create_report` with `fromReportId`. No failed call. The final answer gave the link, said the original was unchanged, listed grouping, columns, totals and filters, explained the formula column, and noted one deal with no amount.

Clean-up: the saved reports were deleted afterwards.
