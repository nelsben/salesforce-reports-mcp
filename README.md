# salesforce-reports-mcp

An MCP server and three Claude skills for Salesforce reports. Claude can find, define, run, save and combine reports through the Salesforce Reports and Dashboards REST API, and hands you the answer, not the plumbing. It comes from the team building Plesio.

## Three experiences

Each one is a skill. Claude picks the right one from what you say.

### Explore: report-runner

For a seller or manager who wants an answer. Claude finds the report, says in plain words what it counts and for whom, runs it, leads with the answer, and offers the next slice. It never saves anything.

> **You:** How is our pipeline looking this fiscal year? Anything I should worry about?
> **Claude:** $3.09M across 8 open deals, from "Pipeline by Stage" (opportunities closing this fiscal year, whole org; the report hides Closed Lost). One owner holds 91% of it, and five of the eight deals are one account. Link to the report. Want it by close month, or against last year?

### Design: report-designer

For someone who wants a report changed or made. Claude drafts the report in your words, previews it on real data, changes it until you like it, then saves it in one step: as a new report, or over the original if you ask. A saved report lands in your Private Reports folder unless you pick a folder.

> **You:** Start from my Pipeline by Stage report. Add Next Step and group it by owner, then save it as Pipeline by Owner.
> **Claude:** Preview, with 8 deals under two owners. Saved as a new report in your Private Reports; the original is untouched. Link.

Salesforce cannot rename a standard column header through the API. Claude says so and offers a formula column with the label you want. Conditional highlighting and joined-report blocks need Report Builder.

### Deploy: report-deploy

For an admin who needs a report in another org or in git. Claude reads the report's metadata name, retrieves it with the Salesforce CLI, checks it with a dry run against the target, and deploys only after you say yes. A report in Private Reports cannot be retrieved, so Claude offers to move it to a shared folder first.

> **You:** Move Pipeline by Stage from dev-frontend-2 to dev-backend. Dry run only.
> **Claude:** Retrieved it as `unfiled$public/Pipeline_by_Stage_...`; the dry run against dev-backend passed (1 of 1 components). Say the word and I will run the real deploy.

## Install

You need Node.js 20 or later and a way to authenticate (see Authentication below). The deploy skill also needs the Salesforce CLI.

### As a Claude Code plugin

The plugin bundles the three skills and the MCP server.

```
claude plugin marketplace add nelsben/salesforce-reports-mcp
claude plugin install salesforce-reports@salesforce-reports
```

The plugin starts the server with no org baked in. It uses the org in the `SF_ORG` environment variable, or your Salesforce CLI default org. To point it at an org, set `SF_ORG=<alias>` in the environment you start Claude Code from (`SF_ORG=my-sandbox claude`). To use a token you already hold, set `SF_INSTANCE_URL` and `SF_ACCESS_TOKEN` the same way. For other options, such as `--read-only`, use the manual setup below instead of the plugin's server.

### Manual MCP config

This gives you the server without the skills.

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

The first run builds the package, which takes a few seconds. To add the skills without the plugin, copy `skills/report-runner`, `skills/report-designer` and `skills/report-deploy` into `~/.claude/skills/`.

## Why the REST API, and not Apex

Apex has `Reports.ReportManager`, which can describe a report and run it, even with changed filters and groupings. It cannot save a report. The Reports and Dashboards REST API can do all of it: run a report defined in the request with no saved report behind it, then create, update, clone and delete. So this server uses the REST API for everything, and it needs nothing deployed to your org. Saving a report needs no deploy. The Metadata API is only for moving a report between orgs or into source control, which is what report-deploy does.

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
| `list_report_folders` | no | List the report folders you can see, including the org-wide Public Reports folder. |
| `list_report_types` | no | List the report types in the org, optionally filtered. |
| `describe_report_type` | no | List a type's fields by section, with the API names, date filters, granularities and filter operators. |
| `describe_report` | no | Summarize one saved report: columns, groupings, aggregates, filters in words, plus `developerName` and the folder as `{id, name, developerName, isPrivate}`. |
| `run_report` | no | Run a saved report. Optional `overrides` change that run only. |
| `query_report` | no | Define a report in the call and run it. Nothing is saved. |
| `combine_reports` | no | Run 2 to 5 reports and stack them (compare periods) or join them (side-by-side measures). |
| `create_report` | yes | Save a new report, from a definition or from a saved report (`fromReportId` plus the changes). It lands in Private Reports unless you give a folder. |
| `update_report` | yes | Change a saved report. Send only the fields to change. |
| `clone_report` | yes | Copy a saved report. |
| `delete_report` | yes | Delete a report (Recycle Bin). Registered only with `--allow-delete`. |

Every run returns the same shape: the filters that were applied (including Salesforce's defaults), a table of groups with their measures, grand totals, optional detail rows, and notes that say when anything was cut.

## Safety

- MCP clients ask you before a tool call, and the skills tell Claude to save, change or delete only when you ask.
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

## The skills

The skills live in `skills/`: `report-runner`, `report-designer` and `report-deploy`. Each has a `description` that makes Claude pick it for its own experience, and the designer and runner keep a `reference.md` with the definition grammar and how to read a result. The plugin installs all three.

## Develop

```
npm install
npm run build
npm test
npm run live -- --org <alias> --allow-delete   # end-to-end run against an org you can write to
npm run capture -- --org <alias>               # refresh the test fixtures (anonymised)
```

`npm run live` creates several private reports named `zz-live-check-*`, deletes them, and fails if any remain. Use a sandbox or scratch org. The design and the facts checked against a live org are in `docs/design.md`.

## Roadmap

- **v0.2, the in-org doors.** A REST endpoint and a hosted MCP server inside the org, over one Apex class, so you choose how to connect: this local server, plain REST, or claude.ai through Salesforce hosted MCP with nothing to host (an admin still installs the package and enables the server). Same tool names and result shape on every door. The plan and the phase 0 findings are in `docs/design.md`.
- Dashboards: list, describe, refresh, and read component data.
- Joined reports, report charts, and subscriptions.
- Publishing to npm.

## License

MIT.
