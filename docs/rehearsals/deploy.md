# Rehearsal: report-deploy

Prompt: "Move my 'Pipeline by Stage' report from dev-frontend-2 over to dev-backend. Dry run only, do not deploy for real. If the report has to be in a shared folder first, you have my OK to move it to Public Reports."

Allowed Bash: `sf project retrieve start`, `sf project deploy start`, `sf project generate`. The working directory was empty. No real deploy was possible or attempted.

## Run 1: report in Private Reports

Tool calls: `Skill(report-deploy)`, `search_reports`, `describe_report` (folder is private), `list_report_folders(search: "Public")` (returned the org-wide Public Reports folder), `update_report` with that `folderId` (moved the report; allowed by the prompt), then `sf org list --json`, refused by the rehearsal's tool limits twice.

Final answer: said what it had done (found the report, saw it was in Private Reports and cannot be retrieved, moved it to Public Reports with the user's OK, worked out the name `unfiled$public/<developerName>`), said it was blocked on the CLI, and listed the three commands it would run.

What the skill got right: spotting the private folder, asking for and using the OK, building the right metadata name. What it got wrong: it tried to look up the org aliases the user had already given. Change made: `SKILL.md` now says to use the aliases as given and not look them up.

## Run 2: report now in Public Reports

Tool calls: `Skill`, `search_reports` (folder: Public Reports), `describe_report`, `ls` and `which sf`, `sf project generate --name <dir>`, `sf project retrieve start --metadata 'Report:unfiled$public/<developerName>' --target-org dev-frontend-2` (Succeeded), `sf project deploy start --metadata '...' --target-org dev-backend --dry-run` (Succeeded, 1 of 1 components, no errors).

Final answer: said it did not need to move the report, that the dry run passed and nothing was deployed, where the retrieved file landed, that a deploy brings the definition and not the data, and gave the exact real command, to run only after a yes.

What the skill got right: the metadata name, single quotes around `$`, retrieve then dry run, no real deploy, waiting for a yes. Run 2 skipped the move because run 1 had already done it, so the two runs together cover both paths. Nothing was deployed to dev-backend; the dry run left no report there.
