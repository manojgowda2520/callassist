// End-to-end task flows over real MCP and the local phone network.
import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { connectClient, startEnv, until, workerBot, sleep, type Env } from "./helpers.js";

let env: Env;
beforeEach(async () => (env = await startEnv()));
afterEach(async () => env.close());

const task = (id: string) => env.store.tasks.get(id)!;
const notes = () => env.store.notifications.map((n) => n.text);

test("errand: coffee → Raju says yes in 10 minutes → user is told", async () => {
  const bot = workerBot(env, "c_raju", ["Yes sir, 10 minutes"]);
  const read = await env.tool("run_errand", { request: "get me a coffee" });
  assert.equal(read.data.needsConfirmation, true);
  assert.match(read.text, /Raju/);
  assert.equal(env.store.calls.size, 0, "no call before yes");
  const go = await env.tool("run_errand", { request: "get me a coffee", confirmed: true });
  assert.equal(go.isError, false);
  const t = await until(() => task(go.data.taskId).status === "accepted" && task(go.data.taskId), 3000, "accepted");
  assert.equal(t.eta, "in 10 minutes");
  assert.equal(bot.calls.length, 1);
  assert.match(bot.heard.get(bot.calls[0])!.join(" "), /AI assistant calling for Manoj/, "AI disclosure first");
  assert.ok(notes().some((n) => /Raju is on it.*10 minutes/.test(n)));
  const status = await env.tool("get_task_status", { taskId: t.id });
  assert.match(status.text, /Raju is on it/);
});

test("errand at home goes to the home helper", async () => {
  const r = await env.tool("run_errand", { request: "coffee", place: "home" });
  assert.equal(r.data.person, "Lakshmi");
  const n = await env.tool("run_errand", { request: "a pizza" });
  assert.equal(n.isError, true);
  assert.equal(n.data.reason, "no_errand");
});

test("task: accepts without a time → CallAssist asks when → by 3 pm", async () => {
  workerBot(env, "c_raju", [["Okay, I can do that", "by 3 pm"]]);
  const r = await env.tool("assign_task", { person: "Raju", task: "set up the conference room for the client meeting", confirmed: true });
  const t = await until(() => (task(r.data.taskId).eta ? task(r.data.taskId) : undefined), 3000, "eta");
  assert.equal(t.status, "accepted");
  assert.equal(t.eta, "by 3 PM");
  const call = env.store.calls.get(t.callIds[0])!;
  assert.ok(call.transcript.some((l) => /Roughly when/.test(l.text)));
});

test("task with a due time: yes is enough", async () => {
  workerBot(env, "c_ravi", ["yes"]);
  const r = await env.tool("assign_task", { person: "the driver", task: "pick up the courier from reception", due: "in 20 minutes", confirmed: true });
  const t = await until(() => task(r.data.taskId).status === "accepted" && task(r.data.taskId));
  assert.equal(t.eta, "in 20 minutes");
});

