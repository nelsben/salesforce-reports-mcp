---
name: report-deploy
description: Move a saved Salesforce report from one org to another, or put reports into git, using the Salesforce CLI. Use when an admin says "move that report to production", "deploy this report to the other org", "copy the report to sandbox", "put our reports in git" or "retrieve the report as metadata". Needs the sf CLI. For reading a report's numbers, use report-runner. For changing or saving a report in one org, use report-designer.
---

# Moving a saved report between orgs

This is for an admin, in Claude Code with the Salesforce CLI. Saving a report in your own org needs no deploy; this is only for moving one to another org or into source control. Run it only on an explicit request, and confirm every real deploy first. Use the MCP server's `describe_report` and `update_report`, and the `sf` CLI for the rest. Always pass `--target-org` explicitly; never rely on the default org. The admin names the orgs by their CLI alias ("from dev-frontend-2 to dev-backend"); use those aliases as given and do not look them up. If they did not name an alias for a side, ask.

## The steps

1. **Identify the report.** `search_reports`, then `describe_report`. From the result take `developerName` and `folder`. The metadata name is `<folder.developerName>/<developerName>`. The org-wide Public Reports folder has the developer name `unfiled$public`, so a report there is `unfiled$public/<developerName>`.
2. **Check the folder.** If `folder.isPrivate` is true, stop and say so: a report in Private Reports cannot be retrieved (the CLI answers "cannot be found" and retrieves nothing). It must move to a shared folder first. Offer `list_report_folders` (it includes the org-wide Public Reports folder, developer name `unfiled$public`) and an `update_report` with that folder's `folderId`, and move it only after the admin agrees; that changes the report in the source org.
3. **Retrieve.** Inside an SFDX project (offer `sf project generate --name <dir>` if there is none), run:
   `sf project retrieve start --metadata 'Report:<folder>/<developerName>' --target-org <source>`
   Single-quote the name; `$` in `unfiled$public` is special to the shell. If the report type is custom, retrieve it too (`ReportType:<name>`), and the folder (`ReportFolder:<name>`) when the target lacks it. The file lands under `force-app/main/default/reports/<folder>/`.
4. **Check the target.** Run the same metadata with `sf project deploy start --metadata '...' --target-org <target> --dry-run`. Report what failed in plain words, such as a missing field, report type or folder, and fix only with the admin's go-ahead. A dry run changes nothing in the target.
5. **Deploy.** Show the exact command without `--dry-run`. Run it only after a clear yes, then give the report's link in the target org (search for it there with `search_reports` if the MCP server points at that org).
6. **Source control.** Commit the retrieved files only when asked. They are plain XML; the report file is `<developerName>.report-meta.xml`.

## Things to say plainly

- A deploy brings the report's definition, not its data. The target org needs the same fields and report type.
- The folder must exist in the target. A deploy of `unfiled$public/...` works because Public Reports is in every org.
- Never deploy without the dry run first.
