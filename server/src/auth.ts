// OAuth for Alexa+ (docs/alexa-plus-design-rules.md §2). A small local
// authorization server with the same contract a Cognito user pool plus a token
// Lambda gives us on AWS:
//   Tier 1  client_credentials, scope mcp:service — initialize, tools/list
//   Tier 2  authorization code + PKCE S256, scope mcp:tools — every tool call
// Tokens are short-lived signed JWTs whose audience is the MCP server URI.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import express, { type Request, type Response, type NextFunction, type Router } from "express";

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
  name: string;
  /** Scopes this client may request with client_credentials. */
  serviceScopes: string[];
}

export interface AuthConfig {
  /** Canonical MCP server URI; tokens must be minted for exactly this resource. */
  resource: string;
  /** The phone-agent MCP URI (Amazon Connect's AI agent calls this). */
  agentResource: string;
  issuer: string;
  secret: string;
  clients: OAuthClient[];
  /** The account that signs in on the local consent page (Cognito's hosted login on AWS). */
  userId: string;
  userName: string;
  /** Which token subjects are real accounts. Defaults to just userId. */
  knownUser?: (sub: string) => boolean;
  tokenTtlSec?: number;
}

export interface TokenClaims {
  iss: string;
  aud: string;
  sub: string;
  client_id: string;
  scope: string;
  iat: number;
  exp: number;
  jti: string;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const sha256 = (s: string) => createHash("sha256").update(s).digest();

export class TokenService {
  constructor(private secret: string) {}

  sign(claims: TokenClaims): string {
    const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const body = b64url(JSON.stringify(claims));
    const sig = b64url(createHmac("sha256", this.secret).update(`${head}.${body}`).digest());
    return `${head}.${body}.${sig}`;
  }

  verify(token: string): TokenClaims | undefined {
    const parts = token.split(".");
    if (parts.length !== 3) return undefined;
    const [head, body, sig] = parts;
    const expected = createHmac("sha256", this.secret).update(`${head}.${body}`).digest();
    const given = Buffer.from(sig, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
    try {
      const h = JSON.parse(Buffer.from(head, "base64url").toString());
      if (h.alg !== "HS256") return undefined;
      const c = JSON.parse(Buffer.from(body, "base64url").toString()) as TokenClaims;
      if (typeof c.exp !== "number" || c.exp * 1000 < Date.now()) return undefined;
      return c;
    } catch {
      return undefined;
    }
  }
}

interface PendingCode {
  clientId: string;
  redirectUri: string;
  challenge: string;
  resource: string;
  scope: string;
  expiresAt: number;
}

type OAuthErrorCode = "invalid_request" | "invalid_client" | "invalid_grant" | "unauthorized_client" | "unsupported_grant_type" | "invalid_scope" | "access_denied" | "invalid_target";

function oauthError(res: Response, status: number, error: OAuthErrorCode, description: string) {
  res.status(status).set("cache-control", "no-store").json({ error, error_description: description });
}

export class AuthServer {
  readonly tokens: TokenService;
  private codes = new Map<string, PendingCode>();
  private refresh = new Map<string, { clientId: string; resource: string; scope: string; sub: string }>();
  private revoked = new Set<string>();
  private ttl: number;

  constructor(readonly config: AuthConfig, private log: (e: Record<string, unknown>) => void = () => {}) {
    this.tokens = new TokenService(config.secret);
    this.ttl = Math.min(config.tokenTtlSec ?? 3600, 3600);
  }

  private client(id: string | undefined): OAuthClient | undefined {
    return this.config.clients.find((c) => c.clientId === id);
  }