test("decline → user is told and asked about someone else", async () => {
  workerBot(env, "c_raju", ["Sorry, I can't, I'm on leave today"]);
  const r = await env.tool("assign_task", { person: "Raju", task: "bring the files from the store room", confirmed: true });
  await until(() => task(r.data.taskId).status === "declined");
  assert.ok(notes().some((n) => /Raju can't do it.*on leave/.test(n)));
});

test("worker question → user answers → call back → accepted", async () => {
  workerBot(env, "c_raju", ["Which conference room?", "Okay, done in 5 minutes"]);
  const r = await env.tool("assign_task", { person: "Raju", task: "arrange water bottles in the conference room", confirmed: true });
  await until(() => task(r.data.taskId).status === "blocked", 3000, "blocked");
  assert.ok(notes().some((n) => /Raju asks.*Which conference room/.test(n)));
  const ans = await env.tool("answer_question", { answer: "Room 3 on the second floor" });
  assert.equal(ans.isError, false);
  const t = await until(() => task(r.data.taskId).status === "accepted" && task(r.data.taskId), 3000, "accepted after answer");
  assert.equal(t.eta, "in 5 minutes");
  const second = env.store.calls.get(t.callIds[1])!;
  assert.ok(second.transcript.some((l) => /Room 3 on the second floor/.test(l.text)));
});

test("blocked problem → user decides → worker goes ahead", async () => {
  workerBot(env, "c_raju", ["We ran out of coffee powder", "yes 15 minutes"]);
  const r = await env.tool("run_errand", { request: "coffee", confirmed: true });
  await until(() => task(r.data.taskId).status === "blocked");
  await env.tool("answer_question", { person: "Raju", answer: "Buy some from the shop downstairs, use petty cash" });
  await until(() => task(r.data.taskId).status === "accepted");
});

test("automatic follow-up after the ETA → done", async () => {
  workerBot(env, "c_raju", ["yes, right away", "done, it's on the desk"]);
  const r = await env.tool("run_errand", { request: "tea", confirmed: true });
  await until(() => task(r.data.taskId).status === "accepted");
  // right away = +5 min; jump the follow-up to now
  env.store.updateTask(r.data.taskId, { nextActionAt: new Date(Date.now() - 1).toISOString() });
  const t = await until(() => task(r.data.taskId).status === "done" && task(r.data.taskId), 3000, "done");
  assert.equal(t.followUps, 1);
  assert.ok(notes().some((n) => /says it's done/.test(n)));
});

test("follow-up says not yet → new time recorded, task stays open", async () => {
  workerBot(env, "c_raju", ["yes in 10 minutes", "not done yet, 5 more minutes"]);
  const r = await env.tool("run_errand", { request: "lunch", confirmed: true });
  await until(() => task(r.data.taskId).status === "accepted");
  const f = await env.tool("follow_up", { person: "Raju" });
  assert.equal(f.isError, false);
  await until(() => task(r.data.taskId).eta === "in 5 minutes", 3000, "new eta");
  assert.equal(task(r.data.taskId).status, "accepted");
});

test("no answer twice → unreachable, user told", async () => {
  workerBot(env, "c_raju", ["ignore", "ignore"]);
  const r = await env.tool("run_errand", { request: "coffee", confirmed: true });
  const t = await until(() => task(r.data.taskId).status === "unreachable" && task(r.data.taskId), 4000, "unreachable");
  assert.equal(t.attempts, 2);
  assert.ok(notes().some((n) => /couldn't reach Raju after 2 tries/.test(n)));
});

test("rejected first call → retried → accepted", async () => {
  workerBot(env, "c_raju", ["reject", "yes 2 minutes"]);
  const r = await env.tool("run_errand", { request: "coffee", confirmed: true });
  const t = await until(() => task(r.data.taskId).status === "accepted" && task(r.data.taskId), 4000);
  assert.equal(t.attempts, 2);
});

test("hang up mid-call → retried", async () => {
  workerBot(env, "c_raju", ["hangup", "ok 10 minutes"]);
  const r = await env.tool("run_errand", { request: "coffee", confirmed: true });
  await until(() => task(r.data.taskId).status === "accepted", 4000);
});

test("silence on the line → call ends, retried", async () => {
  workerBot(env, "c_raju", ["silent", "yes 10 minutes"]);
  const r = await env.tool("run_errand", { request: "coffee", confirmed: true });
  await until(() => task(r.data.taskId).status === "accepted", 5000);
  const first = env.store.calls.get(task(r.data.taskId).callIds[0])!;
  assert.ok(first.transcript.some((l) => /try you again later/.test(l.text)));
});

test("unclear twice → retried later", async () => {
  workerBot(env, "c_raju", [["hmm", "uhh"], "yes 3 minutes"]);
  const r = await env.tool("run_errand", { request: "coffee", confirmed: true });
  await until(() => task(r.data.taskId).status === "accepted", 5000);
  assert.equal(task(r.data.taskId).attempts, 2);
});

test("message to Grandma brings back her reply", async () => {
  workerBot(env, "c_grandma", ["Yes, milk and bread please"]);
  const read = await env.tool("deliver_message", { person: "granny", message: "Manoj will pick you up at 5.", question: "Do you need anything from the store?" });
  assert.equal(read.data.needsConfirmation, true);
  const r = await env.tool("deliver_message", { person: "granny", message: "Manoj will pick you up at 5.", question: "Do you need anything from the store?", confirmed: true });
  const t = await until(() => task(r.data.taskId).status === "done" && task(r.data.taskId));
  assert.equal(t.reply, "Yes, milk and bread please");
  const s = await env.tool("get_task_status", { person: "Grandma" });
  assert.match(s.text, /milk and bread/);
});

test("cancel needs a yes, then tells the worker", async () => {
  const bot = workerBot(env, "c_raju", ["yes 20 minutes", "okay"]);
  const r = await env.tool("run_errand", { request: "coffee", confirmed: true });
  await until(() => task(r.data.taskId).status === "accepted");
  const ask = await env.tool("cancel_task", { person: "Raju" });
  assert.equal(ask.data.needsConfirmation, true);
  assert.equal(task(r.data.taskId).status, "accepted");
  const c = await env.tool("cancel_task", { person: "Raju", confirmed: true });
  assert.match(c.text, /calling Raju to let them know/);
  await until(() => bot.calls.length === 2, 3000, "cancel call");
  await until(() => env.store.activeCalls().length === 0, 3000, "cancel call ends");
  assert.equal(task(r.data.taskId).status, "cancelled");
  assert.ok(env.store.calls.get(bot.calls[1])!.transcript.some((l) => /has cancelled/.test(l.text)));
});

test("cancel while still ringing hangs up and doesn't call back", async () => {
  workerBot(env, "c_raju", ["ignore"]);
  const r = await env.tool("run_errand", { request: "coffee", confirmed: true });
  await env.tool("cancel_task", { taskId: r.data.taskId, confirmed: true });
  assert.equal(task(r.data.taskId).status, "cancelled");
  await sleep(600);
  assert.equal(task(r.data.taskId).callIds.length, 1, "no retries after cancel");
});

test("worker calls in with an update → task done", async () => {
  workerBot(env, "c_raju", ["yes 30 minutes"]);
  const r = await env.tool("run_errand", { request: "coffee", confirmed: true });
  await until(() => task(r.data.taskId).status === "accepted");
  const inbound = env.assistant.inboundCall("c_raju")!;
  assert.ok(inbound.transcript.some((l) => /Is this about/.test(l.text)));
  env.phone.say(inbound.id, "It's done, coffee is on his desk");
  await until(() => task(r.data.taskId).status === "done");
});

test("worker calls in with no open task → message passed to user", async () => {
  const inbound = env.assistant.inboundCall("c_lakshmi")!;
  env.phone.say(inbound.id, "Tell him the gas cylinder was delivered");
  await until(() => notes().some((n) => /Lakshmi called and said.*gas cylinder/.test(n)));
});

test("get_task_status can wait for the call to finish", async () => {
  workerBot(env, "c_raju", ["yes 10 minutes"], 120);
  const r = await env.tool("run_errand", { request: "coffee", confirmed: true });
  const s = await env.tool("get_task_status", { taskId: r.data.taskId, waitSeconds: 3 });
  assert.equal(s.data.status, "accepted");
});

test("list_tasks: open and done", async () => {
  workerBot(env, "c_raju", ["yes 10 minutes"]);
  workerBot(env, "c_grandma", ["Okay dear"]);
  const a = await env.tool("run_errand", { request: "coffee", confirmed: true });
  const b = await env.tool("deliver_message", { person: "Grandma", message: "Dinner at 8.", confirmed: true });
  await until(() => task(a.data.taskId).status === "accepted" && task(b.data.taskId).status === "done");
  const open = await env.tool("list_tasks", {});
  assert.equal(open.data.total, 1);
  assert.match(open.text, /You have 1 open task/);
  const done = await env.tool("list_tasks", { filter: "done" });
  assert.equal(done.data.total, 1);
  const raju = await env.tool("list_tasks", { person: "Raju", filter: "all" });
  assert.equal(raju.data.total, 1);
});

test("several people at once, all in parallel", async () => {
  workerBot(env, "c_raju", ["yes 10 minutes"], 60);
  workerBot(env, "c_lakshmi", ["okay 20 minutes"], 40);
  workerBot(env, "c_ravi", ["coming, 5 minutes"], 20);
  const rs = await Promise.all([
    env.tool("run_errand", { request: "coffee", confirmed: true }),
    env.tool("run_errand", { request: "coffee", place: "home", confirmed: true }),
    env.tool("run_errand", { request: "the car", confirmed: true }),
  ]);
  await until(() => rs.every((r) => task(r.data.taskId).status === "accepted"), 4000, "all accepted");
  assert.deepEqual(rs.map((r) => task(r.data.taskId).eta), ["in 10 minutes", "in 20 minutes", "in 5 minutes"]);
});

test("phone-agent tools (Amazon Connect path) record outcomes", async () => {
  workerBot(env, "c_raju", ["silent"]);
  const r = await env.tool("assign_task", { person: "Raju", task: "print the agenda", confirmed: true });
  const t = task(r.data.taskId);
  await until(() => env.store.calls.get(t.callIds[0])?.status === "in_progress");
  const agent = await connectClient(`${env.url}/agent/mcp`);
  const brief: any = await agent.callTool({ name: "get_call_brief", arguments: { callId: t.callIds[0] } });
  assert.match(brief.structuredContent.disclosure, /AI assistant calling for Manoj/);
  assert.equal(brief.structuredContent.task.details, "print the agenda");
  await agent.callTool({ name: "report_outcome", arguments: { callId: t.callIds[0], outcome: "accept", text: "Sure", eta: "in 10 minutes" } });
  assert.equal(task(t.id).status, "accepted");
  assert.equal(task(t.id).eta, "in 10 minutes");
  await agent.close();
});

test("every tool call is logged", async () => {
  await env.tool("list_team");
  await env.tool("list_tasks");
  assert.ok(env.logs.filter((l) => l.event === "tool").length >= 2);
});

test("the user gets a designed email that matches what happened", async () => {
  const sent: any[] = [];
  await env.close();
  env = await startEnv({ mailer: { send: (m) => sent.push(m) } });
  workerBot(env, "c_raju", ["yes, 10 minutes"]);
  const r = await env.tool("run_errand", { request: "coffee", confirmed: true });
  await until(() => sent.length >= 1);
  const m = sent[0];
  assert.equal(m.to, "manoj@mobil80.com");
  assert.match(m.subject, /Coffee at the office · On it/);
  assert.match(m.html, /<table/);
  assert.match(m.html, /in 10 minutes/);
  assert.match(m.text, /Person: Raju/);
  assert.equal(m.taskId, r.data.taskId);
});

test("closed tasks and their transcripts are deleted after the retention period", async () => {
  workerBot(env, "c_raju", ["yes 10 minutes"]);
  workerBot(env, "c_grandma", ["okay"]);
  const open = await env.tool("run_errand", { request: "coffee", confirmed: true });
  const closed = await env.tool("deliver_message", { person: "Grandma", message: "Dinner at 8.", confirmed: true });
  await until(() => task(closed.data.taskId).status === "done" && task(open.data.taskId).status === "accepted");
  const callId = task(closed.data.taskId).callIds[0];
  const removed = env.assistant.sweepRetention(Date.now() + 31 * 24 * 3600_000);
  assert.equal(removed, 1);
  assert.equal(env.store.tasks.has(closed.data.taskId), false);
  assert.equal(env.store.calls.has(callId), false, "transcript gone too");
  assert.equal(env.store.tasks.has(open.data.taskId), true, "open tasks are kept");
});

test("privacy and terms pages are served", async () => {
  const p = await (await fetch(`${env.url}/privacy`)).text();
  assert.match(p, /30 days/);
  assert.match(p, /call 911/);
  assert.equal((await fetch(`${env.url}/terms`)).status, 200);
  assert.equal((await fetch(`${env.url}/outbox/..%2F..%2Fsecrets.json`)).status, 404);
});
