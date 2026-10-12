# 0003. One Apex service behind both in-org doors, as ports and adapters

Status: Accepted, 2026-10-11

## Context

Salesforce hosted MCP builds a custom MCP server from an API Catalog registration of an Apex REST class: each OpenAPI operation becomes a tool. So the platform already makes the MCP door a layer over a REST door. The question is how to keep that layering clean in the code.

## Decision

Three layers, with dependencies pointing inward only:

| Layer | Classes | Knows about |
| --- | --- | --- |
| Inbound adapter | `ReportsApi` (`@RestResource`) | the URL, the JSON body, HTTP status codes |
| Core | `ReportsService`, `ReportsInput`, `ReportsException`, `ReportsDefinition`, `ReportsShape`, `ReportsSummary`, `ReportsCombine` | tools, reports, permissions. Errors carry a category, never an HTTP status. |
| Outbound adapter | `ReportsCallout` | the org's own REST API |

The MCP adapter is metadata only: the `ExternalServiceRegistration`, the `McpServerDefinition` and the External Client App, plus a setup script that writes the tool rows. It adds no Apex.

The rule is checked in CI by `test/apex-layers.test.ts`: no core class names `ReportsApi`, and none but `ReportsCallout` (which reads upstream responses) touches HTTP status.

## Consequences

- Removing the MCP adapter leaves the REST door untouched. Removing the REST door is impossible without removing the MCP adapter first, and the uninstall order says so.
- Core errors carry a code and a category. Only `ReportsApi` turns a category into 400, 403, 404 or 500, so the mapping lives in one place.
- One more class than strictly needed. Accepted for a codebase people read to learn from.

## Alternatives

- **A second Apex class for MCP.** Rejected: hosted MCP has no Apex entry point of its own; it calls the REST resource.
- **Logic in the `@RestResource` class.** That was phases 1 to 3: `ReportsApi` was 713 lines, and the core called back into it for errors and input helpers. The split (PR #14) left it at 67 lines, with 42 direct door calls byte for byte unchanged.
