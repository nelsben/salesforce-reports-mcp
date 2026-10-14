# Rehearsals

Each file records one headless run of a skill, with `claude -p --model sonnet`, against a Developer Edition scratch org (`dev-frontend-2`, API v62.0 through the server, CLI v68.0). Names and URLs are neutral: owners are `Owner 1` and `Owner 2`, accounts are `Account 1`, and links use `https://example.my.salesforce.com`. Dollar figures are as returned.

How they were run:

- Skills from `--plugin-dir <this repo>`, so Claude saw `salesforce-reports:report-runner`, `report-designer` and `report-deploy`.
- The server from a local MCP config (`node dist/index.js --org dev-frontend-2 --allow-delete`) with `--strict-mcp-config`, because the plugin's own `npx github:` server cannot work until `main` has code.
- `--disallowedTools "mcp__claude_ai_*"`, and `--allowedTools` limited to the server's tools, `Skill`, and for deploy only `sf project retrieve start`, `sf project deploy start` and `sf project generate`.
- A fixture report, "Pipeline by Stage" (summary, grouped by stage, close date this fiscal year), was created first, and every report was deleted afterwards.
- The first runner run was made before any saved pipeline report existed, so it took the "no saved report" path. The rest started from the fixture.
- The REST door runs (`runner-rest.md`, `designer-rest.md`) used no MCP server at all: `--strict-mcp-config` with an MCP config that has no servers, so the plugin's own server did not start. `--allowedTools` was limited to `Skill`, `Bash(sf api request rest:*)`, `Read` on the plugin's `skills/` folder (so the skill could read its own `transport.md` and `reference.md`), and `Write` under `/tmp/sf-reports/` for body files (the model wrote them to its own session scratchpad instead, which needs no rule). Each prompt named the CLI alias, so the run did not stop to ask for it. The package with all eleven tools was deployed in `dev-frontend-2`, the fixture was "zz-rehearsal Pipeline by Stage", made through the door's own `create_report`, and every report was deleted afterwards with curl.

`designer-refusal.md` is a REST door run for a user without the write permission set: the save is refused with `WRITE_NOT_ALLOWED`, and the file also records the refusal on the hosted door. No fixture was needed and no report was made.

Correction, 2026-10-14: several runs say the Opportunity default `probability: >0` hides Closed Lost. The skills said so at the time, and it was wrong: the filter is Salesforce's "All" and keeps 0 percent deals ([live finding](../design.md#live-findings-checked-2026-10-11-api-v620-scriptslive-checkts)). The records keep what Claude said.

`runner-hosted.md` is the exception: interactive runs in claude.ai over the hosted MCP door, described in the file.

Tool names below are the server's own, without the `mcp__salesforce-reports__` prefix.