  /** Client authentication: HTTP Basic or form body. Never the query string. */
  private authenticate(req: Request): { client?: OAuthClient; error?: string } {
    let id: string | undefined;
    let secret: string | undefined;
    const header = req.headers.authorization ?? "";
    if (header.startsWith("Basic ")) {
      const decoded = Buffer.from(header.slice(6), "base64").toString();
      const i = decoded.indexOf(":");
      if (i > 0) {
        id = decodeURIComponent(decoded.slice(0, i));
        secret = decodeURIComponent(decoded.slice(i + 1));
      }
    } else if (req.body?.client_id) {
      id = String(req.body.client_id);
      secret = req.body.client_secret !== undefined ? String(req.body.client_secret) : undefined;
    }
    const client = this.client(id);
    if (!client || secret === undefined) return { error: "Client authentication failed." };
    const a = sha256(secret);
    const b = sha256(client.clientSecret);
    if (!timingSafeEqual(a, b)) return { error: "Client authentication failed." };
    return { client };
  }

  private mint(client: OAuthClient, sub: string, scope: string, resource: string) {
    const now = Math.floor(Date.now() / 1000);
    const claims: TokenClaims = { iss: this.config.issuer, aud: resource, sub, client_id: client.clientId, scope, iat: now, exp: now + this.ttl, jti: b64url(randomBytes(12)) };
    return this.tokens.sign(claims);
  }

