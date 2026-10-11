# Rehearsals

Each file records one headless run of a skill, with `claude -p --model sonnet`, against a Developer Edition scratch org (`dev-frontend-2`, API v62.0 through the server, CLI v68.0). Names and URLs are neutral: owners are `Owner 1` and `Owner 2`, accounts are `Account 1`, and links use `https://example.my.salesforce.com`. Dollar figures are as returned.

How they were run:

- Skills from `--plugin-dir <this repo>`, so Claude saw `salesforce-reports:report-runner`, `report-designer` and `report-deploy`.
- The server from a local MCP config (`node dist/index.js --org dev-frontend-2 --allow-delete`) with `--strict-mcp-config`, because the plugin's own `npx github:` server cannot work until `main` has code.
- `--disallowedTools "mcp__claude_ai_*"`, and `--allowedTools` limited to the server's tools, `Skill`, and for deploy only `sf project retrieve start`, `sf project deploy start` and `sf project generate`.
- A fixture report, "Pipeline by Stage" (summary, grouped by stage, close date this fiscal year), was created first, and every report was deleted afterwards.
- The first runner run was made before any saved pipeline report existed, so it took the "no saved report" path. The rest started from the fixture.

Tool names below are the server's own, without the `mcp__salesforce-reports__` prefix.
