# 0002. The local server needs nothing installed in the org

Status: Accepted, 2026-10-11

## Context

The first question anyone has is "does this work on my org?" Anything that needs an admin before that question is answered slows adoption, and in many companies stops it.

## Decision

The local MCP server talks only to the public Reports and Dashboards REST API, as the signed-in user, through the Salesforce CLI's session or a token the user already holds. It installs nothing, creates no Connected App and needs no admin. The in-org doors are optional additions, and the local server never depends on them.

## Consequences

- Anyone with API access and report permissions can try it in minutes.
- Sharing, folder access and field-level security are Salesforce's own, because every call runs as the user.
- The user's machine holds a token. The server reads it from `sf org auth show-access-token`, never logs it, and never puts it in an error message.
- It cannot serve users who have no shell, such as claude.ai in a browser. That is what the hosted MCP door is for.

## Alternatives

- **Ship the Apex package first.** Rejected for v0.1: an install before a first result.
