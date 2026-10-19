# salesforce-reports-mcp

Claude finds, builds, runs and saves Salesforce reports, and reads your dashboards, from an MCP server on your own machine. Nothing is installed in Salesforce, no Salesforce MCP licence is needed, and no admin has to approve anything. You sign in with the Salesforce CLI you already use.

This repo is working software, and a demonstration of how to put MCP in front of Salesforce without Salesforce's own MCP. The same tools are also packaged as a feature inside the org, for people who cannot run a local server, and every design choice is written down with what it costs. Built by [Ben Nelsen](https://github.com/nelsben).

> **You:** I'm a seller. How is our pipeline looking this fiscal year? Is there anything I should worry about, and can you show it to me by owner too?
>
> **Claude:** $3.09M across 8 open opportunities, here by stage and by owner. Worries: one owner holds 91% of the dollars, one deal alone is 29% of the pipeline, nothing is closed won this fiscal year, and one deal has no amount. Salesforce applied its default probability filter. Nothing was saved; say the word and I will save it as a report.
>
> *Claude Desktop, through the local MCP server, signed in with the sf CLI ([rehearsal](docs/rehearsals/runner.md)).*

![The report card for an unsaved opportunity report grouped by stage, drawn in light, then dark, then at phone width](docs/assets/report-view.gif)

In Claude Desktop the run also draws as a card: the headline numbers, the filters Salesforce applied, the groups with a bar beside each amount, and a button that asks Claude to save it. Dashboards draw the same way, every component as its own chart.

![The dashboard card for a pipeline dashboard: a metric, a gauge, a donut, bar, line, table, funnel and column charts](docs/assets/dashboard-card.png)

*Drawn by the [render test](docs/decisions/0014-render-tests-through-a-test-host.md)'s host page from anonymised test data.*

## Run it on your own org

Two commands in Claude Code, with Node 20 and the Salesforce CLI signed in:

```
claude plugin marketplace add nelsben/salesforce-reports-mcp
claude plugin install salesforce-reports@salesforce-reports
```

