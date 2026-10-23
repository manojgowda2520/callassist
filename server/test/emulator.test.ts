// The Alexa+ emulator: natural phrases → the right MCP tool, full conversations.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { startEnv, until, workerBot, type Env } from "./helpers.js";
import type { AlexaBrain } from "../src/emulator/brain.js";

let env: Env;
let brain: AlexaBrain;
before(async () => {
  env = await startEnv();
  brain = await env.brain();
});
after(async () => env.close());

const intentOf = (u: string) => brain.understand(u.toLowerCase().replace(/^alexa,? /, ""));

test("emulator negotiates the Alexa+ protocol version", () => {
  assert.equal(brain.negotiatedVersion, "2025-03-26");
});

test("understands how people actually ask", () => {
  const cases: [string, string, Record<string, unknown>?][] = [
    ["get me a coffee", "run_errand"],
    ["i want a chai", "run_errand"],
    ["coffee please with less sugar", "run_errand", { notes: "with less sugar" }],
    ["get me a coffee at home", "run_errand", { place: "home" }],
    ["i need the car", "run_errand"],
    ["ask raju to bring my laptop charger to the conference room by 3 pm", "assign_task", { person: "Raju", task: "bring Madhu's laptop charger to the conference room", due: "by 3 pm" }],
    ["tell the driver to wait at the front gate", "assign_task", { person: "Ravi" }],
    ["have lakshmi make dinner for 4 people tonight", "assign_task", { person: "Lakshmi", due: "tonight" }],
    ["raju should clean the meeting room", "assign_task", { person: "Raju" }],
    ["remind raju to send the invoices", "assign_task", { person: "Raju" }],
    ["assign booking the cab to ravi", "assign_task", { person: "Ravi" }],
    ["tell grandma i'll pick her up at 5 and ask if she needs anything from the store", "deliver_message", { person: "Grandma", message: "Madhu will pick you up at 5.", question: "Do you need anything from the store?" }],
    ["ask ravi whether the car is free", "deliver_message", { person: "Ravi", question: "Is the car free?" }],
    ["what's pending", "list_tasks"],
    ["what is raju doing", "list_tasks", { person: "Raju" }],
    ["what got done", "list_tasks", { filter: "done" }],
    ["any update", "get_task_status"],
    ["what did raju say", "get_task_status", { person: "Raju" }],
    ["is the coffee coming", "get_task_status"],
    ["follow up with raju", "follow_up", { person: "Raju" }],
    ["check on the driver", "follow_up", { person: "Ravi" }],
    ["cancel the coffee", "cancel_task"],
    ["tell him it's room 3", "answer_question", { answer: "it's room 3" }],
    ["who's on my team", "list_team"],
    ["what can you do", "list_errands"],
  ];
  for (const [u, tool, args] of cases) {
    const i = intentOf(u);
    assert.ok(i, `no intent for "${u}"`);
    assert.equal(i.tool, tool, u);
    for (const [k, v] of Object.entries(args ?? {})) assert.equal(i.args[k], v, `${u} → ${k}`);
  }
  assert.equal(intentOf("what's the weather"), undefined);
});

test("a full voice conversation: coffee, yes, update", async () => {
  workerBot(env, "c_raju", ["Yes, 5 minutes"]);
  const s = "conv-1";
  const t1 = await brain.handle(s, "Alexa, get me a coffee");
  assert.equal(t1.tools[0].tool, "run_errand");
  assert.equal(t1.expectsReply, true);
  assert.match(t1.speech, /Shall I go ahead/);
  const t2 = await brain.handle(s, "yes please");
  assert.equal(t2.tools[0].args.confirmed, true);
  assert.match(t2.speech, /Calling Raju now/);
  await until(() => [...env.store.tasks.values()].some((t) => t.status === "accepted"));
  const t3 = await brain.handle(s, "is my coffee coming?");
  assert.match(t3.speech, /Raju is on it.*5 minutes/);
});

test("saying no drops the pending action", async () => {
  const s = "conv-2";
  await brain.handle(s, "ask lakshmi to iron my shirts");
  const before = env.store.calls.size;
  const t = await brain.handle(s, "no, wait");
  assert.match(t.speech, /won't/);
  assert.equal(env.store.calls.size, before);
});

test("a new request replaces an unconfirmed one", async () => {
  const s = "conv-3";
  await brain.handle(s, "ask lakshmi to water the plants");
  const t = await brain.handle(s, "what's pending");
  assert.equal(t.tools[0].tool, "list_tasks");
  const y = await brain.handle(s, "yes");
  assert.equal(y.tools.length, 0, "the old read-back was dropped");
});

test("'tell Raju …' answers Raju's open question", async () => {
  workerBot(env, "c_raju", ["Which floor?", "okay 10 minutes"]);
  const s = "conv-4";
  await brain.handle(s, "ask raju to put the new chairs in the meeting room");
  await brain.handle(s, "yes");
  await until(() => [...env.store.tasks.values()].some((t) => t.assigneeName === "Raju" && t.status === "blocked"));
  const t = await brain.handle(s, "tell raju the second floor");
  assert.equal(t.tools[0].tool, "answer_question");
  await until(() => [...env.store.tasks.values()].some((t) => t.title.startsWith("Put the new chairs") && t.status === "accepted"));
});

test("unknown requests get a helpful answer", async () => {
  const t = await brain.handle("conv-5", "sing me a song");
  assert.equal(t.tools.length, 0);
  assert.match(t.speech, /give someone on your team a task/);
});

test("emulator HTTP API returns speech, card and audio link", async () => {
  const res = await fetch(`${env.url}/api/alexa/say`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "http-1", text: "who's on my team" }) });
  const turn = await res.json();
  assert.match(turn.speech, /I can call/);
  assert.equal(turn.card.tool, "list_team");
  const info = await (await fetch(`${env.url}/api/alexa/info`)).json();
  assert.equal(info.tools.length, 10);
});

test("spoken replies never mention a screen and stay under ~30 seconds", async () => {
  const phrases = ["who's on my team", "what can you do", "get me a coffee", "no", "ask raju to clean the meeting room table and arrange twelve chairs and water bottles for the client presentation by 3 pm", "no", "what's pending", "what got done", "any update", "sing me a song"];
  for (const p of phrases) {
    const t = await brain.handle("len-1", p);
    assert.ok(!/\b(screen|tap|click|shown|see below|on the display)\b/i.test(t.speech), `${p}: ${t.speech}`);
    assert.ok(t.speech.split(/\s+/).length <= 75, `${p} is ${t.speech.split(/\s+/).length} words`);
  }
});
