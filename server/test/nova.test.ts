// The emulator's language-model path (Amazon Nova Pro in production), with a
// stand-in model so the tests run offline: free-form requests go to the model,
// common phrases stay on the instant rules, and a failing model falls back.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { startEnv, type Env } from "./helpers.js";
import { AlexaBrain } from "../src/emulator/brain.js";
import type { Plan, PlanContext, Planner } from "../src/emulator/nova.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

let env: Env;
before(async () => {
  env = await startEnv();
});
after(async () => env.close());

class FakeModel implements Planner {
  readonly name = "fake-nova";
  seen: { utterance: string; tools: string[]; ctx: PlanContext }[] = [];
  constructor(private answer: (u: string, ctx: PlanContext) => Plan | Promise<Plan>) {}
  async plan(utterance: string, tools: Tool[], ctx: PlanContext): Promise<Plan> {
    this.seen.push({ utterance, tools: tools.map((t) => t.name), ctx });
    return this.answer(utterance, ctx);
  }
}

test("free-form requests go to the model, and its tool call still needs the user's yes", async () => {
  const model = new FakeModel(() => ({ tool: "assign_task", args: { person: "Raju", task: "sort out the meeting room before the client comes", due: "by 3 pm" } }));
  const brain = new AlexaBrain(`${env.url}/mcp`, undefined, undefined, model);
  const t1 = await brain.handle("n1", "hey can you get raju to sort out the meeting room before the client comes at 3");
  assert.equal(t1.brain, "fake-nova");
  assert.equal(model.seen.length, 1);
  assert.ok(model.seen[0].tools.includes("assign_task"), "the model sees the MCP tools");
  assert.ok(model.seen[0].ctx.team.some((p) => p.name === "Raju"), "the model knows the team");
  assert.match(t1.speech, /Shall I go ahead/, "the server's read-back, not the model's words");
  assert.equal(t1.expectsReply, true);
  assert.equal(env.store.tasks.size, 0, "nobody is called before the yes");
  const t2 = await brain.handle("n1", "yes");
  assert.match(t2.speech, /Calling Raju now/);
  assert.equal(model.seen.length, 1, "yes is handled instantly, without the model");
  await brain.close();
});

test("on-screen suggestions and quick questions skip the model", async () => {
  const model = new FakeModel(() => {
    throw new Error("should not be asked");
  });
  const brain = new AlexaBrain(`${env.url}/mcp`, undefined, undefined, model);
  for (const u of ["Get me a coffee", "What's pending?", "Who's on my team?"]) {
    const t = await brain.handle("n2", u);
    assert.equal(t.brain, "rules", u);
  }
  assert.equal(model.seen.length, 0);
  await brain.close();
});

test("if the model fails or is slow, the rules answer instead", async () => {
  const model = new FakeModel(() => Promise.reject(new Error("ThrottlingException")));
  const brain = new AlexaBrain(`${env.url}/mcp`, undefined, undefined, model);
  const t = await brain.handle("n3", "ask raju to bring the visitor badges");
  assert.equal(t.brain, "rules (model unavailable)");
  assert.match(t.speech, /Raju/);
  await brain.close();
});

test("the model can ask a short question back, and it sees the conversation so far", async () => {
  const model = new FakeModel((u) => (/badges/.test(u) ? { speech: "Who should bring them?" } : { tool: "assign_task", args: { person: "Ravi", task: "bring the visitor badges" } }));
  const brain = new AlexaBrain(`${env.url}/mcp`, undefined, undefined, model);
  const q = await brain.handle("n4", "somebody needs to bring the visitor badges");
  assert.equal(q.speech, "Who should bring them?");
  assert.equal(q.expectsReply, true);
  const r = await brain.handle("n4", "the driver");
  assert.deepEqual(model.seen[1].ctx.history.map((h) => h.text), ["somebody needs to bring the visitor badges", "Who should bring them?"]);
  assert.match(r.speech, /Ravi/);
  await brain.close();
});

test("the model never gets to confirm a call itself", async () => {
  const model = new FakeModel(() => ({ tool: "run_errand", args: { request: "a coffee", confirmed: true, confirmationToken: "made-up" } }));
  const brain = new AlexaBrain(`${env.url}/mcp`, undefined, undefined, model);
  const before = env.store.tasks.size;
  // The planner strips these in production; even if a model sent them, the server refuses a made-up token.
  const t = await brain.handle("n5", "could i get a cup of coffee please");
  assert.equal(env.store.tasks.size, before, "no call from a made-up confirmation");
  assert.ok(!/Calling/.test(t.speech));
  await brain.close();
});

test("the model can't claim an action in words: a recognised request still runs the real tool", async () => {
  const model = new FakeModel(() => ({ speech: "I've called Neeta and she has confirmed the meeting." }));
  const brain = new AlexaBrain(`${env.url}/mcp`, undefined, undefined, model);
  const t = await brain.handle("n6", "Ask Raju to bring the visitor badges by 5 pm");
  assert.equal(t.tools[0]?.tool, "assign_task", "the rules' tool ran");
  assert.match(t.speech, /Shall I go ahead/, "the user hears the real read-back, not the model's claim");
  assert.match(t.brain ?? "", /→ rules/);
  await brain.close();
});
