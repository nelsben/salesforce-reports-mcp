# Install and connect

Each of the three ways to connect has its own setup. Pick one from the [README](../README.md#three-ways-to-connect); they can run side by side.

## The local MCP server

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

### Authentication

Pick one.

1. **Salesforce CLI (recommended).** Log in once with `sf org login web --alias <alias>` and pass `--org <alias>` (or set `SF_ORG`). With no `--org`, the server uses your `sf` default org. The server asks the CLI for the instance URL and a fresh access token, and asks again once if Salesforce answers 401. It never writes the token anywhere.
2. **A token you already hold.** Set `SF_INSTANCE_URL` (for example `https://yourcompany.my.salesforce.com`) and `SF_ACCESS_TOKEN`. These win over `--org` when both are set. The server cannot refresh this token, so it stops with a clear message when it expires.

Everything runs as the authenticated user. Salesforce sharing, folder access and field-level security apply as usual. The user needs the Run Reports permission, and Create and Customize Reports to save.

### Options

| Flag | Environment variable | Default | Meaning |
| --- | --- | --- | --- |
| `--org <alias>` | `SF_ORG` | the `sf` default org | Authenticate through the Salesforce CLI. |
| | `SF_INSTANCE_URL`, `SF_ACCESS_TOKEN` | | Authenticate with a token you hold. |
| `--api-version <v>` | `SF_API_VERSION` | `62.0` | REST API version. |
| `--read-only` | `SF_REPORTS_READ_ONLY=1` | off | Register no write tools. |
| `--allow-delete` | `SF_REPORTS_ALLOW_DELETE=1` | off | Register `delete_report`. |
| `--max-rows <n>` | `SF_REPORTS_MAX_ROWS` | `200` | Default cap on detail rows per result. The ceiling is 2,000. |

## The in-org doors


There are three doors to the same tools. Each takes the same tool names and inputs and returns the same JSON.

| Door | What runs | Who uses it | Tools |
| --- | --- | --- | --- |
| Local MCP | This Node server, on your machine | Claude Code, Claude Desktop, any MCP client that starts a process | All 12 |
| In-org REST | The Apex class `ReportsApi`, at `/services/apexrest/reports/v1/<tool>` | Scripts, Flow, Agentforce, other agents | 11: the eight read tools and three save tools |
| In-org MCP | Salesforce hosted MCP over `ReportsApi`, server `SalesforceReports` | claude.ai and other remote MCP clients, with nothing to host | 11: the eight read tools and three save tools |

The eight read tools are `search_reports`, `list_report_folders`, `list_report_types`, `describe_report`, `describe_report_type`, `run_report`, `query_report` and `combine_reports`. The three save tools are `create_report`, `update_report` and `clone_report`. They work only for a user with the permission set `Salesforce_Reports_Write`, and answer `WRITE_NOT_ALLOWED` (HTTP 403) to anyone else. `delete_report` is on the local server only. The save tools, `list_report_types`, `query_report` and `describe_report_type` call the org's own REST API under the user's session. On the REST door that works. A hosted MCP sign-in gives Apex no session ([decision 0007](decisions/0007-callout-identity-under-hosted-mcp.md)). The optional package `callout-app` gives the hosted door a per-user named credential instead, so every tool but `delete_report` works there as the signed-in user ([decision 0012](decisions/0012-per-user-jwt-named-credential.md)). Without it, on the hosted door `search_reports`, `list_report_folders`, `describe_report`, `run_report` and `combine_reports` over saved reports work, `describe_report_type` reads the type through a saved report, and `list_report_types`, `query_report` and the save tools answer `CALLOUT_SESSION`. The in-org doors ship as Salesforce package directories in `salesforce/` ([decision 0009](decisions/0009-two-shipping-units.md)): `force-app` is the REST door, complete on its own, `mcp-app` adds the hosted MCP door on top of it with no code of its own, and `callout-app` adds the callout identity for the hosted door, also with no code. [salesforce/README.md](../salesforce/README.md) has the details. Hosted MCP needs API 67.0 or later.

### The REST door

`salesforce/force-app` holds the Apex classes and tests, the two permission sets and the custom permission. An admin installs it once per org. Replace `<alias>` with a Salesforce CLI alias, and `<user>` with a username.

1. Deploy it from `salesforce/`. Add `--ignore-conflicts` if a scratch org reports source conflicts.

   ```bash
   sf project deploy start -d force-app -o <alias>
   ```

2. Give each user the permission set.

   ```bash
   sf org assign permset -n Salesforce_Reports -o <alias> --on-behalf-of <user>
   ```

3. Give the write permission set to each user who may save reports. It grants the custom permission `Reports_Write`. The save tools refuse a user without it. A user who saves also needs Create and Customize Reports.

   ```bash
   sf org assign permset -n Salesforce_Reports_Write -o <alias> --on-behalf-of <user>
   ```

4. Call it. From a terminal, `sf api request rest "/services/apexrest/reports/v1/search_reports" --method POST --body '{"query":"pipeline"}' -o <alias>`. From Claude Code or Cowork, the skills call it the same way through the Salesforce CLI (see "The skills").

To remove the REST door, remove the MCP door first if it is installed, then unassign both permission sets from every user and run the `force-app` removal in [salesforce/README.md](../salesforce/README.md).

### The MCP door

`salesforce/mcp-app` holds the API Catalog entry `ReportsApi`, the MCP server `SalesforceReports` with its eleven tools, and the External Client App that Claude signs in through. It holds no code: install the REST door first.

1. Deploy it from `salesforce/`, on top of `force-app`.

   ```bash
   sf project deploy start -d mcp-app -o <alias>
   ```

2. Run the setup script from the repo root. It writes the eleven tool rows if they are missing, turns the server on, and prints the server's URL. Name the org with `--org`, then either pass `--yes` or set `SF_REPORTS_SETUP_ORGS` to the aliases these scripts may change (comma-separated). When that variable is set, an alias not on it is refused even with `--yes`. The script prints the alias and instance URL before it writes.

   ```bash
   npm run mcp:setup -- --org <alias> --yes
   ```

3. If the script says operations are inactive and a tool call fails, open Setup, go to API Catalog, open `ReportsApi`, select its eleven operations, and click Activate. No API does this.
4. Read the External Client App's consumer key. It is a public client with PKCE and the `mcp_api` and `refresh_token` scopes. Run the query, then pass the Id it prints to the second command. Run both from `salesforce/`.

   ```bash
   sf data query -t -q "SELECT Id FROM ExternalClientApplication WHERE DeveloperName = 'SalesforceReportsMcp'" -o <alias>
   sf api request rest "/services/data/v68.0/apps/oauth/credentials/<app id>" -o <alias>
   ```

5. Connect Claude. In claude.ai, open Settings, then Connectors, then Add custom connector. Paste the URL from step 2. Under Advanced settings, paste the consumer key as the OAuth Client ID. Click Add, then Connect, and sign in to the org. A sandbox or scratch org uses `https://api.salesforce.com/platform/mcp/v1/sandbox/custom/SalesforceReports`. Production and Developer Edition use the same URL without `sandbox/`.

Each user signs in as themselves, so sharing, folder access and field-level security apply. The save tools are listed for every user, and refuse anyone without `Salesforce_Reports_Write`. To check the door from a terminal, run `SF_MCP_TOKEN=<token> npm run mcp-check -- --org <alias>` with an access token from that sign-in. It lists the tools and runs `search_reports` and `run_report`. After you change a tool in `src/server.ts`, run `npm run mcp:generate`, then deploy `mcp-app` again.

### The callout tools on the MCP door

Without more setup, `list_report_types`, `query_report`, `combine_reports` with definitions and the save tools answer `CALLOUT_SESSION` on the MCP door. `salesforce/callout-app` fixes that with a per-user named credential: the org mints a token for each signed-in user itself, so no user clicks anything and no secret is stored. It holds no code, and the tracked files hold placeholders only.

1. Run its setup script from the repo root. It fills the org's My Domain, the app's consumer key and the certificate the org makes into a temp copy, deploys it, and prints none of them. The same `--yes` or `SF_REPORTS_SETUP_ORGS` rule applies.

   ```bash
   npm run callout:setup -- --org <alias> --yes
   ```

2. Assign its permission set to each user of the MCP door. A user without it gets `CALLOUT_CREDENTIAL`, with a hint naming the set.

   ```bash
   sf org assign permset -n Salesforce_Reports_Callout -o <alias> --on-behalf-of <user>
   ```

[salesforce/README.md](../salesforce/README.md) has the steps the script runs and the removal.

To remove the MCP door, run `npm run mcp:teardown -- --org <alias> --yes` (the same `--yes` or `SF_REPORTS_SETUP_ORGS` rule applies), then the `mcp-app` removal in [salesforce/README.md](../salesforce/README.md). The REST door stays and keeps working.

## The skills

The skills live in `skills/`: `report-runner`, `report-designer` and `report-deploy`. Each has a `description` that makes Claude pick it for its own experience, and the designer and runner keep a `reference.md` with the definition grammar and how to read a result. The plugin installs all three.

The runner and designer work over any door: the local MCP server, the hosted MCP server, or the in-org REST door. The REST door needs no MCP server, only the `sf` CLI signed in to the org and the package from `salesforce/` deployed there, so it suits Claude Code and any agent with a shell. Each skill's [transport.md](../skills/report-runner/transport.md) says how to tell which door is there, how to call each tool through `sf api request rest`, and what the refusals `WRITE_NOT_ALLOWED` and `CALLOUT_SESSION` mean.
