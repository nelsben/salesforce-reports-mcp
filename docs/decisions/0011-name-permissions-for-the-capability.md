# 0011. Name the permissions for the capability, not the door

Status: Accepted, 2026-10-12. Changes the names in [0005](0005-saves-behind-a-custom-permission.md).

## Context

[0009](0009-two-shipping-units.md) made the REST door installable alone. The permission sets and the custom permission were still named `Salesforce_Reports_MCP`, `Salesforce_Reports_MCP_Write` and `Reports_MCP_Write`. Both sets gate both doors, so an admin who installs only the REST door read "MCP" and thought they were granting MCP access.

## Decision

| Was | Is |
| --- | --- |
| Permission set `Salesforce_Reports_MCP` | `Salesforce_Reports` |
| Permission set `Salesforce_Reports_MCP_Write` | `Salesforce_Reports_Write` |
| Custom permission `Reports_MCP_Write` | `Reports_Write` |

What each grants does not change. The check stays in `ReportsService`.

## Consequences

- The names are right whichever door calls.
- An org that installed the earlier names from `main` deploys `force-app`, assigns the two new sets to the same users, removes the old assignments, then runs the removal manifest for the old sets and the old custom permission. Salesforce will not delete a permission set that is still assigned.
- Anything outside the repo that names the old sets, such as a user's own notes, needs the same edit.

## Alternatives

- **Keep the names.** Misleading on a REST-only install.
- **One set per door.** [0005](0005-saves-behind-a-custom-permission.md) keeps one check in the service, so two sets would grant the same thing twice.
