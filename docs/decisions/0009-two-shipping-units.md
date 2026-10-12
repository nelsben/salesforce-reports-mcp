# 0009. Two Salesforce shipping units: the REST door and the MCP adapter

Status: Accepted, 2026-10-11. Done: `salesforce/` holds the two package directories, each with its own removal manifest in `salesforce/manifest/`, and `test/packages.test.ts` keeps them apart in CI.

## Context

Some orgs want the REST door only: for Claude Code through the Salesforce CLI, for Flow, for Agentforce. Hosted MCP needs more: an API Catalog entry, a server definition, an External Client App, tool rows, and a Setup click to activate the operations. An admin should be able to install the first without the second, and see exactly what the second adds.

## Decision

| Unit | Contents | Depends on |
| --- | --- | --- |
| `salesforce/force-app` | the Apex classes and tests, the two permission sets, the custom permission | nothing |
| `salesforce/mcp-app` | the `ExternalServiceRegistration`, the `McpServerDefinition`, the External Client App; `npm run mcp:setup` writes the tool rows | `force-app` |

Removal runs in the opposite order, because Salesforce will not delete a class an API Catalog entry names.

## Consequences

- The REST door with a skill is a complete feature on its own: deploy `force-app`, assign a permission set, use the skills from Claude Code.
- The MCP door is visibly a thin adapter: its package has no code.
- Two deploy commands instead of one for orgs that want both.
- Unlocked packages are the natural next step for versioned installs; source deploys are enough until there is a release to version.

## Alternatives

- **One directory for everything.** That was phases 1 to 3. It made the REST door look like it needed MCP pieces.
