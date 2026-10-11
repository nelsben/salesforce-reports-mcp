# Experiences: runner, designer, deploy

v0.1 gave Claude the tools. This document says how a person uses them. There are three experiences, and each one is a Claude skill. The design goal is fewest hoops: a seller should never need to know what a report type, an API name or a deploy is to get a report they can keep.

## Who and what

| Experience | Who | They say | They get |
| --- | --- | --- | --- |
| **Runner** | A seller or manager exploring data | "What's in my pipeline report?" "Why is Q4 down?" "Show me that by owner." | The answer, read from a real report. The report's own filters are said in words. Next slices are offered and nothing is saved. |
| **Designer** | A seller, manager or admin who wants a report changed or made | "Start from my pipeline report, add Next Step and group it by owner." "Build me a report of deals stuck in a stage for 30 days." | A previewed definition, changed until they like it, then saved in one step: as a new report, or over the original when they own it. |
| **Deploy** | An admin | "Move that report to production." "Put our reports in git." | The saved report retrieved as metadata, checked against the target org, and deployed after they confirm. |

## Facts that shape them

From probes and the Salesforce v68.0 guides, checked 2026-10-11.

- **Saving needs no deploy.** The Reports REST API saves a report in the user's own org in one call. The Metadata API is for moving a report between orgs and keeping it in source control.
- **The REST API can set** charts, row-level formulas, custom summary formulas, historical trending and the folder. The guide lists bucket fields and cross filters too, but neither is tested yet.
- **Only the Metadata API or the Report Builder UI can set** conditional highlighting and joined-report blocks. When a request needs one of these, the designer says so and links to Report Builder.
- **Standard column headers cannot be renamed** as far as we know. A row-level formula column can carry any label. This needs a probe (task 3 below).
- **The Metadata API reads only reports in shared folders**, as far as we know. A report in Private Reports would have to move to a shared folder before it can be deployed. This needs a probe (task 3).

## Runner

1. **Find.** `search_reports` with the user's words. With several matches, show up to three, each with its folder and last run date, and ask which one. With none, say so and offer the designer.
2. **Say what it counts before running it.** `describe_report`, then one or two plain sentences on the report: what it counts, grouped by what, over which dates, and for whom. The scope matters, for example "only your opportunities". Silent defaults are named, for example "it hides Closed Lost because of its probability filter".
3. **Run and lead with the answer.**
   - `run_report`.
   - First the headline: the total and the biggest movers. Then the group table, at most about 10 rows inline, ranked. Then anything odd: an empty group, one deal carrying a stage, rows that were cut.
4. **Offer the next slice.** Give two or three concrete follow-ups in the user's words, for example "by owner", "last quarter instead" or "without closed deals". Each one becomes a `run_report` with `overrides`. Comparisons go through `combine_reports`: `stack` for this period against last, `join` for two measures by the same dimension.
5. **Never save.** If the user wants a slice kept, hand over to the designer: "Want me to save this as a report?"
6. **Always** give the report link, and say when numbers are partial.

## Designer

1. **Start point.**
   - An existing report: `search_reports`, then `describe_report`.
   - Nothing close: `list_report_types` and `describe_report_type`, searching on the user's words. Pick fields by their labels, never by guessing API names.
2. **Draft in words before any call.** Write a short spec in the user's labels:
   - what each row is;
   - the columns;
   - the groupings;
   - the filters;
   - the date range;
   - the sort.

   Ask only about what is ambiguous.
3. **Preview on real data.** For an existing report, use `run_report` with `overrides`. For a new one, use `query_report`. Show 5 to 10 rows or groups. Change the spec and preview again until the user is happy.
4. **Save in one step,** and ask which kind first:
   - **New report:** `create_report`. Starting from an existing report, pass `fromReportId` (task 2) so the saved definition is copied and the changes applied in one call. With no folder it lands in Private Reports. Offer `list_report_folders` when the user wants it shared.
   - **Overwrite the original:** `update_report`. Only when the user asks for it by name and owns it, or can edit it. Restate what will change first.
5. **After saving,** give the link. Name anything the API could not set, such as conditional highlighting, and point to Report Builder for it.
6. **Header renames.** Say that Salesforce does not rename standard column headers. If the user still wants a different label, offer a row-level formula column with that label, if the probe in task 3 shows the REST API accepts one.

## Deploy

This one is for Claude Code with the Salesforce CLI. It runs only on an admin's explicit request, and every real deploy is confirmed first.

1. **Identify the report.** `describe_report` gives its developer name and folder. If it sits in Private Reports, say it must move to a shared folder first, and offer `update_report` with a `folderId`.
2. **Retrieve.**
   - Run `sf project retrieve start --metadata "Report:<FolderDeveloperName>/<ReportDeveloperName>" --target-org <source>` inside an SFDX project.
   - If there isn't a project, offer to create one with `sf project generate`.
   - If the report type is custom, retrieve it too (`ReportType:<name>`), and the folder (`ReportFolder:<name>`) when the target lacks it.
3. **Check the target.** Run `sf project deploy start --metadata … --target-org <target> --dry-run`. Report what failed in plain words, such as a missing field, report type or folder, and fix only with the admin's go-ahead.
4. **Deploy.** Show the exact command. Run it after a clear yes, then give the report's link in the target org.
5. **Source control.** Commit the retrieved files only when asked.

## Tasks

1. **Skills.** Replace `skills/salesforce-reports/` with three skills: `skills/report-runner/`, `skills/report-designer/` and `skills/report-deploy/`.
   - Each skill's `description` must trigger on its own experience and not the others'.
   - The definition grammar and result-reading rules from the current skill move into `skills/report-designer/reference.md` and `skills/report-runner/reference.md`. Each skill keeps what it needs, and nothing points across skills.
2. **Tool changes.**
   - `create_report` takes an optional `fromReportId`: describe that report, apply the given changes, save as new.
   - `describe_report` returns `developerName` and the folder as `{id, name, developerName, isPrivate}`.
   - Tests for both, and a live-check step for `fromReportId`.
3. **Probes,** on dev-frontend-2. Record each outcome in this document under "Facts that shape them", and adjust the skills to match.
   1. Can a REST create or update give a standard column a custom header? If not, can it add a labelled row-level formula column?
   2. Can `sf project retrieve start` read a report that sits in Private Reports?
   3. Does a REST create accept a new bucket field and a cross filter?
4. **Plugin.** Package the repo as a Claude Code plugin:
   - `.claude-plugin/plugin.json`, the three skills, and the MCP server through `npx -y github:nelsben/salesforce-reports-mcp`. It uses `SF_ORG` or the CLI's default org.
   - A `.claude-plugin/marketplace.json`, so that `claude plugin marketplace add nelsben/salesforce-reports-mcp` and `claude plugin install` work.
   - `claude plugin validate .` must pass.
5. **Rehearsals.** Run each skill once, headless, through the plugin, against dev-frontend-2. Save each transcript summary in `docs/rehearsals/`.
   - The deploy rehearsal is a dry run from dev-frontend-2 to dev-backend.
   - Any report saved in a rehearsal is deleted afterwards.
6. **README.** Lead with the three experiences, each with one example exchange, then install through the plugin, then the tool reference.
