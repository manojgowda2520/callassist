// OAuth exactly as Alexa+ expects it (docs/alexa-plus-design-rules.md §2).
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Assistant } from "../src/assistant.js";
import { createApp } from "../src/app.js";
import { AuthServer, pkcePair } from "../src/auth.js";
import { Store } from "../src/store.js";
import { LocalPhoneNetwork } from "../src/telephony.js";
import { AlexaAccount, AlexaBrain } from "../src/emulator/brain.js";
import { FAST, SEED, workerBot, until } from "./helpers.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let server: Server;
let base = "";
let auth: AuthServer;
let store: Store;
let phone: LocalPhoneNetwork;
let assistant: Assistant;
const ALEXA = { id: "alexa", secret: "alexa-secret" };
const AGENT = { id: "agent", secret: "agent-secret" };

before(async () => {
  store = new Store(SEED);
  phone = new LocalPhoneNetwork();
  assistant = new Assistant(store, phone, FAST);
  server = (await import("node:http")).createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  auth = new AuthServer({
    issuer: base,
    resource: `${base}/mcp`,
    agentResource: `${base}/agent/mcp`,
    secret: "test-secret",
    userId: "user-manoj",
    userName: "Manoj",
    tokenTtlSec: 3600,
    clients: [
      { clientId: ALEXA.id, clientSecret: ALEXA.secret, name: "Alexa", redirectUris: [`${base}/alexa/callback`], serviceScopes: ["mcp:service"] },
      { clientId: AGENT.id, clientSecret: AGENT.secret, name: "Agent", redirectUris: [], serviceScopes: ["agent:calls"] },
    ],
  });
  const app = createApp({
    assistant,
    phone,
    publicDir: join(root, "public"),
    selfMcpUrl: `${base}/mcp`,
    auth,
    rateLimits: { mcp: 0, token: 0, alexa: 0 },
    alexaAuth: { tokenUrl: `${base}/oauth/token`, authorizeUrl: `${base}/oauth/authorize`, clientId: ALEXA.id, clientSecret: ALEXA.secret, resource: `${base}/mcp`, redirectUri: `${base}/alexa/callback` },
  });
  server.on("request", app);
  assistant.start();
});
after(async () => {
  assistant.stop();
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
});

