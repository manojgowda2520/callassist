import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { connectClient, startEnv, type Env } from "./helpers.js";

let env: Env;
before(async () => (env = await startEnv()));
after(async () => env.close());

const EXPECTED_TOOLS = [
  "assign_task",
  "run_errand",
  "deliver_message",
  "get_task_status",
  "list_tasks",
  "follow_up",
  "answer_question",
  "cancel_task",
  "list_team",
  "list_errands",
];

test("negotiates 2025-03-26 for the Alexa+ client", async () => {
  const c = await connectClient(`${env.url}/mcp`, "2025-03-26");
  const { tools } = await c.listTools();
  assert.ok(tools.length > 5, "tools work after negotiating down");
  await c.close();
});

test("speaks 2025-11-25 to newer clients", async () => {
  const res = await fetch(`${env.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
  });
  const body = await res.json();
  assert.equal(body.result.protocolVersion, "2025-11-25");
  assert.equal(body.result.serverInfo.name, "callassist");
});

test("raw initialize with 2025-03-26 echoes 2025-03-26", async () => {
  const res = await fetch(`${env.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: { roots: {} }, clientInfo: { name: "Alexa+ MCP Client", version: "1.0.0" } } }),
  });
  assert.equal((await res.json()).result.protocolVersion, "2025-03-26");
});

test("lists every tool with a schema, title and description", async () => {
  const { tools } = await env.mcp.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [...EXPECTED_TOOLS].sort());
  for (const t of tools) {
    assert.equal(t.inputSchema.type, "object", t.name);
    assert.ok(t.description && t.description.length > 40, `${t.name} description`);
    assert.ok(t.title, `${t.name} title`);
    assert.ok(t.annotations, `${t.name} annotations`);
    assert.equal(t.outputSchema?.type, "object", `${t.name} outputSchema`);
  }
});

test("phone-agent MCP exposes get_call_brief and report_outcome", async () => {
  const c = await connectClient(`${env.url}/agent/mcp`);
  const { tools } = await c.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["get_call_brief", "report_outcome"]);
  const r: any = await c.callTool({ name: "get_call_brief", arguments: { callId: "nope" } });
  assert.equal(r.isError, true);
  await c.close();
});

test("GET and DELETE on /mcp return 405", async () => {
  assert.equal((await fetch(`${env.url}/mcp`)).status, 405);
  assert.equal((await fetch(`${env.url}/mcp`, { method: "DELETE" })).status, 405);
});

test("a foreign Host header is refused (DNS rebinding)", async () => {
  const { request } = await import("node:http");
  const u = new URL(`${env.url}/mcp`);
  const status = await new Promise<number>((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { host: "evil.example", "content-type": "application/json", accept: "application/json, text/event-stream" } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
  });
  assert.equal(status, 403);
});

test("malformed JSON-RPC is rejected cleanly", async () => {
  const res = await fetch(`${env.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: "{not json",
  });
  assert.ok(res.status >= 400 && res.status < 500);
});

test("bad arguments come back as errors, never crashes", async () => {
  const cases: [string, Record<string, unknown>][] = [
    ["assign_task", {}],
    ["assign_task", { person: "Raju" }],
    ["assign_task", { person: "Raju", task: "x".repeat(401) }],
    ["assign_task", { person: 42, task: "do it" }],
    ["get_task_status", { waitSeconds: 999 }],
    ["list_tasks", { filter: "everything" }],
    ["run_errand", { request: "" }],
  ];
  for (const [name, args] of cases) {
    try {
      const r: any = await env.mcp.callTool({ name, arguments: args });
      assert.equal(r.isError, true, `${name} ${JSON.stringify(args)}`);
    } catch (err) {
      assert.match(String(err), /invalid|validation|MCP error/i);
    }
  }
  assert.equal(env.store.calls.size, 0, "no call was placed");
});

test("unknown tool is an error", async () => {
  try {
    const r: any = await env.mcp.callTool({ name: "launch_rockets", arguments: {} });
    assert.equal(r.isError, true);
  } catch (err) {
    assert.match(String(err), /not found|unknown|-32602|-32601/i);
  }
});

test("health endpoint and state API", async () => {
  const h = await (await fetch(`${env.url}/healthz`)).json();
  assert.equal(h.ok, true);
  const s = await (await fetch(`${env.url}/api/state`)).json();
  assert.equal(s.user.name, "Madhu");
  assert.ok(s.contacts.length >= 5);
});

test("metrics count tool calls and errors", async () => {
  await env.tool("list_team");
  await env.tool("assign_task", { person: "Batman", task: "save the city" });
  const m = await (await fetch(`${env.url}/api/metrics`)).json();
  assert.ok(m.counters["ToolCalls|Tool=list_team"] >= 1);
  assert.ok(m.counters["ToolErrors|Tool=assign_task|Reason=not_found"] >= 1);
  assert.ok(m.latency["ToolLatency|Tool=list_team"].n >= 1);
});

test("logs never contain what people said", async () => {
  await env.tool("assign_task", { person: "Raju", task: "my secret salary file is in drawer 3" });
  const line = JSON.stringify(env.logs.filter((l) => l.event === "tool"));
  assert.ok(!line.includes("salary"));
});

test("rate limits answer 429 with Retry-After", async () => {
  const { rateLimit } = await import("../src/ops.js");
  const express = (await import("express")).default;
  const app = express();
  app.use(rateLimit({ name: "t", perMinute: 60, burst: 3 }));
  app.get("/", (_q, r) => void r.send("ok"));
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const url = `http://127.0.0.1:${(srv.address() as any).port}/`;
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await fetch(url)).status);
  assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  assert.ok((await fetch(url)).headers.get("retry-after"));
  srv.close();
});

test("demo reset clears tasks for good (saved, not just in memory)", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { Store } = await import("../src/store.js");
  const { SEED } = await import("./helpers.js");
  const file = join(mkdtempSync(join(tmpdir(), "ca-")), "s.json");
  const s = new Store(SEED, file);
  s.createTask({ kind: "task", title: "T", details: "D", assigneeId: "c_raju", assigneeName: "Raju" });
  s.tasks.clear();
  s.touch();
  assert.equal(new Store(SEED, file).tasks.size, 0);
  const r = await fetch(`${env.url}/api/demo/reset`, { method: "POST" });
  assert.equal((await r.json()).ok, true);
});
