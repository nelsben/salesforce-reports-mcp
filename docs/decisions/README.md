# Decisions

One page per architectural decision: the context, the decision, what it costs, and what was turned down. A decision that changes gets a new record that supersedes the old one; old records stay.

[architecture.md](../architecture.md) is the map these decisions produce, and [design.md](../design.md) is the tool contract.

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-one-contract-three-doors.md) | One tool contract across three doors | Accepted |
| [0002](0002-local-server-needs-nothing-in-the-org.md) | The local server needs nothing installed in the org | Accepted |
| [0003](0003-one-apex-class-behind-both-in-org-doors.md) | One Apex service behind both in-org doors, as ports and adapters | Accepted |
| [0004](0004-reportmanager-first-callout-for-the-rest.md) | `Reports.ReportManager` first, a callout to the org's own REST API for the rest | Accepted |
| [0005](0005-saves-behind-a-custom-permission.md) | Saves behind a custom permission, enforced in the service, not hidden in the tool list | Accepted |
| [0006](0006-no-delete-in-the-org.md) | No delete in the org | Accepted |
| [0007](0007-callout-identity-under-hosted-mcp.md) | The callout's identity under a hosted MCP sign-in | Accepted |
| [0008](0008-result-limits.md) | Result limits: a row cap from the heap, and notes that say so | Accepted |
| [0009](0009-two-shipping-units.md) | Two Salesforce shipping units: the REST door and the MCP adapter | Accepted |
| [0010](0010-verification-by-parity.md) | Verification by parity between doors, against a real org | Accepted |
| [0011](0011-name-permissions-for-the-capability.md) | Name the permissions for the capability, not the door | Accepted |
| [0012](0012-per-user-jwt-named-credential.md) | The hosted door calls out through a per-user JWT named credential, in an optional package | Accepted |
| [0013](0013-report-view-as-an-mcp-app.md) | The report view is an MCP App on the local door only, beside an unchanged text result | Accepted |
| [0014](0014-render-tests-through-a-test-host.md) | The report view is render-tested through a test host page with the real AppBridge | Accepted |
