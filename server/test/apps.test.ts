// MCP Apps and the Agent Skill: the creative extras the Alexa+ track asks for.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startEnv, until, workerBot, type Env } from "./helpers.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
let env: Env;
before(async () => (env = await startEnv()));
after(async () => env.close());

test("every tool points to the CallAssist MCP App view", async () => {
  const { tools } = await env.mcp.listTools();
  for (const t of tools) assert.equal((t._meta as any)?.ui?.resourceUri, "ui://callassist/card.html", t.name);
});

test("the view is a self-contained MCP App resource", async () => {
  const { resources } = await env.mcp.listResources();
  const card = resources.find((r) => r.uri === "ui://callassist/card.html");
  assert.ok(card, "listed");
  assert.equal(card!.mimeType, "text/html;profile=mcp-app");
  const read = await env.mcp.readResource({ uri: "ui://callassist/card.html" });
  const c = read.contents[0] as { text: string; mimeType: string };
  assert.equal(c.mimeType, "text/html;profile=mcp-app");
  assert.match(c.text, /window\.McpApps|McpApps=/, "MCP Apps view library inlined");
  assert.match(c.text, /new App\(/);
  assert.ok(!/<script[^>]+src=/i.test(c.text), "no external scripts (works under a strict CSP)");
});

test("results say which tool made them, for the view", async () => {
  const r = await env.tool("list_team");
  assert.equal(r.data.tool, "list_team");
});

test("the emulator host fetches the view and runs the card's tool calls", async () => {
  workerBot(env, "c_raju", ["yes 10 minutes"]);
  const brain = await env.brain();
  const turn = await brain.handle("apps-1", "get me a coffee");
  assert.equal(turn.ui?.resourceUri, "ui://callassist/card.html");
  assert.equal(turn.ui?.result.structuredContent?.needsConfirmation, true);
  const view = await (await fetch(`${env.url}/api/alexa/resource?uri=${encodeURIComponent("ui://callassist/card.html")}`)).json();
  assert.match(view.html, /CallAssist card/);
  // The card's "Confirm call" button: same tool, same args, plus the token.
  const token = turn.ui!.result.structuredContent!.confirmationToken;
  const res = await (await fetch(`${env.url}/api/alexa/tool`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "run_errand", arguments: { ...turn.ui!.input, confirmed: true, confirmationToken: token } }) })).json();
  assert.equal(res.structuredContent.status, "calling");
  await until(() => [...env.store.tasks.values()].some((t) => t.status === "accepted"));
  const bad = await fetch(`${env.url}/api/alexa/resource?uri=${encodeURIComponent("file:///etc/passwd")}`);
  assert.equal(bad.status, 400, "only ui:// resources");
});

test("the Agent Skill follows the open format and is served over MCP", async () => {
  const raw = readFileSync(join(repo, "skills/callassist/SKILL.md"), "utf8");
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n/)![1];
  assert.match(fm, /^name: callassist$/m, "name matches the folder");
  const desc = fm.match(/^description: (.+)$/m)![1];
  assert.ok(desc.length > 50 && desc.length <= 1024, "description says what and when, within 1024 chars");
  assert.ok(/^[a-z0-9-]{1,64}$/.test("callassist"));
  const { prompts } = await env.mcp.listPrompts();
  assert.ok(prompts.some((p) => p.name === "callassist"));
  const p = await env.mcp.getPrompt({ name: "callassist" });
  const text = (p.messages[0].content as { text: string }).text;
  assert.match(text, /Never place a call without the user's spoken "yes"/);
  assert.ok(!text.startsWith("---"), "YAML header stripped");
});

test("the skill's check script reaches a live server", async () => {
  const { stdout: out } = await promisify(execFile)(process.execPath, [join(repo, "skills/callassist/scripts/check-server.mjs"), `${env.url}/mcp`], { encoding: "utf8", timeout: 15000 });
  assert.match(out, /OK: CallAssist is ready/);
  assert.match(out, /\[MCP App\]/);
});