const basic = (id: string, secret: string) => "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");
async function token(form: Record<string, string>, authz = basic(ALEXA.id, ALEXA.secret), query = "") {
  const res = await fetch(`${base}/oauth/token${query}`, { method: "POST", headers: { authorization: authz, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
  return { status: res.status, body: await res.json(), headers: res.headers };
}
async function rpc(path: string, body: unknown, bearer?: string) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
}
const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: { roots: {} }, clientInfo: { name: "Alexa+ MCP Client", version: "1.0.0" } } };
const listTools = { jsonrpc: "2.0", id: 2, method: "tools/list" };
const callTool = { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_team", arguments: {} } };

async function userToken() {
  const { verifier, challenge } = pkcePair();
  const u = new URL(`${base}/oauth/authorize`);
  u.search = new URLSearchParams({ response_type: "code", client_id: ALEXA.id, redirect_uri: `${base}/alexa/callback`, scope: "mcp:tools", state: "s1", code_challenge: challenge, code_challenge_method: "S256", resource: `${base}/mcp`, approve: "yes" }).toString();
  const r = await fetch(u, { redirect: "manual" });
  const code = new URL(r.headers.get("location")!).searchParams.get("code")!;
  return { code, verifier, ...(await token({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: `${base}/alexa/callback`, resource: `${base}/mcp` })) };
}

test("tier 1: client_credentials with Basic auth → mcp:service token, ≤3600s, no refresh token", async () => {
  const r = await token({ grant_type: "client_credentials", scope: "mcp:service", resource: `${base}/mcp` });
  assert.equal(r.status, 200);
  assert.equal(r.body.token_type, "Bearer");
  assert.ok(r.body.expires_in <= 3600);
  assert.equal(r.body.scope, "mcp:service");
  assert.equal(r.body.refresh_token, undefined);
  assert.equal(r.headers.get("cache-control"), "no-store");
});

test("tier 1: credentials in the form body also work", async () => {
  const r = await token({ grant_type: "client_credentials", scope: "mcp:service", resource: `${base}/mcp`, client_id: ALEXA.id, client_secret: ALEXA.secret }, "");
  assert.equal(r.status, 200);
});

test("token endpoint errors follow RFC 6749 §5.2", async () => {
  assert.deepEqual([(await token({ grant_type: "client_credentials", resource: `${base}/mcp` }, basic(ALEXA.id, "wrong"))).status], [401]);
  assert.equal((await token({ grant_type: "client_credentials", resource: `${base}/mcp` }, basic(ALEXA.id, "wrong"))).body.error, "invalid_client");
  assert.equal((await token({ grant_type: "client_credentials", scope: "mcp:tools", resource: `${base}/mcp` })).body.error, "invalid_scope");
  assert.equal((await token({ grant_type: "client_credentials", scope: "mcp:service" })).body.error, "invalid_request");
  assert.equal((await token({ grant_type: "client_credentials", scope: "mcp:service", resource: "https://evil.example/mcp" })).body.error, "invalid_target");
  assert.equal((await token({ grant_type: "password", username: "a", password: "b" })).body.error, "unsupported_grant_type");
  const q = await token({ grant_type: "client_credentials", scope: "mcp:service", resource: `${base}/mcp` }, "", `?client_id=${ALEXA.id}&client_secret=${ALEXA.secret}`);
  assert.equal(q.status, 400, "credentials in the query string are refused");
});

test("a service token can initialize and list tools, but not call them", async () => {
  const t = (await token({ grant_type: "client_credentials", scope: "mcp:service", resource: `${base}/mcp` })).body.access_token;
  assert.equal((await rpc("/mcp", init, t)).body.result.protocolVersion, "2025-03-26");
  assert.ok((await rpc("/mcp", listTools, t)).body.result.tools.length >= 10);
  const denied = await rpc("/mcp", callTool, t);
  assert.equal(denied.status, 401, "401 makes Alexa+ re-link");
  assert.equal(denied.headers.get("www-authenticate"), null, "Alexa+ doesn't use WWW-Authenticate");
});

test("no token, garbage token, tampered token, wrong audience → 401", async () => {
  assert.equal((await rpc("/mcp", init)).status, 401);
  assert.equal((await rpc("/mcp", init, "not.a.jwt")).status, 401);
  const t = (await token({ grant_type: "client_credentials", scope: "mcp:service", resource: `${base}/mcp` })).body.access_token as string;
  const [h, b, s] = t.split(".");
  const claims = JSON.parse(Buffer.from(b, "base64url").toString());
  const forged = `${h}.${Buffer.from(JSON.stringify({ ...claims, scope: "mcp:tools", sub: "user-manoj" })).toString("base64url")}.${s}`;
  assert.equal((await rpc("/mcp", callTool, forged)).status, 401, "changed claims break the signature");
  const agentTok = (await token({ grant_type: "client_credentials", scope: "agent:calls", resource: `${base}/agent/mcp` }, basic(AGENT.id, AGENT.secret))).body.access_token;
  assert.equal((await rpc("/mcp", init, agentTok)).status, 401, "a token for another resource is refused");
});

test("tier 2: authorization code + PKCE S256 → user token that can call tools", async () => {
  const t = await userToken();
  assert.equal(t.status, 200);
  assert.equal(t.body.scope, "mcp:tools");
  assert.ok(t.body.refresh_token);
  const r = await rpc("/mcp", callTool, t.body.access_token);
  assert.equal(r.status, 200);
  assert.match(r.body.result.content[0].text, /I can call/);
});

test("PKCE and code rules: wrong verifier, reused code, wrong redirect, no S256", async () => {
  const { verifier, challenge } = pkcePair();
  const authorize = (extra: Record<string, string>) => {
    const u = new URL(`${base}/oauth/authorize`);
    u.search = new URLSearchParams({ response_type: "code", client_id: ALEXA.id, redirect_uri: `${base}/alexa/callback`, scope: "mcp:tools", state: "x", code_challenge: challenge, code_challenge_method: "S256", approve: "yes", ...extra }).toString();
    return fetch(u, { redirect: "manual" });
  };
  const code = new URL((await authorize({})).headers.get("location")!).searchParams.get("code")!;
  const bad = await token({ grant_type: "authorization_code", code, code_verifier: "wrong-verifier-wrong-verifier-wrong", redirect_uri: `${base}/alexa/callback` });
  assert.equal(bad.body.error, "invalid_grant");
  const reused = await token({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: `${base}/alexa/callback` });
  assert.equal(reused.body.error, "invalid_grant", "a code works once, even after a failed try");
  const plain = await authorize({ code_challenge_method: "plain" });
  assert.equal(new URL(plain.headers.get("location")!).searchParams.get("error"), "invalid_request");
  const evil = await fetch(`${base}/oauth/authorize?response_type=code&client_id=${ALEXA.id}&redirect_uri=https://evil.example/cb&code_challenge=${challenge}&code_challenge_method=S256`, { redirect: "manual" });
  assert.equal(evil.status, 400, "unknown redirect URIs never get a code");
  const denied = await authorize({ approve: "no" });
  assert.equal(new URL(denied.headers.get("location")!).searchParams.get("error"), "access_denied");
  const consent = await authorize({ approve: "" });
  assert.match(await consent.text(), /Link CallAssist/);
});

test("refresh tokens rotate; the old one stops working", async () => {
  const t = await userToken();
  const r1 = await token({ grant_type: "refresh_token", refresh_token: t.body.refresh_token });
  assert.equal(r1.status, 200);
  const again = await token({ grant_type: "refresh_token", refresh_token: t.body.refresh_token });
  assert.equal(again.body.error, "invalid_grant");
});

test("revoked tokens are refused", async () => {
  const t = await userToken();
  await fetch(`${base}/oauth/revoke`, { method: "POST", headers: { authorization: basic(ALEXA.id, ALEXA.secret), "content-type": "application/x-www-form-urlencoded" }, body: `token=${t.body.access_token}` });
  assert.equal((await rpc("/mcp", callTool, t.body.access_token)).status, 401);
});

test("expired tokens are refused", async () => {
  const now = Math.floor(Date.now() / 1000);
  const old = auth.tokens.sign({ iss: base, aud: `${base}/mcp`, sub: "user-manoj", client_id: ALEXA.id, scope: "mcp:tools", iat: now - 7200, exp: now - 3600, jti: "x" });
  assert.equal((await rpc("/mcp", callTool, old)).status, 401);
});

test("phone-agent endpoint needs its own agent token", async () => {
  const t = await userToken();
  assert.equal((await rpc("/agent/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }, t.body.access_token)).status, 401);
  const a = (await token({ grant_type: "client_credentials", scope: "agent:calls", resource: `${base}/agent/mcp` }, basic(AGENT.id, AGENT.secret))).body.access_token;
  const r = await rpc("/agent/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "connect", version: "1" } } }, a);
  assert.equal(r.status, 200);
  const alexaAgentScope = await token({ grant_type: "client_credentials", scope: "agent:calls", resource: `${base}/agent/mcp` });
  assert.equal(alexaAgentScope.body.error, "invalid_scope", "Alexa's client can't get phone-agent tokens");
});

test("emulator: unlinked → asks to link; after linking → real calls work", async () => {
  const account = new AlexaAccount({ tokenUrl: `${base}/oauth/token`, authorizeUrl: `${base}/oauth/authorize`, clientId: ALEXA.id, clientSecret: ALEXA.secret, resource: `${base}/mcp`, redirectUri: `${base}/alexa/callback` });
  const brain = new AlexaBrain(`${base}/mcp`, () => {}, account);
  await brain.connect();
  const before = await brain.handle("a1", "get me a coffee");
  assert.match(before.speech, /link your account/);
  await account.autoLink();
  await brain.refresh();
  workerBot({ phone, store } as any, "c_raju", ["yes 5 minutes"]);
  const t1 = await brain.handle("a1", "get me a coffee");
  assert.match(t1.speech, /Shall I go ahead/);
  await brain.handle("a1", "yes");
  await until(() => [...store.tasks.values()].some((t) => t.status === "accepted"));
  await brain.close();
});

test("discovery metadata is published", async () => {
  const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  const pr = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
  assert.equal(pr.resource, `${base}/mcp`);
});

test("two accounts never see each other's tasks", async () => {
  // A second household with its own team, store and phones.
  const seedB = structuredClone(SEED);
  seedB.user = { name: "Priya", email: "priya@example.com" };
  const storeB = new Store(seedB);
  const assistantB = new Assistant(storeB, new LocalPhoneNetwork(), FAST);
  const { createApp: make } = await import("../src/app.js");
  const http = await import("node:http");
  const srv = http.createServer();
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const b2 = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const authB = new AuthServer({ ...auth.config, issuer: b2, resource: `${b2}/mcp`, agentResource: `${b2}/agent/mcp`, knownUser: (s) => s === "user-manoj" || s === "user-priya" });
  srv.on("request", make({ assistant, phone, publicDir: join(root, "public"), auth: authB, rateLimits: { mcp: 0, token: 0, alexa: 0 }, accountFor: (s) => (s === "user-manoj" ? assistant : s === "user-priya" ? assistantB : undefined) }));
  const now = Math.floor(Date.now() / 1000);
  const tok = (sub: string) => authB.tokens.sign({ iss: b2, aud: `${b2}/mcp`, sub, client_id: ALEXA.id, scope: "mcp:tools", iat: now, exp: now + 600, jti: sub });
  const call = async (sub: string, name: string, args: Record<string, unknown>) => {
    const res = await fetch(`${b2}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tok(sub)}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    return { status: res.status, body: await res.json() };
  };
  const rb = await call("user-manoj", "assign_task", { person: "Lakshmi", task: "water the plants" });
  const go = await call("user-manoj", "assign_task", { person: "Lakshmi", task: "water the plants", confirmed: true, confirmationToken: rb.body.result.structuredContent.confirmationToken });
  const taskId = go.body.result.structuredContent.taskId;
  assert.ok(taskId);
  const mine = await call("user-manoj", "list_tasks", { filter: "all" });
  assert.ok(mine.body.result.structuredContent.total >= 1);
  const theirs = await call("user-priya", "list_tasks", { filter: "all" });
  assert.equal(theirs.body.result.structuredContent.total ?? 0, 0, "Priya sees none of Manoj's tasks");
  const peek = await call("user-priya", "get_task_status", { taskId });
  assert.equal(peek.body.result.isError, true, "even with the exact taskId");
  const cancel = await call("user-priya", "cancel_task", { taskId, confirmed: true, confirmationToken: rb.body.result.structuredContent.confirmationToken });
  assert.equal(cancel.body.result.isError, true);
  assert.equal(store.tasks.get(taskId)!.status === "cancelled", false);
  const stranger = await call("user-mallory", "list_tasks", {});
  assert.equal(stranger.status, 401, "unknown accounts are refused");
  assistantB.stop();
  srv.closeAllConnections?.();
  await new Promise<void>((r) => srv.close(() => r()));
});
