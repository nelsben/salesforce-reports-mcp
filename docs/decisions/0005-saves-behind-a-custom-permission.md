# 0005. Saves behind a custom permission, enforced in the service, not hidden in the tool list

Status: Accepted, 2026-10-11

## Context

Reading reports is safe for anyone who can already see them. Saving is not: an admin may want everyone to explore but only a few people to create reports through an AI client. The local server solves this with `--read-only`, which removes the write tools. One hosted MCP server has one tool list for every user, and the MCP Tooling objects have no user or permission field, so tools cannot be hidden per user.

## Decision

- A custom permission, `Reports_MCP_Write`, in its own permission set, `Salesforce_Reports_MCP_Write`.
- `ReportsService` checks it with `FeatureManagement.checkPermission` before it reads the input or makes any callout. Without it, `create_report`, `update_report` and `clone_report` answer `WRITE_NOT_ALLOWED` with a hint naming the permission set.
- The save tools stay listed on the hosted server for everyone. The server's description and each save operation's documented 403 response say a permission is needed, and the skills know the refusal code.

## Consequences

- The control holds no matter which client calls, because a tool list is not a security boundary: the REST door can be called directly by anyone holding a session.
- Some users see tools they cannot use. The cost is a refused call, which the skills turn into "ask an admin for `Salesforce_Reports_MCP_Write`".
- The user also needs Salesforce's own Create and Customize Reports permission. The custom permission narrows what Salesforce allows; it never widens it.

## Alternatives

- **A second hosted server for saving.** Rejected: two connectors, two sets of tool rows, and a split conversation, for no control the service check does not already give.
- **Check in the tool list only.** Not possible on one hosted server, and not safe on any door.
