// The HTTP door's own OAuth 2.1 server, for one owner. It issues tokens only for this server's /mcp,
// and only after the owner types the passcode from SF_REPORTS_HTTP_PASSCODE on the /authorize page.
// Everything lives in memory: a restart signs every client out. Importing this module does nothing.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

export const PASSCODE_ENV = "SF_REPORTS_HTTP_PASSCODE";
export const MIN_PASSCODE_LENGTH = 16;

const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_S = 30 * 24 * 60 * 60;
const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_WRONG_PASSCODES = 10;
const WRONG_PASSCODE_WINDOW_MS = 15 * 60 * 1000;
// Hosts that may use plain http, for a public URL and for a registered redirect URI.
const LOOPBACK_HTTP_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

export interface OAuthOptions {
  /** The URL clients reach this server at, such as a tunnel's https URL. The issuer; the resource is `<url>/mcp`. */
  publicUrl: string;
  /** From SF_REPORTS_HTTP_PASSCODE only. Never logged, never echoed. */
  passcode: string;
  /** Milliseconds since the epoch. Tests inject a clock. */
  now?: () => number;
}

/** The issuer URL: https, or http on localhost or 127.0.0.1, with no path, query or fragment. */
export function resolvePublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("--public-url must be an absolute URL, such as https://reports.example.com.");
  }
  // The SDK allows a plain http issuer only on these two hosts.
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("--public-url must use https, unless its host is localhost or 127.0.0.1.");
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("--public-url must be an origin only, with no path, query or fragment, such as https://reports.example.com.");
  }
  return url;
}

/** Checks the passcode without ever putting it in the message. */
export function checkPasscode(passcode: string | undefined): string {
  if (!passcode) throw new Error(`${PASSCODE_ENV} must be set when --public-url turns the OAuth layer on.`);
  if (passcode.length < MIN_PASSCODE_LENGTH) throw new Error(`${PASSCODE_ENV} must be at least ${MIN_PASSCODE_LENGTH} characters.`);
  return passcode;
}

/** Validates the options before anything starts, so a bad start fails before Salesforce is touched. */
export function checkOAuthOptions(options: OAuthOptions): { publicUrl: URL; resource: URL } {
  checkPasscode(options.passcode);
  const publicUrl = resolvePublicUrl(options.publicUrl);
  return { publicUrl, resource: new URL("/mcp", publicUrl) };
}

const sha256 = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();
const hashKey = (value: string): string => sha256(value).toString("base64url");
const newSecret = (): string => randomBytes(32).toString("base64url");

// A resource compared as a string, without its fragment and one trailing slash, as the SDK's bearer check does.
function comparable(value: URL | string): string {
  const text = String(value);
  const hash = text.indexOf("#");
  return (hash === -1 ? text : text.slice(0, hash)).replace(/\/$/, "");
}

function allowedRedirect(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash) return false;
  return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HTTP_HOSTS.includes(url.hostname));
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

interface PendingCode {
  clientId: string;
  redirectUri: string;
  challenge: string;
  resource: string;
  scopes: string[];
  expiresAt: number;
  challenged: boolean;
}

interface Grant {
  kind: "access" | "refresh";
  clientId: string;
  resource: string;
  scopes: string[];
  expiresAt: number;
}

/** An in-memory OAuth server for one owner. Codes and tokens are kept only as SHA-256 hashes. */
export class OwnerOAuthProvider implements OAuthServerProvider {
  readonly resource: URL;
  private readonly now: () => number;
  private readonly passcodeHash: Buffer;
  private readonly clients = new Map<string, OAuthClientInformationFull>();
  private readonly codes = new Map<string, PendingCode>();
  private readonly grants = new Map<string, Grant>();
  private wrongPasscodes: number[] = [];

  constructor(options: OAuthOptions) {
    this.resource = checkOAuthOptions(options).resource;
    this.passcodeHash = sha256(options.passcode);
    this.now = options.now ?? Date.now;
  }

