# 0014. The report view is render-tested through a test host page with the real AppBridge

Status: Accepted, 2026-10-14

## Context

The report view ([0013](0013-report-view-as-an-mcp-app.md)) only draws inside a host. A host loads the HTML into an iframe, answers the view's handshake, and sends it the host context, the tool input and the tool result. Until now the tests checked only the HTML the server serves, so nothing proved that a card actually drew.

Claude Desktop draws the view, but it cannot run in CI. The reference hosts, the ext-apps basic-host and the MCP Inspector, connect to a server over HTTP. This server speaks stdio only.

## Decision

- A test host page in `test/render/` loads the view exactly as the server serves it (`reportViewHtml()` from the built `dist`) into a sandboxed iframe through `srcdoc`. It speaks the host side of the protocol with the real `AppBridge` and `PostMessageTransport` from `@modelcontextprotocol/ext-apps/app-bridge`, bundled for the browser with esbuild at test time.
- The host sends a host context (theme, inline display mode, a container width), then the tool input, then a tool result built from an anonymised fixture `ReportResult`. It records the view's `ui/message` and `ui/open-link` requests, so a spec can check the two buttons.
- Playwright drives it in Chromium (`npm run test:render`). Each case checks the DOM first, then compares a screenshot of the iframe. Baselines are kept per platform under `test/render/__screenshots__/<platform>/`. CI runs it in a render job on Linux and uploads the results.
- The README demo GIF (`npm run demo:gif`) is recorded from the same host page and fixture, so the picture shows the view the tests check.

## Consequences

- Two devDependencies, `@playwright/test` and `esbuild`, both pinned. No runtime dependency changes.
- What only Claude's own host does stays covered by a by-hand Desktop check: its iframe and sandbox proxy, its CSP, and the style variables and fonts it sends.
- Baselines exist per platform, since fonts differ between macOS and Linux. A change to the view's look updates them on both.
- The render test needs `npm run build` first, because it loads the view from `dist`.

## Alternatives turned down

- **An HTTP transport so the reference hosts can connect.** It would open a port on a stdio server only for tests.
- **An app-only tool that reports what the view drew.** It would add a tool to the server only for tests.
- **Checking only the served HTML.** That is what existed, and it proves nothing drew.
