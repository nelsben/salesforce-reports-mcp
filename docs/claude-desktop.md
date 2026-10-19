# Claude Desktop, with nothing in Salesforce

How to run the local MCP server for Claude Desktop, and what each Claude surface can and cannot do with it. This is the recipe behind the README's headline: reports and dashboards in Claude, with no package in the org and no Salesforce MCP.

## What you need

- Claude Desktop on macOS or Windows.
- Node.js 20 or later.
- The Salesforce CLI, signed in to the org once: `sf org login web --alias <alias>`.

Nothing else. No admin, no permission set, no connected app. Every call runs as you, with your sharing and field-level security.

## The config

Claude Desktop starts the server as a child process from `claude_desktop_config.json` (Claude menu, Settings, Developer, Edit Config). Add one entry under `mcpServers`:

```json
{
  "mcpServers": {
    "salesforce-reports": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/path/to/salesforce-reports-mcp/dist/index.js", "--org", "<alias>"],
      "env": { "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" }
    }
  }
}
```

Then quit and reopen Claude Desktop. Two things in that entry are deliberate:

- **Absolute paths.** Claude Desktop is launched from the Dock, not from your shell, so it does not see the `PATH` your terminal has. A bare `npx` or `node` from Homebrew, nvm or Volta is often not found, and the server then never starts. Give the full path to `node` (`which node` prints it) and to the server.
- **`PATH` in `env`.** The server runs `sf` to get your session, so the directory that holds `sf` must be on the child process's `PATH` (`which sf` prints it; `/usr/local/bin` for the installer, `/opt/homebrew/bin` for Homebrew). Without it the first call fails with "The Salesforce CLI (sf) could not be started".

Two ways to get the server itself:

| You want | Do this | `args` |
| --- | --- | --- |
| The released package | nothing; `npx` fetches it | `["-y", "salesforce-reports-mcp", "--org", "<alias>"]`, with `command` set to the full path of `npx` |
| The latest `main`, or your own changes | `git clone`, `npm install`, `npm run build` | `["/path/to/salesforce-reports-mcp/dist/index.js", "--org", "<alias>"]` |

To use a token instead of the CLI, drop `--org` and put `SF_INSTANCE_URL` and `SF_ACCESS_TOKEN` in `env`. The server cannot refresh that token, so it stops with a clear message when it expires. Never commit that file.

## Check it works

1. Open a new chat. The tools button under the composer lists `salesforce-reports` with its tools.
2. Ask: "List the report types I can build on, then build me an opportunity report grouped by stage without saving it."
3. Claude calls `list_report_types`, then `query_report`. Each call shows a permission card; press Allow once. The run draws as a report card: headline numbers, the filters Salesforce applied, the groups with bars, and a Save button for an unsaved report.
4. Ask for a dashboard: "What does my pipeline dashboard say?" It draws as a dashboard card, every component as its own chart.

The server's log is at `~/Library/Logs/Claude/mcp-server-salesforce-reports.log` on macOS and `%APPDATA%\Claude\logs\` on Windows. A failed start shows there first.

## Keep it safe

| Flag | Effect |
| --- | --- |
| `--read-only` | No write tools at all. Nothing can be saved or refreshed. Good for a first week. |
| (default) | Reads, saves and dashboard refreshes, each an explicit tool call you approve. Nothing is saved as a side effect. |
| `--allow-delete` | Adds `delete_report`. Leave it off in Claude Desktop. |
| `--max-rows <n>` | Detail rows per result, default 200, ceiling 2,000. |

Add a flag to `args` (`"--org", "<alias>", "--read-only"`). The token stays in the server's memory and never reaches a log, an error message or the chat.

## If something looks off

- **Claude answers with a different Salesforce connector.** If a claude.ai Salesforce connector is also switched on, Claude may use it instead; it has no report tools and draws no card. Turn that connector off in Settings, Connectors, or say "use the salesforce-reports server".
- **The result shows as a list of fields, not a card.** Claude Desktop can route a local server's tools two ways, and only the direct route draws the card (observed on macOS, October 2026). A fresh chat after a restart takes the direct route. The text answer is the same either way.
- **"sf could not be started".** The `PATH` in `env` does not include the directory with `sf`. See above.
- **401 or "log in again".** Run `sf org login web --alias <alias>` again. The server asks the CLI for a fresh token once per expiry on its own; only a session that cannot be refreshed needs you.

## Where it works, and where it cannot

The local server is a process on your machine, so it is available wherever Claude can start a process on that machine.

| Surface | Local server | Cards | Notes |
| --- | --- | --- | --- |
| Claude Desktop (macOS, Windows) | Yes | Report and dashboard cards | The surface this guide is for |
| Claude Code | Yes, as a plugin or `claude mcp add` | Text only | The skills ride along in the plugin |
| Cowork | Yes, through Claude Desktop's config | Cards, where Cowork draws MCP Apps | Same config entry |
| claude.ai in a browser | No | | The browser cannot start a process. Needs a server hosted somewhere, or the in-org door |
| Claude mobile (iOS, Android) | No | | Same as the browser. See below |

### Claude mobile

A phone cannot run the server, and the mobile apps take only remote MCP connectors: servers reached over HTTPS with OAuth, configured in claude.ai. So the headline recipe, nothing in the org and no Salesforce MCP, does not reach the phone on its own. Three ways to get there, each with a cost:

| Way | What it takes | What you get | Cost |
| --- | --- | --- | --- |
| **Leave the laptop on.** Claude Desktop can announce its local servers to your claude.ai account as remote tools, when it is running and connected. | Claude Desktop open on a machine that stays awake | The same tools, as text. No cards on that route. | Works only while the laptop is up. Observed on macOS in October 2026 and not yet tried from a phone, so treat it as a lead, not a promise. |
| **Host this server yourself.** Run it on a small server with an HTTP transport and OAuth in front, and add it as a connector. | A host, a domain, an OAuth layer, and an HTTP transport this server does not ship yet | Everything the local server does, from any Claude surface | The server now holds Salesforce credentials off your machine, which is the thing the local door avoids. On the roadmap, not built. |
| **The in-org hosted door.** Install the packages in `salesforce/` and add the org's MCP server as a connector. | An admin, the packages, and Salesforce hosted MCP | Eleven of the sixteen tools, as the signed-in user, governed by permission sets | This is Salesforce MCP, the thing the headline does without. It is why the Apex is in the repo. |

For most people the honest answer is: build and explore on the laptop, where the cards are; read the saved reports from the phone through whichever remote door the org allows.
