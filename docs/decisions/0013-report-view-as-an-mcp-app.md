# 0013. The report view is an MCP App on the local door only, beside an unchanged text result

Status: Accepted, 2026-10-13

## Context

A report result reads best the way Salesforce draws it: a title, the filters, a group table with totals, then detail rows. Claude Desktop renders MCP Apps from a local stdio server. This was verified on 2026-10-13 with the ext-apps customer-segmentation example. So the local door can draw a result inside the Claude surface, not only describe it.

Not every host draws MCP Apps. Claude Code shows text, and the skills and tests read the text result as JSON. The hosted door is built by Salesforce from an API Catalog registration of an Apex REST class, and that registration cannot carry a `ui://` resource. The REST door answers plain JSON.

## Decision

- The view lives on the local door only. `run_report` and `query_report` are registered with `registerAppTool` from `@modelcontextprotocol/ext-apps/server`, with `_meta.ui.resourceUri` set to `ui://salesforce-reports/report`. Their inputs, descriptions, annotations and errors are unchanged. Every other tool stays as it was.
- The two tools return the `ReportResult` twice: the text content, byte for byte what they returned before, and `structuredContent` with the same object. They declare no `outputSchema`, so the SDK does not validate the result against a second schema.
- The view is one self-contained HTML resource of type `text/html;profile=mcp-app`. Its CSS and script are inline, and the ext-apps browser client is inlined from the installed package when the view is first served. It loads nothing from the network, so it needs no csp block.
- The view draws data only. It sets every value through `textContent`, never calls a tool by itself, and offers two actions: open the report in Salesforce, and, for an unsaved result, ask Claude in the chat to save it.

## Consequences

- `@modelcontextprotocol/ext-apps` becomes the third runtime dependency, pinned to 1.x. Version 2 needs the MCP SDK 2 and zod 4, and this repo stays on the SDK 1.x and zod 3.25.
- The view is not parity-checked against the in-org doors, which have none. Parity covers the `ReportResult`, and that is unchanged.
- Hosts that show text only, such as Claude Code, see no change.
- The served view is about 330 KB, almost all of it the ext-apps client. It is read once per server process and cached.

## Alternatives turned down

- **An artifact page.** It would need a publish step and a URL per result, and it would sit outside the chat turn that produced the numbers.
- **A view loaded from a CDN, with a csp allowlist.** It would add a network dependency and a third-party origin to every render, where an inline document needs neither.
- **Drawing the view on the hosted door with HXL widgets.** The hosted door is generated from an API Catalog registration, which cannot carry a `ui://` resource, and a second view technology would split the design.
