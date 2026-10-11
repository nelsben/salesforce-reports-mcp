# salesforce-reports-mcp

An MCP server that lets Claude find, define, run, save and combine Salesforce reports. Ask a question such as "what is our pipeline by stage this quarter, and how does it compare with last quarter?" and Claude picks or builds the right report, runs it through the Salesforce Reports and Dashboards REST API, and gets the numbers back in a compact shape it can reason about. When you want to keep a report it has built, it saves it to your Private Reports folder. It comes from the team building Plesio.

## Why the REST API, and not Apex

Apex has `Reports.ReportManager`, which can describe a report and run it, even with changed filters and groupings. It cannot save a report. The Reports and Dashboards REST API can do all of it: run a report defined in the request with no saved report behind it, then create, update, clone and delete. So this server uses the REST API for everything, and it needs nothing deployed to your org.

## Install and connect

You need Node.js 20 or later and a way to authenticate (see the next section).

**Claude Code**

```
claude mcp add salesforce-reports -- npx -y github:nelsben/salesforce-reports-mcp --org <alias>
```

**Claude Desktop**: add this to `claude_desktop_config.json`, then restart Claude Desktop.

```json
{
  "mcpServers": {
    "salesforce-reports": {
      "command": "npx",
      "args": ["-y", "github:nelsben/salesforce-reports-mcp", "--org", "<alias>"]
    }
  }
}
```

The first run builds the package, which takes a few seconds.

## Authentication

Pick one.

1. **Salesforce CLI (recommended).** Log in once with `sf org login web --alias <alias>` and pass `--org <alias>` (or set `SF_ORG`). With no `--org`, the server uses your `sf` default org. The server asks the CLI for the instance URL and a fresh access token, and asks again once if Salesforce answers 401. It never writes the token anywhere.
2. **A token you already hold.** Set `SF_INSTANCE_URL` (for example `https://yourcompany.my.salesforce.com`) and `SF_ACCESS_TOKEN`. These win over `--org` when both are set. The server cannot refresh this token, so it stops with a clear message when it expires.

Everything runs as the authenticated user. Salesforce sharing, folder access and field-level security apply as usual. The user needs the Run Reports permission, and Create and Customize Reports to save.

## Options

| Flag | Environment variable | Default | Meaning |
| --- | --- | --- | --- |
| `--org <alias>` | `SF_ORG` | the `sf` default org | Authenticate through the Salesforce CLI. |
| | `SF_INSTANCE_URL`, `SF_ACCESS_TOKEN` | | Authenticate with a token you hold. |
| `--api-version <v>` | `SF_API_VERSION` | `62.0` | REST API version. |
| `--read-only` | `SF_REPORTS_READ_ONLY=1` | off | Register no write tools. |
| `--allow-delete` | `SF_REPORTS_ALLOW_DELETE=1` | off | Register `delete_report`. |
| `--max-rows <n>` | `SF_REPORTS_MAX_ROWS` | `200` | Default cap on detail rows per result. The ceiling is 2,000. |

## Tools

| Tool | Writes | What it does |
| --- | --- | --- |
| `search_reports` | no | Find saved reports by name, folder or format. Returns ids and links. |
| `list_report_folders` | no | List the report folders you can see. |
| `list_report_types` | no | List the report types in the org, optionally filtered. |
| `describe_report_type` | no | List a type's fields by section, with the API names, date filters, granularities and filter operators. |
| `describe_report` | no | Summarize one saved report: columns, groupings, aggregates, filters in words. |
| `run_report` | no | Run a saved report. Optional `overrides` change that run only. |
| `query_report` | no | Define a report in the call and run it. Nothing is saved. |
| `combine_reports` | no | Run 2 to 5 reports and stack them (compare periods) or join them (side-by-side measures). |
| `create_report` | yes | Save a new report. It lands in Private Reports unless you give a folder. |
| `update_report` | yes | Change a saved report. Send only the fields to change. |
| `clone_report` | yes | Copy a saved report. |
| `delete_report` | yes | Delete a report (Recycle Bin). Registered only with `--allow-delete`. |

Every run returns the same shape: the filters that were applied (including Salesforce's defaults), a table of groups with their measures, grand totals, optional detail rows, and notes that say when anything was cut.

## Safety

- MCP clients ask you before a tool call, and the bundled skill tells Claude to save, change or delete only when you ask.
- `--read-only` registers no write tools at all.
- `delete_report` does not exist unless you start the server with `--allow-delete`. A deleted report goes to the Recycle Bin.
- A new report with no folder goes to the user's **Private Reports** folder. Only that user can see it until they move it.
- The server never prints, logs or returns an access token, and calls the Salesforce CLI with an argument list, not a shell string.

## Limits

- Salesforce returns at most **2,000 detail rows** per run. When it stops there, the result says so in `notes`.
- A report takes at most **100 columns**.
- Salesforce allows **500 synchronous report runs per org per hour**. The server runs the inputs of `combine_reports` one at a time.
- **Joined reports are not supported.** Tabular, summary and matrix are.
- Salesforce applies default filters to some report types (for Opportunity, the current fiscal quarter and probability above 0). They are listed in the result's `filters`, so check them against the question.

## The skill

`skills/salesforce-reports/SKILL.md` teaches Claude the workflow: search first, query before saving, read the filters and notes, and when to stack or join. To install it for Claude Code, copy the folder:

```
git clone https://github.com/nelsben/salesforce-reports-mcp
cp -r salesforce-reports-mcp/skills/salesforce-reports ~/.claude/skills/
```

For a single project, copy it to `.claude/skills/` in that project instead.

## Develop

```
npm install
npm run build
npm test
npm run live -- --org <alias> --allow-delete   # end-to-end run against an org you can write to
npm run capture -- --org <alias>               # refresh the test fixtures (anonymised)
```

`npm run live` creates two private reports named `zz-live-check-*`, deletes them, and fails if any remain. Use a sandbox or scratch org. The design and the facts checked against a live org are in `docs/design.md`.

## Roadmap

- **v0.2, the in-org door.** An Apex `@RestResource` class over `Reports.ReportManager` for describe and run, an `ExternalServiceRegistration`, and an `McpServerDefinition`, so claude.ai can reach reports through Salesforce's hosted MCP with nothing to host. Same tool names and result shape. Saving from Apex waits on a probe of whether a call back into the org's REST API works under a hosted-MCP token.
- Dashboards: list, describe, refresh, and read component data.
- Joined reports, report charts, and subscriptions.
- Publishing to npm.

## License

MIT.
