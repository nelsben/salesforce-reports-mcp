# 0020. Door four: the local server over HTTP, behind a tunnel, with its own sign-in for one owner

Status: Accepted, 2026-10-19

## Context

The local server speaks stdio, so only hosts that start a process can use it. claude.ai in a browser, Claude mobile and Claude's Dashboard artifacts reach tools only through a remote connector: an HTTPS URL that signs in with OAuth. Before this record, the two ways to such a connector were the in-org hosted door, which is Salesforce MCP and needs an admin ([decision 0009](0009-two-shipping-units.md)), and a self-hosted server that did not exist yet.

The repo's headline is MCP on Salesforce with nothing in the org and no Salesforce MCP ([decision 0002](0002-local-server-needs-nothing-in-the-org.md)). That headline should reach claude.ai and the phone too.

## Decision

The same server, with the same 16 tools and the same two `ui://` views, can run over Streamable HTTP. It is a fourth door.

- `--http <port>` serves the MCP endpoint at `/mcp` on `--host` (default `127.0.0.1`). Without `--http`, stdio is unchanged.
- It stays signed in to Salesforce the way the local door is: the `sf` CLI session of the machine it runs on, or a token held in the environment. Nothing is installed in the org.
- Reaching it from claude.ai needs a public HTTPS URL, which is a tunnel the owner starts (`cloudflared tunnel --url http://127.0.0.1:8787` works; any HTTPS tunnel does). `--public-url <url>` turns the sign-in layer on and names the issuer.
- The server is its own OAuth 2.1 authorization server, for one owner. It serves the metadata documents, dynamic client registration, PKCE (S256), `/authorize`, `/token` and `/revoke`. `/authorize` shows a page that names the requesting client and asks for a passcode read from `SF_REPORTS_HTTP_PASSCODE` (at least 16 characters, environment only, never a flag). The server refuses to start with the layer on and no passcode.
- Tokens are random opaque values, bound to this server's `/mcp` as their audience. Only SHA-256 hashes are kept, in memory. Access tokens last one hour, refresh tokens 30 days and rotate on each use. Restarting the server signs every client out.
- `/mcp` requires a valid bearer token once the layer is on. Loopback without `--public-url` needs none.

## Consequences

- Every client that signs in acts as one Salesforce user: the user whose `sf` session the machine holds. The passcode decides who may use that identity. There are no per-user identities on this door. For per-user identity, use the in-org hosted door.
- The machine must stay up and awake, and the tunnel must run. Closing the laptop ends the connector.
- The server is reachable on a public URL. The passcode, the rate limit on the passcode page, short-lived audience-bound tokens and `--read-only` are the controls. Run with `--read-only` unless writes are wanted.
- A restart means signing in again on each client, since tokens are not stored on disk.
- The view travels with the tools, so the report and dashboard cards draw wherever the host draws MCP Apps.
- No new Salesforce footprint. The security table in the architecture page gains a row for the passcode.

## Alternatives turned down

- **Token passthrough**, accepting the client's Salesforce token and forwarding it. The MCP specification forbids a server accepting tokens that were not issued for it, and the token would reach a process it was never meant for.
- **Salesforce as the identity provider.** Sign-in through Salesforce needs an External Client App or Connected App in the org, which is an admin task and is what decision 0002 avoids. It would also make this a second hosted door.
- **A shared secret in the URL.** It leaks through logs and screenshots, cannot be rotated per client, and claude.ai custom connectors expect OAuth.
- **No sign-in behind an unguessable tunnel URL.** Anyone who learns the URL could run reports as the owner.
- **A hosted service run by this project.** It would hold Salesforce credentials off the owner's machine, which is the thing the local door avoids.