  router(): Router {
    const r = express.Router();
    r.use(express.urlencoded({ extended: false, limit: "10kb" }));

    r.get("/.well-known/oauth-authorization-server", (_req, res) => {
      const iss = this.config.issuer;
      res.json({
        issuer: iss,
        authorization_endpoint: `${iss}/oauth/authorize`,
        token_endpoint: `${iss}/oauth/token`,
        revocation_endpoint: `${iss}/oauth/revoke`,
        grant_types_supported: ["client_credentials", "authorization_code", "refresh_token"],
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
        scopes_supported: ["mcp:service", "mcp:tools"],
      });
    });
    r.get("/.well-known/oauth-protected-resource", (_req, res) => {
      res.json({ resource: this.config.resource, authorization_servers: [this.config.issuer], scopes_supported: ["mcp:service", "mcp:tools"], bearer_methods_supported: ["header"] });
    });

    // Account linking: the user approves CallAssist in the Alexa app.
    r.get("/oauth/authorize", (req, res) => {
      const q = req.query as Record<string, string | undefined>;
      const client = this.client(q.client_id);
      if (!client) return void res.status(400).send("Unknown client.");
      if (!q.redirect_uri || !client.redirectUris.includes(q.redirect_uri)) return void res.status(400).send("Redirect URI not allowed.");
      const back = (params: Record<string, string>) => {
        const u = new URL(q.redirect_uri!);
        for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
        if (q.state) u.searchParams.set("state", q.state);
        res.redirect(302, u.toString());
      };
      if (q.response_type !== "code") return back({ error: "unsupported_response_type" });
      if (!q.code_challenge || q.code_challenge_method !== "S256") return back({ error: "invalid_request", error_description: "PKCE S256 is required." });
      if ((q.scope ?? "mcp:tools").split(" ").some((s) => s !== "mcp:tools")) return back({ error: "invalid_scope" });
      if (q.resource && q.resource !== this.config.resource) return back({ error: "invalid_target" });
      if (q.approve === "no") return back({ error: "access_denied" });
      if (q.approve !== "yes") {
        const approve = new URL(req.originalUrl, this.config.issuer);
        approve.searchParams.set("approve", "yes");
        const deny = new URL(req.originalUrl, this.config.issuer);
        deny.searchParams.set("approve", "no");
        return void res.type("html").send(consentPage(client.name, this.config.userName, approve.pathname + approve.search, deny.pathname + deny.search));
      }
      const code = b64url(randomBytes(24));
      this.codes.set(code, { clientId: client.clientId, redirectUri: q.redirect_uri, challenge: q.code_challenge, resource: q.resource ?? this.config.resource, scope: "mcp:tools", expiresAt: Date.now() + 5 * 60_000 });
      this.log({ event: "oauth_code_issued", client: client.clientId });
      back({ code });
    });

    r.post("/oauth/token", (req, res) => {
      if (req.query.client_secret || req.query.client_id || req.query.code) return oauthError(res, 400, "invalid_request", "Credentials must not be sent in the query string.");
      const body = (req.body ?? {}) as Record<string, string | undefined>;
      const { client, error } = this.authenticate(req);
      if (!client) return oauthError(res, 401, "invalid_client", error ?? "Client authentication failed.");
      const grant = body.grant_type;

      if (grant === "client_credentials") {
        const scope = body.scope ?? client.serviceScopes[0];
        if (!scope || !client.serviceScopes.includes(scope)) return oauthError(res, 400, "invalid_scope", "That scope isn't allowed for this client.");
        if (!body.resource) return oauthError(res, 400, "invalid_request", "resource is required.");
        const expected = scope === "agent:calls" ? this.config.agentResource : this.config.resource;
        if (body.resource !== expected) return oauthError(res, 400, "invalid_target", "Unknown resource.");
        this.log({ event: "oauth_token", grant, client: client.clientId });
        return void res.set("cache-control", "no-store").json({ access_token: this.mint(client, `client:${client.clientId}`, scope, body.resource), token_type: "Bearer", expires_in: this.ttl, scope });
      }

      if (grant === "authorization_code") {
        const pending = body.code ? this.codes.get(body.code) : undefined;
        if (body.code) this.codes.delete(body.code); // one use only
        if (!pending || pending.expiresAt < Date.now()) return oauthError(res, 400, "invalid_grant", "Code is invalid or expired.");
        if (pending.clientId !== client.clientId) return oauthError(res, 400, "invalid_grant", "Code was issued to another client.");
        if (body.redirect_uri !== pending.redirectUri) return oauthError(res, 400, "invalid_grant", "redirect_uri does not match.");
        if (!body.code_verifier || b64url(sha256(body.code_verifier)) !== pending.challenge) return oauthError(res, 400, "invalid_grant", "PKCE verification failed.");
        const resource = body.resource ?? pending.resource;
        if (resource !== this.config.resource) return oauthError(res, 400, "invalid_target", "Unknown resource.");
        const refresh = b64url(randomBytes(32));
        this.refresh.set(refresh, { clientId: client.clientId, resource, scope: pending.scope, sub: this.config.userId });
        this.log({ event: "oauth_token", grant, client: client.clientId });
        return void res.set("cache-control", "no-store").json({ access_token: this.mint(client, this.config.userId, pending.scope, resource), token_type: "Bearer", expires_in: this.ttl, scope: pending.scope, refresh_token: refresh });
      }

      if (grant === "refresh_token") {
        const old = body.refresh_token ? this.refresh.get(body.refresh_token) : undefined;
        if (!old || old.clientId !== client.clientId) return oauthError(res, 400, "invalid_grant", "Refresh token is invalid.");
        this.refresh.delete(body.refresh_token!); // rotate
        const next = b64url(randomBytes(32));
        this.refresh.set(next, old);
        return void res.set("cache-control", "no-store").json({ access_token: this.mint(client, old.sub, old.scope, old.resource), token_type: "Bearer", expires_in: this.ttl, scope: old.scope, refresh_token: next });
      }

      return oauthError(res, 400, "unsupported_grant_type", "Use client_credentials, authorization_code or refresh_token.");
    });

    r.post("/oauth/revoke", (req, res) => {
      const { client } = this.authenticate(req);
      if (!client) return oauthError(res, 401, "invalid_client", "Client authentication failed.");
      const token = String(req.body?.token ?? "");
      this.refresh.delete(token);
      const claims = this.tokens.verify(token);
      if (claims) this.revoked.add(claims.jti);
      res.status(200).end();
    });

    return r;
  }

  /** Checks a bearer token for the MCP endpoint. */
  check(header: string | undefined, audience = this.config.resource): { ok: true; claims: TokenClaims } | { ok: false; reason: string } {
    if (!header?.startsWith("Bearer ")) return { ok: false, reason: "missing_token" };
    const claims = this.tokens.verify(header.slice(7).trim());
    if (!claims) return { ok: false, reason: "invalid_or_expired" };
    if (claims.iss !== this.config.issuer) return { ok: false, reason: "wrong_issuer" };
    if (claims.aud !== audience) return { ok: false, reason: "wrong_audience" };
    if (this.revoked.has(claims.jti)) return { ok: false, reason: "revoked" };
    return { ok: true, claims };
  }

