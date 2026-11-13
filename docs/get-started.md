# Try it on your own Salesforce org

This page takes you from nothing to a first answer, and then a dashboard, on your own Salesforce org in Claude Desktop. It takes about twenty minutes. Each step ends with a `Check:` line that says what you should see before you go on.

## What you need

- Claude Desktop on macOS or Windows.
- A Claude plan. For the dashboard step you need a plan that includes Claude Data ([how to get started with Claude dashboards](https://support.claude.com/en/articles/17454700-get-started-with-claude-dashboards)).
- A Salesforce user with API Enabled and Run Reports. That means Enterprise, Unlimited, Performance or Developer Edition. Professional Edition works only with the API add-on.
- Nothing is installed in the org, and you need no admin, unless your org blocks API access.

No org of your own to try? A free Developer Edition from https://developer.salesforce.com/signup comes with sample accounts and opportunities.

## 1. Install Node.js and the Salesforce CLI

Install Node.js 20 or later from https://nodejs.org. Choose the LTS installer.

Install the Salesforce CLI from https://developer.salesforce.com/tools/salesforcecli.

Open a terminal. On macOS this is the Terminal app. On Windows it is PowerShell. Then run:

```
node -v
```

```
sf --version
```

Check: `node -v` prints v20 or later, and `sf --version` prints a version.

## 2. Sign in to your org

Run this. A browser window opens. Log in to Salesforce there.

```
sf org login web --alias my-org
```

For a sandbox, add the sandbox address:

```
sf org login web --alias my-org --instance-url https://test.salesforce.com
```

Then run:

```
sf org list
```

Check: `sf org list` shows `my-org` as Connected.

## 3. Connect Claude Desktop

In Claude Desktop, open Settings, then Developer, then Edit Config. This opens a file called `claude_desktop_config.json`.

If the file is empty, paste the whole block for your system. If the file already has `mcpServers`, add only the inner `salesforce-reports` entry next to the others.

On macOS, first run this and copy the path it prints:

```
which npx
```

Then paste this, with your path in place of `/opt/homebrew/bin/npx`:

```json
{
  "mcpServers": {
    "salesforce-reports": {
      "command": "/opt/homebrew/bin/npx",
      "args": ["-y", "salesforce-reports-mcp", "--org", "my-org", "--read-only"],
      "env": { "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" }
    }
  }
}
```

Why the full path: Claude Desktop is launched from the Dock, not from your shell, so it does not see the `PATH` your terminal has. A bare `npx` is often not found, and the server then never starts.

Why the `PATH`: the server runs `sf` to get your session, so the folder that holds `sf` must be on its `PATH`. Without it the first call fails with "The Salesforce CLI (sf) could not be started".

On Windows, paste this:

```json
{
  "mcpServers": {
    "salesforce-reports": {
      "command": "C:\\Program Files\\nodejs\\npx.cmd",
      "args": ["-y", "salesforce-reports-mcp", "--org", "my-org", "--read-only"]
    }
  }
}
```

If you installed Node.js somewhere else, run this and use the path it prints:

```
where npx
```

Save the file. Quit Claude Desktop fully and open it again.

Check: the tools button under the chat box lists `salesforce-reports`.

## 4. Add the skills

A skill only tells Claude how to work. The server from step 3 is what reaches Salesforce.

Download these two files:

```
https://github.com/nelsben/salesforce-reports-mcp/releases/latest/download/report-runner.zip
```

```
https://github.com/nelsben/salesforce-reports-mcp/releases/latest/download/report-designer.zip
```

Then in Claude Desktop:

1. Open Settings, then Capabilities. Turn on Code execution and file creation. Newer settings call it Create and edit files.
2. Open Customize, then Skills. Press +, then Create skill, then Upload a skill. Do this once for each zip.
3. Turn both skills on.

A third skill, report-deploy, is for Claude Code. It runs the Salesforce CLI in a terminal, so Claude Desktop does not use it.

Check: Customize, Skills lists report-runner and report-designer, both on.

## 5. Your first five minutes

Type these three prompts in one chat, in order. Press Allow once on each permission card. Nothing is saved in Salesforce.

1. Ask:

   ```
   How is our open pipeline looking by stage, and what should I worry about?
   ```

   Expect a report card, a total over every close date, the filters Salesforce applied, and a one-line offer of a dashboard.

2. Ask:

   ```
   Yes, make that a dashboard.
   ```

   Expect a Claude dashboard, labelled as a copy with the run date.

3. Ask:

   ```
   Start from that and group it by owner, then show me a preview.
   ```

   Expect a preview. Nothing is saved.

Check: you have seen a report card, a dashboard and a preview, and no report was added in Salesforce.

## Turn on saving

Saving is off because the config has `--read-only`. To turn it on, remove `--read-only` from `args`, then quit and reopen Claude Desktop. Every save is still a tool call that you approve.

## If something goes wrong

| What you see | What to do |
| --- | --- |
| No `salesforce-reports` in the tools list | Check the JSON for a missing comma or bracket. Quit Claude Desktop fully and open it again. Read the log: `~/Library/Logs/Claude/mcp-server-salesforce-reports.log` on macOS, or the files in `%APPDATA%\Claude\logs` on Windows. |
| "The Salesforce CLI (sf) could not be started" | The `PATH` in the config does not include the folder with `sf`. Run `which sf` and add that folder. |
| Log in again, or a 401 error | Your session ended. Run step 2 again. |
| `API_DISABLED_FOR_ORG` or "API not enabled" | Ask your admin to give your profile or permission set API Enabled. |
| A saved report answers forbidden | You have no access to its folder. Ask for the question in plain words instead. |
| Claude answers with a different Salesforce connector | Turn that connector off in Settings, Connectors. |
| A list of fields instead of a card | Start a new chat. |
| Skill upload refused | Upload the zip as downloaded. Do not unzip and zip it again. |

## Remove it

1. Delete the `salesforce-reports` entry from the config, then quit and reopen Claude Desktop.
2. Delete the skills in Customize, Skills.
3. Sign the CLI out of the org:

```
sf org logout --target-org my-org
```