  readonly clientsStore: OAuthRegisteredClientsStore = {
    getClient: (clientId) => this.clients.get(clientId),
    registerClient: (client) => {
      const full = client as OAuthClientInformationFull;
      if (full.redirect_uris.length === 0 || !full.redirect_uris.every(allowedRedirect)) {
        throw new InvalidClientMetadataError("Each redirect URI must use https, or http on a loopback host.");
      }
      this.clients.set(full.client_id, full);
      return full;
    },
  };

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: any): Promise<void> { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (params.resource && comparable(params.resource) !== comparable(this.resource)) {
      throw new InvalidTargetError(`This server issues tokens only for ${this.resource.href}.`);
    }
    const req = res.req as { method: string; body?: Record<string, unknown> };
    if (req.method !== "POST") {
      this.page(res, 200, client, params);
      return;
    }
    const now = this.now();
    this.wrongPasscodes = this.wrongPasscodes.filter((t) => now - t < WRONG_PASSCODE_WINDOW_MS);
    if (this.wrongPasscodes.length >= MAX_WRONG_PASSCODES) {
      this.page(res, 429, client, params, "Too many wrong passcodes. Wait 15 minutes, then try again.");
      return;
    }
    const given = typeof req.body?.passcode === "string" ? req.body.passcode : "";
    if (!timingSafeEqual(sha256(given), this.passcodeHash)) {
      this.wrongPasscodes.push(now);
      this.page(res, 403, client, params, "That passcode is not right.");
      return;
    }
    this.prune(now);
    const code = newSecret();
    this.codes.set(hashKey(code), {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      challenge: params.codeChallenge,
      resource: this.resource.href,
      scopes: params.scopes ?? [],
      expiresAt: now + CODE_TTL_MS,
      challenged: false,
    });
    const target = new URL(params.redirectUri);
    target.searchParams.set("code", code);
    if (params.state !== undefined) target.searchParams.set("state", params.state);
    res.redirect(302, target.href);
  }

  // The token handler asks for the challenge, checks the verifier, then exchanges. Asking spends the code,
  // so a wrong verifier burns it and a second try with the same code fails.
  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const key = hashKey(authorizationCode);
    const entry = this.codes.get(key);
    if (!entry || entry.challenged || entry.clientId !== client.client_id || entry.expiresAt <= this.now()) {
      this.codes.delete(key);
      throw new InvalidGrantError("The authorization code is invalid, used or expired.");
    }
    entry.challenged = true;
    return entry.challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const key = hashKey(authorizationCode);
    const entry = this.codes.get(key);
    this.codes.delete(key);
    if (!entry || !entry.challenged || entry.clientId !== client.client_id || entry.expiresAt <= this.now()) {
      throw new InvalidGrantError("The authorization code is invalid, used or expired.");
    }
    if (redirectUri !== undefined && redirectUri !== entry.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request.");
    }
    if (resource && comparable(resource) !== comparable(entry.resource)) {
      throw new InvalidTargetError("resource does not match the authorization request.");
    }
    return this.issueTokens(client.client_id, new URL(entry.resource), entry.scopes);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const key = hashKey(refreshToken);
    const grant = this.grants.get(key);
    if (!grant || grant.kind !== "refresh" || grant.clientId !== client.client_id || grant.expiresAt <= this.now()) {
      if (grant && grant.expiresAt <= this.now()) this.grants.delete(key);
      throw new InvalidGrantError("The refresh token is invalid, used or expired.");
    }
    if (resource && comparable(resource) !== comparable(grant.resource)) {
      throw new InvalidTargetError("resource does not match the refresh token.");
    }
    if (scopes && !scopes.every((s) => grant.scopes.includes(s))) {
      throw new InvalidScopeError("A refresh cannot widen the scopes.");
    }
    // Rotate: the old refresh token stops working.
    this.grants.delete(key);
    return this.issueTokens(client.client_id, new URL(grant.resource), scopes ?? grant.scopes);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const key = hashKey(token);
    const grant = this.grants.get(key);
    if (!grant || grant.kind !== "access") throw new InvalidTokenError("The access token is not valid.");
    if (grant.expiresAt <= this.now()) {
      this.grants.delete(key);
      throw new InvalidTokenError("The access token has expired.");
    }
    if (comparable(grant.resource) !== comparable(this.resource)) {
      throw new InvalidTokenError("The access token was not issued for this resource.");
    }
    return {
      token,
      clientId: grant.clientId,
      scopes: grant.scopes,
      expiresAt: Math.floor(grant.expiresAt / 1000),
      resource: new URL(grant.resource),
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const key = hashKey(request.token);
    if (this.grants.get(key)?.clientId === client.client_id) this.grants.delete(key);
  }

  /** Issues an access and refresh token pair. Only the hashes are kept. */
  issueTokens(clientId: string, resource: URL, scopes: string[]): OAuthTokens {
    const now = this.now();
    this.prune(now);
    const accessToken = newSecret();
    const refreshToken = newSecret();
    this.grants.set(hashKey(accessToken), { kind: "access", clientId, resource: resource.href, scopes, expiresAt: now + ACCESS_TTL_S * 1000 });
    this.grants.set(hashKey(refreshToken), { kind: "refresh", clientId, resource: resource.href, scopes, expiresAt: now + REFRESH_TTL_S * 1000 });
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_S,
      refresh_token: refreshToken,
      ...(scopes.length ? { scope: scopes.join(" ") } : {}),
    };
  }

  private prune(now: number): void {
    for (const [key, code] of this.codes) if (code.expiresAt <= now) this.codes.delete(key);
    for (const [key, grant] of this.grants) if (grant.expiresAt <= now) this.grants.delete(key);
  }

  // One self-contained page: no script, no external asset. The passcode is never written back into it.
  private page(res: any, status: number, client: OAuthClientInformationFull, params: AuthorizationParams, error?: string): void { // eslint-disable-line @typescript-eslint/no-explicit-any
    const name = escapeHtml(client.client_name || client.client_id);
    const returnHost = escapeHtml(new URL(params.redirectUri).host);
    const hidden: Record<string, string | undefined> = {
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: params.redirectUri,
      code_challenge: params.codeChallenge,
      code_challenge_method: "S256",
      state: params.state,
      scope: params.scopes?.length ? params.scopes.join(" ") : undefined,
      resource: params.resource?.href,
    };
    const fields = Object.entries(hidden)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`)
      .join("\n      ");
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in to Salesforce reports</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 16px/1.5 system-ui, sans-serif; background: Canvas; color: CanvasText; }
  main { max-width: 28rem; margin: 3rem auto; padding: 0 1rem; }
  h1 { font-size: 1.4rem; }
  .error { color: #b3261e; font-weight: 600; }
  label { display: block; margin: 1.25rem 0 .25rem; font-weight: 600; }
  input[type=password] { box-sizing: border-box; width: 100%; padding: .6rem; font: inherit; }
  button { margin-top: 1rem; padding: .6rem 1.2rem; font: inherit; cursor: pointer; }
  .small { font-size: .875rem; opacity: .8; }
</style>
</head>
<body>
<main>
  <h1>Allow ${name} to use Salesforce reports?</h1>
  <p><strong>${name}</strong> asks to connect to this server. Approving lets it run this server's tools as the Salesforce user this server is signed in as.</p>
  <p class="small">After you approve, you go back to ${returnHost}. Only approve a client you just added yourself.</p>
  ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
  <form method="post" action="/authorize">
      ${fields}
    <label for="passcode">Passcode</label>
    <input id="passcode" name="passcode" type="password" autocomplete="current-password" required autofocus>
    <button type="submit">Approve</button>
  </form>
</main>
</body>
</html>
`;
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.status(status).type("html").send(html);
  }
}

