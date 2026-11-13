# 0023. The Claude Code plugin starts the server read-only and pinned to its release

Status: Accepted, 2026-11-12

## Context

The README is now written for people who have never used the project, and the plugin is the two-command way in. Until now the plugin started the server with every write tool on and ran `npx -y salesforce-reports-mcp`, which is whatever version npm serves that day.

Two things went wrong with that. A first-time user could save a report or refresh a shared Salesforce dashboard before they knew the tools existed. And the plugin's skills ship from the repository the moment they merge, while the server ships only when a version is published to npm: in November 2026 the runner skill told Claude to run a `dashboard-files` subcommand that npm did not serve yet.

On 2026-11-12 the plugin was run with `SF_REPORTS_READ_ONLY` set in its `env` as `${SF_REPORTS_READ_ONLY:-1}`. With the variable unset it registered 11 tools and none that save or refresh. Started with `SF_REPORTS_READ_ONLY=0` it registered 15, `create_report`, `update_report`, `clone_report` and `refresh_dashboard` among them. The server already reads `0` as off, so no server change was needed.

## Decision

- The plugin's server entry sets `SF_REPORTS_READ_ONLY` to `${SF_REPORTS_READ_ONLY:-1}`. People turn saving on with `SF_REPORTS_READ_ONLY=0 claude`.
- The plugin runs `npx -y salesforce-reports-mcp@<version>`, the version its skills were written for.
- At a release, the version is published to npm first and the plugin's pin moves after, so the pin never names a version npm does not have.
- A manual MCP config, Claude Desktop and the in-org doors keep their own defaults. Only the plugin changes.

## Consequences

- report-designer saves and the runner's dashboard refresh need the opt-in. Both skills say how to turn saving on when the tools are missing.
- report-deploy is not blocked: its deploys go through the Salesforce CLI and always ask first. Moving a private report to a shared folder uses `update_report`, so that one step needs the opt-in.
- `delete_report` still needs `--allow-delete` and is never on in the plugin.
- An update of the plugin brings a new server only with a new release, which is also when the skills change.

## Alternatives turned down

- **`--read-only` in the plugin's `args`.** A command-line flag wins over the environment, so nobody could turn saving back on without editing the plugin.
- **Writes on, with a louder README.** A reader skims; the safe default is the one that holds when they do.
- **An unpinned `npx`.** It lets the skills and the server drift apart between releases, which is what happened in November 2026.