That installs the three skills and the MCP server. For Claude Desktop, [docs/claude-desktop.md](docs/claude-desktop.md) is the full recipe: the config entry with the two paths that trip people up, how to check it works, the safety flags, and what each Claude surface, including mobile, can do with a local server. For claude.ai and your phone, [From claude.ai and your phone](docs/install.md#from-claudeai-and-your-phone) runs the same server over HTTP behind a tunnel. [docs/install.md](docs/install.md#the-local-mcp-server) has every option.

## Why I built this

Most of what a company knows about its customers and its pipeline sits in Salesforce reports, and most of the people who need those answers cannot build a report. Assistants like Claude are becoming the way people ask, and the hard part is not the model: it is where the code runs, whose identity each call uses, and what it is allowed to change. I built this to work through those questions end to end for one real job, in the open, with every decision written down. The first answer is the local server, which needs nothing from Salesforce but an API session. The in-org packages show what it takes when that is not enough.

## What this repo shows

| Claim | Where to look | Evidence you can check |
| --- | --- | --- |
| **1. MCP on Salesforce without Salesforce MCP**, from Claude Desktop and Claude Code, and from claude.ai and the phone through the same server over HTTP, plus two in-org doors for when a local server is not an option | [Four ways to connect](#four-ways-to-connect) | One tool contract and result shape on every door (16 tools locally, 15 in the org); a [parity check](docs/decisions/0010-verification-by-parity.md) runs the same calls through two doors against a real org and compares them |
| **2. A useful feature added to Salesforce itself**, packaged the way an admin expects | [A feature inside Salesforce](#a-feature-inside-salesforce) | Three package directories; layered Apex with a CI test that fails if the layers leak; 90 Apex tests at 99% coverage |
| **3. Security, authentication and integration** done deliberately, per door | [Security and identity](#security-and-identity) | A different identity per door, a per-user JWT named credential with no stored secret, writes behind a custom permission, and a test that keeps org values out of the repo |
| **4. Product and architecture judgment**, shown in the work | [How it was built](#how-it-was-built) | Personas and [experiences](docs/experiences.md), [7 probes](docs/probes/) before building, [21 decision records](docs/decisions/README.md), [live findings](docs/design.md), [7 rehearsals](docs/rehearsals/README.md) |

## The product

**The problem.** Reports are how a Salesforce org answers questions, and they are hard to use. A seller wants a number, not Report Builder. An analyst wants to try three versions of a report before saving one. An admin wants a report in another org or in git. As of October 2026, Salesforce's own Claude skills and its standard hosted MCP servers had no report tools, and the closest open-source servers could run or create a report, but none could change, clone or combine one, or run one that was never saved.

**Three experiences.** Each is a Claude skill, and Claude picks the right one from what you say.

| Skill | For | What Claude does |
| --- | --- | --- |
| [report-runner](skills/report-runner/SKILL.md) | A seller or manager who wants an answer | Finds the report, says in plain words what it counts, runs it, leads with the answer, offers the next slice. Never saves. |
| [report-designer](skills/report-designer/SKILL.md) | Someone who wants a report changed or made | Drafts the report in your words, previews it on real data, changes it until you like it, saves it in one step when you ask. |
| [report-deploy](skills/report-deploy/SKILL.md) | An admin moving a report between orgs or into git | Retrieves the report's metadata, checks it with a dry run, deploys only after you say yes. |

> **You:** Start from my Pipeline by Stage report. Add Next Step and group it by owner, then save it as Pipeline by Owner.
>
> **Claude:** Preview, with 8 deals under two owners. Saved as a new report in your Private Reports; the original is untouched. Link.

**Answers you can trust.** Every run returns the same compact shape: the filters that were applied, including the ones Salesforce adds on its own, the groups and totals, and notes that say when rows were cut or Salesforce ignored part of the request. The [experiences page](docs/experiences.md) has the personas and the facts that shaped them.

**A report card in the chat.** The card at the top is an MCP App the local server carries with each run: the headline numbers, the filters, the groups with a bar beside each amount (or, for a matrix, a heat grid), the totals, a link to open it in Salesforce and, for an unsaved report, a button that asks Claude to save it. Claude's reply then leads with what the card cannot show instead of repeating it. The card loads nothing from the network, is styled with the Lightning Design System's own tokens so it reads as Salesforce ([decision 0018](docs/decisions/0018-cards-follow-the-lightning-design-system.md)), and every heat cell passes WCAG AA contrast in light and dark. Clients that show only text, such as Claude Code, get the same result as text ([decision 0013](docs/decisions/0013-report-view-as-an-mcp-app.md), [decision 0015](docs/decisions/0015-report-card-visuals.md)).

**Dashboards, read and refreshed.** Claude can find a dashboard, describe its components and filters, read the numbers Salesforce last cached, and refresh it when the data is missing or old. A refresh counts as a write, so read-only mode leaves it out, and no tool saves a dashboard ([decision 0016](docs/decisions/0016-dashboards-read-and-refresh-only.md)). In Claude Desktop the result draws as the dashboard card above, with every component as its own chart in the dashboard's layout ([decision 0017](docs/decisions/0017-dashboard-card.md)).

## Four ways to connect

The local server is the lead: it is the whole product for anyone on Claude Code or Claude Desktop, and it needs nothing from Salesforce beyond an API session. The same server also runs over HTTP behind a tunnel, which is how it reaches claude.ai and the phone with nothing in the org and no Salesforce MCP. The same tools also reach Claude two more ways, for people who cannot run a local process: a seller on claude.ai, a Flow, an Agentforce agent. Those doors live inside the org as Apex. They differ in where the code runs, who hosts it and how the user signs in.

```mermaid
flowchart LR
  subgraph Laptop["Your machine"]
    CC["Claude Code / Desktop"]
    LS["Local MCP server<br/>(Node)"]
    CLI["sf CLI"]
  end
  subgraph Cloud["claude.ai and the phone"]
    CAI["Claude"]
  end
  TUN["HTTPS tunnel"]
  subgraph SF["Salesforce org"]
    GW["Hosted MCP<br/>(Salesforce gateway)"]
    REST["ReportsApi<br/>(Apex REST)"]
    CORE["Reports service<br/>(Apex)"]
    API["Reports REST API"]
  end
  CC -- "1. stdio" --> LS -- "REST" --> API
  CC -- "2. skills + CLI" --> CLI -- "Apex REST" --> REST
  CAI -- "3. MCP over OAuth" --> GW --> REST
  CAI -- "4. MCP over OAuth, passcode" --> TUN --> LS
  REST --> CORE --> API
```

| | 1. Local MCP server | 2. In-org REST door with skills | 3. Hosted MCP door | 4. Local server over HTTP |
| --- | --- | --- | --- | --- |
| **Direction** | Claude reaches into Salesforce | Salesforce offers a feature; Claude calls it | Salesforce serves Claude directly | Claude reaches into Salesforce, from claude.ai and the phone |
| **Runs** | Node on your machine | Apex in the org | Salesforce's MCP gateway, then the same Apex | Node on your machine, behind an HTTPS tunnel |
| **Installed in the org** | Nothing | `force-app` | `force-app`, `mcp-app`, optionally `callout-app` | Nothing |
| **Signs in with** | Your `sf` CLI session or a token | Your own Salesforce session | OAuth with PKCE through an External Client App | The server's own OAuth with a passcode, then your `sf` CLI session |
| **Clients** | Claude Code, Claude Desktop, any MCP client | Claude Code and any agent with a shell; Flow, Agentforce, any HTTP client | claude.ai and any remote MCP client, with nothing to host | claude.ai, Claude mobile, Claude's Dashboard artifacts; one owner |
| **Tools** | All 16, including dashboards; delete only with a flag | 11, no delete | 11, no delete | All 16; delete only with a flag |
| **Choose it when** | You can run a process on your machine. No org change, no Salesforce MCP | An admin wants the feature in the org, used from scripts and agents | A team wants Claude in the browser, governed by the org | You want claude.ai or the phone with no org change and no Salesforce MCP, and can keep a machine up |

Each door gets the same tool names, the same input and the same result ([decision 0001](docs/decisions/0001-one-contract-three-doors.md)). The skills bind to tool names, not to a door, so one skill works over all four. Door 4 acts as one Salesforce user, the one signed in on that machine ([decision 0020](docs/decisions/0020-door-four-the-local-server-over-http.md)). [docs/architecture.md](docs/architecture.md) has a numbered sequence diagram for each door, with every step explained.

## A feature inside Salesforce

The in-org doors are the same tools, rebuilt in Apex so they run where a local server cannot. They are a Salesforce feature an admin installs, not a script. They ship as three package directories in [salesforce/](salesforce/README.md) ([decision 0009](docs/decisions/0009-two-shipping-units.md)):

| Package | Holds | Needs |
| --- | --- | --- |
| `force-app` | The Apex service, its tests, two permission sets and a custom permission | Nothing else; complete on its own |
| `mcp-app` | The API Catalog entry, the MCP server definition and the External Client App Claude signs in through. No code. | `force-app` |
| `callout-app` | The per-user named credential that lets the hosted door call the org's own API as the user. No code. | `force-app`; used by the hosted door |

The Apex is layered as ports and adapters ([decision 0003](docs/decisions/0003-one-apex-class-behind-both-in-org-doors.md)). One service does the work; the REST class is only an adapter, and [a test](test/apex-layers.test.ts) fails CI if the core ever names it or sets an HTTP status. Reads use `Reports.ReportManager` inside the org; only what Apex cannot do (list report types, run an unsaved report, save) calls the org's own REST API ([decision 0004](docs/decisions/0004-reportmanager-first-callout-for-the-rest.md)). There is no delete in the org ([decision 0006](docs/decisions/0006-no-delete-in-the-org.md)).

## Security and identity

Each door signs in differently, and each is least privilege by default.

| Door | Identity | What it can do |
| --- | --- | --- |
| Local | The user's `sf` CLI session, refetched on expiry; never written anywhere | Whatever the user can do. `--read-only` removes every write tool; `delete_report` exists only with `--allow-delete`. |
| REST | The caller's own Salesforce session | Reads with `Salesforce_Reports`. Saves only with `Salesforce_Reports_Write`, checked in the service, not by hiding tools ([decision 0005](docs/decisions/0005-saves-behind-a-custom-permission.md)). |
| Hosted MCP | OAuth with PKCE through the External Client App `SalesforceReportsMcp`, scopes `mcp_api` and `refresh_token` only | The same permission sets. For the calls that need the org's REST API, a per-user JWT named credential mints a token for the signed-in user. |

Sharing, folder access and field-level security apply on every door, because every call runs as the user.

**The hard part, and how it was solved.** Under a hosted MCP sign-in, Apex has no session, and asking for one throws an exception no `catch` block can stop. The first version leaked a raw platform error to claude.ai. The fix came in two steps, each with a decision record:

1. The hosted door got its own route, so the code knows which door called before it asks for a session, and answers a clear `CALLOUT_SESSION` instead ([decision 0007](docs/decisions/0007-callout-identity-under-hosted-mcp.md)).
2. A probe showed that a [per-user JWT named credential](docs/probes/v0.2-phase3c.md) lets the org mint a token for the running user from a certificate it made itself. No secret is stored, no user clicks anything, and the connector's own app keeps its narrow scopes ([decision 0012](docs/decisions/0012-per-user-jwt-named-credential.md)). `npm run callout:renew` renews the certificate.

No token, consumer key, org address or certificate reaches the repo, logs or error messages. The tracked metadata holds placeholders that setup scripts fill at deploy time, and a test enforces it.

## How it was built

The method was the same for every feature: probe the platform, decide in writing, build, then check against a real org.

| Step | What it produced |
| --- | --- |
| **Probe** before building | [7 probe write-ups](docs/probes/): can a hosted MCP server wrap Apex, can Apex call its own org's API, how big a result fits in the heap, which identity works under a hosted sign-in, how dashboards refresh and filter |
| **Decide** in writing | [21 decision records](docs/decisions/README.md), each with what it costs and what was turned down |
| **Build** to one contract | [design.md](docs/design.md): the input and output shapes, and the live findings where Salesforce did not behave as documented |
| **Verify** against a real org | 268 unit and server tests, 24 render tests that draw the report and dashboard cards in a browser, 90 Apex tests, a live end-to-end check that leaves no report behind, and a parity check across doors; `npm run verify` runs all of it against one org and ends with one table of counts |
| **Rehearse** the experience | [7 rehearsals](docs/rehearsals/README.md): real Claude runs of each skill on each door, with what went wrong and what changed |

## Get started

| You want | Start here |
| --- | --- |
| Claude Desktop on your own org, nothing installed in Salesforce | [Claude Desktop guide](docs/claude-desktop.md) |
| Claude Code or another MCP client, the same way | [Local MCP server](docs/install.md#the-local-mcp-server) |
| The feature inside your org, called from the CLI, scripts or agents | [The REST door](docs/install.md#the-rest-door) |
| Claude on claude.ai or your phone, with nothing in the org and no Salesforce MCP | [From claude.ai and your phone](docs/install.md#from-claudeai-and-your-phone) |
| Claude in the browser, signed in through Salesforce | [The MCP door](docs/install.md#the-mcp-door), then [the callout tools](docs/install.md#the-callout-tools-on-the-mcp-door) |

The tools, the result shape, the safety rails and the limits are in [docs/reference.md](docs/reference.md).

## Develop

```
npm install
npm run build
npm test
npm run test:render                            # draw the report card in Chromium and compare screenshots
npm run live -- --org <alias> --allow-delete   # end-to-end run against an org you can write to
npm run capture -- --org <alias>               # refresh the test fixtures (anonymised)
```

`npm run live` creates several private reports named `zz-live-check-*`, deletes them, and fails if any remain. Use a sandbox or scratch org.

## Roadmap

- Joined reports, report charts, and subscriptions.

## License

MIT.