export interface OwnerAuth {
  provider: OwnerOAuthProvider;
  /** Metadata, registration, /authorize, /token and /revoke. Mount at the app root. */
  router: ReturnType<typeof mcpAuthRouter>;
  /** Guards /mcp: a valid bearer for this resource, or 401 naming the resource metadata URL. */
  bearer: ReturnType<typeof requireBearerAuth>;
  /** Host headers the app accepts: the public host and loopback. */
  allowedHosts: string[];
}

export function createOwnerAuth(options: OAuthOptions): OwnerAuth {
  const { publicUrl, resource } = checkOAuthOptions(options);
  const provider = new OwnerOAuthProvider(options);
  // Behind a tunnel every request arrives from loopback with an X-Forwarded-For header. The SDK's limits then
  // count all callers together, which suits one owner; skip the check that would print a stack trace for it.
  const rateLimit = { validate: { xForwardedForHeader: false } };
  const router = mcpAuthRouter({
    provider,
    issuerUrl: publicUrl,
    resourceServerUrl: resource,
    resourceName: "Salesforce reports",
    authorizationOptions: { rateLimit },
    clientRegistrationOptions: { rateLimit },
    tokenOptions: { rateLimit },
    revocationOptions: { rateLimit },
  });
  const bearer = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource),
    expectedResource: resource,
  });
  const allowedHosts = [...new Set([publicUrl.hostname, ...LOOPBACK_HTTP_HOSTS])];
  return { provider, router, bearer, allowedHosts };
}