  /** Middleware for /agent/mcp: only the phone agent's service token, for the agent resource. */
  agentGuard() {
    return (req: Request, res: Response, next: NextFunction) => {
      const result = this.check(req.headers.authorization, this.config.agentResource);
      if (!result.ok || !result.claims.scope.split(" ").includes("agent:calls")) {
        this.log({ event: "auth_denied", reason: result.ok ? "wrong_scope" : result.reason, endpoint: "agent" });
        return void res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: firstId(req.body) });
      }
      next();
    };
  }

  /**
   * Express middleware for /mcp. Service tokens may only initialize and list;
   * tool calls need a user token for this account. Alexa+ re-links on 401 and
   * doesn't read WWW-Authenticate, so we don't send it.
   */
  mcpGuard() {
    return (req: Request, res: Response, next: NextFunction) => {
      const result = this.check(req.headers.authorization);
      const deny = (status: number, message: string, reason: string) => {
        this.log({ event: "auth_denied", reason, method: methodsOf(req.body).join(",") });
        res.status(status).json({ jsonrpc: "2.0", error: { code: -32001, message }, id: firstId(req.body) });
      };
      if (!result.ok) return deny(401, "Unauthorized", result.reason);
      const scopes = result.claims.scope.split(" ");
      const needsUser = methodsOf(req.body).some((m) => !SERVICE_METHODS.has(m));
      if (needsUser) {
        if (!scopes.includes("mcp:tools")) return deny(401, "Account linking required", "service_token_on_tool_call");
        const known = this.config.knownUser ?? ((sub: string) => sub === this.config.userId);
        if (!known(result.claims.sub)) return deny(401, "Unauthorized", "unknown_user");
      }
      (req as Request & { auth?: TokenClaims }).auth = result.claims;
      next();
    };
  }
}

const SERVICE_METHODS = new Set(["initialize", "notifications/initialized", "ping", "tools/list", "notifications/cancelled"]);

function methodsOf(body: unknown): string[] {
  const msgs = Array.isArray(body) ? body : [body];
  return msgs.map((m) => (m && typeof m === "object" && "method" in m ? String((m as { method: unknown }).method) : "")).filter(Boolean);
}

function firstId(body: unknown): unknown {
  const m = Array.isArray(body) ? body[0] : body;
  return m && typeof m === "object" && "id" in m ? (m as { id: unknown }).id : null;
}

/** PKCE helpers, used by the emulator (as Alexa+ would) and tests. */
export function pkcePair() {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(sha256(verifier)) };
}

function consentPage(clientName: string, user: string, approve: string, deny: string): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link CallAssist</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#f4f5f7;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
.c{background:#fff;border:1px solid #e3e6eb;border-radius:16px;padding:28px;max-width:420px;box-shadow:0 4px 16px #0001}
h1{font-size:22px;margin:0 0 8px}p{color:#4a505b;line-height:1.5}ul{color:#4a505b;padding-left:18px;line-height:1.6}
a{display:inline-block;padding:11px 18px;border-radius:10px;font-weight:700;text-decoration:none;margin-right:8px}
.y{background:#0a7cff;color:#fff}.n{background:#eef0f3;color:#14161a}</style></head><body><div class="c">
<h1>Link CallAssist to ${esc(clientName)}</h1><p>Signed in as <b>${esc(user)}</b>. ${esc(clientName)} will be able to:</p>
<ul><li>Give tasks to people on your CallAssist team by phone</li><li>Read the status of your tasks and replies</li><li>Cancel tasks you started</li></ul>
<p>CallAssist only calls people who agreed to it, and every call says it's an AI assistant.</p>
<a class="y" href="${esc(approve)}">Allow</a><a class="n" href="${esc(deny)}">Cancel</a></div></body></html>`;
}
